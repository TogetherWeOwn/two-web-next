// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// TOG-12680: pin the blank-bot zero-call guarantee.
//
// Auth ledger (docs/w15-auth-tests.md, JoinDenialMatrix row) gap: an
// unconfigured/missing bot token must make zero bot-credentialed outbound
// Discord calls on both one-click join and ordinary login. Fail-closed: join
// renders recovery (no member session); login still signs in as non-member
// with recomputed (non-moderator) flags. No token/secret echo anywhere.
//
// Reading of "zero calls" pinned here: the OAuth exchange + user lookup still
// run (login needs the identity to sign in as non-member); the guarantee is
// zero `Bot <token>`-authenticated calls (PUT member add + GET role lookup).
// The member stubs below answer success WITH the moderator role so any emitted
// bot call would flip the outcome — the assertions prove none was emitted.
//
// Scope guard: test-only. Must not import or edit `src/join/route.ts`,
// `src/join/service.ts`, `src/sessions.ts`, `src/index.tsx`,
// `test/join.test.ts` or `test/auth-acceptance.test.ts` (PR #141/#314 hot).
// Drives the mounted app (`test/app.ts`) with stubbed fetch, no live Discord.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import type { Env } from "../src/env";
import type { EnvWithJoin } from "../src/join/route";
import { createMemorySessionStore, hashToken, type Sql } from "../src/sessions";
import { FALLBACK_INVITE } from "../src/invite";

const MOD_ROLE = "508654771276873729";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
};

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

// In-memory Sql double for the journey's two statements. Mirrors
// test/join.test.ts; anything else is a test bug, surfaced loudly.
function fakeSql() {
  const sql = (async (strings: TemplateStringsArray) => {
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

function isolated(botToken: string, inviteUrl?: string) {
  const store = createMemorySessionStore();
  const e = {
    ...baseEnv,
    DISCORD_BOT_TOKEN: botToken,
    ...(inviteUrl !== undefined ? { DISCORD_INVITE_URL: inviteUrl } : {}),
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fakeSql() },
  } as unknown as Env;
  return { store, env: e };
}

// Member stubs answer success WITH the moderator role: any emitted bot call
// would sign the join in as a member and grant moderator — the assertions
// below prove no bot call was emitted.
function mockDiscord() {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token" });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && (init as RequestInit)?.method === "PUT")
        return new Response(null, { status: 201 });
      if (url.includes("/members/42"))
        return Response.json({ roles: [MOD_ROLE], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

/** Outbound calls carrying a bot credential — the guarantee pins these to zero. */
function botCalls(calls: { url: string; init?: RequestInit }[]) {
  return calls.filter((c) => {
    const auth = (c.init?.headers as Record<string, string> | undefined)?.authorization;
    return (typeof auth === "string" && auth.startsWith("Bot ")) || c.url.includes("/members/42");
  });
}

/** Capture every console.warn/error call so tests can scan the written stream. */
function captureLogs() {
  const lines: { level: string; args: unknown[] }[] = [];
  for (const level of ["warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push({ level, args });
    });
  }
  return lines;
}

const leakFree = (...surfaces: unknown[]) => {
  const text = surfaces.map((s) => JSON.stringify(s) ?? String(s)).join("\n");
  expect(text).not.toContain("user-token");
  expect(text).not.toContain("client-secret");
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("blank bot token on the join callback (TOG-12680)", () => {
  it.each(["", "   "])("emits zero bot-credentialed Discord calls (token %j)", async (token) => {
    const { env: e } = isolated(token);
    const calls = mockDiscord();
    const start = await app.request("/join/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    await app.request(
      `/join/callback?code=abc&state=${state}`,
      {
        headers: { cookie: cookiesFrom(start) },
      },
      e,
    );
    expect(botCalls(calls)).toHaveLength(0);
  });

  it.each(["", "   "])(
    "renders recovery with the static invite, clears journey cookies, issues no member session (token %j)",
    async (token) => {
      const { env: e } = isolated(token, "");
      const logs = captureLogs();
      mockDiscord();
      const start = await app.request("/join/discord?source=web-homepage&next=/events", {}, e);
      const res = await app.request(
        `/join/callback?code=abc&state=${new URL(start.headers.get("location")!).searchParams.get("state")}`,
        { headers: { cookie: cookiesFrom(start) } },
        e,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("We couldn&#39;t add you automatically");
      expect(html).toContain(`href="${FALLBACK_INVITE}"`);
      expect(html).toContain('data-testid="recovery-retry"');
      const set = res.headers.getSetCookie().join("\n");
      expect(set).not.toContain("__Host-two_session=");
      for (const name of ["state", "source", "next"]) {
        expect(set).toContain(`__Host-two_join_${name}=; Max-Age=0`);
      }
      leakFree(html, logs);
    },
  );
});

describe("blank bot token on the ordinary login callback (TOG-12680)", () => {
  it.each(["", "   "])("emits zero bot-credentialed Discord calls (token %j)", async (token) => {
    const { env: e } = isolated(token);
    const calls = mockDiscord();
    const start = await app.request("/auth/discord", {}, e);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    await app.request(
      `/auth/discord/callback?code=abc&state=${state}`,
      {
        headers: { cookie: cookiesFrom(start) },
      },
      e,
    );
    expect(botCalls(calls)).toHaveLength(0);
  });

  it.each(["", "   "])(
    "signs in as non-member with recomputed non-moderator flags (token %j)",
    async (token) => {
      const { store, env: e } = isolated(token);
      const logs = captureLogs();
      mockDiscord();
      const start = await app.request("/auth/discord", {}, e);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const res = await app.request(
        `/auth/discord/callback?code=abc&state=${state}`,
        {
          headers: { cookie: cookiesFrom(start) },
        },
        e,
      );
      expect(res.status).toBe(302);
      const signed = decodeURIComponent(
        res.headers
          .getSetCookie()
          .find((c) => c.startsWith("__Host-two_session="))!
          .split(";")[0]!
          .split("=")[1]!,
      );
      // hono signs `token.signature`; the bearer token is the part before the dot.
      const row = await store.get(await hashToken(signed.split(".")[0]!));
      expect(row).toMatchObject({ userId: "42", member: false, moderator: false });
      leakFree(logs, res.headers.get("location"));
    },
  );
});
