import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SMOKE_SECURITY_TXT_EXPIRES } from "../bin/smoke.mjs";

// Acceptance: the post-promotion verification proves the promoted UUID serves
// ordinary traffic, not just healthy content from an unwanted version.
//
// After the gradual promotion reaches 100%, a healthy response from the
// previous version can satisfy every readiness assertion without proving the
// recorded promotion target serves normal routing. The final smoke must pass
// steps.gradual.outputs.promoted-version-id to bin/smoke.mjs
// --expected-version-id on every attempt, with no version-override routing
// header, and must reject an absent/malformed promoted id before probing.
// A failed verification blocks the release tag while leaving the promoted
// candidate live and naming the recorded restoration target; it never adds an
// automatic rollback.
//
// Hermetic only: every probe below talks to a loopback stub. No live host,
// no workflow dispatch.

const PROMOTED = "22345678-1234-1234-1234-123456789abc";
const WRONG = "11111111-2222-3333-4444-555555555555";
const RESTORATION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
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
  "/up": [200, "application/json", healthyUp(PROMOTED)],
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
        ...(type ? { "content-type": `${type}; charset=UTF-8` } : {}),
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

async function promotionSmokeStep() {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const start = workflow.indexOf("- name: Verify public routes on the promoted version");
  assert.notEqual(start, -1, "promotion smoke step not found");
  const step = workflow.slice(start);
  const runAt = step.indexOf("run: |");
  assert.notEqual(runAt, -1, "promotion smoke run block not found");
  const lines = step
    .slice(runAt + "run: |".length)
    .split("\n")
    .slice(1);
  const scriptLines = [];
  for (const line of lines) {
    if (!line.startsWith("          ")) break;
    scriptLines.push(line.slice(10));
  }
  const script = scriptLines.join("\n");
  return { step, script };
}

test("promotion workflow passes the promoted version to the smoke verifier inside the bounded retry loop, with no version override", async () => {
  const { step, script } = await promotionSmokeStep();
  assert.match(script, /for i in 1 2 3 4 5 6; do/, script);
  assert.match(script, /sleep 10/, script);
  assert.match(script, /node bin\/smoke\.mjs https:\/\/togetherweown\.com/, script);
  assert.match(script, /--allow-indexable/, script);
  assert.match(script, /--expected-version-id "\$PROMOTED_VERSION_ID"/, script);
  assert.doesNotMatch(script, /--version-override/, script);
  assert.doesNotMatch(step, /Cloudflare-Workers-Version-Overrides/, step);
  // The promoted id travels steps.gradual.outputs -> env -> quoted shell
  // variable, never through expression interpolation in the run block.
  assert.match(
    step,
    /PROMOTED_VERSION_ID: \$\{\{ steps\.gradual\.outputs\.promoted-version-id \}\}/,
    step,
  );
  assert.match(
    step,
    /PREV_VERSION: \$\{\{ steps\.gradual\.outputs\.rollback-version-id \}\}/,
    step,
  );
  assert.doesNotMatch(script, /\$\{\{/, script);
  // Absent/malformed promoted output fails closed before any probe instead of
  // silently omitting verification.
  assert.match(script, /PROMOTED_VERSION_ID/, script);
  assert.match(script, /missing or malformed|absent\/malformed|malformed/i, script);
});

test("promotion failure message identifies the live candidate and the recorded restoration target", async () => {
  const { script } = await promotionSmokeStep();
  assert.match(script, /PROMOTED_VERSION_ID:-unknown/, script);
  assert.match(script, /PREV_VERSION:-unknown/, script);
  assert.match(script, /remains live at 100%/, script);
  assert.match(script, /release will not tag/, script);
  assert.match(script, /rollback-production workflow/, script);
});

async function runPromotionScript(t, serve, envOverrides = {}) {
  const { url, requests } = await stub(t, serve);
  const { script } = await promotionSmokeStep();
  const hermetic = script
    .replaceAll("https://togetherweown.com", url)
    .replaceAll("sleep 10", "sleep 0");
  const result = await spawnCollect("bash", ["-c", hermetic], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PROMOTED_VERSION_ID: PROMOTED,
      PREV_VERSION: RESTORATION,
      SMOKE_FAILED_BASELINE: "",
      SMOKE_ALLOW_MISSING_BASELINE: "1",
      ...envOverrides,
    },
  });
  return { ...result, requests };
}

test("extracted promotion smoke step fails after its bounded retries while a healthy wrong version serves ordinary traffic", async (t) => {
  const result = await runPromotionScript(t, serveUp(healthyUp(WRONG)));
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /FAIL \/up: expected revision\.version_id/);
  assert.match(result.output, new RegExp(PROMOTED.replaceAll("-", "\\-")));
  assert.match(result.output, new RegExp(RESTORATION.replaceAll("-", "\\-")));
  assert.match(result.output, /remains live at 100%/);
  assert.match(result.output, /release will not tag/);
  assert.ok(result.requests.length >= 36, `requests=${result.requests.length}`);
  assert.ok(result.requests.every((r) => r.override === undefined));
});

test("extracted promotion smoke step passes once propagation serves the promoted version", async (t) => {
  let upHits = 0;
  const result = await runPromotionScript(t, (route, res) => {
    if (route === "/up") {
      upHits += 1;
      res.body = healthyUp(upHits === 1 ? WRONG : PROMOTED);
    }
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /post-promotion production smoke ok \(attempt 2\)/);
  assert.ok(result.requests.every((r) => r.override === undefined));
});

test("extracted promotion smoke step fails closed on empty promoted output without probing", async (t) => {
  const result = await runPromotionScript(t, serveUp(healthyUp(PROMOTED)), {
    PROMOTED_VERSION_ID: "",
  });
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /promoted-version-id missing or malformed/i);
  assert.equal(result.requests.length, 0, `requests=${result.requests.length}`);
});

for (const bad of [
  "NOT-A-UUID",
  `${PROMOTED} `,
  ` ${PROMOTED}`,
  `${PROMOTED}; echo injected`,
  "22345678-1234-1234-1234-123456789ABC",
]) {
  test(`extracted promotion smoke step fails closed on malformed promoted output ${JSON.stringify(bad)} without probing`, async (t) => {
    const result = await runPromotionScript(t, serveUp(healthyUp(PROMOTED)), {
      PROMOTED_VERSION_ID: bad,
    });
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /promoted-version-id missing or malformed/i);
    assert.equal(result.requests.length, 0, `requests=${result.requests.length}`);
  });
}

test("extracted promotion smoke step still fails when readiness is unhealthy even with the right version", async (t) => {
  const body = JSON.stringify({
    status: "healthy",
    db: "error",
    pending_migrations: 0,
    queue: { status: "unknown", warn_at: 20, critical_at: 100 },
    revision: { version_id: PROMOTED, commit: null },
  });
  const result = await runPromotionScript(t, serveUp(body));
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /FAIL \/up: expected JSON \/up db:ok/);
  assert.ok(result.requests.every((r) => r.override === undefined));
});

test("promotion runbook distinguishes target identity from healthy content", async () => {
  const runbook = await readFile(new URL("../docs/runbook.md", import.meta.url), "utf8");
  const marker = "Post-promotion smoke proves ordinary traffic identity";
  const start = runbook.indexOf(marker);
  assert.notEqual(start, -1, "post-promotion runbook section not found");
  const section = runbook.slice(start, start + 4000);
  assert.match(section, /--expected-version-id/, section);
  assert.match(section, /promoted/i, section);
  assert.match(section, /ordinary traffic/i, section);
  assert.match(section, /version-override/i, section);
  assert.match(section, /absent or malformed|missing or malformed/i, section);
  assert.match(section, /restoration target|PREV_VERSION/i, section);
  assert.match(section, /healthy/i, section);
  assert.match(section, /never adds an automatic rollback/i, section);
});
