import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { KIT_EVENT_JSON_ROUTE } from "../../src/events/kit-json-routes.ts";
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
  const separateSlice = ["/events.json", "/api/public/community", "/api/public/join"];
  const remaining = map.rows.filter(
    ({ slice, path }) => slice === "API-4" && ![...coveredFeeds, ...separateSlice].includes(path),
  );
  const routes = [KIT_EVENT_JSON_ROUTE, ...KIT_PUBLIC_API_ROUTES];
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
  eventJsonOn,
  publicApiOn,
  databaseUrl,
}) {
  await assertInventory();
  const sql = postgres(databaseUrl, { max: 1 });
  const workers = [hono, unset, eventJsonOn, publicApiOn];
  const ips = new Map(workers.map((worker, index) => [worker, `192.0.2.${150 + index}`]));
  const buckets = [...ips.values()].map((ip) => `events-read:${ip}`);
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

  async function hitCounts() {
    const rows = await sql`select bucket, count(*)::int as hits from web_throttle_hits
      where bucket in ${sql(buckets)} group by bucket order by bucket`;
    return rows.map(({ bucket, hits }) => ({ bucket, hits }));
  }

  async function compare(path, status, { kit = true, headers, method, ownEtag, cache } = {}) {
    let baseline;
    const results = [];
    const enabled = path.startsWith("/events/") ? eventJsonOn : publicApiOn;
    for (const worker of workers) {
      const index = results.length;
      const requestHeaders = { ...headers };
      if (ownEtag) requestHeaders["if-none-match"] = ownEtag[index];
      if (method === "POST") requestHeaders.origin = worker === unset ? unset.origin : hono.origin;
      const { response, body } = await read(worker, path, { method, headers: requestHeaders });
      const label = `${worker.name}: ${method ?? "GET"} ${path}`;
      assert.equal(response.status, status, label);
      assert.equal(
        response.headers.get("x-two-renderer"),
        kit && worker === enabled ? "kit" : null,
        label,
      );
      assert.equal(response.headers.get("set-cookie"), null, label);
      if (method === "HEAD" || status === 304) assert.equal(body, "", label);
      const requestId = response.headers.get("x-request-id");
      assert.ok(requestId, label);
      let normalized = body
        .replaceAll(requestId, "REQUEST_ID")
        .replaceAll(worker.origin, hono.origin);
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
      results.push({ body, etag });
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

    await sql`insert into events (event_key, title, game, status, starts_at, ends_at, join_instructions)
      values (${published}, 'Synthetic API Published', ${game}, 'published', '2099-02-01 18:00+00', '2099-02-01 19:00+00', ${privateField}),
        (${draft}, ${draftTitle}, ${game}, 'draft', '2099-02-02 18:00+00', '2099-02-02 19:00+00', ${privateField})`;
    seeded = true;
    await sql`insert into rsvps (event_id, user_id, status)
      select id, ${memberId}, 'waitlisted' from events where event_key = ${published}`;
    const member = { cookie: await mintSession(memberId, false), accept: "application/json" };
    const moderator = { cookie: await mintSession(moderatorId, true), accept: "application/json" };

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
    for (const path of [publicList, publicEvent(published), "/openapi.json"]) {
      const cache = path === "/openapi.json" ? "public, max-age=3600" : "public";
      const first = await compare(path, 200, { headers: moderator, cache });
      const guest = await compare(path, 200, { cache });
      const body = JSON.parse(first[0].body);
      if (path === publicList) {
        assert.deepEqual(body.meta, { current_page: 1, per_page: 1, total: 1, last_page: 1 });
        assert.deepEqual(Object.keys(body.data[0]), eventFields);
        assert.equal(body.data[0].event_key, published);
      }
      if (path === publicEvent(published)) assert.deepEqual(Object.keys(body), eventFields);
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
          first[index],
          `${path}: cookie-independent bytes and validator`,
        );
        assert.match(etag ?? "", /^"[a-f0-9]{40}"$/);
        assert.ok(!body.includes(draftTitle) && !body.includes(draft));
      }
      await compare(path, 200, { method: "HEAD", cache });
      await compare(path, 304, { method: "HEAD", ownEtag: first.map(({ etag }) => etag), cache });
    }
    // Four requests per event route, including 304. Discovery is budget-free.
    assert.deepEqual(
      await hitCounts(),
      beforePublic.map(({ bucket, hits }) => ({ bucket, hits: hits + 8 })),
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
    await compare(`${event(published)}.ics`, 200);
    const { response } = await read(eventJsonOn, "/events/past");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-two-renderer"), "kit");

    console.log(
      "PASS built Worker API-4 JSON and OpenAPI inventory, ownership, wire parity and privacy",
    );
  } finally {
    try {
      if (seeded) await sql`delete from events where event_key in ${sql([published, draft])}`;
      if (sessions.length) await sql`delete from web_sessions where token_hash in ${sql(sessions)}`;
      await sql`delete from web_throttle_hits where bucket in ${sql(buckets)}`;
    } finally {
      await sql.end();
    }
  }
}
