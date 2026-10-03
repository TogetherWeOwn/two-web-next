// route-inventory: GET /join/callback
// TOG-12611: pin the join-blocked copy and the degraded-bot join path.
//
// Legacy `tests/Browser/JoinBlockedWidgetTest.php` pins the blocked-outcome
// widget copy and CTA. Next `test/join.test.ts` proves invite fallback,
// degradation, recovery pages and the Discord widget sandbox — but no suite
// asserts the blocked-outcome copy stays user-visible when the bot refuses
// the join with a still-valid session. This suite pins that path against the
// mounted app with local fixtures only (no live Discord):
//   - a refused bot join (403/500/throw) renders the blocked copy + fallback
//     invite CTA with status 200 and no member session;
//   - already-member and denied-consent keep their distinct copy;
//   - the blocked page is distinct from outage and expired-grant copy;
//   - no live token or secret is echoed in the rendered page.
//
// Scope guard: this file must not import or edit `src/join/route.ts`,
// `src/join/service.ts`, `src/sessions.ts`, `src/index.tsx` or
// `test/join.test.ts` (PR #141 hot). It drives them only through the mounted
// app (`test/app.ts`) with stubbed fetch.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import type { Env } from "../src/env";
import type { EnvWithJoin } from "../src/join/route";
import { createMemorySessionStore, type Sql } from "../src/sessions";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "508654771276873729",
};

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

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
    if (head.includes("count(*)")) return [{ n: 0, wait: 1 }];
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
  return { sql: withThrottleTx(sql), attempts };
}

function isolated() {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql },
  } as unknown as Env;
  return { store, fake, env: e };
}

function mockDiscord({
  joinStatus = 403,
  token = "user-token",
}: {
  joinStatus?: number;
  token?: string;
} = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: token });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && (init as RequestInit)?.method === "PUT")
        return new Response(null, { status: joinStatus });
      if (url.includes("/members/42"))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

async function startJoin(e: Env, query = "") {
  const res = await app.request(`/join/discord${query}`, {}, e);
  const location = res.headers.get("location") ? new URL(res.headers.get("location")!) : null;
  return {
    res,
    location,
    state: location?.searchParams.get("state") ?? null,
    cookie: cookiesFrom(res),
  };
}

const finishJoinCb = (e: Env, state: string, cookie: string, extra = "code=abc") =>
  app.request(`/join/callback?${extra}&state=${state}`, { headers: { cookie } }, e);

afterEach(() => vi.unstubAllGlobals());

describe("join-blocked copy (legacy JoinBlockedWidgetTest)", () => {
  it("a bot-refused join renders the blocked copy + fallback invite CTA, 200, no session", async () => {
    const { fake, env: e } = isolated();
    mockDiscord({ joinStatus: 403 });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Blocked-outcome copy (HTML-escaped apostrophe).
    expect(html).toContain("We couldn&#39;t add you automatically");
    expect(html).toContain("use the invite link below");
    // Fallback invite CTA + retry stay user-visible.
    expect(html).toContain('data-testid="recovery-retry"');
    expect(html).toContain('href="/join/discord"');
    expect(html).toContain('data-testid="recovery-invite"');
    expect(html).toContain("https://discord.gg/invite");
    expect(html).toContain("Join with an invite link instead");
    // Never a member session on the degraded path.
    expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
    expect(fake.attempts[0]).toMatchObject({ outcome: "degraded", discordId: "42" });
  });

  it.each([403, 500])(
    "degraded-bot join path: Discord PUT %i renders the same blocked copy",
    async (joinStatus) => {
      const { env: e } = isolated();
      mockDiscord({ joinStatus });
      const { state, cookie } = await startJoin(e);
      const res = await finishJoinCb(e, state!, cookie);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("We couldn&#39;t add you automatically");
      expect(html).toContain('data-testid="recovery-invite"');
      expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
    },
  );

  it("a throwing bot still degrades to the blocked copy (never a 500)", async () => {
    const fake = fakeSql();
    const store = createMemorySessionStore();
    const e = {
      ...env,
      SESSION_STORE: store,
      JOIN_DEPS: {
        store: async () => fake.sql,
        bot: () => async () => Promise.reject(new Error("bot down")),
      },
    } as unknown as EnvWithJoin as unknown as Env;
    mockDiscord();
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("We couldn&#39;t add you automatically");
  });

  it("blocked copy stays distinct from denied, outage, expired-grant and expired-link copy", async () => {
    const { env: e } = isolated();
    mockDiscord({ joinStatus: 403 });
    const { state, cookie } = await startJoin(e);
    const html = await (await finishJoinCb(e, state!, cookie)).text();
    for (const other of [
      "Join cancelled",
      "You cancelled the Discord approval",
      "Discord is unreachable",
      "Join approval expired",
      "Join link expired",
    ]) {
      expect(html).not.toContain(other);
    }
  });

  it("already-member keeps its distinct copy (redirect + reinvite banner, no blocked copy)", async () => {
    const { fake, env: e } = isolated();
    mockDiscord({ joinStatus: 204 });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=already_member");
    expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_session=");
    expect(fake.attempts).toEqual([
      { outcome: "already_member", source: null, requestId: null, discordId: "42" },
    ]);
    const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
    const html = await home.text();
    expect(html).toContain("You are already in the server.");
    expect(html).toContain('data-testid="reinvite-link"');
    expect(html).not.toContain("We couldn&#39;t add you automatically");
  });

  it("denied consent keeps its distinct copy and never echoes the provider description", async () => {
    const { fake, env: e } = isolated();
    const calls = mockDiscord();
    // One-use admission: a denial is only recorded for an admitted journey
    // (valid state matching the signed cookie), so start one first.
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(
      e,
      state!,
      cookie,
      "error=access_denied&error_description=blocked-probe-never-echo",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join cancelled");
    expect(html).toContain("You cancelled the Discord approval");
    expect(html).toContain('data-testid="recovery-invite"');
    expect(html).not.toContain("blocked-probe-never-echo");
    expect(html).not.toContain("We couldn&#39;t add you automatically");
    expect(calls).toHaveLength(0);
    expect(fake.attempts).toEqual([
      { outcome: "denied", source: null, requestId: null, discordId: null },
    ]);
  });

  it("no live token or secret is echoed in the blocked page, headers or journey rows", async () => {
    const probe = `tok-blocked-probe-${Date.now()}`;
    const { fake, env: e } = isolated();
    mockDiscord({ joinStatus: 403, token: probe });
    const { state, cookie } = await startJoin(e);
    const res = await finishJoinCb(e, state!, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(probe);
    // Configured secrets never render either.
    expect(html).not.toContain("client-secret");
    expect(html).not.toContain("bot-token");
    expect(JSON.stringify(fake.attempts)).not.toContain(probe);
    expect(res.headers.getSetCookie().join("\n")).not.toContain(probe);
  });
});
