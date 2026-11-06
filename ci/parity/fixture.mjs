// Disposable database fixture for route-parity recordings. Every value here
// is a non-secret test constant: the database is a throwaway clone and the
// Worker runs only on loopback.
import { generateSignedCookie } from "hono/cookie";
import { EVENT_KEY, MEMBER_ID } from "./vectors.mjs";

export const FIXTURE_SECRETS = {
  SESSION_SECRET: "parity-fixture-session-secret-not-a-real-key-000000",
  QA_AUTH_TOKEN: "parity-fixture-qa-token-not-a-real-token-0000000000",
  OPS_CONTROL_TOKEN: "parity-fixture-ops-token-not-a-real-token-000000000",
  DISCORD_CLIENT_SECRET: "parity-fixture-unused-client-secret",
  DISCORD_BOT_TOKEN: "parity-fixture-unused-bot-token",
};
export const WRONG_QA_TOKEN = "parity-wrong-qa-token-same-length-as-the-real-one00";
export const SESSION_COOKIE = "__Host-two_session";
const FAR_FUTURE = "2099-12-31T00:00:00Z";
const LONG_PAST = "2020-01-02T00:00:00Z";

/** Minted bearer shape (`two_` + 43 base64url characters). */
const token = (label) => `two_${label.padEnd(43, "0")}`;
export const SESSIONS = {
  member: {
    token: token("parityMember"),
    userId: MEMBER_ID,
    username: "Parity Member",
    moderator: false,
  },
  moderator: {
    token: token("parityModerator"),
    userId: "900000000000001399",
    username: "Parity Moderator",
    moderator: true,
  },
  expired: {
    token: token("parityExpired"),
    userId: MEMBER_ID,
    username: "Parity Member",
    moderator: false,
  },
};

async function hashToken(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

/** Cookie header per identity; `forged` carries a bad signature. */
export async function identityCookies() {
  const signed = async (value) => {
    const header = await generateSignedCookie(
      SESSION_COOKIE,
      value,
      FIXTURE_SECRETS.SESSION_SECRET,
      { path: "/", secure: true },
    );
    return header.split(";")[0];
  };
  return {
    member: await signed(SESSIONS.member.token),
    moderator: await signed(SESSIONS.moderator.token),
    expired: await signed(SESSIONS.expired.token),
    forged: `${SESSION_COOKIE}=${encodeURIComponent(`${SESSIONS.member.token}.cGFyaXR5LWZvcmdlZA==`)}`,
  };
}

/** Seed the template database once. Rows mirror e2e/seed.mjs plus three sessions. */
export async function seedTemplate(sql) {
  const events = [
    [EVENT_KEY, "E2E Community Night", "2099-01-01T18:00:00Z", "2099-01-01T20:00:00Z"],
    [
      "01J00000000000000000000002",
      "E2E Past Night",
      "2020-01-01T18:00:00Z",
      "2020-01-01T20:00:00Z",
    ],
    [
      "01J00000000000000000000003",
      "E2E Calendar May",
      "2099-05-15T18:00:00Z",
      "2099-05-15T20:00:00Z",
    ],
    [
      "01J00000000000000000000004",
      "E2E Calendar June",
      "2099-06-15T18:00:00Z",
      "2099-06-15T20:00:00Z",
    ],
  ];
  for (const [key, title, starts, ends] of events) {
    await sql`
      insert into events (event_key, title, description, starts_at, ends_at, timezone, status, capacity, rsvp_open)
      values (${key}, ${title}, 'Route-parity fixture', ${starts}, ${ends}, 'UTC', 'published', 10, true)`;
  }
  for (const [name, session] of Object.entries(SESSIONS)) {
    const hash = await hashToken(session.token);
    const expired = name === "expired";
    // roles_checked_at in the far future: the 5-minute Discord role recheck
    // compares against the database clock and would otherwise start firing
    // part-way through a run.
    await sql`
      insert into web_sessions (token_hash, status_hash, user_id, username, avatar, member, moderator,
        expires_at, created_at, roles_checked_at)
      values (${hash}, ${hash}, ${session.userId}, ${session.username}, null, true, ${session.moderator},
        ${expired ? LONG_PAST : FAR_FUTURE}, ${expired ? LONG_PAST : FAR_FUTURE}, ${FAR_FUTURE})`;
  }
}

/** Per clone: live sessions start now, inside the database's 24-hour absolute cap. */
export async function refreshClone(sql) {
  await sql`update web_sessions set created_at = now() where expires_at > now()`;
}
