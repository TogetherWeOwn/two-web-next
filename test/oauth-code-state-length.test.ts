// Acceptance: oversized OAuth `code`/`state` values are rejected with the
// generic failure BEFORE any Discord exchange, on both callbacks.
// route-inventory: GET /auth/discord/callback
// route-inventory: GET /join/callback
//
// Discord authorization codes are short opaque strings (~30 chars) and the
// state this app issues is a UUID, so a multi-kilobyte value is never
// legitimate. Without an inbound bound, a valid-state holder can make the
// callback POST an arbitrarily large `code` to Discord on every hit.
// The exact cap is the implementer's choice; this suite pins only that an
// 8192-char value is refused pre-exchange and a normal-length code still
// reaches the exchange. Hermetic: memory session store, stubbed fetch,
// fake SQL — no live Discord, database, or secrets.
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import type { Env } from "../src/env";
import { createMemorySessionStore, type Sql } from "../src/sessions";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture-client",
  DISCORD_CLIENT_SECRET: "fixture-secret",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: "fixture-bot",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "",
};

const OVERSIZED = 8192;
const normalCode = "c".repeat(32);

const flows = ["auth", "join"] as const;
type Flow = (typeof flows)[number];
const startPath = (flow: Flow) => (flow === "auth" ? "/auth/discord" : "/join/discord");
const callbackPath = (flow: Flow) =>
  flow === "auth" ? "/auth/discord/callback" : "/join/callback";
const stateCookieName = (flow: Flow) =>
  flow === "auth" ? "__Host-two_oauth_state" : "__Host-two_join_state";

const cookieJar = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith("__Host-two_session="));

function mockDiscord() {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth2/token"))
      return Response.json({ access_token: "fixture-access-token" });
    if (url.endsWith("/users/@me"))
      return Response.json({
        id: "42",
        username: "Fixture Member",
        global_name: null,
        avatar: null,
      });
    if (url.includes("/members/42") && init?.method === "PUT")
      return new Response(null, { status: 204 });
    throw new Error("Unexpected network request in OAuth length fixture");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function fixture() {
  const store = createMemorySessionStore(() => Date.now());
  const fake = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (query.includes("INSERT INTO join_attempts")) return [];
    if (query.includes("web_throttle_hits")) return [];
    throw new Error("Unexpected SQL in OAuth length fixture");
  }) as unknown as Sql;
  fake.unsafe = async () => [];
  const create = vi.fn(store.create);
  const replace = vi.fn(store.replace);
  const env = {
    ...baseEnv,
    SESSION_STORE: { ...store, create, replace },
    JOIN_DEPS: { store: async () => withThrottleTx(fake) },
  } as Env;
  return { env, create, replace };
}

async function start(env: Env, flow: Flow) {
  const res = await app.request(startPath(flow), {}, env);
  expect(res.status).toBe(302);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: cookieJar(res) };
}

/** The pre-exchange generic failure surface each flow already uses. */
async function expectGenericFailure(flow: Flow, res: Response) {
  expect(sessionCookie(res)).toBeUndefined();
  if (flow === "auth") {
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
  } else {
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Join link expired|We couldn&#39;t add you automatically/);
  }
}

describe("OAuth callbacks bound code/state lengths before the Discord exchange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(flows)(
    "%s oversized code with a valid state is rejected with zero Discord calls",
    async (flow) => {
      const f = fixture();
      const original = await start(f.env, flow);
      const fetch = mockDiscord();
      const res = await app.request(
        `${callbackPath(flow)}?code=${"a".repeat(OVERSIZED)}&state=${original.state}`,
        { headers: { cookie: original.cookie } },
        f.env,
      );
      await expectGenericFailure(flow, res);
      expect(fetch).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.replace).not.toHaveBeenCalled();
    },
  );

  it.each(flows)("%s oversized state is rejected with zero Discord calls", async (flow) => {
    const f = fixture();
    const original = await start(f.env, flow);
    const fetch = mockDiscord();
    const res = await app.request(
      `${callbackPath(flow)}?code=${normalCode}&state=${"s".repeat(OVERSIZED)}`,
      { headers: { cookie: original.cookie } },
      f.env,
    );
    await expectGenericFailure(flow, res);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.replace).not.toHaveBeenCalled();
  });

  it.each(flows)(
    "%s oversized state with a matching signed state cookie is rejected with zero Discord calls",
    async (flow) => {
      const f = fixture();
      const fetch = mockDiscord();
      const oversizedState = "s".repeat(OVERSIZED);
      const cookie = (
        await serializeSigned(stateCookieName(flow), oversizedState, baseEnv.SESSION_SECRET, {
          path: "/",
          secure: true,
        })
      ).split(";")[0]!;
      const res = await app.request(
        `${callbackPath(flow)}?code=${normalCode}&state=${oversizedState}`,
        { headers: { cookie } },
        f.env,
      );
      await expectGenericFailure(flow, res);
      expect(fetch).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.replace).not.toHaveBeenCalled();
    },
  );

  it.each(flows)("%s normal-length code still reaches the exchange", async (flow) => {
    const f = fixture();
    const original = await start(f.env, flow);
    const fetch = mockDiscord();
    const res = await app.request(
      `${callbackPath(flow)}?code=${normalCode}&state=${original.state}`,
      { headers: { cookie: original.cookie } },
      f.env,
    );
    expect(sessionCookie(res)).toBeDefined();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/oauth2/token"))).toBe(true);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it.each(flows)(
    "%s tampered state with a normal code still fails before the exchange",
    async (flow) => {
      const f = fixture();
      const original = await start(f.env, flow);
      const fetch = mockDiscord();
      const res = await app.request(
        `${callbackPath(flow)}?code=${normalCode}&state=mismatch`,
        { headers: { cookie: original.cookie } },
        f.env,
      );
      await expectGenericFailure(flow, res);
      expect(fetch).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.replace).not.toHaveBeenCalled();
    },
  );
});
