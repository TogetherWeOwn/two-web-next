import assert from "node:assert/strict";
import { signedCookieHeader } from "../../src/http/signed-cookie.ts";
import { SESSION_COOKIE } from "../../src/session-cookie.ts";
import { hashToken, newSessionToken } from "../../src/sessions.ts";
import postgres from "postgres";

const owner = "900000000000091960";
const viewers = ["900000000000091961", "900000000000091962", "900000000000091963"];
const profilePath = `/members/${owner}`;
const query = "?q=fixture-eligibility-canary&filter=guides&page=2";
const privateContent = /fixture-eligibility-canary|Synthetic retired profile|90000000000009196\d/;
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

async function read(worker, path, method = "GET", cookie) {
  const response = await fetch(worker.origin + path, {
    method,
    redirect: "manual",
    headers: { origin: worker.origin, accept: "application/json", ...(cookie ? { cookie } : {}) },
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
  const sql = postgres(databaseUrl, { max: 1 });
  const sessions = await Promise.all(
    viewers.map(async (id, index) => {
      const token = newSessionToken();
      const cookie = (await signedCookieHeader(SESSION_COOKIE, token, secret)).split(";", 1)[0];
      return { id, hash: await hashToken(token), cookie, member: index !== 0, mod: index === 2 };
    }),
  );
  const auditRows = () => sql`
    select route, subject_user_ids from member_data_access_logs where viewer_discord_id in ${sql(viewers)}`;
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
    const active = await sql`select token_hash from web_sessions where user_id in ${sql(viewers)}`;
    assert.deepEqual(
      active.map(({ token_hash }) => token_hash).sort(),
      sessions.map(({ hash }) => hash).sort(),
    );
    assert.deepEqual(await auditRows(), []);

    // The neighboring profile, aliases, data URLs and unsafe methods retain Hono.
    for (const [path, method, status, location] of [
      [profilePath, "GET", 302, "/auth/discord"],
      [`${profilePath}/__data.json`, "GET", 302, "/auth/discord"],
      ["/members/__data.json", "GET", 302, "/auth/discord"],
      ["/%6dembers", "GET", 404, null],
      ["/members/", "POST", 303, "/auth/recover?next=%2Fprofile"],
      [`/__browser_fixture__${query}`, "GET", 404, null],
    ]) {
      const result = await read(on, path, method);
      assert.equal(result.status, status, `${method} ${path}`);
      assert.equal(result.renderer, null);
      assert.equal(result.headers.location, location);
      assert.doesNotMatch(result.body, privateContent);
    }
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
          await tx`delete from member_data_access_logs where viewer_discord_id in ${tx(viewers)}`;
          await tx`delete from profiles where user_id = ${owner}`;
          await tx`delete from users where id = ${owner}`;
        });
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
