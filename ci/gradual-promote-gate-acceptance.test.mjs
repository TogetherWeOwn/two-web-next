// Acceptance: gradual-promote gates against the REAL bin/smoke.mjs checker.
//
// The review bug this pins: the composite action's canary gates passed
// --version-override "$WORKER_NAME=$NEW_VERSION" (unquoted), while the
// checker only accepts the Cloudflare dictionary form
// worker-name="<lowercase version uuid>" and exits 2 before any probe.
// Every canary gate therefore failed, every promote rolled back, and the
// fake-checker workflow tests stayed green. These tests extract each gate's
// actual `run:` block from the action and execute it (bash, same retry loop,
// same argument token) against the real checker and a loopback stub, so the
// two halves cannot drift again.
//
// Local adaptations, and only these: `https://$DOMAIN` becomes
// `http://$DOMAIN` (the loopback stub has no TLS) and `sleep 10` becomes
// `sleep 0` (the attempt count is unchanged). The --version-override token
// under test is never rewritten in the positive cases.
//
// Run: node --test ci/gradual-promote-gate-acceptance.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

const WORKER = "two-web-next-production";
const NEW_VERSION = "22345678-1234-1234-1234-123456789abc";
const QUOTED_OVERRIDE = `${WORKER}="${NEW_VERSION}"`;
const GATE_IDS = ["smoke-5", "smoke-50", "smoke-100-override"];

const fixtures = {
  // The /up fixture carries the candidate revision the gates pin
  // (NEW_VERSION): the real checker requires revision.version_id to equal
  // the override UUID, so an ignored override serving the old version fails.
  "/up": [
    200,
    "application/json",
    '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"unknown","warn_at":20,"critical_at":100},"revision":{"version_id":"22345678-1234-1234-1234-123456789abc","commit":null}}',
  ],
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
  // RFC 9116 publication: the loopback stub has no TLS, so like the real Worker
  // on an http origin the body carries no Canonical line (bin/smoke.mjs
  // asserts its absence on http and requires the same-origin value on https).
  "/.well-known/security.txt": [
    200,
    "text/plain",
    "Contact: https://github.com/TogetherWeOwn/two-web-next/security/advisories/new\nExpires: 2027-10-01T00:00:00Z\nPreferred-Languages: en\nPolicy: https://github.com/TogetherWeOwn/two-web-next/blob/main/SECURITY.md\n",
  ],
  "/discord": [302, null, "", "https://discord.gg/fixture"],
  "/profile": [302, null, "", "/auth/discord"],
  "/admin": [302, null, "", "/auth/discord"],
  "/api/public/events": [
    200,
    "application/json",
    '{"data":[],"page":1,"limit":20,"meta":{"current_page":1,"per_page":20,"total":0,"last_page":1}}',
  ],
  "/api/public/events/00000000000000000000000001": [
    200,
    "application/json",
    '{"event_key":"00000000000000000000000001","title":"Fixture game night","game":null,"description":"Brackets ] and braces } stay inside the row","starts_at":"2026-11-01T19:00:00.000Z","ends_at":"2026-11-01T22:00:00.000Z","starts_at_local":"2026-11-01 19:00","ends_at_local":"2026-11-01 22:00","timezone":"UTC","location":null,"capacity":null,"going_count":3,"status":"published","rsvp_open":true,"synced_to_discord":false}',
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
  "/__smoke_unknown_route__": [
    404,
    "text/html",
    "<title>We cannot find that page — Together We Own</title>",
  ],
};

async function stub(t, change = () => {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      override: request.headers["cloudflare-workers-version-overrides"],
    });
    const fixture = fixtures[request.url];
    if (!fixture) {
      response.writeHead(500).end("Unexpected request");
      return;
    }
    const [status, type, body, location] = fixture;
    const origin = `http://${request.headers.host}`;
    const resolved = typeof body === "function" ? body(origin) : body;
    const result = {
      status,
      body: resolved,
      location,
      type,
    };
    change(request.url, result);
    response.writeHead(result.status, {
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      ...(result.type ? { "content-type": `${result.type}; charset=UTF-8` } : {}),
      ...(result.type === "text/html" ? { "x-robots-tag": "noindex, nofollow" } : {}),
      ...(request.url === "/up"
        ? { "x-two-origin": "two-web-next", "cache-control": "no-store" }
        : {}),
      ...(result.location ? { location: result.location } : {}),
    });
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
  return { host: `127.0.0.1:${server.address().port}`, requests };
}

function readAction() {
  const url = new URL("../.github/actions/gradual-promote/action.yml", import.meta.url);
  assert.ok(
    existsSync(url),
    "missing .github/actions/gradual-promote/action.yml (gradual-promote action not landed)",
  );
  return readFileSync(url, "utf8");
}

// One gate step's `run: |` block, dedented, exactly as bash would receive it.
function gateBlock(action, id) {
  const match = action.match(
    new RegExp(`\\n      id: ${id}\\n      shell: bash\\n      run: \\|\\n((?:        .*\\n)+)`),
  );
  assert.ok(match, `gradual-promote action has no bash gate step with id ${id}`);
  return match[1]
    .split("\n")
    .map((line) => line.slice(8))
    .join("\n");
}

// Async spawn: the stub server lives in this process, so a blocking spawn
// would starve it and every probe would time out instead of answering.
async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [status] = await once(child, "exit");
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function runGate(block, host, mutate = (script) => script) {
  assert.ok(block.includes("https://$DOMAIN"), "gate probes https://$DOMAIN in production");
  assert.ok(block.includes("sleep 10"), "gate keeps the 10s retry spacing in production");
  const script = mutate(block)
    .replaceAll("https://$DOMAIN", "http://$DOMAIN")
    .replaceAll("sleep 10", "sleep 0");
  return run("bash", ["-c", script], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      DOMAIN: host,
      INDEXABLE: "",
      WORKER_NAME: WORKER,
      NEW_VERSION,
    },
  });
}

test("gradual-promote defines exactly the three version-override gates, quoted", () => {
  const action = readAction();
  assert.equal(
    (action.match(/--version-override /g) ?? []).length,
    3,
    "expected exactly three --version-override gates (5, 50, 100 percent)",
  );
  for (const id of GATE_IDS) {
    const block = gateBlock(action, id);
    assert.ok(
      block.includes('--version-override "$WORKER_NAME=\\"$NEW_VERSION\\""'),
      `${id} must pass the quoted dictionary form the checker requires, got: ${block.trim()}`,
    );
    assert.ok(
      !block.includes('--version-override "$WORKER_NAME=$NEW_VERSION"'),
      `${id} passes the override unquoted; the real checker exits 2 before probing`,
    );
  }
});

for (const id of GATE_IDS) {
  test(`gate ${id} passes against the real checker and pins every probe`, async (t) => {
    const action = readAction();
    const { host, requests } = await stub(t);
    const result = await runGate(gateBlock(action, id), host);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /smoke ok \(attempt 1\)/);
    assert.equal(requests.length, 23, "the real checker probed every route once");
    assert.ok(
      requests.every((r) => r.override === QUOTED_OVERRIDE),
      `every probe must carry ${QUOTED_OVERRIDE}`,
    );
  });
}

test("the same gate block with an unquoted override fails closed, probing nothing", async (t) => {
  const action = readAction();
  const { host, requests } = await stub(t);
  const block = gateBlock(action, "smoke-5");
  assert.ok(
    block.includes('"$WORKER_NAME=\\"$NEW_VERSION\\""'),
    "precondition: the landed gate is quoted, so unquoting it recreates the bug",
  );
  const result = await runGate(block, host, (script) =>
    script.replace('"$WORKER_NAME=\\"$NEW_VERSION\\""', '"$WORKER_NAME=$NEW_VERSION"'),
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /version-override must look like/);
  assert.equal(
    ((result.stdout + result.stderr).match(/version-override must look like/g) ?? []).length,
    6,
    "all six gate attempts refuse the unquoted override",
  );
  assert.equal(requests.length, 0, "the checker must refuse before any probe is sent");
});

test("the real checker itself accepts quoted and refuses unquoted overrides", async (t) => {
  const { host, requests } = await stub(t);
  const cli = (override) =>
    run(process.execPath, ["bin/smoke.mjs", `http://${host}`, "--version-override", override], {
      cwd: new URL("..", import.meta.url),
    });
  const unquoted = await cli(`${WORKER}=${NEW_VERSION}`);
  assert.equal(unquoted.status, 2, unquoted.stdout + unquoted.stderr);
  assert.match(unquoted.stdout + unquoted.stderr, /version-override/);
  assert.equal(requests.length, 0);
  const quoted = await cli(QUOTED_OVERRIDE);
  assert.equal(quoted.status, 0, quoted.stdout + quoted.stderr);
  assert.match(quoted.stdout, /23 routes, 0 failed assertions/);
  assert.equal(requests.length, 23);
  assert.ok(requests.every((r) => r.override === QUOTED_OVERRIDE));
});

test("gate smoke-5 fails when the override is ignored and the old version answers healthy", async (t) => {
  // Response attribution, not readiness: the stub answers every readiness
  // assertion healthy but identifies the old version, so the extracted gate
  // block probing the candidate UUID must fail closed.
  const action = readAction();
  const { host, requests } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body = JSON.stringify({
        status: "healthy",
        db: "ok",
        pending_migrations: 0,
        queue: { status: "unknown", warn_at: 20, critical_at: 100 },
        revision: {
          version_id: "11111111-2222-3333-4444-555555555555",
          commit: null,
        },
      });
  });
  const result = await runGate(gateBlock(action, "smoke-5"), host);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /revision\.version_id/);
  assert.ok(
    requests.every((r) => r.override === QUOTED_OVERRIDE),
    "the gate still pins every probe to the candidate version",
  );
});
