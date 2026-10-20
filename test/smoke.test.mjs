import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { build } from "esbuild";
import {
  SMOKE_QUEUE_CRITICAL_AT,
  SMOKE_QUEUE_WARN_AT,
  SMOKE_SECURITY_TXT_EXPIRES,
  securityTxtAssertions,
  smoke,
} from "../bin/smoke.mjs";

// Producer-derived security.txt body: buildSecurityTxt bundled once from
// src/security-txt.ts (same in-memory esbuild pattern as the rendering tests
// below), so the passing fixture is the exact producer output for the loopback
// origin and cannot drift from it. The loopback stub has no TLS, so like the
// real Worker on an http origin the body carries no Canonical line; the https
// Canonical path is covered by the securityTxtAssertions unit tests.
let securityTxtBuilderPromise = null;
function securityTxtBuilder() {
  securityTxtBuilderPromise ??= build({
    entryPoints: ["src/security-txt.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  }).then(
    async (bundle) =>
      (
        await import(
          `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
        )
      ).buildSecurityTxt,
  );
  return securityTxtBuilderPromise;
}

// Independent local responses matching the route contracts, not a live Worker/DB.
// The /up fixture carries the candidate revision the version-override tests
// pin (22345678-...): non-overridden probes ignore it, while overridden
// probes require revision.version_id to equal the override UUID.
const fixtures = {
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
  // RFC 9116 publication (S8): the body is rendered per request from the real
  // producer (see stub below), so the probe's Expires-pin and no-Canonical-on-
  // http assertions exercise a true positive. The pin itself stays hardcoded
  // in bin/smoke.mjs like the queue thresholds in /up above; the drift guard
  // at the bottom of this file pins SMOKE_SECURITY_TXT_EXPIRES to
  // src/security-txt.ts, so a pin change fails here first. Body is unused (the
  // stub renders the producer); status and type still drive the generic loops.
  "/.well-known/security.txt": [200, "text/plain", null],
  "/discord": [302, null, "", "https://discord.gg/fixture"],
  "/profile": [302, null, "", "/auth/discord"],
  "/admin": [302, null, "", "/auth/discord"],
  // Session-free public read API: collection envelope, one missing event
  // (404 not_found, mirroring the real handler), community snapshot, join
  // handoff, and discovery document. Bodies mirror the acceptance healthy
  // fixtures; the probe asserts each envelope shape and the OpenAPI marker,
  // not fixture contents.
  "/api/public/events": [
    200,
    "application/json",
    '{"data":[],"page":1,"limit":20,"meta":{"current_page":1,"per_page":20,"total":0,"last_page":1}}',
  ],
  // The fixed probe key exists in no database, so like the real handler
  // (src/public-data/routes.ts) the stub answers 404 not_found.
  "/api/public/events/00000000000000000000000001": [
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
  // Single-event HTML detail (GET /e/:key, src/events/routes-detail.tsx):
  // the fixed probe key exists in no database, so like the real handler's
  // notFound() the stub answers the branded missing-event page.
  "/e/00000000000000000000000001": [
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

async function stub(t, change = () => {}) {
  const requests = [];
  const buildSecurityTxt = await securityTxtBuilder();
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      method: request.method,
      cookie: request.headers.cookie,
      host: request.headers.host,
      override: request.headers["cloudflare-workers-version-overrides"],
    });
    const fixture = fixtures[request.url];
    if (!fixture) {
      response.writeHead(500).end("Unexpected request");
      return;
    }
    const [status, type, body, location] = fixture;
    // Origin-aware SEO fixtures (W16b TOG-11942): the stub advertises its own
    // origin the way the Worker advertises APP_URL, so the probe's
    // same-origin robots/sitemap assertions exercise a true positive. The
    // security.txt body is rendered from the real producer for that origin.
    const origin = `http://${request.headers.host}`;
    const resolved =
      request.url === "/.well-known/security.txt"
        ? buildSecurityTxt(origin)
        : typeof body === "function"
          ? body(origin)
          : body;
    const result = {
      status,
      body: resolved,
      headers: {
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "x-frame-options": "DENY",
        ...(type ? { "content-type": `${type}; charset=UTF-8` } : {}),
        ...(type === "text/html" ? { "x-robots-tag": "noindex, nofollow" } : {}),
        // Cutover identity (TOG-12863): the live /up answers as two-web-next
        // with no-store, so the stub advertises the same pair.
        ...(request.url === "/up"
          ? { "x-two-origin": "two-web-next", "cache-control": "no-store" }
          : {}),
        ...(location ? { location } : {}),
        "set-cookie": "fixture=not-a-session; Path=/",
      },
    };
    change(request.url, result);
    response.writeHead(result.status, result.headers);
    if (result.body === null) response.flushHeaders();
    else response.end(result.body);
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

async function run(url, options = {}) {
  const output = [];
  const ok = await smoke(url, { log: (line) => output.push(line), ...options });
  return { ok, output: output.join("\n") };
}

async function cli(args) {
  const child = spawn(process.execPath, ["bin/smoke.mjs", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const [code] = await once(child, "exit");
  return { code, output };
}

test("CLI passes every route without following redirects or carrying cookies", async (t) => {
  const { url, requests } = await stub(t);
  const result = await cli([url]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /24 routes, 0 failed assertions/);
  assert.deepEqual(
    requests.map((r) => r.path),
    Object.keys(fixtures),
  );
  assert.ok(requests.every((r) => r.method === "GET" && r.cookie === undefined));
  assert.ok(requests.every((r) => r.override === undefined));
});

test("version override pins every gradual-promotion probe to the new version", async (t) => {
  const { url, requests } = await stub(t);
  const override = 'two-web-next-production="22345678-1234-1234-1234-123456789abc"';
  const result = await cli([url, "--version-override", override]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /24 routes, 0 failed assertions/);
  assert.equal(requests.length, 24);
  assert.ok(requests.every((r) => r.override === override));
});

test("version override refuses a healthy /up that identifies another Worker version", async (t) => {
  // Ignored-override attribution: the stub answers healthy with the old
  // version while the probe pins the candidate UUID, so the checker must
  // fail even though every existing readiness assertion would pass.
  const override = 'two-web-next-production="22345678-1234-1234-1234-123456789abc"';
  const oldVersion = "11111111-2222-3333-4444-555555555555";
  const { url, requests } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body = JSON.stringify({
        status: "healthy",
        db: "ok",
        pending_migrations: 0,
        queue: { status: "unknown", warn_at: 20, critical_at: 100 },
        revision: { version_id: oldVersion, commit: null },
      });
  });
  const result = await run(url, { versionOverride: override });
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /FAIL \/up: expected revision\.version_id/);
  assert.equal(requests.length, 24);
  assert.ok(requests.every((r) => r.override === override));
});

test("version override refuses missing or malformed revision metadata", async (t) => {
  const override = 'two-web-next-production="22345678-1234-1234-1234-123456789abc"';
  const healthy = {
    status: "healthy",
    db: "ok",
    pending_migrations: 0,
    queue: { status: "unknown", warn_at: 20, critical_at: 100 },
  };
  const bodies = [
    JSON.stringify(healthy),
    JSON.stringify({ ...healthy, revision: null }),
    JSON.stringify({ ...healthy, revision: "22345678-1234-1234-1234-123456789abc" }),
    JSON.stringify({ ...healthy, revision: {} }),
    JSON.stringify({ ...healthy, revision: { version_id: null, commit: null } }),
    JSON.stringify({ ...healthy, revision: { version_id: 123, commit: null } }),
    JSON.stringify({
      ...healthy,
      revision: { version_id: "22345678-1234-1234-1234-123456789ABC", commit: null },
    }),
    JSON.stringify({ ...healthy, revision: { commit: null } }),
  ];
  for (const body of bodies) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/up") result.body = body;
    });
    const result = await run(url, { versionOverride: override });
    assert.equal(result.ok, false, body);
    assert.match(result.output, /FAIL \/up: expected revision\.version_id/, body);
  }
});

test("version override refuses the same commit served as a different version", async (t) => {
  // Commit equality is not identity: the candidate UUID must match exactly.
  const override = 'two-web-next-production="22345678-1234-1234-1234-123456789abc"';
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body = JSON.stringify({
        status: "healthy",
        db: "ok",
        pending_migrations: 0,
        queue: { status: "unknown", warn_at: 20, critical_at: 100 },
        revision: { version_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", commit },
      });
  });
  const result = await run(url, { versionOverride: override });
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /FAIL \/up: expected revision\.version_id/);
});

test("version override still requires every readiness assertion", async (t) => {
  // The candidate version answers, but unhealthy: identity alone never passes.
  const uuid = "22345678-1234-1234-1234-123456789abc";
  const override = `two-web-next-production="${uuid}"`;
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body = JSON.stringify({
        status: "healthy",
        db: "error",
        pending_migrations: 0,
        queue: { status: "unknown", warn_at: 20, critical_at: 100 },
        revision: { version_id: uuid, commit: null },
      });
  });
  const result = await run(url, { versionOverride: override });
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /FAIL \/up: expected JSON \/up db:ok/);
});

test("version override passes when the candidate version answers healthy", async (t) => {
  const uuid = "22345678-1234-1234-1234-123456789abc";
  const override = `two-web-next-production="${uuid}"`;
  const { url, requests } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body = JSON.stringify({
        status: "healthy",
        db: "ok",
        pending_migrations: 0,
        queue: { status: "unknown", warn_at: 20, critical_at: 100 },
        revision: { version_id: uuid, commit: null },
      });
  });
  const result = await run(url, { versionOverride: override });
  assert.equal(result.ok, true, result.output);
  assert.ok(result.output.includes("PASS /up"), result.output);
  assert.equal(requests.length, 24);
  assert.ok(requests.every((r) => r.override === override));
});

test("CLI refuses a malformed version override without probing", async (t) => {
  const { url, requests } = await stub(t);
  for (const bad of ['two-web-next-production="NOT-A-UUID"', "no-quotes", ""]) {
    const result = await cli([url, "--version-override", bad]);
    assert.equal(result.code, 2, bad);
    assert.match(result.output, /version-override/);
  }
  assert.equal(requests.length, 0);
});

test("CLI refuses a present version override without a value", async (t) => {
  const { url, requests } = await stub(t);
  const valid = 'two-web-next-production="22345678-1234-1234-1234-123456789abc"';
  for (const args of [
    [url, "--version-override"],
    [url, "--version-override", valid, "--version-override"],
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 2, `${JSON.stringify(args)}: ${result.output}`);
    assert.match(result.output, /version-override/);
  }
  assert.equal(requests.length, 0);
});

for (const path of Object.keys(fixtures)) {
  test(`rejects wrong status on ${path} and continues through remaining routes`, async (t) => {
    const { url, requests } = await stub(t, (route, result) => {
      if (route === path) result.status = 503;
    });
    const result = await run(url);
    assert.equal(result.ok, false);
    assert.ok(result.output.includes(`FAIL ${path}: expected HTTP`), result.output);
    assert.match(result.output, /actual HTTP 503/);
    assert.equal(requests.length, 24);
  });
}

for (const [header, path, expected] of [
  ["content-security-policy", "/events.rss", "nonempty Content-Security-Policy"],
  ["x-content-type-options", "/discord", "X-Content-Type-Options nosniff"],
  // The static security headers apply to every response, not only HTML:
  // one non-HTML route and one HTML route pin the unconditional scope.
  ["referrer-policy", "/events.rss", "Referrer-Policy strict-origin-when-cross-origin"],
  ["x-frame-options", "/about", "X-Frame-Options DENY"],
  ["x-robots-tag", "/about", "staging X-Robots-Tag noindex/none (unscoped)"],
  ["x-robots-tag", "/__smoke_unknown_route__", "staging X-Robots-Tag noindex/none (unscoped)"],
]) {
  test(`rejects missing ${header} on ${path}`, async (t) => {
    const { url } = await stub(t, (route, result) => {
      if (route === path) delete result.headers[header];
    });
    const result = await run(url);
    assert.equal(result.ok, false);
    assert.ok(
      result.output.includes(`FAIL ${path}: expected ${expected}; actual missing`),
      result.output,
    );
  });
}

for (const [header, path, wrong, expected] of [
  ["referrer-policy", "/about", "unsafe-url", "Referrer-Policy strict-origin-when-cross-origin"],
  // SAMEORIGIN is the wrong value, not an acceptable spelling of DENY; the
  // redirect response pins the check outside HTML routes like nosniff above.
  ["x-frame-options", "/discord", "SAMEORIGIN", "X-Frame-Options DENY"],
]) {
  test(`rejects wrong ${header} on ${path}`, async (t) => {
    const { url } = await stub(t, (route, result) => {
      if (route === path) result.headers[header] = wrong;
    });
    const result = await run(url);
    assert.equal(result.ok, false);
    assert.ok(
      result.output.includes(`FAIL ${path}: expected ${expected}; actual ${wrong}`),
      result.output,
    );
  });
}

for (const path of Object.keys(fixtures).filter((path) => fixtures[path][1])) {
  test(`rejects a fallback body on ${path}`, async (t) => {
    const { url } = await stub(t, (route, result) => {
      if (route === path) result.body = "upstream fallback";
    });
    const result = await run(url);
    assert.equal(result.ok, false);
    assert.ok(result.output.includes(`FAIL ${path}: expected`), result.output);
    assert.ok(!result.output.includes("upstream fallback"));
  });
}

test("a broken single-event error envelope served with HTTP 404 fails only that entry", async (t) => {
  const brokenBodies = [
    // A success envelope where the missing-event error belongs.
    JSON.stringify({
      event_key: "00000000000000000000000001",
      title: "Fixture game night",
      status: "published",
      rsvp_open: true,
      synced_to_discord: false,
      going_count: 3,
    }),
    // Empty object: no envelope at all.
    "{}",
    // A collection array instead of the error object.
    "[]",
    // Wrong error code.
    JSON.stringify({ error: { code: "unavailable", message: "Event data is unavailable." } }),
    // Missing message.
    JSON.stringify({ error: { code: "not_found" } }),
    // Empty message.
    JSON.stringify({ error: { code: "not_found", message: "" } }),
    // Not JSON at all.
    "event is temporarily unavailable",
  ];
  for (const body of brokenBodies) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/api/public/events/00000000000000000000000001") result.body = body;
    });
    const result = await run(url);
    assert.equal(result.ok, false, body);
    assert.ok(
      result.output.includes("FAIL /api/public/events/00000000000000000000000001: expected"),
      result.output,
    );
    assert.match(result.output, /^PASS \/api\/public\/events$/m, `${body}\n${result.output}`);
    assert.match(result.output, /^PASS \/api\/public\/community$/m, `${body}\n${result.output}`);
    assert.match(result.output, /^PASS \/api\/public\/join$/m, `${body}\n${result.output}`);
  }
});

test("a broken single-event HTML detail fails only that entry", async (t) => {
  // GET /e/:key (src/events/routes-detail.tsx) must answer the branded
  // missing-event page for the fixed probe key: a success body, the JSON
  // error envelope, an unbranded page, a wrong status, or a wrong
  // Content-Type fails this entry only while the neighbouring HTML and
  // JSON probes keep passing.
  const broken = [
    ["<h1>Fixture game night</h1>", 200],
    ['{"error":{"code":"not_found","message":"No published event with that key."}}', 404],
    ["<h1>Something went wrong</h1>", 404],
    ["<title>We cannot find that page — Together We Own</title>", 200],
    // Branded body with the right status but the wrong Content-Type: pins
    // the probe's type: "text/html" assertion (bin/smoke.mjs), which no
    // body/status mutation exercises.
    [
      "<title>We cannot find that page — Together We Own</title>",
      404,
      "application/json",
      "expected Content-Type text/html",
    ],
  ];
  for (const [body, status, contentType, expectedFragment] of broken) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/e/00000000000000000000000001") {
        result.body = body;
        result.status = status;
        if (contentType) result.headers["content-type"] = `${contentType}; charset=UTF-8`;
      }
    });
    const result = await run(url);
    assert.equal(result.ok, false, body);
    assert.ok(
      result.output.includes("FAIL /e/00000000000000000000000001: expected"),
      `${body}\n${result.output}`,
    );
    if (expectedFragment) {
      assert.ok(
        result.output.includes(`FAIL /e/00000000000000000000000001: ${expectedFragment}`),
        `${body}\n${result.output}`,
      );
    }
    assert.match(result.output, /^PASS \/events$/m, `${body}\n${result.output}`);
    assert.match(
      result.output,
      /^PASS \/api\/public\/events\/00000000000000000000000001$/m,
      `${body}\n${result.output}`,
    );
    assert.match(result.output, /^PASS \/__smoke_unknown_route__$/m, `${body}\n${result.output}`);
  }
});

test("a broken community snapshot served with HTTP 200 fails only that entry", async (t) => {
  const brokenBodies = [
    // The public error envelope, mis-served as a success.
    JSON.stringify({ error: { code: "unavailable", message: "Event data is unavailable." } }),
    // Empty object: no envelope at all.
    "{}",
    // Ranks is not an array.
    JSON.stringify({ member_count: 123, online_count: 12, ranks: {} }),
    // Counts with the wrong types (unknown must read as null, never "0").
    JSON.stringify({ member_count: "123", online_count: 12, ranks: [] }),
    // Rank row missing its member_count.
    JSON.stringify({
      member_count: 123,
      online_count: 12,
      ranks: [{ key: "veterans", label: "Veterans" }],
    }),
    // Not JSON at all.
    "community snapshot unavailable",
  ];
  for (const body of brokenBodies) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/api/public/community") result.body = body;
    });
    const result = await run(url);
    assert.equal(result.ok, false, body);
    assert.ok(result.output.includes("FAIL /api/public/community: expected"), result.output);
    assert.match(result.output, /^PASS \/api\/public\/join$/m, `${body}\n${result.output}`);
    assert.match(result.output, /^PASS \/openapi\.json$/m, `${body}\n${result.output}`);
  }
});

test("a broken join handoff served with HTTP 200 fails only that entry", async (t) => {
  const brokenBodies = [
    // The public error envelope, mis-served as a success.
    JSON.stringify({ error: { code: "rate_limited", message: "Too many requests." } }),
    // Empty object: no envelope at all.
    "{}",
    // Missing invite.
    JSON.stringify({ intro: "Approve once with Discord and we will add you to the server." }),
    // Non-HTTPS invite.
    JSON.stringify({
      intro: "Approve once with Discord and we will add you to the server.",
      invite_url: "http://discord.gg/fixture",
    }),
    // Not JSON at all.
    "join handoff unavailable",
  ];
  for (const body of brokenBodies) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/api/public/join") result.body = body;
    });
    const result = await run(url);
    assert.equal(result.ok, false, body);
    assert.ok(result.output.includes("FAIL /api/public/join: expected"), result.output);
    assert.match(result.output, /^PASS \/api\/public\/community$/m, `${body}\n${result.output}`);
    assert.match(result.output, /^PASS \/openapi\.json$/m, `${body}\n${result.output}`);
  }
});

test("null community counts pass (collectors down reads as unknown, never 0)", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/api/public/community")
      result.body = '{"member_count":null,"online_count":null,"ranks":[]}';
  });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /^PASS \/api\/public\/community$/m, result.output);
});

test("rejects a foreign robots Sitemap host without leaking the body", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/robots.txt")
      result.body =
        "User-agent: *\nDisallow:\nSitemap: https://togetherweown.com/sitemap_index.xml\n";
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL \/robots\.txt: expected robots Sitemap: .*sitemap_index\.xml; actual Sitemap line missing or foreign/,
  );
  assert.doesNotMatch(result.output, /togetherweown\.com/);
});

test("rejects a comment-only robots Sitemap line", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/robots.txt") result.body = result.body.replace("Sitemap:", "# Sitemap:");
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL \/robots\.txt: expected robots Sitemap: .*sitemap_index\.xml; actual Sitemap line missing or foreign/,
  );
});

test("rejects a split-line robots Sitemap directive", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/robots.txt") result.body = result.body.replace("Sitemap:", "Sitemap:\n");
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL \/robots\.txt: expected robots Sitemap: .*sitemap_index\.xml; actual Sitemap line missing or foreign/,
  );
});

test("rejects a split-line robots Sitemap directive with a comment before the URL", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/robots.txt") result.body = result.body.replace("Sitemap:", "Sitemap: # note\n");
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL \/robots\.txt: expected robots Sitemap: .*sitemap_index\.xml; actual Sitemap line missing or foreign/,
  );
});

// Comment parity with the cutover robots gate: comments are stripped
// before the anchored Sitemap match, so a trailing comment after a real
// same-origin Sitemap line stays a pass, never a failure.
test("passes a same-origin robots Sitemap line with a trailing comment", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/robots.txt")
      result.body = result.body.replace(
        "/sitemap_index.xml\n",
        "/sitemap_index.xml # this environment\n",
      );
  });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
});

test("rejects foreign sitemap locs and an empty sitemap", async (t) => {
  for (const [body, expected] of [
    [
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://togetherweown.com/</loc></url></urlset>',
      "same-origin sitemap locs",
    ],
    [
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
      "at least one sitemap <loc>",
    ],
  ]) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/sitemap_index.xml") result.body = body;
    });
    const result = await run(url);
    assert.equal(result.ok, false, body);
    assert.ok(
      result.output.includes(`FAIL /sitemap_index.xml: expected ${expected}`),
      result.output,
    );
    assert.doesNotMatch(result.output, /togetherweown\.com/);
  }
});

test("rejects a stale security.txt Expires pin without leaking the body", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/.well-known/security.txt")
      result.body = result.body.replace(
        `Expires: ${SMOKE_SECURITY_TXT_EXPIRES}`,
        "Expires: 2026-10-01T00:00:00Z",
      );
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.ok(
    result.output.includes(
      `FAIL /.well-known/security.txt: expected security Expires: ${SMOKE_SECURITY_TXT_EXPIRES}; actual Expires line missing or stale`,
    ),
    result.output,
  );
  assert.doesNotMatch(result.output, /2026-10-01T00:00:00Z/);
});

test("rejects a Canonical line on http origins, where the producer omits it", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/.well-known/security.txt")
      result.body += "Canonical: https://togetherweown.com/.well-known/security.txt\n";
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL \/.well-known\/security\.txt: expected security no Canonical on http origin; actual unexpected Canonical line/,
  );
  assert.doesNotMatch(result.output, /togetherweown\.com/);
});

test("security.txt assertions parse fields on both protocols", () => {
  const contact = "Contact: https://github.com/TogetherWeOwn/two-web-next/security/advisories/new";
  const policy = "Policy: https://github.com/TogetherWeOwn/two-web-next/blob/main/SECURITY.md";
  const https = new URL("https://example.test");
  const http = new URL("http://127.0.0.1:9");
  const httpsBody = [
    contact,
    `Expires: ${SMOKE_SECURITY_TXT_EXPIRES}`,
    "Preferred-Languages: en",
    "Canonical: https://example.test/.well-known/security.txt",
    policy,
    "",
  ].join("\n");
  const httpBody = [
    contact,
    `Expires: ${SMOKE_SECURITY_TXT_EXPIRES}`,
    "Preferred-Languages: en",
    policy,
    "",
  ].join("\n");
  // Exact producer output passes on both protocols.
  assert.deepEqual(securityTxtAssertions(httpsBody, https), []);
  assert.deepEqual(securityTxtAssertions(httpBody, http), []);
  // A commented-out correct line cannot satisfy a missing or stale field.
  assert.equal(
    securityTxtAssertions(
      `# Expires: ${SMOKE_SECURITY_TXT_EXPIRES}\nExpires: 2026-10-01T00:00:00Z\nCanonical: https://example.test/.well-known/security.txt\n`,
      https,
    ).length,
    1,
  );
  assert.equal(
    securityTxtAssertions(
      `${httpsBody}\n# Canonical: https://example.test/.well-known/security.txt\nCanonical: https://other.test/.well-known/security.txt\n`,
      https,
    ).length,
    1,
  );
  // RFC 9116 permits only one Expires field; a duplicate fails even when one
  // value matches the pin.
  assert.equal(
    securityTxtAssertions(`${httpsBody}Expires: ${SMOKE_SECURITY_TXT_EXPIRES}\n`, https).length,
    1,
  );
  // A previous reviewed pin passes when listed, and fails when it is not.
  const rotated = httpsBody.replace(
    `Expires: ${SMOKE_SECURITY_TXT_EXPIRES}`,
    "Expires: 2026-10-01T00:00:00Z",
  );
  assert.deepEqual(securityTxtAssertions(rotated, https, ["2026-10-01T00:00:00Z"]), []);
  assert.equal(securityTxtAssertions(rotated, https).length, 1);
  // https requires the same-origin Canonical; http rejects any Canonical.
  assert.equal(
    securityTxtAssertions(
      httpsBody.replace(
        "Canonical: https://example.test/.well-known/security.txt",
        "Canonical: https://other.test/.well-known/security.txt",
      ),
      https,
    ).length,
    1,
  );
  assert.equal(
    securityTxtAssertions(
      httpBody.replace(
        "Policy:",
        "Canonical: http://127.0.0.1:9/.well-known/security.txt\nPolicy:",
      ),
      http,
    ).length,
    1,
  );
});

test("security.txt passes in both indexing modes", async (t) => {
  for (const allowIndexable of [false, true]) {
    const { url } = await stub(t, (route, result) => {
      // Apex posture for the indexable run: strip the staging noindex from
      // indexable HTML leaves; the archive and branded 404 keep theirs.
      // security.txt is text/plain, so neither mode touches its headers.
      if (
        allowIndexable &&
        (route === "/events/past" ||
          route === "/e/00000000000000000000000001" ||
          route === "/__smoke_unknown_route__")
      )
        return;
      if (allowIndexable && result.headers["content-type"]?.startsWith("text/html"))
        delete result.headers["x-robots-tag"];
    });
    const result = await run(url, { allowIndexable });
    assert.equal(result.ok, true, `allowIndexable=${allowIndexable}: ${result.output}`);
    // The security.txt route itself passes in both modes: a failure here
    // would name it explicitly.
    assert.ok(
      result.output.includes("PASS /.well-known/security.txt"),
      `allowIndexable=${allowIndexable}: ${result.output}`,
    );
  }
});

test("rules accepts rendered Rules but rejects rendered Home with the shared footer", async (t) => {
  // In-memory rendering uses local components only: https://esbuild.github.io/api/#write
  const bundle = await build({
    entryPoints: ["src/pages.tsx"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const { Home, Rules } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const home = Home({
    session: null,
    notice: null,
    inviteUrl: "https://discord.gg/fixture",
    appUrl: "https://example.test",
    counts: { memberCount: null, onlineCount: null, ranks: [] },
    upcomingEvents: [],
    eventsUnavailable: false,
    featured: [],
  }).toString();
  const rules = Rules({ appUrl: "https://example.test", lastUpdated: null }).toString();
  assert.match(home, /<a href="\/rules">House rules<\/a>/);
  assert.match(rules, /id="rules-heading"/);
  for (const [body, expected] of [
    [home, false],
    [rules, true],
  ]) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/rules") result.body = body;
    });
    const result = await run(url);
    assert.equal(result.ok, expected, result.output);
    if (!expected) {
      assert.match(
        result.output,
        /FAIL \/rules: expected body matching .*rules-heading.*; actual body did not match/,
      );
      assert.ok(!result.output.includes("PASS /rules"), result.output);
    }
  }
});

test("join accepts rendered Join but rejects rendered Home with the shared footer", async (t) => {
  // In-memory rendering uses local components only: https://esbuild.github.io/api/#write
  const bundle = await build({
    entryPoints: ["src/pages.tsx"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const { Home, Join } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const home = Home({
    session: null,
    notice: null,
    inviteUrl: "https://discord.gg/fixture",
    appUrl: "https://example.test",
    counts: { memberCount: null, onlineCount: null, ranks: [] },
    upcomingEvents: [],
    eventsUnavailable: false,
    featured: [],
  }).toString();
  const join = Join({
    inviteUrl: "https://discord.gg/fixture",
    widgetUrl: null,
    next: null,
    appUrl: "https://example.test",
    joinResult: null,
  }).toString();
  assert.match(join, /One click with Discord/);
  assert.doesNotMatch(home, /One click with Discord/);
  for (const [body, expected] of [
    [home, false],
    [join, true],
  ]) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/join") result.body = body;
    });
    const result = await run(url);
    assert.equal(result.ok, expected, result.output);
    if (!expected) {
      assert.match(
        result.output,
        /FAIL \/join: expected body matching .*One click with Discord.*; actual body did not match/,
      );
      assert.ok(!result.output.includes("PASS /join"), result.output);
    }
  }
});

test("past events accepts rendered Archive but rejects rendered Upcoming with archive navigation", async (t) => {
  const bundle = await build({
    entryPoints: ["src/events/pages.tsx"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const { EventsCalendarPage, PastEventsPage } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const upcoming = EventsCalendarPage({
    state: { view: "list", month: "2026-10", q: "", past: false },
    upcoming: [],
    past: [],
    zone: "UTC",
    now: new Date("2026-10-01T00:00:00Z"),
    emptyState: "never",
    discordFailed: false,
    member: false,
    inviteUrl: "https://discord.gg/fixture",
    appUrl: "https://example.test",
  }).toString();
  const archive = PastEventsPage({
    rows: [],
    page: 1,
    hasMore: false,
    totalPages: 0,
    appUrl: "https://example.test",
  }).toString();
  assert.match(upcoming, /Past events/);
  assert.doesNotMatch(upcoming, /id="past-events-heading"/);
  assert.match(archive, /id="past-events-heading"/);
  for (const [body, expected] of [
    [upcoming, false],
    [archive, true],
  ]) {
    const { url, requests } = await stub(t, (route, result) => {
      if (route === "/events/past") result.body = body;
    });
    const result = await run(url);
    assert.equal(result.ok, expected, result.output);
    assert.equal(requests.length, 24);
    if (!expected) {
      assert.match(
        result.output,
        /FAIL \/events\/past: expected body matching .*past-events-heading.*; actual body did not match/,
      );
      assert.ok(!result.output.includes("PASS /events/past"), result.output);
    }
  }
});

test("accepts rendered healthy, degraded, unknown and unconfigured /up envelopes", async (t) => {
  const bundle = await build({
    entryPoints: ["src/up.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const { upBody } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  // Critical ready-wait is fail-closed only with failOnReadyWaitCritical
  // (S6, staging deploy only) and covered below; every other rendered
  // severity passes.
  for (const state of ["healthy", "warning", "degraded", "unknown", "unconfigured"]) {
    const body = await upBody(
      state === "unconfigured"
        ? null
        : async () => {
            if (state === "unknown") throw new Error("fixture outage");
            const pending = state === "degraded" ? 20 : 0;
            return {
              pending,
              delayed: 0,
              reserved: 0,
              total: pending,
              failed: 0,
              oldestPendingAgeSeconds: null,
              oldestReadyWaitAgeSeconds: state === "warning" ? 300.1 : null,
            };
          },
    );
    // The envelope's queue slice comes from the real renderer; DB readiness fields are set explicitly.
    const ready = { ...body, db: "ok", pending_migrations: 0 };
    const expectedSeverity = ["unknown", "unconfigured"].includes(state)
      ? "unknown"
      : state === "warning"
        ? state
        : "healthy";
    assert.equal(ready.queue.ready_wait_severity, expectedSeverity);
    assert.ok(Object.hasOwn(ready.queue, "oldest_ready_wait_age_seconds"));
    const { url } = await stub(t, (route, result) => {
      if (route === "/up") result.body = JSON.stringify(ready);
    });
    const result = await run(url);
    assert.equal(result.ok, true, `${state}: ${result.output}`);
  }
});

test("fails closed on critical ready-wait severity with the age in the output", async (t) => {
  const bundle = await build({
    entryPoints: ["src/up.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const { upBody } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const body = await upBody(async () => ({
    pending: 1,
    delayed: 0,
    reserved: 0,
    total: 1,
    failed: 0,
    oldestPendingAgeSeconds: null,
    oldestReadyWaitAgeSeconds: 612000,
  }));
  const ready = { ...body, db: "ok", pending_migrations: 0 };
  assert.equal(ready.queue.ready_wait_severity, "critical");
  assert.equal(ready.queue.oldest_ready_wait_age_seconds, 612000);
  const { url } = await stub(t, (route, result) => {
    if (route === "/up") result.body = JSON.stringify(ready);
  });
  const result = await run(url, { failOnReadyWaitCritical: true });
  assert.equal(result.ok, false, result.output);
  assert.match(
    result.output,
    /FAIL \/up: expected ready_wait_severity not critical; actual critical \(oldest_ready_wait_age_seconds: 612000\)/,
  );
});

test("critical ready-wait without an age still fails closed without leaking the body", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"healthy","warn_at":20,"critical_at":100,"ready_wait_severity":"critical","oldest_ready_wait_age_seconds":null}}';
  });
  const result = await run(url, { failOnReadyWaitCritical: true });
  assert.equal(result.ok, false, result.output);
  assert.match(
    result.output,
    /FAIL \/up: expected ready_wait_severity not critical; actual critical \(oldest_ready_wait_age_seconds: unknown\)/,
  );
});

test("without the ready-wait flag a critical envelope warns and passes (production/rollback posture)", async (t) => {
  // Production promote (gradual-promote --version-override stages) and
  // post-rollback smoke omit --fail-on-ready-wait-critical: the age reflects
  // shared queue_jobs state, not the version under test, so a stuck queue
  // must not block its own fix. Flag-less invocation warns and passes.
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"healthy","warn_at":20,"critical_at":100,"ready_wait_severity":"critical","oldest_ready_wait_age_seconds":612000}}';
  });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.match(
    result.output,
    /WARN \/up: ready_wait_severity critical \(oldest_ready_wait_age_seconds: 612000\)/,
  );
  assert.ok(result.output.includes("PASS /up"), result.output);
});

test("CLI --fail-on-ready-wait-critical gates staging while the flag-less CLI passes", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"healthy","warn_at":20,"critical_at":100,"ready_wait_severity":"critical","oldest_ready_wait_age_seconds":612000}}';
  });
  const gated = await cli([url, "--fail-on-ready-wait-critical"]);
  assert.equal(gated.code, 1, gated.output);
  assert.match(
    gated.output,
    /FAIL \/up: expected ready_wait_severity not critical; actual critical \(oldest_ready_wait_age_seconds: 612000\)/,
  );
  const ungated = await cli([url]);
  assert.equal(ungated.code, 0, ungated.output);
  assert.match(
    ungated.output,
    /WARN \/up: ready_wait_severity critical \(oldest_ready_wait_age_seconds: 612000\)/,
  );
});

// Acceptance: a blind queue-observability path must not pass the staging
// fail-closed gate. /up itself is unchanged (unknown stays HTTP 200 /
// healthy at the route); only the staging smoke verdict changes, and only
// with failOnReadyWaitCritical. Without the flag the legacy pass is kept
// so production/rollback smokes can still ship a fix for a blind queue.
test("fails closed on rendered unknown queue/readiness with the staging flag; flag-less passes", async (t) => {
  const bundle = await build({
    entryPoints: ["src/up.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const { upBody } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const unknownQueue = {
    status: "unknown",
    pending: null,
    delayed: null,
    reserved: null,
    total: null,
    failed: null,
    oldest_pending_age_seconds: null,
    oldest_ready_wait_age_seconds: null,
    ready_wait_severity: "unknown",
    warn_at: 20,
    critical_at: 100,
    detail: null,
  };
  // Throwing measureQueue (broken observability) and unconfigured ledger
  // (null) are the two real producers of the unknown envelope.
  const measureQueue = async () => {
    throw new Error("fixture outage");
  };
  for (const [state, measure, detail] of [
    ["throwing measureQueue", measureQueue, null],
    ["unconfigured", null, "queue ledger is not configured."],
  ]) {
    const body = await upBody(measure);
    const ready = { ...body, db: "ok", pending_migrations: 0 };
    // /up payload unchanged: queue slice is exactly the unknown envelope.
    assert.deepEqual(ready.queue, { ...unknownQueue, detail }, state);
    assert.equal(ready.queue.status, "unknown", state);
    assert.equal(ready.queue.ready_wait_severity, "unknown", state);
    const { url } = await stub(t, (route, result) => {
      if (route === "/up") result.body = JSON.stringify(ready);
    });
    const gated = await run(url, { failOnReadyWaitCritical: true });
    assert.equal(gated.ok, false, `${state}: ${gated.output}`);
    assert.match(gated.output, /FAIL \/up:[^\n]*unknown/, state);
    assert.ok(!gated.output.includes("PASS /up"), `${state}: ${gated.output}`);
    const ungated = await run(url);
    assert.equal(ungated.ok, true, `${state}: ${ungated.output}`);
    assert.ok(ungated.output.includes("PASS /up"), `${state}: ${ungated.output}`);
  }
});

test("staging flag fails closed when either queue.status or ready_wait_severity alone is unknown", async (t) => {
  // The smoke consumes JSON, not the renderer, so each readiness field is
  // gated independently: either one reporting unknown (including an older
  // envelope with no severity field at all) is a blind queue.
  const base = { status: "healthy", db: "ok", pending_migrations: 0 };
  const cases = [
    [
      "queue.status unknown, severity healthy",
      {
        status: "unknown",
        warn_at: 20,
        critical_at: 100,
        ready_wait_severity: "healthy",
        oldest_ready_wait_age_seconds: null,
      },
    ],
    ["queue.status unknown, severity absent", { status: "unknown", warn_at: 20, critical_at: 100 }],
    [
      "queue.status healthy, severity unknown",
      {
        status: "healthy",
        warn_at: 20,
        critical_at: 100,
        ready_wait_severity: "unknown",
        oldest_ready_wait_age_seconds: null,
      },
    ],
    [
      "queue.status degraded, severity unknown",
      {
        status: "degraded",
        warn_at: 20,
        critical_at: 100,
        ready_wait_severity: "unknown",
        oldest_ready_wait_age_seconds: null,
      },
    ],
  ];
  for (const [state, queue] of cases) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/up") result.body = JSON.stringify({ ...base, queue });
    });
    const gated = await run(url, { failOnReadyWaitCritical: true });
    assert.equal(gated.ok, false, `${state}: ${gated.output}`);
    assert.match(gated.output, /FAIL \/up:[^\n]*unknown/, state);
    assert.ok(!gated.output.includes("PASS /up"), `${state}: ${gated.output}`);
    const ungated = await run(url);
    assert.equal(ungated.ok, true, `${state}: ${ungated.output}`);
    assert.ok(ungated.output.includes("PASS /up"), `${state}: ${ungated.output}`);
  }
});

test("healthy, warning and degraded rendered envelopes still pass with the staging flag", async (t) => {
  const bundle = await build({
    entryPoints: ["src/up.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const { upBody } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  for (const state of ["healthy", "warning", "degraded"]) {
    const body = await upBody(async () => {
      const pending = state === "degraded" ? 20 : 0;
      return {
        pending,
        delayed: 0,
        reserved: 0,
        total: pending,
        failed: 0,
        oldestPendingAgeSeconds: null,
        oldestReadyWaitAgeSeconds: state === "warning" ? 300.1 : null,
      };
    });
    const ready = { ...body, db: "ok", pending_migrations: 0 };
    assert.notEqual(ready.queue.status, "unknown", state);
    assert.notEqual(ready.queue.ready_wait_severity, "unknown", state);
    const { url } = await stub(t, (route, result) => {
      if (route === "/up") result.body = JSON.stringify(ready);
    });
    const gated = await run(url, { failOnReadyWaitCritical: true });
    assert.equal(gated.ok, true, `${state}: ${gated.output}`);
    assert.ok(gated.output.includes("PASS /up"), `${state}: ${gated.output}`);
  }
});

test("CLI --fail-on-ready-wait-critical fails an unknown queue envelope while the flag-less CLI passes", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"unknown","pending":null,"delayed":null,"reserved":null,"total":null,"failed":null,"oldest_pending_age_seconds":null,"oldest_ready_wait_age_seconds":null,"ready_wait_severity":"unknown","warn_at":20,"critical_at":100,"detail":null}}';
  });
  const gated = await cli([url, "--fail-on-ready-wait-critical"]);
  assert.equal(gated.code, 1, gated.output);
  assert.match(gated.output, /FAIL \/up:[^\n]*unknown/);
  const ungated = await cli([url]);
  assert.equal(ungated.code, 0, ungated.output);
  assert.ok(ungated.output.includes("PASS /up"), ungated.output);
});

// Acceptance: with the staging flag, ready_wait_severity admits only the
// documented passing strings (healthy / warning; src/up-queue.ts
// ReadyWaitSeverity, docs/runbook.md). Every other field in these fixtures
// is valid, and the positive controls below change nothing but the
// severity, so a failure here can only come from the severity contract.
// Absent, null, wrong-type and unrecognized severities fail closed on
// either a healthy or a degraded queue.status; without the flag the
// legacy production/rollback pass is preserved. Diagnostics must stay
// fixed safe metadata: a severity drawn from the response body (the
// sentinel strings) must never appear in the output.
test("staging flag fails closed on absent or malformed ready_wait_severity with an otherwise-valid queue", async (t) => {
  const stringSentinel = "malformedseveritysentinel9x7";
  const objectSentinel = "objectseveritysentinel9x7";
  const severities = [
    ["absent", undefined, null],
    ["null", null, null],
    ["numeric", 42, null],
    ["boolean", true, null],
    ["object", { probe: objectSentinel }, objectSentinel],
    ["array", ["healthy"], null],
    ["misspelled", `healty-${stringSentinel}`, stringSentinel],
    ["empty string", "", null],
    ["uppercase", "HEALTHY", null],
  ];
  for (const queueStatus of ["healthy", "degraded"]) {
    for (const [label, severity, sentinel] of severities) {
      const state = `queue.status ${queueStatus}, severity ${label}`;
      const queue = {
        status: queueStatus,
        failed: 0,
        warn_at: 20,
        critical_at: 100,
        oldest_ready_wait_age_seconds: null,
      };
      if (label !== "absent") queue.ready_wait_severity = severity;
      assert.equal(Object.hasOwn(queue, "ready_wait_severity"), label !== "absent", state);
      const body = JSON.stringify({
        status: queueStatus,
        db: "ok",
        pending_migrations: 0,
        queue,
      });
      const { url } = await stub(t, (route, result) => {
        if (route === "/up") result.body = body;
      });
      const gated = await run(url, { failOnReadyWaitCritical: true });
      assert.equal(gated.ok, false, `${state}: ${gated.output}`);
      assert.match(gated.output, /FAIL \/up:/, state);
      assert.ok(!gated.output.includes("PASS /up"), `${state}: ${gated.output}`);
      if (sentinel !== null) {
        assert.ok(!gated.output.includes(sentinel), `${state}: diagnostic leaked the body value`);
      }
      const ungated = await run(url);
      assert.equal(ungated.ok, true, `${state} flag-less: ${ungated.output}`);
      assert.ok(ungated.output.includes("PASS /up"), `${state} flag-less: ${ungated.output}`);
    }
  }
});

test("staging flag admits only healthy/warning severities on an otherwise-valid queue", async (t) => {
  // Paired controls on the exact fixture shape above: healthy and warning
  // pass with the flag on either queue.status, and the literal
  // critical/unknown refusals are retained (their exact diagnostics are
  // pinned by the earlier tests).
  const controls = [
    ["healthy", null, true],
    ["warning", 301, true],
    ["critical", 612000, false],
    ["unknown", null, false],
  ];
  for (const queueStatus of ["healthy", "degraded"]) {
    for (const [severity, readyAge, shouldPass] of controls) {
      const state = `queue.status ${queueStatus}, severity ${severity}`;
      const { url } = await stub(t, (route, result) => {
        if (route === "/up")
          result.body = JSON.stringify({
            status: queueStatus,
            db: "ok",
            pending_migrations: 0,
            queue: {
              status: queueStatus,
              failed: 0,
              warn_at: 20,
              critical_at: 100,
              ready_wait_severity: severity,
              oldest_ready_wait_age_seconds: readyAge,
            },
          });
      });
      const gated = await run(url, { failOnReadyWaitCritical: true });
      assert.equal(gated.ok, shouldPass, `${state}: ${gated.output}`);
      if (shouldPass) {
        assert.ok(gated.output.includes("PASS /up"), `${state}: ${gated.output}`);
      } else {
        assert.match(gated.output, /FAIL \/up:/, state);
        assert.ok(!gated.output.includes("PASS /up"), `${state}: ${gated.output}`);
      }
    }
  }
});

test("CLI --fail-on-ready-wait-critical fails an absent-severity envelope while the flag-less CLI passes", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"healthy","failed":0,"warn_at":20,"critical_at":100,"oldest_ready_wait_age_seconds":null}}';
  });
  const gated = await cli([url, "--fail-on-ready-wait-critical"]);
  assert.equal(gated.code, 1, gated.output);
  assert.match(gated.output, /FAIL \/up:/);
  const ungated = await cli([url]);
  assert.equal(ungated.code, 0, ungated.output);
  assert.ok(ungated.output.includes("PASS /up"), ungated.output);
});

test("smoke queue thresholds track src/up.ts QUEUE_WARN_AT / QUEUE_CRITICAL_AT", async () => {
  // Drift guard: bin/smoke.mjs runs on plain node with no TS loader, so its
  // expected warn_at/critical_at are duplicated from src/up-queue.ts
  // (re-exported by src/up.ts) and pinned here. A threshold change in src
  // fails this test at PR time (npm run test:smoke is in the required check
  // job); update SMOKE_QUEUE_* in bin/smoke.mjs to match.
  const bundle = await build({
    entryPoints: ["src/up.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const { QUEUE_WARN_AT, QUEUE_CRITICAL_AT } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  assert.equal(
    SMOKE_QUEUE_WARN_AT,
    QUEUE_WARN_AT,
    `smoke queue warn_at drifted from src/up.ts: smoke=${SMOKE_QUEUE_WARN_AT} src=${QUEUE_WARN_AT}; update SMOKE_QUEUE_WARN_AT in bin/smoke.mjs`,
  );
  assert.equal(
    SMOKE_QUEUE_CRITICAL_AT,
    QUEUE_CRITICAL_AT,
    `smoke queue critical_at drifted from src/up.ts: smoke=${SMOKE_QUEUE_CRITICAL_AT} src=${QUEUE_CRITICAL_AT}; update SMOKE_QUEUE_CRITICAL_AT in bin/smoke.mjs`,
  );
});

test("smoke security.txt expiry tracks src/security-txt.ts SECURITY_TXT_EXPIRES", async () => {
  // Drift guard: bin/smoke.mjs runs on plain node with no TS loader, so its
  // expected Expires is duplicated from src/security-txt.ts and pinned here.
  // An expiry change in src fails this test at PR time (npm run test:smoke is
  // in the required check job); update SMOKE_SECURITY_TXT_EXPIRES in
  // bin/smoke.mjs to match.
  const bundle = await build({
    entryPoints: ["src/security-txt.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const { SECURITY_TXT_EXPIRES } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  assert.equal(
    SMOKE_SECURITY_TXT_EXPIRES,
    SECURITY_TXT_EXPIRES,
    `smoke security Expires drifted from src/security-txt.ts: smoke=${SMOKE_SECURITY_TXT_EXPIRES} src=${SECURITY_TXT_EXPIRES}; update SMOKE_SECURITY_TXT_EXPIRES in bin/smoke.mjs`,
  );
});

for (const body of [
  '{"ok":true}',
  "null",
  '{"status":"healthy","queue":null}',
  '{"status":"unknown","queue":{"status":"healthy"}}',
  '{"status":"healthy","queue":{"status":"unknown"}} trailing',
  "<html>not JSON</html>",
  '{"status":"healthy"}',
  '{"status":"healthy","queue":{"status":"unexpected"}}',
  '{"status":"degraded","db":"ok","pending_migrations":1,"queue":{"status":"healthy"}}',
  '{"status":"healthy","db":"error","pending_migrations":null,"queue":{"status":"healthy"}}',
  '{"status":"healthy","db":"ok","pending_migrations":"0","queue":{"status":"healthy"}}',
]) {
  test(`rejects invalid /up envelope (${body})`, async (t) => {
    const { url } = await stub(t, (route, result) => {
      if (route === "/up") result.body = body;
    });
    const result = await run(url);
    assert.equal(result.ok, false);
    assert.match(
      result.output,
      /FAIL \/up: expected (JSON \/up db:ok, pending_migrations:0, status and queue.status|valid JSON object)/,
    );
  });
}

test("accepts a critical backlog as degraded, never down", async (t) => {
  // QUEUE_CRITICAL_AT (100) stays degraded: a backlog is RSVP lag, not an
  // outage (src/up.ts). The gate asserts the 200 + origin + no-store triple.
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"degraded","db":"ok","pending_migrations":0,"queue":{"status":"degraded","pending":100,"warn_at":20,"critical_at":100}}';
  });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
  assert.ok(result.output.includes("PASS /up"), result.output);
});

test("fails closed on a dead-letter failed count with the count in the output", async (t) => {
  for (const failed of [1, 3]) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/up")
        result.body = `{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"healthy","warn_at":20,"critical_at":100,"failed":${failed}}}`;
    });
    const result = await run(url);
    assert.equal(result.ok, false, `${failed}: ${result.output}`);
    assert.match(
      result.output,
      new RegExp(
        `FAIL /up: expected queue\\.failed 0 \\(no dead letters\\); actual queue\\.failed ${failed}`,
      ),
    );
    assert.ok(!result.output.includes("PASS /up"), result.output);
  }
});

test("fails closed on dead letters from the real /up renderer", async (t) => {
  const bundle = await build({
    entryPoints: ["src/up.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const { upBody } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const body = await upBody(async () => ({
    pending: 0,
    delayed: 0,
    reserved: 0,
    total: 0,
    failed: 2,
    oldestPendingAgeSeconds: null,
    oldestReadyWaitAgeSeconds: null,
  }));
  const ready = { ...body, db: "ok", pending_migrations: 0 };
  assert.equal(ready.queue.failed, 2);
  const { url } = await stub(t, (route, result) => {
    if (route === "/up") result.body = JSON.stringify(ready);
  });
  const result = await run(url);
  assert.equal(result.ok, false, result.output);
  assert.match(
    result.output,
    /FAIL \/up: expected queue\.failed 0 \(no dead letters\); actual queue\.failed 2/,
  );
  assert.ok(!result.output.includes("PASS /up"), result.output);
});

test("failed 0, null and missing do not fail the dead-letter gate on their own", async (t) => {
  for (const queue of ['"failed":0', '"failed":null', '"pending":0']) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/up")
        result.body = `{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"unknown","warn_at":20,"critical_at":100,${queue}}}`;
    });
    const result = await run(url);
    assert.equal(result.ok, true, `${queue}: ${result.output}`);
    assert.ok(result.output.includes("PASS /up"), result.output);
  }
});

test("retained dead letters pass when the pre-deploy baseline covers them", async (t) => {
  // Staging serves retained rows (queue.failed 19 on 2026-10-18): the
  // promotion workflows capture that count before mutating, so history
  // passes and only growth fails.
  for (const [failed, failedBaseline] of [
    [19, 19],
    [19, 25],
    [0, 0],
  ]) {
    const { url } = await stub(t, (route, result) => {
      if (route === "/up")
        result.body = `{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"healthy","warn_at":20,"critical_at":100,"failed":${failed}}}`;
    });
    const result = await run(url, { failedBaseline });
    assert.equal(result.ok, true, `${failed}/${failedBaseline}: ${result.output}`);
    assert.ok(result.output.includes("PASS /up"), result.output);
  }
});

test("dead letters past the baseline fail with the count in the output", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"healthy","warn_at":20,"critical_at":100,"failed":20}}';
  });
  const result = await run(url, { failedBaseline: 19 });
  assert.equal(result.ok, false, result.output);
  assert.match(
    result.output,
    /FAIL \/up: expected queue\.failed <= 19 \(no new dead letters; baseline 19\); actual queue\.failed 20/,
  );
  assert.ok(!result.output.includes("PASS /up"), result.output);
});

test("CLI --failed-baseline and SMOKE_FAILED_BASELINE cover retained rows", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"healthy","warn_at":20,"critical_at":100,"failed":19}}';
  });
  const flagged = await cli([url, "--failed-baseline", "19"]);
  assert.equal(flagged.code, 0, flagged.output);
  const grown = await cli([url, "--failed-baseline", "18"]);
  assert.equal(grown.code, 1, grown.output);
  assert.match(grown.output, /actual queue\.failed 19/);
  const unflagged = await cli([url]);
  assert.equal(unflagged.code, 1, unflagged.output);
  const previous = process.env.SMOKE_FAILED_BASELINE;
  process.env.SMOKE_FAILED_BASELINE = "19";
  try {
    const fromEnv = await cli([url]);
    assert.equal(fromEnv.code, 0, fromEnv.output);
  } finally {
    if (previous === undefined) delete process.env.SMOKE_FAILED_BASELINE;
    else process.env.SMOKE_FAILED_BASELINE = previous;
  }
  // An empty SMOKE_FAILED_BASELINE is the workflows' unreadable-/up fallback:
  // it maps to no baseline, so ad-hoc runs keep the absolute gate.
  const previousEmpty = process.env.SMOKE_FAILED_BASELINE;
  process.env.SMOKE_FAILED_BASELINE = "";
  try {
    const fromEmpty = await cli([url]);
    assert.equal(fromEmpty.code, 1, fromEmpty.output);
    assert.match(
      fromEmpty.output,
      /FAIL \/up: expected queue\.failed 0 \(no dead letters\); actual queue\.failed 19/,
    );
  } finally {
    if (previousEmpty === undefined) delete process.env.SMOKE_FAILED_BASELINE;
    else process.env.SMOKE_FAILED_BASELINE = previousEmpty;
  }
  // An explicit flag wins over the environment in either direction.
  const previousBoth = process.env.SMOKE_FAILED_BASELINE;
  process.env.SMOKE_FAILED_BASELINE = "18";
  try {
    const flagWins = await cli([url, "--failed-baseline", "19"]);
    assert.equal(flagWins.code, 0, flagWins.output);
  } finally {
    if (previousBoth === undefined) delete process.env.SMOKE_FAILED_BASELINE;
    else process.env.SMOKE_FAILED_BASELINE = previousBoth;
  }
  process.env.SMOKE_FAILED_BASELINE = "19";
  try {
    const envLoses = await cli([url, "--failed-baseline", "18"]);
    assert.equal(envLoses.code, 1, envLoses.output);
    assert.match(envLoses.output, /actual queue\.failed 19/);
  } finally {
    if (previousBoth === undefined) delete process.env.SMOKE_FAILED_BASELINE;
    else process.env.SMOKE_FAILED_BASELINE = previousBoth;
  }
});

test("allow-missing-baseline skips the dead-letter gate when the baseline is unreadable", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"healthy","warn_at":20,"critical_at":100,"failed":19}}';
  });
  // Unit surface: no baseline + opt-in skips, without it the absolute gate fires.
  const skipped = await run(url, { allowMissingBaseline: true });
  assert.equal(skipped.ok, true, skipped.output);
  assert.ok(skipped.output.includes("SKIP /up dead-letter gate"), skipped.output);
  assert.ok(skipped.output.includes("PASS /up"), skipped.output);
  const strict = await run(url);
  assert.equal(strict.ok, false, strict.output);
  // CLI surface: empty env (the workflow fallback) + opt-in skips.
  const previousBaseline = process.env.SMOKE_FAILED_BASELINE;
  const previousAllow = process.env.SMOKE_ALLOW_MISSING_BASELINE;
  process.env.SMOKE_FAILED_BASELINE = "";
  process.env.SMOKE_ALLOW_MISSING_BASELINE = "1";
  try {
    const fromEnv = await cli([url]);
    assert.equal(fromEnv.code, 0, fromEnv.output);
    assert.match(fromEnv.output, /SKIP \/up dead-letter gate/);
  } finally {
    if (previousBaseline === undefined) delete process.env.SMOKE_FAILED_BASELINE;
    else process.env.SMOKE_FAILED_BASELINE = previousBaseline;
    if (previousAllow === undefined) delete process.env.SMOKE_ALLOW_MISSING_BASELINE;
    else process.env.SMOKE_ALLOW_MISSING_BASELINE = previousAllow;
  }
  const flagged = await cli([url, "--allow-missing-baseline"]);
  assert.equal(flagged.code, 0, flagged.output);
  assert.match(flagged.output, /SKIP \/up dead-letter gate/);
  // A readable baseline with allow-missing still enforces growth: the
  // workflows set both together, so `if (allowMissingBaseline)` alone would
  // silently disable the gate. Growth fails, at-baseline passes without SKIP.
  const { url: grownUrl } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"healthy","warn_at":20,"critical_at":100,"failed":20}}';
  });
  const grownWithBaseline = await run(grownUrl, {
    failedBaseline: 19,
    allowMissingBaseline: true,
  });
  assert.equal(grownWithBaseline.ok, false, grownWithBaseline.output);
  assert.match(
    grownWithBaseline.output,
    /FAIL \/up: expected queue\.failed <= 19 \(no new dead letters; baseline 19\); actual queue\.failed 20/,
  );
  assert.ok(
    !grownWithBaseline.output.includes("SKIP /up dead-letter gate"),
    grownWithBaseline.output,
  );
  const { url: atUrl } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"healthy","warn_at":20,"critical_at":100,"failed":19}}';
  });
  const atBaseline = await run(atUrl, { failedBaseline: 19, allowMissingBaseline: true });
  assert.equal(atBaseline.ok, true, atBaseline.output);
  assert.ok(atBaseline.output.includes("PASS /up"), atBaseline.output);
  assert.ok(!atBaseline.output.includes("SKIP /up dead-letter gate"), atBaseline.output);
});

test("rejects a non-integer failed baseline", async (t) => {
  const { url } = await stub(t);
  await assert.rejects(() => smoke(url, { failedBaseline: -1 }), /failed-baseline/);
  const badFlag = await cli([url, "--failed-baseline", "many"]);
  assert.equal(badFlag.code, 2, badFlag.output);
  assert.match(badFlag.output, /failed-baseline/);
});

test("rejects /up without the cutover origin marker", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up") delete result.headers["x-two-origin"];
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.ok(
    result.output.includes("FAIL /up: expected X-TWO-Origin two-web-next; actual missing"),
    result.output,
  );
});

test("rejects /up without no-store", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up") result.headers["cache-control"] = "public, max-age=3600";
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.ok(result.output.includes("FAIL /up: expected Cache-Control no-store"), result.output);
});

test("rejects /up 500 even with the origin marker present", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up") {
      result.status = 500;
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"unknown","warn_at":20,"critical_at":100}}';
    }
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.ok(result.output.includes("FAIL /up: expected HTTP 200; actual HTTP 500"), result.output);
});

test("rejects /up envelopes missing the queue thresholds", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"unknown"}}';
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL \/up: expected JSON \/up db:ok, pending_migrations:0, status and queue\.status/,
  );
});

test("allows degraded /up and guest admin 403", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up")
      result.body =
        '{"status":"degraded","db":"ok","pending_migrations":0,"queue":{"status":"degraded","warn_at":20,"critical_at":100}}';
    if (route === "/admin") {
      result.status = 403;
      delete result.headers.location;
    }
  });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
});

for (const robotsTag of [null, "index, follow", "noindex, nofollow"]) {
  test(`guest admin HTML 403 requires noindex (${robotsTag ?? "missing"})`, async (t) => {
    const { url } = await stub(t, (route, result) => {
      if (route === "/admin") {
        result.status = 403;
        result.body = "<h1>Forbidden</h1>";
        result.headers["content-type"] = "Text/HTML; charset=UTF-8";
        delete result.headers.location;
        if (robotsTag !== null) result.headers["x-robots-tag"] = robotsTag;
      }
    });
    const result = await run(url);
    assert.equal(result.ok, robotsTag === "noindex, nofollow", result.output);
    if (!result.ok) {
      assert.ok(
        result.output.includes(
          `FAIL /admin: expected staging X-Robots-Tag noindex/none (unscoped); actual ${robotsTag ?? "missing"}`,
        ),
        result.output,
      );
      assert.ok(!result.output.includes("PASS /admin"), result.output);
    }
  });
}

for (const [robotsTag, expected] of [
  ["googlebot: noindex", false],
  ["googlebot: nofollow, noindex", false],
  ["googlebot: none", false],
  ["bingbot: noindex, googlebot: noindex", false],
  ["x-noindex", false],
  ["noindexing", false],
  ["noindex=true", false],
  ["max-image-preview: none", false],
  ["max-image-preview: noindex", false],
  ["none", true],
  ["NoIndex, NoFollow", true],
  ["max-image-preview: none, noindex", true],
  ["noindex, googlebot: nofollow", true],
]) {
  test(`HTML requires complete unscoped indexing directive (${robotsTag})`, async (t) => {
    const { url, requests } = await stub(t, (route, result) => {
      if (route === "/about" || route === "/admin") {
        result.headers["x-robots-tag"] = robotsTag;
        if (route === "/admin") {
          result.status = 403;
          result.headers["content-type"] = "text/html; charset=UTF-8";
          result.body = "<h1>Forbidden</h1>";
          delete result.headers.location;
        }
      }
    });
    const result = await run(url);
    assert.equal(result.ok, expected, result.output);
    assert.equal(requests.length, 24);
    if (!expected) {
      for (const path of ["/about", "/admin"]) {
        assert.ok(
          result.output.includes(`FAIL ${path}: expected staging X-Robots-Tag noindex`),
          result.output,
        );
        assert.ok(!result.output.includes(`PASS ${path}`), result.output);
      }
    }
  });
}

test("non-HTML redirects and guest admin 403 do not require noindex", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (["/discord", "/profile", "/admin"].includes(route)) {
      result.headers["content-type"] = "text/plain; charset=UTF-8";
      delete result.headers["x-robots-tag"];
      if (route === "/admin") {
        result.status = 403;
        delete result.headers.location;
      }
    }
  });
  const result = await run(url);
  assert.equal(result.ok, true, result.output);
});

test("rejects wrong content type despite successful status and body", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/events.rss") result.headers["content-type"] = "text/html";
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL \/events.rss: expected Content-Type application\/rss\+xml; actual text\/html/,
  );
});

for (const path of ["/discord", "/profile", "/admin"]) {
  for (const location of [null, "https://example.invalid/login?secret=never-log-this"]) {
    test(`rejects ${location === null ? "missing" : "wrong"} redirect on ${path}`, async (t) => {
      const { url } = await stub(t, (route, result) => {
        if (route === path) {
          if (location === null) delete result.headers.location;
          else result.headers.location = location;
        }
      });
      const result = await run(url);
      assert.equal(result.ok, false);
      assert.ok(result.output.includes(`FAIL ${path}: expected Location to`), result.output);
      assert.ok(!result.output.includes("never-log-this"));
    });
  }
}

for (const [location, expected] of [
  ["https://discord.gg/fixture", true],
  ["https://discord.com/invite/fixture-code", true],
  ["https://DISCORD.COM/invite/fixture?event=123", true],
  ["https://discord.gg:443/fixture", true],
  ["https://discord.com:443/invite/fixture", true],
  ["https://discord.gg:8443/fixture", false],
  ["https://discord.com:8443/invite/fixture", false],
  ["https://discord.gg:80/fixture", false],
  ["https://discord.com:80/invite/fixture", false],
  ["https://discord.com/", false],
  ["https://discord.com/channels/123/456", false],
  ["https://discord.com/invite/", false],
  ["https://discord.com/invite/fixture/extra", false],
  ["https://discord.gg/", false],
  ["https://discord.gg/fixture/extra", false],
  ["https://discord.gg/%2Ffixture", false],
  ["https://never-log-this@discord.gg/fixture", false],
  ["https://user:never-log-this@discord.com/invite/fixture", false],
  ["https://discord.gg.example.invalid/fixture", false],
  ["http://discord.gg/fixture", false],
]) {
  test(`Discord redirect requires a credential-free invite (${location.replace(/[^/]*@/, "redacted@")})`, async (t) => {
    const { url, requests } = await stub(t, (route, result) => {
      if (route === "/discord") result.headers.location = location;
    });
    const result = await run(url);
    assert.equal(result.ok, expected, result.output);
    assert.equal(requests.length, 24);
    assert.ok(!result.output.includes("never-log-this"));
    if (!expected) {
      assert.match(
        result.output,
        /FAIL \/discord: expected Location to HTTPS Discord invite; actual unexpected Location/,
      );
      assert.ok(!result.output.includes("PASS /discord"), result.output);
    }
  });
}

test("CLI exits nonzero and names expected versus actual on failure", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/faq") result.status = 500;
  });
  const result = await cli([url]);
  assert.equal(result.code, 1);
  assert.match(result.output, /FAIL \/faq: expected HTTP 200; actual HTTP 500/);
});

test("bounds stalled response bodies", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/up") result.body = null;
  });
  const result = await run(url, { timeoutMs: 150 });
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL \/up: expected HTTP response and body within timeout; actual (TimeoutError|AbortError)/,
  );
  assert.match(result.output, /PASS \/__smoke_unknown_route__/);
});

test("connection failures include route and expected versus actual", async (t) => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.match(
    result.output,
    /FAIL \/up: expected HTTP response and body within timeout; actual TypeError/,
  );
  assert.match(result.output, /24 routes, 24 failed assertions/);
});

test("invalid input is rejected before making requests", async () => {
  for (const url of [
    "file:///etc/passwd",
    "https://user:password@example.test",
    "https://example.test/path",
    "https://example.test?token=x",
    "https://example.test#fragment",
  ]) {
    await assert.rejects(smoke(url), /base-url must be an HTTP\(S\) origin/);
  }
  assert.equal((await cli([])).code, 2);
  assert.equal((await cli(["not-a-url"])).code, 2);
  assert.equal((await cli(["http://127.0.0.1", "--bogus-flag"])).code, 2);
});

test("allowIndexable passes apex HTML without the staging noindex", async (t) => {
  // Apex serving apex omits X-Robots-Tag on indexable leaves (src/headers.ts
  // robotsTagFor); the archive and branded 404 stay meta-noindex, which this
  // header probe skips.
  const { url, requests } = await stub(t, (route, result) => {
    if (
      route === "/events/past" ||
      route === "/e/00000000000000000000000001" ||
      route === "/__smoke_unknown_route__"
    )
      return;
    delete result.headers["x-robots-tag"];
  });
  const result = await run(url, { allowIndexable: true });
  assert.equal(result.ok, true, result.output);
  assert.equal(requests.length, 24);
  assert.ok(requests.every((r) => r.method === "GET" && r.cookie === undefined));
});

test("allowIndexable rejects a staging noindex leaked onto apex HTML", async (t) => {
  const { url } = await stub(t);
  const result = await run(url, { allowIndexable: true });
  assert.equal(result.ok, false);
  assert.ok(
    result.output.includes(
      "FAIL /: expected no universal X-Robots-Tag noindex on indexable apex HTML",
    ),
    result.output,
  );
  assert.ok(!result.output.split("\n").includes("PASS /"), result.output);
});

test("default mode still requires the staging noindex", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (route === "/about") delete result.headers["x-robots-tag"];
  });
  const result = await run(url);
  assert.equal(result.ok, false);
  assert.ok(
    result.output.includes("FAIL /about: expected staging X-Robots-Tag noindex"),
    result.output,
  );
});

test("CLI --allow-indexable reaches the apex posture", async (t) => {
  const { url } = await stub(t, (route, result) => {
    if (
      route === "/events/past" ||
      route === "/e/00000000000000000000000001" ||
      route === "/__smoke_unknown_route__"
    )
      return;
    delete result.headers["x-robots-tag"];
  });
  const result = await cli([url, "--allow-indexable"]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /24 routes, 0 failed assertions/);
});
