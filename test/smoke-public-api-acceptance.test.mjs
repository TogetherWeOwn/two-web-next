import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SMOKE_SECURITY_TXT_EXPIRES, smoke } from "../bin/smoke.mjs";

// Acceptance contract: deploy smoke covers the session-free public API.
//
// bin/smoke.mjs probes HTML leaves, feeds, the sitemap, robots.txt and
// redirects, but nothing on the public read API, although
// /api/public/events and /openapi.json are anonymous by construction
// (src/public-data/routes.ts). A deploy that breaks the public envelope
// or the discovery document therefore smokes green today.
//
// Locked builder contract (this file is acceptance-owned; do not edit it
// to make an implementation pass):
// - Deploy smoke additionally probes exactly two session-free routes,
//   with no auth, no cookies and no new CLI flags:
//   - GET /api/public/events expects HTTP 200, Content-Type
//     application/json, and a collection envelope in the body: a `data`
//     array (empty or populated), numeric `page` and `limit`, and a
//     `meta` object with numeric current_page, per_page, total and
//     last_page (src/public-data/contracts.ts). An error envelope, a
//     missing or truncated envelope, non-numeric paging fields, or a
//     non-JSON body served with HTTP 200 must fail this entry.
//   - GET /openapi.json expects HTTP 200, Content-Type application/json,
//     and the OpenAPI version marker in the body. A body without the
//     marker (or not JSON at all) served with HTTP 200 must fail it.
// - No other route is added. In particular the session-gated
//   /events.json stay out of deploy smoke, as do the other public
//   endpoints (/api/public/community, /api/public/join and the
//   single-event route).
// - A broken public entry fails only its own route: every existing
//   entry keeps its current assertions and pass/fail behaviour.
// - No application code, envelope schema or workflow changes: this is a
//   probe-only addition mirroring the existing route-entry shape.
// - Wire this file into the test:smoke script in package.json, and
//   update the existing smoke selftest fixtures and route counts
//   (18 -> 20) in the builder-owned test files.
//
// Hermetic only: every probe below talks to a loopback stub. No live
// host, no workflow dispatch.

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const healthyUp = JSON.stringify({
  status: "healthy",
  db: "ok",
  pending_migrations: 0,
  queue: { status: "unknown", warn_at: 20, critical_at: 100 },
});

// Canonical serializer order (src/public-data/routes.ts
// serializeEventCollection): data, page, limit, then the meta block.
const healthyCollection = JSON.stringify({
  data: [],
  page: 1,
  limit: 20,
  meta: { current_page: 1, per_page: 20, total: 0, last_page: 1 },
});

const populatedCollection = JSON.stringify({
  data: [
    {
      event_key: "01J00000000000000000000000",
      title: "Fixture game night",
      game: null,
      description: "Brackets ] and braces } stay inside the row",
      starts_at: "2026-11-01T19:00:00.000Z",
      ends_at: "2026-11-01T22:00:00.000Z",
      starts_at_local: "2026-11-01 19:00",
      ends_at_local: "2026-11-01 22:00",
      timezone: "UTC",
      location: null,
      capacity: null,
      going_count: 3,
      status: "published",
      rsvp_open: true,
      synced_to_discord: false,
    },
  ],
  page: 1,
  limit: 20,
  meta: { current_page: 1, per_page: 20, total: 1, last_page: 1 },
});

const healthyOpenApi = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Together We Own public read API", version: "1.0.0" },
  paths: {
    "/api/public/events": { get: { responses: { 200: { description: "ok" } } } },
  },
});

const fixtures = {
  "/up": [200, "application/json", healthyUp],
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
  "/api/public/events": [200, "application/json", healthyCollection],
  "/openapi.json": [200, "application/json", healthyOpenApi],
};

const EXPECTED_PATHS = Object.keys(fixtures).sort();

async function stub(t, change = () => {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      method: request.method,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
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
        ...(type === "text/html" ? { "x-robots-tag": "noindex, nofollow" } : {}),
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

function serve(route, mutate) {
  return (path, result) => {
    if (path === route) mutate(result);
  };
}

async function run(url, options = {}) {
  const output = [];
  const ok = await smoke(url, { log: (line) => output.push(line), ...options });
  return { ok, output: output.join("\n"), lines: output };
}

function failLinesFor(lines, path) {
  return lines.filter((line) => line.startsWith(`FAIL ${path}:`));
}

function assertOnlyRouteFails(result, path) {
  assert.equal(result.ok, false, result.output);
  assert.ok(failLinesFor(result.lines, path).length >= 1, result.output);
  const otherFailures = result.lines.filter(
    (line) => line.startsWith("FAIL ") && !line.startsWith(`FAIL ${path}:`),
  );
  assert.deepEqual(otherFailures, [], result.output);
}

function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/smoke.mjs", ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

// --- Positive controls: these pass at the current base and must keep passing.

test("positive control: a healthy stub passes the existing smoke probes", async (t) => {
  const { url } = await stub(t);
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
});

test("positive control: an unhealthy /up still fails the smoke run", async (t) => {
  const body = JSON.stringify({
    status: "healthy",
    db: "error",
    pending_migrations: 0,
    queue: { status: "unknown", warn_at: 20, critical_at: 100 },
  });
  const { url } = await stub(
    t,
    serve("/up", (result) => {
      result.body = body;
    }),
  );
  const result = await run(url);
  assert.equal(result.ok, false, result.output);
  assert.ok(failLinesFor(result.lines, "/up").length >= 1, result.output);
});

test("positive control: no probe sends a cookie or authorization header, and the session-gated /events.json is never probed", async (t) => {
  const { url, requests } = await stub(t);
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.ok(requests.length > 0);
  assert.ok(
    requests.every((r) => r.cookie === undefined && r.authorization === undefined),
    JSON.stringify(requests),
  );
  assert.ok(
    requests.every((r) => r.path !== "/events.json"),
    JSON.stringify(requests),
  );
});

// --- Failing-first: the public API probes do not exist yet.

test("healthy stub: both public API entries are probed exactly once and pass, as plain anonymous GETs", async (t) => {
  const { url, requests } = await stub(t);
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /^PASS \/api\/public\/events$/m, result.output);
  assert.match(result.output, /^PASS \/openapi\.json$/m, result.output);
  assert.match(result.output, /smoke: 20 routes, 0 failed assertions/, result.output);
  // Exactly the two additions: no other public endpoint, no
  // session-gated route, no query string, no duplicate probe.
  assert.deepEqual(requests.map((r) => r.path).sort(), EXPECTED_PATHS, JSON.stringify(requests));
  for (const path of ["/api/public/events", "/openapi.json"]) {
    const hits = requests.filter((r) => r.path === path);
    assert.equal(hits.length, 1, path);
    assert.equal(hits[0].method, "GET", path);
    assert.equal(hits[0].cookie, undefined, path);
    assert.equal(hits[0].authorization, undefined, path);
  }
});

test("a populated collection envelope passes (the envelope check must not require an empty data array)", async (t) => {
  const { url, requests } = await stub(
    t,
    serve("/api/public/events", (result) => {
      result.body = populatedCollection;
    }),
  );
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /^PASS \/api\/public\/events$/m, result.output);
  assert.equal(requests.filter((r) => r.path === "/api/public/events").length, 1);
});

test("a broken public collection envelope served with HTTP 200 fails only the events entry", async (t) => {
  const brokenBodies = [
    // The public error envelope, mis-served as a success.
    JSON.stringify({ error: { code: "unavailable", message: "Event data is unavailable." } }),
    // Empty object: no envelope at all.
    "{}",
    // data is not an array.
    JSON.stringify({
      data: {},
      page: 1,
      limit: 20,
      meta: { current_page: 1, per_page: 20, total: 0, last_page: 1 },
    }),
    // Truncated envelope: paging and meta missing.
    JSON.stringify({ data: [] }),
    // Meta present but empty.
    JSON.stringify({ data: [], page: 1, limit: 20, meta: {} }),
    // Paging fields with the wrong types.
    JSON.stringify({
      data: [],
      page: "1",
      limit: 20,
      meta: { current_page: 1, per_page: 20, total: "0", last_page: 1 },
    }),
    // Not JSON at all.
    "events are temporarily unavailable",
  ];
  for (const body of brokenBodies) {
    const { url } = await stub(
      t,
      serve("/api/public/events", (result) => {
        result.body = body;
      }),
    );
    const result = await run(url);
    assertOnlyRouteFails(result, "/api/public/events");
    // The other new entry and the existing entries are untouched.
    assert.match(result.output, /^PASS \/openapi\.json$/m, `${body}\n${result.output}`);
    assert.match(result.output, /^PASS \/up$/m, `${body}\n${result.output}`);
  }
});

test("a non-200 or non-JSON events response fails only the events entry", async (t) => {
  const mutations = [
    (result) => {
      result.status = 503;
      result.body = JSON.stringify({
        error: { code: "unavailable", message: "Event data is unavailable." },
      });
    },
    (result) => {
      result.headers["content-type"] = "text/html; charset=UTF-8";
      result.headers["x-robots-tag"] = "noindex, nofollow";
    },
  ];
  for (const mutate of mutations) {
    const { url } = await stub(t, serve("/api/public/events", mutate));
    const result = await run(url);
    assertOnlyRouteFails(result, "/api/public/events");
    assert.match(result.output, /^PASS \/openapi\.json$/m, result.output);
  }
});

test("a broken discovery document served with HTTP 200 fails only the openapi entry", async (t) => {
  const brokenBodies = [
    "{}",
    JSON.stringify({ info: { title: "Together We Own public read API", version: "1.0.0" } }),
    "openapi document unavailable",
  ];
  for (const body of brokenBodies) {
    const { url } = await stub(
      t,
      serve("/openapi.json", (result) => {
        result.body = body;
      }),
    );
    const result = await run(url);
    assertOnlyRouteFails(result, "/openapi.json");
    assert.match(result.output, /^PASS \/api\/public\/events$/m, `${body}\n${result.output}`);
    assert.match(result.output, /^PASS \/up$/m, `${body}\n${result.output}`);
  }
});

test("a non-200 or non-JSON discovery response fails only the openapi entry", async (t) => {
  const mutations = [
    (result) => {
      result.status = 500;
    },
    (result) => {
      result.headers["content-type"] = "text/plain; charset=UTF-8";
    },
  ];
  for (const mutate of mutations) {
    const { url } = await stub(t, serve("/openapi.json", mutate));
    const result = await run(url);
    assertOnlyRouteFails(result, "/openapi.json");
    assert.match(result.output, /^PASS \/api\/public\/events$/m, result.output);
  }
});

// --- CLI surface the deploy workflows call (no new flags).

test("CLI passes a healthy stub and reports both new entries, with no extra flags", async (t) => {
  const { url } = await stub(t);
  const result = await cli([url]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /^PASS \/api\/public\/events$/m, result.output);
  assert.match(result.output, /^PASS \/openapi\.json$/m, result.output);
  assert.match(result.output, /smoke: 20 routes, 0 failed assertions/, result.output);
});

test("CLI exits 1 when the stub serves a broken public envelope", async (t) => {
  const { url } = await stub(
    t,
    serve("/api/public/events", (result) => {
      result.body = "{}";
    }),
  );
  const result = await cli([url]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /^FAIL \/api\/public\/events:/m, result.output);
});

// --- Wiring: the suite runs under the smoke gate.

test("this acceptance file is wired into the test:smoke script", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(
    pkg.scripts["test:smoke"],
    /test\/smoke-public-api-acceptance\.test\.mjs/,
    pkg.scripts["test:smoke"],
  );
});
