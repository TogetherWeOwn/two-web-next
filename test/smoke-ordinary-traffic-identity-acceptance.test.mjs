import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SMOKE_PROBE_KEY, SMOKE_SECURITY_TXT_EXPIRES, smoke } from "../bin/smoke.mjs";

// Acceptance contract: verify the recorded version serves ordinary traffic.
//
// Post-rollback, a healthy unwanted Worker version can satisfy every health
// assertion in bin/smoke.mjs without proving the recorded rollback target is
// the version answering normal (unpinned) routing. The existing identity
// check only runs when a version override pins the probe to a candidate, so
// it proves canary routing, not ordinary routing.
//
// Locked builder contract (this file is acceptance-owned; do not edit it to
// make an implementation pass):
// - smoke(baseUrl, { expectedVersionId }) and the CLI flag
//   --expected-version-id <lowercase-uuid> add a validated identity check
//   that is independent of version routing: a missing, malformed or
//   different /up revision.version_id fails even when readiness is healthy.
// - The expected version is validated as a lowercase UUID before any probe
//   request is sent; malformed values are a usage error (CLI exit 2).
// - The check sends no Cloudflare-Workers-Version-Overrides header.
// - Exact identity still requires every existing health/security assertion.
// - Without expectedVersionId, behavior is unchanged (identity unenforced),
//   so staging and ad-hoc probes keep working.
// - .github/workflows/rollback-production.yml wires the recorded
//   ROLLBACK_VERSION_ID into its existing bounded smoke retry loop via the
//   step env (inputs -> env -> quoted shell variable), keeping queue-warning
//   behavior, target-version secret preflight, admission and the shared
//   concurrency group unchanged.
// - docs/runbook.md (Production one-click workflow section) documents the
//   ordinary-traffic identity proof and its limit.
// - Wire this file into the test:smoke script in package.json.
//
// Hermetic only: every probe below talks to a loopback stub. No live host,
// no workflow dispatch.

const EXPECTED = "22345678-1234-1234-1234-123456789abc";
const WRONG = "11111111-2222-3333-4444-555555555555";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function healthyUp(versionId) {
  return JSON.stringify({
    status: "healthy",
    db: "ok",
    pending_migrations: 0,
    queue: { status: "unknown", warn_at: 20, critical_at: 100 },
    revision: { version_id: versionId, commit: null },
  });
}

const fixtures = {
  "/up": [200, "application/json", healthyUp(EXPECTED)],
  "/": [200, "text/html", "<h1>The lobby is open.</h1>"],
  "/about": [200, "text/html", "<h1>About Together We Own</h1>"],
  "/faq": [200, "text/html", "<h1>Frequently asked questions</h1>"],
  "/rules": [200, "text/html", '<h1 id="rules-heading">House rules</h1>'],
  "/privacy": [200, "text/html", "<h1>Privacy policy</h1>"],
  "/events": [200, "text/html", '<h1 id="events-heading">Events</h1>'],
  "/events/past": [200, "text/html", '<h1 id="past-events-heading">Past events</h1>'],
  "/join": [
    200,
    "text/html",
    '<h1 id="join-heading">Join Together We Own</h1><p>One click with Discord</p>',
  ],
  "/events.rss": [200, "application/rss+xml", '<rss version="2.0"><channel></channel></rss>'],
  "/events.ics": [200, "text/calendar", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"],
  "/sitemap_index.xml": [
    200,
    "application/xml",
    (origin) =>
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`,
  ],
  "/robots.txt": [
    200,
    "text/plain",
    (origin) => `User-agent: *\nDisallow:\nSitemap: ${origin}/sitemap_index.xml\n`,
  ],
  "/.well-known/security.txt": [
    200,
    "text/plain",
    `Contact: https://example.invalid/contact\nExpires: ${SMOKE_SECURITY_TXT_EXPIRES}\n`,
  ],
  "/discord": [302, null, "", "https://discord.gg/fixture"],
  "/profile": [302, null, "", "/auth/discord"],
  "/admin": [302, null, "", "/auth/discord"],
  "/api/public/events": [
    200,
    "application/json",
    '{"data":[],"page":1,"limit":20,"meta":{"current_page":1,"per_page":20,"total":0,"last_page":1}}',
  ],
  // The fixed probe key exists in no database: 404 not_found like the
  // real handler (src/public-data/routes.ts).
  [`/api/public/events/${SMOKE_PROBE_KEY}`]: [
    404,
    "application/json",
    '{"error":{"code":"not_found","message":"No published event with that key."}}',
  ],
  "/api/public/community": [
    200,
    "application/json",
    '{"member_count":123,"online_count":12,"ranks":[{"key":"veterans","label":"Veterans","member_count":42}]}',
  ],
  "/api/public/join": [
    200,
    "application/json",
    '{"intro":"Approve once with Discord and we will add you to the server.","invite_url":"https://discord.gg/fixture"}',
  ],
  "/openapi.json": [
    200,
    "application/json",
    '{"openapi":"3.1.0","info":{"title":"Together We Own public read API","version":"1.0.0"},"paths":{"/api/public/events":{"get":{"responses":{"200":{"description":"ok"}}}}}}',
  ],
  // Single-event HTML detail (GET /e/:key): the fixed probe key exists in
  // no database, so like the real handler's notFound() the stub answers the
  // branded missing-event page.
  [`/e/${SMOKE_PROBE_KEY}`]: [
    404,
    "text/html",
    "<title>We cannot find that page — Together We Own</title>",
  ],
  "/__smoke_unknown_route__": [
    404,
    "text/html",
    "<title>We cannot find that page — Together We Own</title>",
  ],
};

async function stub(t, change = () => {}, { indexable = false } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      method: request.method,
      override: request.headers["cloudflare-workers-version-overrides"],
    });
    const fixture = fixtures[request.url];
    if (!fixture) {
      response.writeHead(500).end("Unexpected request");
      return;
    }
    const [status, type, body, location] = fixture;
    const origin = `http://${request.headers.host}`;
    const result = {
      status,
      body: typeof body === "function" ? body(origin) : body,
      headers: {
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "x-frame-options": "DENY",
        ...(type ? { "content-type": `${type}; charset=UTF-8` } : {}),
        ...(type === "text/html" && !indexable ? { "x-robots-tag": "noindex, nofollow" } : {}),
        ...(request.url === "/up"
          ? { "x-two-origin": "two-web-next", "cache-control": "no-store" }
          : {}),
        ...(location ? { location } : {}),
      },
    };
    change(request.url, result);
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function serveUp(body) {
  return (route, result) => {
    if (route === "/up") result.body = body;
  };
}

async function run(url, options = {}) {
  const output = [];
  const ok = await smoke(url, { log: (line) => output.push(line), ...options });
  return { ok, output: output.join("\n") };
}

function spawnCollect(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

function cli(args) {
  return spawnCollect(process.execPath, ["bin/smoke.mjs", ...args], { cwd: repoRoot });
}

// --- Positive controls: these pass at the current base and must keep passing.

test("positive control: expected version passes when it serves healthy ordinary traffic, without any version-override header", async (t) => {
  const { url, requests } = await stub(t, serveUp(healthyUp(EXPECTED)));
  const result = await run(url, { expectedVersionId: EXPECTED });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /24 routes, 0 failed assertions/);
  assert.equal(requests.length, 24);
  assert.ok(requests.every((r) => r.method === "GET" && r.override === undefined));
});

test("positive control: without an expected version, identity stays unenforced", async (t) => {
  // Existing staging/ad-hoc probes pass no expected version; a healthy /up
  // naming any (or no) version must keep passing exactly as today.
  const { url } = await stub(t, serveUp(healthyUp(WRONG)));
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
});

test("positive control: exact identity still fails when readiness is unhealthy", async (t) => {
  const body = JSON.stringify({
    status: "healthy",
    db: "error",
    pending_migrations: 0,
    queue: { status: "unknown", warn_at: 20, critical_at: 100 },
    revision: { version_id: EXPECTED, commit: null },
  });
  const { url } = await stub(t, serveUp(body));
  const result = await run(url, { expectedVersionId: EXPECTED });
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /FAIL \/up: expected JSON \/up db:ok/);
});

// --- Failing-first: the ordinary-traffic identity check does not exist yet.

test("healthy /up identifying a different version fails the expected-version check, with no override header sent", async (t) => {
  // Propagation has not landed: ordinary routing still serves the unwanted
  // version, healthy on every existing assertion. Only identity can fail it.
  const { url, requests } = await stub(t, serveUp(healthyUp(WRONG)));
  const result = await run(url, { expectedVersionId: EXPECTED });
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /FAIL \/up: expected revision\.version_id/);
  assert.equal(requests.length, 24);
  assert.ok(requests.every((r) => r.override === undefined));
});

test("same commit served as a different version still fails (commit equality is not identity)", async (t) => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const body = JSON.stringify({
    status: "healthy",
    db: "ok",
    pending_migrations: 0,
    queue: { status: "unknown", warn_at: 20, critical_at: 100 },
    revision: { version_id: WRONG, commit },
  });
  const { url } = await stub(t, serveUp(body));
  const result = await run(url, { expectedVersionId: EXPECTED });
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /FAIL \/up: expected revision\.version_id/);
});

test("missing or malformed revision metadata fails the expected-version check", async (t) => {
  const healthy = {
    status: "healthy",
    db: "ok",
    pending_migrations: 0,
    queue: { status: "unknown", warn_at: 20, critical_at: 100 },
  };
  const bodies = [
    JSON.stringify(healthy),
    JSON.stringify({ ...healthy, revision: null }),
    JSON.stringify({ ...healthy, revision: [] }),
    JSON.stringify({ ...healthy, revision: EXPECTED }),
    JSON.stringify({ ...healthy, revision: {} }),
    JSON.stringify({ ...healthy, revision: { version_id: null, commit: null } }),
    JSON.stringify({ ...healthy, revision: { version_id: 123, commit: null } }),
    JSON.stringify({ ...healthy, revision: { version_id: "not-a-uuid", commit: null } }),
    JSON.stringify({
      ...healthy,
      revision: { version_id: EXPECTED.toUpperCase().replace("ABC", "ABC"), commit: null },
    }),
    JSON.stringify({ ...healthy, revision: { version_id: ` ${EXPECTED}`, commit: null } }),
    JSON.stringify({ ...healthy, revision: { commit: null } }),
  ];
  for (const body of bodies) {
    const { url, requests } = await stub(t, serveUp(body));
    const result = await run(url, { expectedVersionId: EXPECTED });
    assert.equal(result.ok, false, body);
    assert.match(result.output, /FAIL \/up: expected revision\.version_id/, body);
    assert.ok(
      requests.every((r) => r.override === undefined),
      body,
    );
  }
});

test("malformed expected version is refused before any probe request", async (t) => {
  const { url, requests } = await stub(t);
  const badValues = [
    "",
    "NOT-A-UUID",
    "22345678-1234-1234-1234-123456789ABC",
    `${EXPECTED} `,
    ` ${EXPECTED}`,
    `${EXPECTED}; echo injected`,
    'two-web-next-production="22345678-1234-1234-1234-123456789abc"',
    123,
    null,
  ];
  for (const bad of badValues) {
    await assert.rejects(
      () => smoke(url, { log: () => {}, expectedVersionId: bad }),
      /expected-version-id/,
      `expectedVersionId=${JSON.stringify(bad)}`,
    );
  }
  assert.equal(requests.length, 0);
});

test("wrong version first, recorded version after propagation: first probe fails, retry passes, never with an override header", async (t) => {
  let upHits = 0;
  const { url, requests } = await stub(t, (route, result) => {
    if (route === "/up") {
      upHits += 1;
      result.body = healthyUp(upHits === 1 ? WRONG : EXPECTED);
    }
  });
  const first = await run(url, { expectedVersionId: EXPECTED });
  assert.equal(first.ok, false, first.output);
  assert.match(first.output, /FAIL \/up: expected revision\.version_id/);
  const second = await run(url, { expectedVersionId: EXPECTED });
  assert.equal(second.ok, true, second.output);
  assert.ok(requests.every((r) => r.override === undefined));
});

// --- CLI surface the rollback workflow calls.

test("CLI --expected-version-id passes when the recorded version serves, without an override header", async (t) => {
  const { url, requests } = await stub(t, serveUp(healthyUp(EXPECTED)));
  const result = await cli([url, "--expected-version-id", EXPECTED]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /24 routes, 0 failed assertions/);
  assert.equal(requests.length, 24);
  assert.ok(requests.every((r) => r.override === undefined));
});

test("CLI --expected-version-id fails (exit 1) when a healthy different version serves", async (t) => {
  const { url, requests } = await stub(t, serveUp(healthyUp(WRONG)));
  const result = await cli([url, "--expected-version-id", EXPECTED]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /FAIL \/up: expected revision\.version_id/);
  assert.ok(requests.every((r) => r.override === undefined));
});

test("CLI refuses a malformed or missing --expected-version-id value without probing", async (t) => {
  const { url, requests } = await stub(t);
  for (const args of [
    [url, "--expected-version-id", "NOT-A-UUID"],
    [url, "--expected-version-id", ""],
    [url, "--expected-version-id"],
    [url, "--expected-version-id", EXPECTED, "--expected-version-id"],
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 2, `${JSON.stringify(args)}: ${result.output}`);
    assert.match(result.output, /expected-version-id/, JSON.stringify(args));
  }
  assert.equal(requests.length, 0);
});

// --- Workflow wiring: the recorded input UUID reaches the verifier.

async function rollbackSmokeStep() {
  const workflow = await readFile(
    new URL("../.github/workflows/rollback-production.yml", import.meta.url),
    "utf8",
  );
  const start = workflow.indexOf("- name: Smoke test public routes on the rolled-back version");
  assert.notEqual(start, -1, "rollback smoke step not found");
  const step = workflow.slice(start);
  const runAt = step.indexOf("run: |");
  assert.notEqual(runAt, -1, "rollback smoke run block not found");
  // The run block ends at the first line outside its indentation, so later
  // jobs (rollback-notify) never leak into the extracted script.
  const lines = step.slice(runAt + "run: |".length).split("\n").slice(1);
  const end = lines.findIndex((line) => line !== "" && !line.startsWith("          "));
  const script = (end === -1 ? lines : lines.slice(0, end))
    .filter((line) => line.startsWith("          "))
    .map((line) => line.slice(10))
    .join("\n");
  return { step, script };
}

test("rollback workflow passes the recorded version to the smoke verifier inside the bounded retry loop, with no version override", async () => {
  const { step, script } = await rollbackSmokeStep();
  assert.match(script, /for i in 1 2 3 4 5 6; do/, script);
  assert.match(script, /node bin\/smoke\.mjs "\$ROLLBACK_ORIGIN" "\$\{indexable\[@\]\}"/, script);
  assert.match(script, /indexable=\(--allow-indexable\)/, script);
  assert.match(step, /ROLLBACK_ORIGIN: \$\{\{ steps\.target\.outputs\.origin \}\}/, step);
  assert.match(script, /--expected-version-id "\$ROLLBACK_VERSION_ID"/, script);
  assert.doesNotMatch(script, /--version-override/, script);
  assert.doesNotMatch(step, /Cloudflare-Workers-Version-Overrides/, step);
  // The input travels inputs -> env -> quoted shell variable, never through
  // expression interpolation in the run block (same rule as the other steps).
  assert.match(step, /ROLLBACK_VERSION_ID: \$\{\{ inputs\.version_id \}\}/, step);
  assert.doesNotMatch(script, /\$\{\{/, script);
});

async function runRollbackScript(t, serve) {
  const { url, requests } = await stub(t, serve, { indexable: true });
  const { script } = await rollbackSmokeStep();
  // Hermetic extraction: same shell, loopback target, no real retry delay.
  const hermetic = script.replaceAll("sleep 10", "sleep 0");
  const result = await spawnCollect("bash", ["-c", hermetic], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ROLLBACK_VERSION_ID: EXPECTED,
      ROLLBACK_ORIGIN: url,
      ROLLBACK_INDEXABLE: "true",
      SMOKE_FAILED_BASELINE: "",
      SMOKE_ALLOW_MISSING_BASELINE: "1",
    },
  });
  return { ...result, requests };
}

test("extracted rollback smoke step fails after its bounded retries while a healthy wrong version serves ordinary traffic", async (t) => {
  const result = await runRollbackScript(t, serveUp(healthyUp(WRONG)));
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /public-route smoke failed after rollback/);
  assert.match(result.output, /FAIL \/up: expected revision\.version_id/);
  // The bounded loop retried instead of accepting the first healthy answer.
  assert.ok(result.requests.length >= 36, `requests=${result.requests.length}`);
  assert.ok(result.requests.every((r) => r.override === undefined));
});

test("extracted rollback smoke step passes once propagation serves the recorded version", async (t) => {
  let upHits = 0;
  const result = await runRollbackScript(t, (route, res) => {
    if (route === "/up") {
      upHits += 1;
      res.body = healthyUp(upHits === 1 ? WRONG : EXPECTED);
    }
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /rollback smoke ok \(attempt 2\)/);
  assert.ok(result.requests.every((r) => r.override === undefined));
});

// --- Runbook: the proof and its limit are documented where operators look.

test("rollback runbook documents the ordinary-traffic identity proof and its limit", async () => {
  const runbook = await readFile(new URL("../docs/runbook.md", import.meta.url), "utf8");
  const start = runbook.indexOf("#### Production (one-click workflow)");
  assert.notEqual(start, -1, "production rollback runbook section not found");
  const rest = runbook.slice(start);
  const end = rest.indexOf("\n#### ", 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  assert.match(section, /revision\.version_id/, section);
  assert.match(section, /ordinary traffic/i, section);
  assert.match(section, /version-override/i, section);
  // The limit: versions that cannot self-report a revision cannot pass, and
  // a failed verification is neither an undone rollback nor a roll-forward.
  assert.match(section, /cannot pass|predat|before the marker|no `revision`/i, section);
  assert.match(section, /not.*(undone|undo|roll-forward)|never.*roll-forward/i, section);
});
