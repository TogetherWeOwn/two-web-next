import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { build } from "esbuild";
import { smoke } from "../bin/smoke.mjs";

// Independent local responses matching the route contracts, not a live Worker/DB.
const fixtures = {
  "/up": [
    200,
    "application/json",
    '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"unknown","warn_at":20,"critical_at":100}}',
  ],
  "/": [200, "text/html", "<h1>The lobby is open.</h1>"],
  "/about": [200, "text/html", "<h1>About Together We Own</h1>"],
  "/faq": [200, "text/html", "<h1>Frequently asked questions</h1>"],
  "/rules": [200, "text/html", '<h1 id="rules-heading">House rules</h1>'],
  "/privacy": [200, "text/html", "<h1>Privacy policy</h1>"],
  "/events": [200, "text/html", '<h1 id="events-heading">Events</h1>'],
  "/events/past": [200, "text/html", '<h1 id="past-events-heading">Past events</h1>'],
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
      cookie: request.headers.cookie,
      host: request.headers.host,
    });
    const fixture = fixtures[request.url];
    if (!fixture) {
      response.writeHead(500).end("Unexpected request");
      return;
    }
    const [status, type, body, location] = fixture;
    // Origin-aware SEO fixtures (W16b TOG-11942): the stub advertises its own
    // origin the way the Worker advertises APP_URL, so the probe's
    // same-origin robots/sitemap assertions exercise a true positive.
    const origin = `http://${request.headers.host}`;
    const resolved = typeof body === "function" ? body(origin) : body;
    const result = {
      status,
      body: resolved,
      headers: {
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
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
  assert.match(result.output, /16 routes, 0 failed assertions/);
  assert.deepEqual(
    requests.map((r) => r.path),
    Object.keys(fixtures),
  );
  assert.ok(requests.every((r) => r.method === "GET" && r.cookie === undefined));
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
    assert.equal(requests.length, 16);
  });
}

for (const [header, path, expected] of [
  ["content-security-policy", "/events.rss", "nonempty Content-Security-Policy"],
  ["x-content-type-options", "/discord", "X-Content-Type-Options nosniff"],
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
    assert.equal(requests.length, 16);
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
  for (const state of ["healthy", "degraded", "unknown", "unconfigured"]) {
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
            };
          },
    );
    // The envelope's queue slice comes from the real renderer; DB readiness fields are set explicitly.
    const ready = { ...body, db: "ok", pending_migrations: 0 };
    const { url } = await stub(t, (route, result) => {
      if (route === "/up") result.body = JSON.stringify(ready);
    });
    const result = await run(url);
    assert.equal(result.ok, true, `${state}: ${result.output}`);
  }
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
    assert.equal(requests.length, 16);
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
    assert.equal(requests.length, 16);
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
  assert.match(result.output, /16 routes, 16 failed assertions/);
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
});
