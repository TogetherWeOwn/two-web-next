import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { KIT_STATIC_FEED_ROUTES } from "../../src/events/kit-static-feed-routes.ts";

const eventKeys = [
  "01J00000000000000000001001",
  "01J00000000000000000001002",
  "01J00000000000000000001003",
];
const cachePolicy = "max-age=300, public";
const fixtureIp = "192.0.2.110";
const wireHeaders = [
  "content-type",
  "content-disposition",
  "cache-control",
  "vary",
  "set-cookie",
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

export async function assertStaticFeedParity({ hono, kit, startKit, databaseUrl }) {
  await assertMountedFeeds();
  const [off, on] = await Promise.all([
    startKit("kit-feed-off", { APP_URL: hono.origin, KIT_ROUTE_FEEDS: "false" }),
    startKit("kit-feed-on", { APP_URL: hono.origin, KIT_ROUTE_FEEDS: "true" }),
  ]);
  const modes = [hono, kit, off, on];
  const sql = postgres(databaseUrl, { max: 1 });
  const buckets = [`events-read:${fixtureIp}`];
  let seeded = false;

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
    if (target !== kit) assert.equal(actual.headers.get("etag"), direct.headers.get("etag"), path);
  }

  async function compareFallback(method, path, status, origin = hono.origin) {
    const options = { method, status, headers: { origin } };
    const direct = await request(hono, path, options);
    const actual = await request(on, path, options);
    compare(actual, direct, on, path);
  }

  try {
    // Run 404 parity before seeding events. The baseline Worker may already
    // have a cached empty suggestion list from earlier checks.
    for (const [method, path, status, origin] of [
      ["POST", "/events.ics", 404],
      ["OPTIONS", "/events.rss", 404],
      ["POST", "/events.rss", 403, "https://example.invalid"],
      ["GET", "/events.ics/", 404],
      ["HEAD", "/events.rss/", 404],
      ["GET", "/events.ics/__data.json", 404],
      ["GET", "/version", 200],
    ]) {
      await compareFallback(method, path, status, origin);
    }
    await request(on, "/about", { status: 200, renderer: "kit" });

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
    await compareFallback("GET", `/events/${eventKeys[0]}.ics`, 200);

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
      await sql`delete from web_throttle_hits where bucket in ${sql(buckets)}`;
    } finally {
      await sql.end();
    }
  }
}
