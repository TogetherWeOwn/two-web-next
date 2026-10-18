// Acceptance: the ordinary-login callback fails closed to the invite
// fallback when the Discord bot token is missing, exactly as it already
// does for a blank token. A Workers binding that was never set reads back
// as `undefined`, not "", so "unset" here means the env double carries no
// DISCORD_BOT_TOKEN key at all. Sign-in must still succeed (302, session
// issued) with member false and moderator false, must land on the
// join-failed recovery notice that carries the invite fallback, must never
// answer 500, and must not call Discord's member endpoints (no
// "Bot undefined" probe) or leak any token material into logs or the
// response. Every Discord call is mocked; no database is touched.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import app from "./app";
import type { Env } from "../src/env";
import { createMemorySessionStore, type SessionStore, type Sql } from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const USER_ID = "420000000000000042";
const MOD_ROLE = "1546777856984481792";
const BOT_TOKEN_SENTINEL = "bot-token-sentinel";
const ACCESS_TOKEN_SENTINEL = "user-access-token-sentinel";

const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: BOT_TOKEN_SENTINEL,
  DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
  SESSION_SECRET,
};

// In-memory Sql double for the throttle statements — same shape as
// test/login-return.test.ts.
function fakeSql() {
  const sql = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (head.includes("INSERT INTO web_throttle_hits")) return [];
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) return [];
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return withThrottleTx(sql);
}

type BotTokenMode = "unset" | "blank" | "spaces" | "present";

function isolated(mode: BotTokenMode) {
  const store = createMemorySessionStore();
  const raw: Record<string, unknown> = {
    ...baseEnv,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fakeSql() },
  };
  if (mode === "unset") delete raw.DISCORD_BOT_TOKEN;
  if (mode === "blank") raw.DISCORD_BOT_TOKEN = "";
  if (mode === "spaces") raw.DISCORD_BOT_TOKEN = "   ";
  return { store, env: raw as unknown as Env };
}

/** Capture the session rows issueSession writes, to prove member/moderator. */
function captureIssuedSessions(store: SessionStore) {
  const created: { userId: string; member: boolean; moderator: boolean }[] = [];
  const origCreate = store.create.bind(store);
  const origReplace = store.replace.bind(store);
  store.create = async (s) => {
    created.push({ userId: s.userId, member: s.member, moderator: s.moderator });
    return origCreate(s);
  };
  store.replace = async (oldHash, s) => {
    created.push({ userId: s.userId, member: s.member, moderator: s.moderator });
    return origReplace(oldHash, s);
  };
  return created;
}

type RecordedCall = { url: string; method: string; authorization: string | null };

/**
 * Discord stub that would fully succeed if the bot paths ran: exchange and
 * identity answer, the member PUT adds (201) and the member GET reports the
 * moderator role. If a missing-token callback still answers member false and
 * moderator false, it failed closed instead of using the absent token.
 */
function mockDiscord() {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
      });
      if (url.endsWith("/oauth2/token"))
        return Response.json({ access_token: ACCESS_TOKEN_SENTINEL });
      if (url.endsWith("/users/@me"))
        return Response.json({
          id: USER_ID,
          username: "rick",
          global_name: "Rick",
          avatar: null,
        });
      if (url.includes(`/members/${USER_ID}`) && init?.method === "PUT")
        return new Response(null, { status: 201 });
      if (url.includes(`/members/${USER_ID}`))
        return Response.json({ roles: [MOD_ROLE], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

type Jar = Record<string, string>;
const jarFrom = (res: Response, into: Jar = {}): Jar => {
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(";");
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq);
    const value = pair!.slice(eq + 1);
    if (value === "" || attrs.some((a) => /max-age=0/i.test(a.trim()))) delete into[name];
    else into[name] = value;
  }
  return into;
};
const sendJar = (j: Jar) =>
  Object.entries(j)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

/** Run the full ordinary-login round trip against one env double. */
async function loginRoundTrip(env: Env) {
  const start = await app.request("/auth/discord", {}, env);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  const jar = jarFrom(start);
  const cb = await app.request(
    `/auth/discord/callback?code=abc&state=${state}`,
    { headers: { cookie: sendJar(jar) } },
    env,
  );
  return { cb, jar: jarFrom(cb, jar) };
}

function captureConsole() {
  const lines: string[] = [];
  const render = (args: unknown[]) =>
    args
      .map((a) => {
        if (a instanceof Error) return `${a.name} ${a.message} ${a.stack ?? ""}`;
        try {
          return JSON.stringify(a) ?? String(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
  const spies = (["log", "info", "debug", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(render(args));
    }),
  );
  return {
    text: () => lines.join("\n"),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("login callback with no usable bot token (fail closed to invite fallback)", () => {
  it.each(["unset", "blank", "spaces"] as const)(
    "bot token %s: 302 sign-in via invite fallback, member false, moderator false, no 500",
    async (mode) => {
      const calls = mockDiscord();
      const { store, env } = isolated(mode);
      if (mode === "unset") {
        // Fixture self-check: the double really carries no token binding,
        // the way an unset Workers variable presents to the callback.
        expect("DISCORD_BOT_TOKEN" in (env as unknown as Record<string, unknown>)).toBe(false);
      }
      const created = captureIssuedSessions(store);
      const logs = captureConsole();
      try {
        const { cb, jar } = await loginRoundTrip(env);

        // Sign-in succeeds: never a 500, a real session is issued, and the
        // landing is the join-failed recovery (not a failure or success
        // notice) so the member hears why and gets the invite fallback.
        expect(cb.status).toBe(302);
        expect(cb.headers.get("location")).toBe("/?n=join_failed");
        expect(created).toEqual([{ userId: USER_ID, member: false, moderator: false }]);
        expect(jar["__Host-two_session"]).toBeTruthy();

        // Fail closed before any bot call: only the OAuth exchange and the
        // identity lookup ran — no member PUT/GET, so no credential of the
        // form "Bot undefined" (or a blank one) ever left the callback.
        expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
          "POST /api/v10/oauth2/token",
          "GET /api/v10/users/@me",
        ]);
        expect(
          calls.some((c) => c.url.includes("/members/") || c.authorization?.startsWith("Bot ")),
        ).toBe(false);

        // The landing actually offers the invite fallback to this signed-in
        // non-member, and nothing token-shaped appears in what they see.
        const landing = await app.request(
          "/?n=join_failed",
          { headers: { cookie: sendJar(jar) } },
          env,
        );
        expect(landing.status).toBe(200);
        const html = await landing.text();
        expect(html).toContain("couldn&#39;t add you to the Discord automatically");
        expect(html).toContain("Join with an invite link instead");
        expect(html).toContain("https://discord.gg/invite");
        expect(html).not.toContain(BOT_TOKEN_SENTINEL);
        expect(html).not.toContain(ACCESS_TOKEN_SENTINEL);
        expect(html).not.toContain("DISCORD_BOT_TOKEN");
      } finally {
        logs.restore();
      }

      // No token value, access token, or env-var presence probe in any log
      // line the round trip produced (the expected bounded warn may name
      // the failure, never the credential or the binding).
      const stream = logs.text();
      expect(stream).not.toContain(BOT_TOKEN_SENTINEL);
      expect(stream).not.toContain(ACCESS_TOKEN_SENTINEL);
      expect(stream).not.toContain("DISCORD_BOT_TOKEN");
      expect(stream).not.toContain("Bot undefined");
    },
  );

  it("control, bot token present: auto-join and moderator recompute still run", async () => {
    const calls = mockDiscord();
    const { store, env } = isolated("present");
    const created = captureIssuedSessions(store);

    const { cb } = await loginRoundTrip(env);

    // The present-token path is untouched by the missing-token hardening:
    // the bot adds the member, the moderator role is honored, and the
    // landing is the joined notice. A fix that always fails closed (or that
    // skips the bot calls when a token exists) breaks this control.
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/?n=joined");
    expect(created).toEqual([{ userId: USER_ID, member: true, moderator: true }]);
    const botCalls = calls.filter((c) => c.url.includes("/members/"));
    expect(botCalls.map((c) => c.method)).toEqual(["PUT", "GET"]);
    expect(botCalls.every((c) => c.authorization === `Bot ${BOT_TOKEN_SENTINEL}`)).toBe(true);
  });
});
