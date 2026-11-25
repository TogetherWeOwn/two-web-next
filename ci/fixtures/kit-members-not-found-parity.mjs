import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { signedCookieHeader } from "../../src/http/signed-cookie.ts";
import { SESSION_COOKIE } from "../../src/session-cookie.ts";
import postgres from "postgres";

const query = "?q=fixture-eligibility-canary&filter=guides&page=2";
const parityHeaders = [
  "cache-control",
  "content-type",
  "content-security-policy",
  "location",
  "vary",
  "etag",
  "x-robots-tag",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
];

async function read(worker, path, method = "GET", cookie, accept = "application/json") {
  const response = await fetch(worker.origin + path, {
    method,
    redirect: "manual",
    headers: { origin: worker.origin, accept, ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  assert.ok(response.headers.get("x-request-id"), "request correlation survives");
  return {
    status: response.status,
    renderer: response.headers.get("x-two-renderer"),
    cookies: response.headers.getSetCookie(),
    headers: Object.fromEntries(parityHeaders.map((name) => [name, response.headers.get(name)])),
    body: await response.text(),
  };
}

// Run only against the installed Worker and the runner's disposable database.
export async function assertMembersNotFoundParity({ hono, off, on, databaseUrl, secret }) {
  // The positive control writes an append-only audit row. Use a fresh range
  // so repeat fixture runs on the same disposable database stay independent.
  const namespace = `900000${String(randomInt(10 ** 12)).padStart(12, "0")}`;
  const owner = `${namespace}0`;
  const viewers = [1, 2, 3].map((suffix) => `${namespace}${suffix}`);
  const profilePath = `/members/${owner}`;
  const privateContent = new RegExp(
    `fixture-eligibility-canary|Synthetic (?:retired profile|viewer)|${namespace}[0-3]`,
  );
  const sql = postgres(databaseUrl, { max: 1 });
  const sessions = await Promise.all(
    viewers.map(async (id, index) => {
      const token = `two_${randomBytes(32).toString("base64url")}`;
      const hash = createHash("sha256").update(token).digest("hex");
      const cookie = (await signedCookieHeader(SESSION_COOKIE, token, secret)).split(";", 1)[0];
      return { id, hash, cookie, member: index !== 0, mod: index === 2 };
    }),
  );
  const auditRows = async () => [
    ...(await sql`
      select route, subject_user_ids from member_data_access_logs where viewer_discord_id in ${sql(viewers)}`),
  ];
  const sessionRows = async () => [
    ...(await sql`
      select token_hash, expires_at, roles_checked_at from web_sessions
      where user_id in ${sql(viewers)} order by user_id`),
  ];
  let seeded = false;
  try {
    await sql.begin(async (tx) => {
      const [existing] = await tx`
        select exists(
          select 1 from web_sessions where user_id in ${tx(viewers)}
          union all
          select 1 from web_session_grace where user_id in ${tx(viewers)}
          union all
          select 1 from member_data_access_logs where viewer_discord_id in ${tx(viewers)}
        ) as occupied`;
      assert.equal(existing.occupied, false, "synthetic viewers must be unused");
      await tx`insert into users (id, username, member) values (${owner}, 'Synthetic retired profile', true)`;
      await tx`insert into profiles (user_id, bio, leaderboard_opt_out)
        values (${owner}, 'Synthetic retired profile contents', true)`;
      for (const { id, hash, member, mod } of sessions) {
        await tx`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at, roles_checked_at)
          values (${hash}, ${id}, 'Synthetic viewer', ${member}, ${mod}, now() + interval '10 minutes', now())`;
      }
    });
    seeded = true;

    const active = await sessionRows();
    assert.deepEqual(
      active.map(({ token_hash }) => token_hash),
      sessions.map(({ hash }) => hash),
    );
    const reference = await read(hono, "/members");
    assert.equal(reference.status, 404);
    assert.equal(reference.headers["cache-control"], "no-store, private");
    assert.match(reference.headers["content-type"], /^text\/html; charset=utf-8$/i);
    assert.equal(reference.headers.location, null);
    assert.deepEqual(reference.cookies, []);
    assert.match(reference.body, /data-testid="error-join"/);
    assert.doesNotMatch(reference.body, privateContent);
    const cookies = [undefined, "__Host-two_session=malformed", ...sessions.map((s) => s.cookie)];
    for (const path of ["/members", "/members/", `/members${query}`, `/members/${query}`]) {
      for (const method of ["GET", "HEAD"]) {
        const expected = { ...reference, body: method === "HEAD" ? "" : reference.body };
        for (const cookie of cookies) {
          assert.deepEqual(
            await read(off, path, method, cookie),
            expected,
            `${method} ${path} off`,
          );
          assert.deepEqual(
            await read(on, path, method, cookie),
            { ...expected, renderer: "kit" },
            `${method} ${path} on`,
          );
        }
      }
    }
    assert.deepEqual(await sessionRows(), active);
    assert.deepEqual(await auditRows(), []);

    // The neighboring profile, aliases, data URLs and unsafe methods retain Hono.
    for (const [path, method, status, location] of [
      [profilePath, "GET", 302, "/auth/discord"],
      [`${profilePath}/__data.json`, "GET", 302, "/auth/discord"],
      ["/members/__data.json", "GET", 302, "/auth/discord"],
      ["/%6dembers", "GET", 404, null],
      ["/members/", "POST", 401, null],
      [`/__browser_fixture__${query}`, "GET", 404, null],
    ]) {
      const result = await read(on, path, method);
      assert.equal(result.status, status, `${method} ${path}`);
      assert.equal(result.renderer, null);
      assert.equal(result.headers.location, location);
      assert.doesNotMatch(result.body, privateContent);
    }
    const form = await read(on, "/members/", "POST", undefined, "text/html");
    assert.equal(form.status, 303);
    assert.equal(form.renderer, null);
    assert.equal(form.headers.location, "/auth/recover?next=%2Fprofile");
    assert.doesNotMatch(form.body, privateContent);
    for (const path of [profilePath, `${profilePath}/__data.json`]) {
      const denied = await read(on, path, "GET", sessions[0].cookie);
      assert.equal(denied.status, 403);
      assert.equal(denied.renderer, null);
      assert.deepEqual(denied.cookies, []);
      assert.doesNotMatch(denied.body, privateContent);
    }
    assert.deepEqual(await auditRows(), []);
    const allowed = await read(on, profilePath, "GET", sessions[1].cookie);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.renderer, null);
    assert.match(allowed.body, /Synthetic retired profile contents/);
    assert.deepEqual(await auditRows(), [{ route: "profiles.show", subject_user_ids: [owner] }]);
    console.log("PASS installed Kit retired members 404 parity and adjacent profile privacy");
  } finally {
    try {
      if (seeded) {
        await sql.begin(async (tx) => {
          await tx`delete from web_session_grace where user_id in ${tx(viewers)}`;
          await tx`delete from web_sessions where user_id in ${tx(viewers)}`;
          // The synthetic access receipt expires with the disposable database.
          await tx`delete from profiles where user_id = ${owner}`;
          await tx`delete from users where id = ${owner}`;
        });
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
