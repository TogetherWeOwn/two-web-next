// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
// route-inventory: GET /auth/status
// TOG-12272: prove join signed-in re-entry on the one-click path.
//
// Ledger `docs/w15-auth-tests.md` JoinDenialMatrix row: duplicate-callback
// idempotence and the blank-bot guarantee are already proven on the join path
// by `test/auth-admission.test.ts` (original-cookie replay, one session / one
// attempt row, memory + Postgres) and `test/join-blank-bot.test.ts` (zero
// bot-credentialed calls, recovery, no member session). What neither proves
// is the re-entry the card names: an already-signed-in member going through
// the join journey again. This file pins that combination only:
//
//   1. hitting `/join/discord` with a live session still issues a fresh
//      journey (302 to Discord) with no session side effects;
//   2. completing the callback with the prior session presented replaces it
//      atomically (create x0, replace x1), leaves exactly one live session,
//      and honors the guarded `next`;
//   3. chaining a second full re-join on the fresh session still leaves
//      exactly one live session (no accumulation);
//   4. replaying the consumed callback issues nothing further (no session,
//      no fetch, no extra attempt row).
//
// Scope guard: test-only. Must not import or edit `src/join/route.ts`,
// `src/join/service.ts`, `src/sessions.ts`, `src/return-journey.ts`,
// `src/index.tsx`, `test/join.test.ts` or `test/auth-acceptance.test.ts`.
// Drives the mounted app (`test/app.ts`) with stubbed fetch, no live Discord.
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "../src/sessions";

const SECRET = "test-session-secret-at-least-32-bytes-long";
const SESSION_COOKIE = "__Host-two_session";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: SECRET,
  DISCORD_MODERATOR_ROLE_IDS: "",
};

const jarOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

const sessionCookieOf = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));

const bearerOf = (res: Response) =>
  decodeURIComponent(
    sessionCookieOf(res)!
      .split(";")[0]!
      .slice(SESSION_COOKIE.length + 1),
  ).split(".")[0]!;

// In-memory Sql double for the journey's two statements. Mirrors
// test/join.test.ts; anything else is a test bug, surfaced loudly.
function fakeSql() {
  const throttle: { bucket: string; at: number }[] = [];
  const attempts: {
    outcome: string;
    source: string | null;
    requestId: string | null;
    discordId: string | null;
  }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("count(*)")) {
      const [bucket] = values as [string];
      const cutoff = Date.now() - 60_000;
      const rows = throttle.filter((r) => r.bucket === bucket && r.at > cutoff);
      const wait =
        rows.length === 0
          ? 1
          : Math.max(
              1,
              Math.ceil((Math.min(...rows.map((r) => r.at)) + 60_000 - Date.now()) / 1000),
            );
      return [{ n: rows.length, wait }];
    }
    if (head.includes("INSERT INTO web_throttle_hits")) {
      throttle.push({ bucket: values[0] as string, at: Date.now() });
      return [];
    }
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) {
      const [outcome, source, requestId, discordId] = values as [
        string,
        string | null,
        string | null,
        string | null,
      ];
      attempts.push({ outcome, source, requestId, discordId });
      return [];
    }
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql, attempts };
}

/** Fresh memory session store with instrumented session writes, per test. */
function isolated() {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const create = vi.fn(store.create.bind(store));
  const replace = vi.fn(store.replace.bind(store));
  const instrumented = { ...store, create, replace };
  const e = {
    ...env,
    SESSION_STORE: instrumented,
    JOIN_DEPS: { store: async () => withThrottleTx(fake.sql) },
  } as unknown as Env;
  return { store, create, replace, fake, env: e };
}

/** Mint a live member session row and return its bearer cookie jar. */
async function mintPriorSession(store: SessionStore, userId = "42") {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await store.create({
    tokenHash,
    userId,
    username: "Signed-in member",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const session = (
    await serializeSigned(SESSION_COOKIE, token, SECRET, { path: "/", secure: true })
  ).split(";")[0]!;
  const status = (
    await serializeSigned(AUTH_STATUS_COOKIE, tokenHash, SECRET, { path: "/", secure: true })
  ).split(";")[0]!;
  return { token, tokenHash, jar: `${session}; ${status}` };
}

function mockDiscord() {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token" });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && init?.method === "PUT")
        return new Response(null, { status: 201 });
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("join signed-in re-entry (TOG-12272)", () => {
  it("a signed-in start still issues a fresh journey with no session side effects", async () => {
    const { store, create, replace, env: e } = isolated();
    mockDiscord();
    const prior = await mintPriorSession(store);

    const start = await app.request(
      "/join/discord?next=/events",
      {
        headers: { cookie: prior.jar },
      },
      e,
    );
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(location.searchParams.get("state")).toMatch(/^[0-9a-f-]{36}$/);

    // The start is session-blind: no session minted, replaced or consulted.
    expect(create).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(sessionCookieOf(start)).toBeUndefined();
    // The guarded next survives onto the journey for the callback to honor.
    expect(start.headers.getSetCookie().join("\n")).toContain("__Host-two_join_next=");
    // The presented session is untouched and still live.
    expect(await store.get(prior.tokenHash)).not.toBeNull();
  });

  it("a re-entry callback replaces the prior session, honors the guarded next and records one attempt", async () => {
    const { store, create, replace, fake, env: e } = isolated();
    const calls = mockDiscord();
    const prior = await mintPriorSession(store);

    const start = await app.request("/join/discord?next=/events", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const path = `/join/callback?code=abc&state=${state}`;
    const cookie = `${jarOf(start)}; ${prior.jar}`;
    const res = await app.request(path, { headers: { cookie } }, e);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/events");
    expect(sessionCookieOf(res)).toBeDefined();

    // Exactly one session row turns over: no second session is created.
    expect(create).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(await store.get(prior.tokenHash)).toBeNull();
    const fresh = await store.get(await hashToken(bearerOf(res)));
    expect(fresh).toMatchObject({ userId: "42", member: true });
    expect(
      await (await app.request("/auth/status", { headers: { cookie: prior.jar } }, e)).json(),
    ).toEqual({ authenticated: false });
    expect(
      await (await app.request("/auth/status", { headers: { cookie: jarOf(res) } }, e)).json(),
    ).toEqual({ authenticated: true });

    expect(fake.attempts).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);

    // Replaying the byte-identical consumed callback issues nothing further:
    // no session, no extra Discord call, no extra attempt row.
    const fetchesBefore = calls.length;
    const replay = await app.request(path, { headers: { cookie } }, e);
    expect(sessionCookieOf(replay)).toBeUndefined();
    expect(calls).toHaveLength(fetchesBefore);
    expect(fake.attempts).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(await store.get(await hashToken(bearerOf(res)))).not.toBeNull();
  });

  it("a second chained re-join still leaves exactly one live session", async () => {
    const { store, create, replace, fake, env: e } = isolated();
    mockDiscord();
    const prior = await mintPriorSession(store);

    const firstStart = await app.request("/join/discord", {}, e);
    const firstState = new URL(firstStart.headers.get("location")!).searchParams.get("state")!;
    const first = await app.request(
      `/join/callback?code=abc&state=${firstState}`,
      { headers: { cookie: `${jarOf(firstStart)}; ${prior.jar}` } },
      e,
    );
    expect(first.headers.get("location")).toBe("/?n=joined");
    const firstHash = await hashToken(bearerOf(first));

    const secondStart = await app.request("/join/discord", {}, e);
    const secondState = new URL(secondStart.headers.get("location")!).searchParams.get("state")!;
    const second = await app.request(
      `/join/callback?code=abc&state=${secondState}`,
      { headers: { cookie: `${jarOf(secondStart)}; ${jarOf(first)}` } },
      e,
    );
    expect(second.headers.get("location")).toBe("/?n=joined");

    // Two admitted journeys, two replacements, zero creates: sessions never
    // accumulate across re-joins.
    expect(create).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(2);
    expect(await store.get(prior.tokenHash)).toBeNull();
    expect(await store.get(firstHash)).toBeNull();
    expect(await store.get(await hashToken(bearerOf(second)))).toMatchObject({
      userId: "42",
      member: true,
    });
    expect(fake.attempts.map((a) => a.outcome)).toEqual(["added", "added"]);
  });
});
