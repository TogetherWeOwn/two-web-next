import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";
import { withFixtureCleanup } from "./kit-worker-lifecycle.mjs";

const keys = {
  published: "01J0000000000000000000A001",
  draft: "01J0000000000000000000A002",
  cancelled: "01J0000000000000000000A003",
  past: "01J0000000000000000000A004",
  missing: "01J0000000000000000000A005",
};
const titleFor = (status) => `Synthetic Markdown ${status}`;
const detail = (key) => `/e/${key}.md`;
const markdownType = "text/markdown; charset=utf-8";
const wireHeaders = [
  "content-type",
  "cache-control",
  "etag",
  "vary",
  "location",
  "allow",
  "x-robots-tag",
  "content-security-policy",
  "referrer-policy",
  "x-content-type-options",
];

export function withEventMarkdownDatabaseCleanup(run, sql, sessionHash, buckets) {
  const failureMessage = "Event Markdown fixture database cleanup failed";
  return withFixtureCleanup(
    run,
    async () => {
      try {
        try {
          await sql`delete from web_sessions where token_hash = ${sessionHash}`;
          await sql`delete from events where event_key in ${sql(Object.values(keys))}`;
          if (buckets.length)
            await sql`delete from web_throttle_hits where bucket in ${sql(buckets)}`;
        } finally {
          await sql.end();
        }
      } catch {
        throw new Error(failureMessage);
      }
    },
    () => console.error(failureMessage),
  );
}

export async function assertEventMarkdownParity({
  hono,
  kit,
  startKit,
  assertEventDetail,
  databaseUrl,
}) {
  const [off, on] = await Promise.all(
    ["false", "true"].map((flag) =>
      startKit(`kit-event-markdown-${flag}`, {
        APP_URL: hono.origin,
        KIT_ROUTE_EVENT_MARKDOWN: flag,
        KIT_ROUTE_PUBLIC_API: flag,
        KIT_PARITY_FIXTURE_EVENT_DETAIL: "true",
        E2E_PUBLIC_READ_BUDGET: "3",
      }),
    ),
  );
  const sql = postgres(databaseUrl, { max: 1 });
  const token = `two_${randomBytes(32).toString("base64url")}`;
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const buckets = [];
  function fixtureClient() {
    const ip = `198.51.100.${120 + buckets.length}`;
    buckets.push(`events-read:${ip}`);
    return { "cf-connecting-ip": ip, "x-forwarded-for": ip };
  }

  async function request(target, path, { status, owner = null, method = "GET", headers = {} }) {
    const label = `${target.name}: ${method} ${path}`;
    const result = await fetch(`${target.origin}${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { origin: hono.origin, ...headers },
    });
    const body = await result.text();
    assert.equal(result.status, status, label);
    assert.equal(result.headers.get("x-two-renderer"), owner, `${label}: route owner`);
    assert.ok(result.headers.get("x-request-id"), `${label}: request correlation`);
    assert.ok(result.headers.get("content-security-policy"), `${label}: security policy`);
    assert.deepEqual(result.headers.getSetCookie(), [], `${label}: no cookie effects`);
    if (method === "HEAD" || status === 304) assert.equal(body, "", `${label}: no body`);
    return { body, headers: result.headers };
  }

  async function parity(path, { native = true, headers = {}, ...options }) {
    const init = { ...options, headers: { ...fixtureClient(), ...headers } };
    const direct = await request(hono, path, init);
    for (const target of [off, on]) {
      const result = await request(target, path, {
        ...init,
        owner: target === on && native ? "kit" : null,
      });
      const normalize = ({ body, headers }) =>
        body
          .replaceAll(headers.get("x-request-id"), "REQUEST_ID")
          .replace(/nonce="[^"]+"/g, 'nonce="NONCE"');
      assert.equal(normalize(result), normalize(direct), `${target.name}: ${path} body`);
      for (const name of wireHeaders)
        assert.equal(
          result.headers.get(name),
          direct.headers.get(name),
          `${target.name}: ${path} ${name}`,
        );
    }
    return direct;
  }

  const run = async () => {
    for (const [status, key] of Object.entries(keys)) {
      if (status === "missing") continue;
      const starts = status === "past" ? "2020-01-01T18:00:00Z" : "2090-01-01T18:00:00Z";
      const ends = status === "past" ? "2020-01-01T20:00:00Z" : "2090-01-01T20:00:00Z";
      await sql`insert into events (event_key, title, status, starts_at, ends_at, timezone)
        values (${key}, ${titleFor(status)}, ${status}, ${starts}, ${ends}, 'UTC')`;
    }
    await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
      values (${sessionHash}, ${sessionHash}, '900000000000009136', 'Synthetic Markdown Moderator', true, true, now() + interval '15 minutes')`;
    const moderator = (
      await generateSignedCookie(SESSION_COOKIE, token, FIXTURE_SECRETS.SESSION_SECRET, {
        path: "/",
        secure: true,
      })
    ).split(";", 1)[0];

    for (const path of ["/events.md", detail(keys.published)]) {
      const initial = await parity(path, { status: 200 });
      assert.equal(initial.headers.get("content-type"), markdownType, path);
      assert.equal(initial.headers.get("cache-control"), "public, max-age=300", path);
      assert.equal(initial.headers.get("x-robots-tag"), "noindex, nofollow", path);
      assert.match(initial.body, /Synthetic Markdown published/, path);
      assert.doesNotMatch(initial.body, /Synthetic Markdown (draft|cancelled|past)/, path);
      const etag = `"${createHash("sha1").update(initial.body).digest("hex")}"`;
      assert.equal(initial.headers.get("etag"), etag, path);
      await parity(path, { status: 200, method: "HEAD" });
      for (const [method, validator] of [
        ["GET", `"other", W/${etag}`],
        ["HEAD", "*"],
      ]) {
        const result = await parity(path, {
          status: 304,
          method,
          headers: { "if-none-match": validator },
        });
        for (const name of ["cache-control", "etag", "x-robots-tag"])
          assert.equal(result.headers.get(name), initial.headers.get(name), `${path}: 304 ${name}`);
        assert.equal(result.headers.get("content-type"), null, `${path}: 304 media type`);
      }
      const absent = await request(kit, path, { status: 200, headers: fixtureClient() });
      assert.equal(absent.headers.get("content-type"), markdownType, `${path}: binding absent`);
    }

    for (const [status, name, body] of [
      [403, "draft", "Forbidden"],
      [404, "missing", "Not found"],
      [410, "cancelled", "Cancelled — this event was cancelled."],
      [200, "past", "- Status: past"],
    ]) {
      const result = await parity(detail(keys[name]), {
        status,
        headers: name === "past" ? {} : { "if-none-match": "*" },
      });
      assert.ok(result.body.includes(body), name);
      assert.equal(result.headers.get("content-type"), markdownType, name);
      assert.equal(result.headers.get("x-robots-tag"), "noindex, nofollow", name);
      if (status !== 200) {
        assert.match(result.headers.get("cache-control"), /no-store/, name);
        assert.equal(result.headers.get("etag"), null, name);
      }
    }
    for (const method of ["GET", "HEAD"]) {
      await parity(detail(keys.draft), {
        status: 403,
        method,
        headers: { cookie: moderator, "if-none-match": "*" },
      });
    }

    const path = detail(keys.published);
    const query = "?crawler=%2F&crawler=2";
    const redirected = await parity(`${detail(keys.published.toLowerCase())}${query}`, {
      status: 301,
    });
    assert.equal(redirected.headers.get("location"), `${path}${query}`);
    await parity(path.replace("01J", "%301J"), { status: 200 });
    const suffixAlias = path.replace(".md", "%2Emd");
    const mountAlias = path.replace("/e/", "/%65/");
    const canonicalAlias = await parity(`${mountAlias.toLowerCase()}${query}`, { status: 301 });
    assert.equal(canonicalAlias.headers.get("location"), `${path}${query}`);
    await parity(`${suffixAlias}${query}`, { status: 200 });
    await parity(mountAlias, { status: 200, method: "HEAD" });
    await parity(path.replace("/e/", "/%65/").replace(".md", "%2Emd"), {
      status: 304,
      method: "HEAD",
      headers: { "if-none-match": "*" },
    });

    const nested = path.replace(".md", "/extra.md");
    for (const spelling of [
      nested,
      "/e//.md",
      "/e/a%2Fb.md",
      "/e/a%2fb%2Emd",
      detail("bad%ZZ"),
      "/e/%FF/extra.md",
    ]) {
      const error = await parity(`${spelling}${query}`, {
        status: 404,
        headers: { "if-none-match": "*" },
      });
      assert.equal(error.body, "Not found", spelling);
      assert.equal(error.headers.get("content-type"), markdownType, spelling);
      assert.equal(error.headers.get("cache-control"), "no-store, private", spelling);
      assert.equal(error.headers.get("etag"), null, spelling);
      assert.equal(error.headers.get("x-robots-tag"), "noindex, nofollow", spelling);
    }
    await parity(`${nested}${query}`, { status: 404, method: "HEAD" });
    const absent = await request(kit, nested, { status: 404, headers: fixtureClient() });
    assert.equal(absent.headers.get("content-type"), markdownType, `${nested}: binding absent`);
    const lineBreak = await parity(detail("bad%0Akey"), { status: 404, native: false });
    assert.match(lineBreak.headers.get("content-type"), /^text\/html/);
    for (const miss of [
      `${nested}/`,
      `${nested}/__data.json`,
      "/e/a%0A/b.md",
      "/e%2Fa/b.md",
      "/e/a/b.MD",
      "/api/e/a/b.md",
    ]) {
      const error = await parity(miss, { status: 404, native: false });
      assert.match(error.headers.get("content-type"), /^text\/html/, miss);
    }
    await parity(nested, { status: 404, native: false, method: "POST" });
    const rsvp = await parity(`/e/${keys.published}/rsvp`, {
      status: 303,
      native: false,
      method: "POST",
    });
    assert.equal(rsvp.headers.get("location"), `/join/discord?next=%2Fe%2F${keys.published}`);
    await parity(`${path}/`, { status: 404, native: false });
    await parity(`${path}/__data.json`, { status: 404, native: false });
    await parity(path, { status: 404, native: false, method: "POST" });
    for (const target of [off, on]) {
      const page = await request(target, `/e/${keys.published}`, {
        status: 200,
        owner: "kit",
        headers: fixtureClient(),
      });
      assert.match(page.headers.get("content-type"), /^text\/html/);
      const bare = await request(target, "/e/.md", {
        status: 404,
        owner: "kit",
        headers: fixtureClient(),
      });
      assert.match(bare.headers.get("content-type"), /^text\/html/);
    }

    async function hits(bucket, expected) {
      const [{ count }] =
        await sql`select count(*)::int from web_throttle_hits where bucket = ${bucket}`;
      assert.equal(count, expected, "one shared events-read charge per admitted read");
    }
    for (const [conditionalPath, limitedPath] of [
      [path, path],
      [suffixAlias, nested],
    ]) {
      const headers = { ...fixtureClient(), accept: "application/json" };
      const bucket = buckets.at(-1);
      await request(off, "/events.md", { status: 200, headers });
      await hits(bucket, 1);
      await request(on, conditionalPath, {
        status: 304,
        owner: "kit",
        headers: { ...headers, "if-none-match": "*" },
      });
      await hits(bucket, 2);
      await request(on, "/api/public/events", { status: 200, owner: "kit", headers });
      await hits(bucket, 3);
      for (const target of [off, on]) {
        const result = await request(target, limitedPath, {
          status: 429,
          owner: target === on ? "kit" : null,
          headers: { ...headers, "if-none-match": "*" },
        });
        assert.match(result.headers.get("retry-after"), /^[1-9]\d*$/);
        assert.equal(result.headers.get("cache-control"), "no-store, private");
        assert.equal(result.headers.get("etag"), null);
      }
      await hits(bucket, 3);
    }
    console.log(
      "PASS installed Worker legacy event Markdown suffix, redirects and neighboring routes",
    );
    console.log(
      "PASS installed Worker event Markdown fallback, wire parity, suffix precedence and shared read budget",
    );
    await assertEventDetail({ key: keys.past, title: titleFor("past"), headers: fixtureClient() });
  };
  await withEventMarkdownDatabaseCleanup(run, sql, sessionHash, buckets);
}
