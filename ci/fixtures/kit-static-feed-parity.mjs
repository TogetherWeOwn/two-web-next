import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { KIT_EVENT_CALENDAR_ROUTE } from "../../src/events/kit-event-calendar-route.ts";
import { KIT_STATIC_FEED_ROUTES } from "../../src/events/kit-static-feed-routes.ts";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";

const eventKeys = [
  "01J00000000000000000001001",
  "01J00000000000000000001002",
  "01J00000000000000000001003",
];
const cachePolicy = "max-age=300, public";
const detailCachePolicy = "max-age=300, private";
const eventCalendar = (key) => `/events/${key}.ics`;
const fixtureIp = "192.0.2.110";
const wireHeaders = [
  "content-type",
  "content-disposition",
  "cache-control",
  "vary",
  "location",
  "allow",
  "x-robots-tag",
  "content-security-policy",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "origin-agent-cluster",
  "referrer-policy",
  "x-content-type-options",
  "x-dns-prefetch-control",
  "x-download-options",
  "x-frame-options",
  "x-permitted-cross-domain-policies",
  "x-xss-protection",
  "permissions-policy",
  "reporting-endpoints",
];

async function assertMountedFeeds() {
  const { manifest } = await import("../../web/.svelte-kit/output/server/manifest-full.js");
  const inventory = JSON.parse(
    await readFile(new URL("../../test/fixtures/route-inventory.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    KIT_STATIC_FEED_ROUTES.map(({ method, path }) => [method, path]),
    [
      ["GET", "/events.ics"],
      ["GET", "/events.rss"],
    ],
  );
  for (const { path, method } of KIT_STATIC_FEED_ROUTES) {
    const routes = manifest.routes.filter(
      ({ id, pattern }) => id !== "/[...path]" && pattern.test(path),
    );
    assert.deepEqual(
      routes.map(({ id }) => id),
      [path],
      `${path}: exact Kit route with no overlap`,
    );
    assert.equal(routes[0].page, null, `${path}: endpoint only`);
    assert.equal(typeof routes[0].endpoint, "function", `${path}: mounted endpoint`);
    assert.deepEqual(
      inventory.filter((row) => row.path === path).map((row) => row.method),
      [method],
    );
  }
  const detailRoutes = manifest.routes.filter(
    ({ id, pattern }) => id !== "/[...path]" && pattern.test(eventCalendar(eventKeys[0])),
  );
  assert.deepEqual(
    detailRoutes.map(({ id }) => id),
    [KIT_EVENT_CALENDAR_ROUTE.dynamic.id],
  );
  assert.equal(detailRoutes[0].page, null, "per-event ICS is endpoint only");
  assert.equal(typeof detailRoutes[0].endpoint, "function", "per-event ICS is mounted");
  assert.deepEqual(
    inventory
      .filter(({ path }) => path === KIT_EVENT_CALENDAR_ROUTE.path)
      .map(({ method }) => method),
    ["GET"],
    "mounted Hono per-event ICS registration",
  );
}

async function request(worker, path, { method = "GET", headers, status, renderer = null }) {
  const label = `${worker.name}: ${method} ${path}`;
  const response = await fetch(`${worker.origin}${path}`, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "x-request-id": "0123456789abcdef",
      "cf-connecting-ip": fixtureIp,
      "x-forwarded-for": fixtureIp,
      ...headers,
    },
  });
  const body = await response.text();
  if (status !== undefined) assert.equal(response.status, status, label);
  assert.equal(response.headers.get("x-two-renderer"), renderer, `${label}: owner`);
  const id = response.headers.get("x-request-id");
  assert.match(id ?? "", /^(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-f]{16}(?:-[A-Z]{3})?)$/i, label);
  assert.notEqual(id, "0123456789abcdef", `${label}: ignores caller request ID`);
  assert.ok(response.headers.get("content-security-policy")?.includes("default-src 'self'"), label);
  if (method === "HEAD" || response.status === 304) assert.equal(body, "", `${label}: no body`);
  return { body, headers: response.headers, id, status: response.status };
}

function cookieShape(headers) {
  return headers.getSetCookie().map((cookie) => cookie.replace(/=[^;]+/, "=<opaque>"));
}

function sessionRenewal(headers) {
  const cookies = headers.getSetCookie();
  assert.deepEqual(
    cookies.map((cookie) => cookie.split("=", 1)[0]),
    ["__Host-two_session_status", SESSION_COOKIE],
  );
  for (const cookie of cookies) {
    assert.ok(
      /; Secure\b/.test(cookie) && /; HttpOnly\b/.test(cookie) && /; SameSite=Lax\b/.test(cookie),
      "synthetic renewal retains cookie security attributes",
    );
  }
  return cookies[1].split(";", 1)[0];
}

export async function assertStaticFeedParity({ hono, kit, startKit, databaseUrl }) {
  await assertMountedFeeds();
  const [off, on] = await Promise.all([
    startKit("kit-feed-off", { APP_URL: hono.origin, KIT_ROUTE_FEEDS: "false" }),
    startKit("kit-feed-on", { APP_URL: hono.origin, KIT_ROUTE_FEEDS: "true" }),
  ]);
  const modes = [hono, kit, off, on];
  const sql = postgres(databaseUrl, { max: 1 });
  const buckets = [`events-read:${fixtureIp}`];
  const sessionLineages = [];
  let seeded = false;

  async function mintSession(moderator) {
    const token = `two_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    sessionLineages.push(hash);
    await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
      values (${hash}, ${hash}, '900000000000009106', 'Synthetic Feed Viewer', true, ${moderator}, now() + interval '15 minutes')`;
    const signed = await generateSignedCookie(
      SESSION_COOKIE,
      token,
      FIXTURE_SECRETS.SESSION_SECRET,
    );
    return signed.split(";", 1)[0];
  }

  function compare(actual, direct, target, path) {
    const normalize = (result, origin) =>
      result.body
        .replaceAll(origin, "ORIGIN")
        .replaceAll(new URL(origin).host, "HOST")
        .replaceAll(result.id, "REQUEST_ID");
    assert.equal(actual.status, direct.status, path);
    assert.equal(
      normalize(actual, target === kit ? kit.origin : hono.origin),
      normalize(direct, hono.origin),
      `${target.name}: ${path} body`,
    );
    for (const name of wireHeaders) {
      assert.equal(
        actual.headers.get(name),
        direct.headers.get(name),
        `${target.name}: ${path} ${name}`,
      );
    }
    assert.deepEqual(cookieShape(actual.headers), cookieShape(direct.headers), `${path}: cookies`);
    if (target !== kit) assert.equal(actual.headers.get("etag"), direct.headers.get("etag"), path);
  }

  async function compareFallback(method, path, status, origin = hono.origin) {
    const options = { method, status, headers: { origin } };
    const direct = await request(hono, path, options);
    const actual = await request(on, path, options);
    compare(actual, direct, on, path);
  }

  try {
    const publicPath = eventCalendar(eventKeys[0]);
    const draftPath = eventCalendar(eventKeys[2]);
    // Run 404 parity before seeding events. The baseline Worker may already
    // have a cached empty suggestion list from earlier checks.
    for (const [method, path, status, origin] of [
      ["POST", "/events.ics", 404],
      ["OPTIONS", "/events.rss", 404],
      ["POST", "/events.rss", 403, "https://example.invalid"],
      ["GET", "/events.ics/", 404],
      ["HEAD", "/events.rss/", 404],
      ["GET", "/events.ics/__data.json", 404],
      ["GET", `${publicPath}/`, 404],
      ["HEAD", `${publicPath}/`, 404],
      ["POST", publicPath, 404],
      ["OPTIONS", publicPath, 404],
      ["POST", publicPath, 403, "https://example.invalid"],
      ["GET", `${publicPath}/__data.json`, 404],
      ["GET", "/events/outer/inner.ics", 404],
      ["GET", "/events/.ics", 401],
      ["GET", "/events/line%0Abreak.ics", 401],
      ["GET", "/events/malformed%FF.ics", 404],
      ["GET", `/events/${eventKeys[0]}`, 401],
      ["GET", `/api/public/events/${eventKeys[0]}.ics`, 404],
      ["GET", "/version", 200],
    ]) {
      await compareFallback(method, path, status, origin);
    }
    await request(on, "/about", { status: 200, renderer: "kit" });
    await request(on, "/events/past", { status: 200, renderer: "kit" });

    await sql`insert into events (event_key, title, game, status, starts_at, ends_at, updated_at)
      values (${eventKeys[0]}, 'Fixture Racing Night', 'Fixture Racing', 'published',
        '2099-01-02 18:00+00', '2099-01-02 19:00+00', '2026-01-01 18:00+00'),
        (${eventKeys[1]}, 'Fixture Cancelled Night', 'Fixture Puzzles', 'cancelled',
        '2099-01-03 18:00+00', '2099-01-03 19:00+00', '2026-01-01 18:00+00'),
        (${eventKeys[2]}, 'Fixture Draft Night', 'Fixture Racing', 'draft',
        '2099-01-04 18:00+00', '2099-01-04 19:00+00', '2026-01-01 18:00+00')`;
    seeded = true;

    for (const [path, mediaType, disposition] of [
      ["/events.ics?game=Fixture%20Racing", "text/calendar", 'inline; filename="events.ics"'],
      ["/events.rss", "application/rss+xml", null],
    ]) {
      const run = (target, options) =>
        request(target, path, {
          ...options,
          renderer: target === on ? "kit" : null,
        });
      const baseline = await run(hono, { status: 200 });
      for (const target of modes) {
        const get = await run(target, {
          status: 200,
          headers: { cookie: "__Host-two_session=fixture" },
        });
        compare(get, baseline, target, path);
        const etag = `"${createHash("sha256").update(get.body).digest("hex")}"`;
        assert.equal(get.headers.get("etag"), etag);
        assert.equal(get.headers.get("content-type"), `${mediaType}; charset=utf-8`);
        assert.equal(get.headers.get("content-disposition"), disposition);
        assert.equal(get.headers.get("cache-control"), cachePolicy);
        assert.equal(get.headers.get("set-cookie"), null);
        assert.match(get.body, /Fixture Racing Night/);
        assert.equal(get.body.includes("Fixture Cancelled Night"), disposition === null);
        assert.doesNotMatch(get.body, /Fixture Draft Night/);

        const head = await run(target, { method: "HEAD", status: 200 });
        for (const name of [...wireHeaders, "etag"])
          assert.equal(head.headers.get(name), get.headers.get(name), name);
        assert.deepEqual(cookieShape(head.headers), cookieShape(get.headers), "HEAD cookies");
        for (const [method, validator] of [
          ["GET", etag],
          ["HEAD", `"stale", W/${etag}`],
        ]) {
          const cached = await run(target, {
            method,
            status: 304,
            headers: { "if-none-match": validator },
          });
          assert.equal(cached.headers.get("etag"), etag);
          assert.equal(cached.headers.get("cache-control"), cachePolicy);
          for (const name of ["content-type", "content-disposition", "set-cookie"]) {
            assert.equal(cached.headers.get(name), null, name);
          }
        }
      }
    }

    const invalidPath = "/events.ics?game=Line%0ABreak";
    const invalidOptions = { status: 400, headers: { "if-none-match": "*" } };
    const invalid = await request(hono, invalidPath, invalidOptions);
    assert.equal(invalid.body, "Invalid game filter.");
    assert.equal(invalid.headers.get("cache-control"), "no-store");
    for (const target of modes.slice(1)) {
      const actual = await request(target, invalidPath, {
        ...invalidOptions,
        renderer: target === on ? "kit" : null,
      });
      compare(actual, invalid, target, invalidPath);
    }

    await compareFallback("GET", "/events%2Erss", 200);
    await compareFallback("GET", `/events/${eventKeys[0]}%2Eics`, 200);
    await compareFallback("GET", `/%65vents/${eventKeys[0]}.ics`, 200);

    const detailBaseline = new Map();
    for (const [index, target] of modes.entries()) {
      const ip = `192.0.2.${120 + index}`;
      const bucket = `events-read:${ip}`;
      buckets.push(bucket);
      const run = async (label, path, { headers, ...options }) => {
        const result = await request(target, path, {
          ...options,
          renderer: target === on ? "kit" : null,
          headers: { "cf-connecting-ip": ip, "x-forwarded-for": ip, ...headers },
        });
        if (target === hono) detailBaseline.set(label, result);
        else compare(result, detailBaseline.get(label), target, `${label}: ${path}`);
        return result;
      };

      const moderator = await mintSession(true);
      const publicHeaders = { cookie: moderator };
      const get = await run("public GET", publicPath, { status: 200, headers: publicHeaders });
      assert.equal(get.headers.get("cache-control"), detailCachePolicy);
      assert.equal(get.headers.get("content-type"), "text/calendar; charset=utf-8");
      assert.equal(
        get.headers.get("content-disposition"),
        `attachment; filename="${eventKeys[0]}.ics"`,
      );
      assert.match(get.body, /SUMMARY:Fixture Racing Night\r\n/);
      assert.doesNotMatch(get.body, /Fixture Draft Night|Synthetic Feed Viewer|900000000000009106/);
      assert.equal(get.headers.get("set-cookie"), null, "public GET leaves the session alone");
      const publicTag = `"${createHash("sha256").update(get.body).digest("hex")}"`;
      assert.equal(get.headers.get("etag"), publicTag);
      const head = await run("public HEAD", publicPath, {
        method: "HEAD",
        status: 200,
        headers: publicHeaders,
      });
      for (const name of [...wireHeaders, "etag"])
        assert.equal(head.headers.get(name), get.headers.get(name), name);
      const [{ count }] =
        await sql`select count(*)::int from web_throttle_hits where bucket = ${bucket}`;
      assert.equal(count, 2, `${target.name}: each GET and HEAD charges the shared bucket once`);

      await run("public conditional", publicPath, {
        status: 304,
        headers: { "if-none-match": publicTag },
      });
      const encoded = await run("encoded key", eventCalendar(`%30${eventKeys[0].slice(1)}`), {
        status: 200,
      });
      assert.equal(encoded.body, get.body);
      const lowerPath = `${eventCalendar(eventKeys[0].toLowerCase())}?game=one%20two`;
      const redirect = await run("canonical redirect", lowerPath, {
        status: 301,
        headers: publicHeaders,
      });
      assert.equal(redirect.headers.get("location"), `${publicPath}?game=one%20two`);
      assert.equal(redirect.headers.get("set-cookie"), null);
      const cancelled = await run("cancelled GET", eventCalendar(eventKeys[1]), { status: 200 });
      assert.match(cancelled.body, /STATUS:CANCELLED\r\n/);

      for (const [label, key] of [
        ["missing event", "01J00000000000000000001009"],
        ["escaped separator", `${eventKeys[0]}%2Fpart`],
        ["escaped percent", `%2530${eventKeys[0].slice(1)}`],
        ["Unicode key", "%E2%98%83"],
      ]) {
        for (const method of ["GET", "HEAD"]) {
          const missing = await run(`${label} ${method}`, eventCalendar(key), {
            method,
            status: 404,
            headers: publicHeaders,
          });
          assert.equal(missing.headers.get("x-robots-tag"), "noindex, nofollow");
          assert.equal(missing.headers.get("set-cookie"), null);
        }
      }

      const draft = await run("authorized draft GET", draftPath, {
        status: 200,
        headers: { cookie: moderator },
      });
      assert.match(draft.body, /SUMMARY:Fixture Draft Night\r\n/);
      assert.equal(draft.headers.get("cache-control"), detailCachePolicy);
      const validator = draft.headers.get("etag");
      assert.ok(validator, "draft GET supplies a validator");
      const cached = await run("authorized draft HEAD", draftPath, {
        method: "HEAD",
        status: 304,
        headers: { cookie: sessionRenewal(draft.headers), "if-none-match": validator },
      });
      assert.equal(cached.headers.get("cache-control"), detailCachePolicy);
      assert.equal(cached.headers.get("etag"), validator);
      await run("renewed draft HEAD", draftPath, {
        method: "HEAD",
        status: 200,
        headers: { cookie: sessionRenewal(cached.headers) },
      });

      for (const method of ["GET", "HEAD"]) {
        const denied = await run(`guest draft ${method}`, draftPath, {
          method,
          status: 403,
          headers: { "if-none-match": validator },
        });
        if (method === "GET") assert.equal(denied.body, "Forbidden");
        assert.equal(denied.headers.get("etag"), null);
        assert.equal(denied.headers.get("set-cookie"), null);
      }
      const member = await mintSession(false);
      const denied = await run("member draft GET", draftPath, {
        status: 403,
        headers: { cookie: member, "if-none-match": validator },
      });
      assert.equal(denied.body, "Forbidden");
      assert.equal(denied.headers.get("etag"), null);
      // A valid non-moderator session renews before either refusal.
      const memberHead = await run("member draft HEAD", draftPath, {
        method: "HEAD",
        status: 403,
        headers: { cookie: sessionRenewal(denied.headers), "if-none-match": validator },
      });
      assert.equal(memberHead.headers.get("etag"), null);
      sessionRenewal(memberHead.headers);
    }
    console.log(
      "PASS built Worker per-event ICS absent/off/on: path and method ownership, one budget charge, public, draft renewal and refusal parity",
    );

    let directLimit;
    for (const [index, target] of modes.entries()) {
      const ip = `192.0.2.${112 + index}`;
      const bucket = `events-read:${ip}`;
      await sql`insert into web_throttle_hits (bucket) select ${bucket} from generate_series(1, 59)`;
      buckets.push(bucket);
      const headers = { "cf-connecting-ip": ip, "x-forwarded-for": ip, accept: "application/json" };
      const renderer = target === on ? "kit" : null;
      await request(target, "/events.ics", { status: 200, headers, renderer });
      const limited = await request(target, "/events.rss", { status: 429, headers, renderer });
      assert.equal(limited.body, "Too many requests");
      assert.equal(limited.headers.get("cache-control"), "no-store, private");
      assert.match(limited.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
      if (directLimit) compare(limited, directLimit, target, "/events.rss");
      else directLimit = limited;
      const [{ count }] =
        await sql`select count(*)::int from web_throttle_hits where bucket = ${bucket}`;
      assert.equal(
        count,
        60,
        `${target.name}: the allowed read charges once and the refusal adds no hit`,
      );
    }
    console.log(
      "PASS built Worker static feeds absent/off/on: exact routes, wire parity and one shared budget charge",
    );
  } finally {
    try {
      if (seeded) await sql`delete from events where event_key in ${sql(eventKeys)}`;
      if (sessionLineages.length) {
        await sql`delete from web_session_grace where status_hash in ${sql(sessionLineages)}`;
        await sql`delete from web_sessions where status_hash in ${sql(sessionLineages)}`;
      }
      await sql`delete from web_throttle_hits where bucket in ${sql(buckets)}`;
    } finally {
      await sql.end();
    }
  }
}
