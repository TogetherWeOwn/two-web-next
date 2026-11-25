import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import {
  KIT_EVENT_COLLECTION_ROUTE,
  KIT_EVENT_JSON_ROUTE,
} from "../../src/events/kit-json-routes.ts";
import { FALLBACK_INVITE } from "../../src/invite-fallback.ts";
import { KIT_PUBLIC_API_ROUTES } from "../../src/public-data/kit-routes.ts";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";

const published = "01J0000000000000000000132A";
const draft = "01J0000000000000000000132B";
const missing = "01J0000000000000000000132C";
const game = "Synthetic API Event Reads";
const privateField = "synthetic-event-join-instructions";
const draftTitle = "Synthetic API Draft";
const event = (key) => `/events/${key}`;
const publicEvent = (key) => `/api/public/events/${key}`;
const collection = "/events.json";
const publicSnapshots = ["/api/public/community", "/api/public/join"];

const eventFields = [
  "event_key",
  "title",
  "game",
  "description",
  "starts_at",
  "ends_at",
  "starts_at_local",
  "ends_at_local",
  "timezone",
  "location",
  "capacity",
  "going_count",
  "going_occupancy",
  "status",
  "rsvp_open",
  "synced_to_discord",
];

async function assertInventory() {
  const { manifest } = await import("../../web/.svelte-kit/output/server/manifest-full.js");
  const map = JSON.parse(
    await readFile(new URL("../../test/fixtures/route-kit-map.json", import.meta.url), "utf8"),
  );
  const coveredFeeds = ["/events.ics", "/events.rss", "/events/:file{.+\\.ics}"];
  const remaining = map.rows.filter(
    ({ slice, path }) => slice === "API-4" && !coveredFeeds.includes(path),
  );
  const routes = [KIT_EVENT_COLLECTION_ROUTE, KIT_EVENT_JSON_ROUTE, ...KIT_PUBLIC_API_ROUTES];
  const pair = ({ method, path }) => `${method} ${path}`;
  assert.deepEqual(routes.map(pair).sort(), remaining.map(pair).sort());
  for (const { path, dynamic } of routes) {
    const id = dynamic?.id ?? path;
    const route = manifest.routes.find((entry) => entry.id === id);
    assert.equal(route?.page, null, `${id}: endpoint only`);
    assert.equal(typeof route.endpoint, "function", `${id}: mounted endpoint`);
  }
}

export async function assertEventReadsParity({
  hono,
  unset,
  feedOn,
  combinedOn,
  eventJsonOn,
  publicApiOn,
  databaseUrl,
}) {
  await assertInventory();
  const sql = postgres(databaseUrl, { max: 1 });
  const workers = [hono, unset, eventJsonOn, publicApiOn, feedOn];
  const ips = new Map(workers.map((worker, index) => [worker, `192.0.2.${150 + index}`]));
  const buckets = [...ips.values()].map((ip) => `events-read:${ip}`);
  const combinedIp = "192.0.2.155";
  const combinedBucket = `events-read:${combinedIp}`;
  ips.set(combinedOn, combinedIp);
  const sessions = [];
  const memberId = "900000000000013200";
  const moderatorId = "900000000000013201";
  let seeded = false;

  async function mintSession(userId, moderator) {
    const token = `two_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    sessions.push(hash);
    await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
      values (${hash}, ${hash}, ${userId}, 'Synthetic API Reader', true, ${moderator}, now() + interval '15 minutes')`;
    const signed = await generateSignedCookie(
      SESSION_COOKIE,
      token,
      FIXTURE_SECRETS.SESSION_SECRET,
      { path: "/", secure: true },
    );
    return signed.split(";", 1)[0];
  }

  async function read(worker, path, { method = "GET", headers = {} } = {}) {
    const ip = ips.get(worker);
    const response = await fetch(`${worker.origin}${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { "cf-connecting-ip": ip, "x-forwarded-for": ip, ...headers },
    });
    return { response, body: await response.text() };
  }

  async function hitCounts(selectedBuckets = buckets) {
    const rows = await sql`select bucket, count(*)::int as hits from web_throttle_hits
      where bucket in ${sql(selectedBuckets)} group by bucket order by bucket`;
    return rows.map(({ bucket, hits }) => ({ bucket, hits }));
  }

  async function compare(path, status, { kit = true, headers, method, ownEtag, cache } = {}) {
    let baseline;
    const results = [];
    const enabled =
      path.startsWith(collection) || path.endsWith(".ics")
        ? feedOn
        : path.startsWith("/events/")
          ? eventJsonOn
          : publicApiOn;
    for (const worker of workers) {
      const index = results.length;
      const requestHeaders = { ...headers };
      if (ownEtag) requestHeaders["if-none-match"] = ownEtag[index];
      if (method === "POST")
        requestHeaders.origin ??= worker === unset ? unset.origin : hono.origin;
      const { response, body } = await read(worker, path, { method, headers: requestHeaders });
      const label = `${worker.name}: ${method ?? "GET"} ${path}`;
      assert.equal(response.status, status, label);
      assert.equal(
        response.headers.get("x-two-renderer"),
        kit && worker === enabled ? "kit" : null,
        label,
      );
      assert.equal(response.headers.get("set-cookie"), null, label);
      assert.equal(response.headers.get("access-control-allow-origin"), null, label);
      assert.equal(response.headers.get("access-control-allow-credentials"), null, label);
      if (method === "HEAD" || status === 304) assert.equal(body, "", label);
      const requestId = response.headers.get("x-request-id");
      assert.ok(requestId, label);
      let normalized = body
        .replaceAll(requestId, "REQUEST_ID")
        .replaceAll(worker.origin, hono.origin);
      if (status === 429) {
        const retry = response.headers.get("retry-after");
        assert.match(retry ?? "", /^(?:[1-5]?\d|60)$/);
        assert.ok(Number(retry) > 0, label);
        if (method !== "HEAD") {
          const payload = JSON.parse(body);
          const error = path === collection ? payload : payload.error;
          assert.equal(error.code, "rate_limited", label);
          assert.equal(error.request_id, requestId, label);
          assert.equal(error.message, `Too many requests. Try again in ${retry} seconds.`, label);
          if (path === collection) assert.equal(error.retry_after, Number(retry), label);
          normalized = normalized
            .replace(`in ${retry} seconds`, "in RETRY seconds")
            .replace(`"retry_after":${retry}`, '"retry_after":RETRY');
        }
      }
      if (path.endsWith(".ics")) {
        const host = new URL(worker === unset ? unset.origin : hono.origin).host;
        const uid = `UID:${published}@${host}\r\n`;
        assert.ok(body.includes(uid), `${label}: UID uses configured authority`);
        normalized = normalized.replace(uid, `UID:${published}@FIXTURE_HOST\r\n`);
      }
      const cacheControl = response.headers.get("cache-control");
      if (cache === "public") assert.match(cacheControl ?? "", /^public, max-age=(?:[0-5]?\d|60)$/);
      else if (cache !== undefined) assert.equal(cacheControl, cache, label);
      const wire = [
        normalized,
        ...[
          "allow",
          "content-type",
          "content-disposition",
          "vary",
          "location",
          "x-robots-tag",
          "content-security-policy",
          "x-content-type-options",
          "referrer-policy",
          "permissions-policy",
          "reporting-endpoints",
        ].map((name) => response.headers.get(name)),
      ];
      if (cache !== "public") wire.push(cacheControl);
      const etag = response.headers.get("etag");
      if (path !== "/openapi.json" && !path.endsWith(".ics")) wire.push(etag);
      if (worker === hono) baseline = wire;
      else assert.deepEqual(wire, baseline, label);
      assert.ok(
        !body.includes(privateField) && !body.includes(memberId) && !body.includes(moderatorId),
        label,
      );
      results.push({ body, etag, headers: response.headers });
    }
    return results;
  }

  try {
    for (const [method, path, status] of [
      ["POST", publicEvent(published), 404],
      ["OPTIONS", "/openapi.json", 404],
      ["GET", "/api/public/events/", 404],
      ["GET", `${publicEvent(published)}/__data.json`, 404],
      ["GET", "/api/public/unknown", 404],
      ["GET", `/api/public/events/%30${published.slice(1)}`, 404],
      ["GET", "/api/public/%65vents?game=none", 200],
      ["GET", `${event(published)}/__data.json`, 404],
    ])
      await compare(path, status, { kit: false, method });

    for (const path of [collection, ...publicSnapshots]) {
      for (const [method, suffix, status] of [
        ["POST", "", 404],
        ["OPTIONS", "", 404],
        ["HEAD", "/", 404],
        ["GET", "/__data.json", 404],
      ]) {
        await compare(path + suffix, status, { method, kit: false });
      }
      await compare(path, 403, {
        method: "POST",
        kit: false,
        headers: { origin: "https://example.invalid", accept: "application/json" },
      });
    }
    for (const [path, status] of [
      ["/events%2Ejson", 401],
      ["/api/public/%63ommunity", 200],
      ["/api/public/%6Aoin", 200],
    ]) {
      await compare(path, status, { kit: false });
    }

    await sql`insert into events (event_key, title, game, status, starts_at, ends_at, join_instructions)
      values (${published}, 'Synthetic API Published', ${game}, 'published', '2099-02-01 18:00+00', '2099-02-01 19:00+00', ${privateField}),
        (${draft}, ${draftTitle}, ${game}, 'draft', '2099-02-02 18:00+00', '2099-02-02 19:00+00', ${privateField})`;
    seeded = true;
    await sql`insert into rsvps (event_id, user_id, status)
      select id, ${memberId}, 'waitlisted' from events where event_key = ${published}`;
    const member = { cookie: await mintSession(memberId, false), accept: "application/json" };
    const moderator = { cookie: await mintSession(moderatorId, true), accept: "application/json" };
    const beforeCollection = await hitCounts();
    const collectionUrl = `${collection}?event_key=${published.toLowerCase()}&per_page=1&page=50`;
    const privateCache = "private, no-cache";
    const list = await compare(collectionUrl, 200, { headers: member, cache: privateCache });
    const data = JSON.parse(list[0].body);
    assert.deepEqual(data.meta, { current_page: 1, per_page: 1, total: 1, last_page: 1 });
    assert.deepEqual(Object.keys(data.data[0]), eventFields);
    assert.equal(data.data[0].event_key, published);
    assert.equal(list[0].headers.get("vary"), "Cookie, Accept");
    const [head] = await compare(collectionUrl, 200, {
      method: "HEAD",
      headers: member,
      cache: privateCache,
    });
    assert.equal(head.etag, list[0].etag);
    assert.equal(head.headers.get("content-type"), list[0].headers.get("content-type"));
    for (const method of ["GET", "HEAD"]) {
      await compare(collectionUrl, 304, {
        method,
        headers: member,
        ownEtag: list.map(({ etag }) => `W/${etag}`),
        cache: privateCache,
      });
    }
    const [guest] = await compare(collectionUrl, 401, {
      ownEtag: list.map(({ etag }) => etag),
      cache: "private, no-store",
    });
    assert.equal(guest.etag, null);
    assert.deepEqual(JSON.parse(guest.body), { error: "unauthenticated" });
    const [login] = await compare(collectionUrl, 302, {
      headers: { accept: "text/html" },
      cache: "private, no-store",
    });
    assert.equal(
      new URL(login.headers.get("location"), hono.origin).searchParams.get("next"),
      collectionUrl,
    );
    const [invalid] = await compare(`${collection}?event_key=invalid%2Fkey`, 422, {
      headers: { ...member, "if-none-match": "*" },
      cache: "private, no-store",
    });
    assert.deepEqual(JSON.parse(invalid.body), { error: "invalid_event_key" });
    const [hidden] = await compare(`${collection}?event_key=${draft}`, 200, {
      headers: moderator,
      cache: privateCache,
    });
    assert.deepEqual(JSON.parse(hidden.body).data, []);
    assert.deepEqual(
      await hitCounts(),
      beforeCollection.map(({ bucket, hits }) => ({ bucket, hits: hits + 8 })),
    );

    const before = await hitCounts();
    assert.equal(before.length, workers.length);
    await compare(event(published), 401, { cache: "private, no-store" });
    await compare(event(published), 302, {
      headers: { accept: "text/html" },
      cache: "private, no-store",
    });
    assert.deepEqual(
      await hitCounts(),
      before.map(({ bucket, hits }) => ({ bucket, hits: hits + 2 })),
    );
    const detail = await compare(event(published), 200, {
      headers: member,
      cache: "private, no-cache",
    });
    const detailDto = JSON.parse(detail[0].body).data;
    assert.deepEqual(Object.keys(detailDto), [...eventFields, "waitlist_position"]);
    assert.equal(detailDto.waitlist_position, 1);
    await compare(event(published), 304, {
      method: "HEAD",
      headers: member,
      ownEtag: detail.map(({ etag }) => etag),
      cache: "private, no-cache",
    });
    const [other] = await compare(event(published), 200, {
      headers: moderator,
      ownEtag: detail.map(({ etag }) => etag),
    });
    assert.equal(JSON.parse(other.body).data.waitlist_position, null);
    await compare(event(missing), 404, { headers: member, cache: "private, no-store" });
    await compare(event(draft), 403, {
      headers: { ...member, "if-none-match": "*" },
      cache: "private, no-store",
    });
    const [preview] = await compare(event(draft), 200, {
      headers: moderator,
      cache: "private, no-cache",
    });
    assert.equal(JSON.parse(preview.body).data.title, draftTitle);
    await compare(`${event(published.toLowerCase())}?source=fixture`, 301, { headers: member });

    const publicList = `/api/public/events?game=${encodeURIComponent(game)}&per_page=1&page=50`;
    const beforePublic = await hitCounts();
    for (const path of [publicList, publicEvent(published), ...publicSnapshots, "/openapi.json"]) {
      const snapshot = publicSnapshots.includes(path);
      const beforeSnapshot = snapshot ? await hitCounts() : null;
      const cache = path === "/openapi.json" ? "public, max-age=3600" : "public";
      const first = await compare(path, 200, { headers: moderator, cache });
      const guest = await compare(path, 200, {
        cache,
        headers: snapshot ? { origin: "https://example.invalid" } : undefined,
      });
      const body = JSON.parse(first[0].body);
      if (path === publicList) {
        assert.deepEqual(body.meta, { current_page: 1, per_page: 1, total: 1, last_page: 1 });
        assert.deepEqual(Object.keys(body.data[0]), eventFields);
        assert.equal(body.data[0].event_key, published);
      }
      if (path === publicEvent(published)) assert.deepEqual(Object.keys(body), eventFields);
      if (path === publicSnapshots[0]) {
        assert.deepEqual(body, { member_count: null, online_count: null, ranks: [] });
      }
      if (path === publicSnapshots[1]) {
        assert.deepEqual(Object.keys(body), ["intro", "invite_url"]);
        assert.ok(body.intro.length > 0);
        assert.equal(body.invite_url, FALLBACK_INVITE);
      }
      if (path === "/openapi.json") {
        assert.equal(body.openapi, "3.1.0");
        assert.equal(body.servers[0].url, hono.origin);
        assert.deepEqual(Object.keys(body.paths).sort(), [
          "/api/public/community",
          "/api/public/events",
          "/api/public/events/{key}",
          "/api/public/join",
        ]);
      }
      for (const [index, { body, etag }] of guest.entries()) {
        assert.deepEqual(
          { body, etag },
          { body: first[index].body, etag: first[index].etag },
          `${path}: cookie-independent bytes and validator`,
        );
        assert.match(etag ?? "", /^"[a-f0-9]{40}"$/);
        assert.ok(!body.includes(draftTitle) && !body.includes(draft));
      }
      const [head] = await compare(path, 200, { method: "HEAD", cache });
      assert.equal(head.etag, first[0].etag);
      await compare(path, 304, { method: "HEAD", ownEtag: first.map(({ etag }) => etag), cache });
      if (beforeSnapshot) {
        await compare(path, 304, { ownEtag: first.map(({ etag }) => `W/${etag}`), cache });
        assert.deepEqual(
          await hitCounts(),
          beforeSnapshot.map(({ bucket, hits }) => ({ bucket, hits: hits + 5 })),
        );
      }
    }
    // Four requests per event route, five per snapshot. Discovery is budget-free.
    assert.deepEqual(
      await hitCounts(),
      beforePublic.map(({ bucket, hits }) => ({ bucket, hits: hits + 18 })),
    );
    for (const key of [missing, draft]) {
      const [refusal] = await compare(publicEvent(key), 404, {
        headers: { ...moderator, "if-none-match": "*" },
        cache: "no-store, private",
      });
      assert.equal(JSON.parse(refusal.body).error.code, "not_found");
      assert.ok(!refusal.body.includes(draft) && !refusal.body.includes(draftTitle));
    }
    await compare(publicEvent(published.toLowerCase()), 422, { cache: "no-store, private" });
    const calendarPath = `${event(published)}.ics`;
    const [calendar] = await compare(calendarPath, 200);
    const combinedCases = [
      [calendarPath, calendar],
      [event(published), detail[0], member],
    ];
    for (const [index, [path, expected, headers]] of combinedCases.entries()) {
      const result = await read(combinedOn, path, { headers });
      assert.equal(result.response.status, 200, path);
      assert.equal(result.response.headers.get("x-two-renderer"), "kit", path);
      assert.equal(
        result.response.headers.get("content-type"),
        expected.headers.get("content-type"),
        path,
      );
      assert.equal(result.body, expected.body, path);
      assert.deepEqual(
        await hitCounts([combinedBucket]),
        [{ bucket: combinedBucket, hits: index + 1 }],
        `${path}: combined rollout charges the shared read bucket once`,
      );
    }
    const { response } = await read(eventJsonOn, "/events/past");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-two-renderer"), "kit");

    // Fill the real shared window. Cached JSON and correct validators cannot
    // bypass admission, and refusals must leave the bucket unchanged.
    await sql`delete from web_throttle_hits where bucket in ${sql(buckets)}`;
    for (const bucket of buckets) {
      await sql`insert into web_throttle_hits (bucket) select ${bucket} from generate_series(1, 60)`;
    }
    for (const path of [collection, ...publicSnapshots]) {
      for (const method of ["GET", "HEAD"]) {
        await compare(path, 429, {
          method,
          headers: { "if-none-match": "*" },
          cache: "no-store, private",
        });
      }
    }
    assert.deepEqual(
      await hitCounts(),
      buckets
        .map((bucket) => ({ bucket, hits: 60 }))
        .sort((a, b) => a.bucket.localeCompare(b.bucket)),
    );

    console.log(
      "PASS built Worker API-4 JSON and OpenAPI inventory, ownership, wire parity and privacy",
    );
  } finally {
    try {
      if (seeded) await sql`delete from events where event_key in ${sql([published, draft])}`;
      if (sessions.length) await sql`delete from web_sessions where token_hash in ${sql(sessions)}`;
      await sql`delete from web_throttle_hits where bucket in ${sql([...buckets, combinedBucket])}`;
    } finally {
      await sql.end();
    }
  }
}
