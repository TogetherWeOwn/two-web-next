import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import app from "./app";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  migrate,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import { migrateJoin } from "../src/join/service";
import { authTestDatabaseUrl } from "./helpers/auth-test-db";

const url = authTestDatabaseUrl();
const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture-client",
  DISCORD_CLIENT_SECRET: "fixture-secret",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: "fixture-bot",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  SESSION_SECRET: "fixture-signing-secret-at-least-32-bytes",
  DISCORD_MODERATOR_ROLE_IDS: "",
};
const cookieJar = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith("__Host-two_session="));
const sessionToken = (res: Response) =>
  decodeURIComponent(sessionCookie(res)!.split(";")[0]!.slice("__Host-two_session=".length)).split(
    ".",
  )[0]!;
const flows = ["auth", "join"] as const;
type Flow = (typeof flows)[number];
const startPath = (flow: Flow) => (flow === "auth" ? "/auth/discord" : "/join/discord");
const callbackPath = (flow: Flow) =>
  flow === "auth" ? "/auth/discord/callback" : "/join/callback";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function mockDiscord(
  options: {
    entered?: ReturnType<typeof deferred>;
    release?: ReturnType<typeof deferred>;
    failure?: "exchange" | "join";
  } = {},
) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth2/token")) {
      options.entered?.resolve();
      await options.release?.promise;
      if (options.failure === "exchange")
        return new Response("fixture exchange failure", { status: 503 });
      return Response.json({ access_token: "fixture-access-token" });
    }
    if (url.endsWith("/users/@me"))
      return Response.json({
        id: "42",
        username: "Fixture Member",
        global_name: null,
        avatar: null,
      });
    if (url.includes("/members/42") && init?.method === "PUT")
      return new Response(null, { status: options.failure === "join" ? 403 : 204 });
    throw new Error("Unexpected network request in auth fixture");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function fixture(store: SessionStore, sql?: Sql) {
  const attempts: unknown[][] = [];
  const fake = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("count(*)")) return [{ n: 0, wait: 1 }];
    if (query.includes("INSERT INTO join_attempts")) {
      attempts.push(values);
      return [];
    }
    if (query.includes("web_throttle_hits")) return [];
    throw new Error("Unexpected SQL in auth fixture");
  }) as unknown as Sql;
  fake.unsafe = async () => [];
  const create = vi.fn(store.create);
  const replace = vi.fn(store.replace);
  const instrumented = { ...store, create, replace };
  const env = {
    ...baseEnv,
    SESSION_STORE: instrumented,
    JOIN_DEPS: { store: async () => sql ?? fake },
  } as Env;
  return {
    store,
    env,
    create,
    replace,
    attemptCount: async () =>
      sql
        ? (await sql<{ n: number }[]>`select count(*)::int as n from join_attempts`)[0]!.n
        : attempts.length,
  };
}

async function start(env: Env, flow: Flow) {
  const res = await app.request(startPath(flow), {}, env);
  expect(res.status).toBe(302);
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: cookieJar(res) };
}

async function priorSession(store: SessionStore) {
  const token = newSessionToken();
  const hash = await hashToken(token);
  await store.create({
    tokenHash: hash,
    userId: "42",
    username: "Prior Member",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const cookie = await serializeSigned("__Host-two_session", token, baseEnv.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
  });
  return { hash, cookie: cookie.split(";")[0]! };
}

function contract(name: string, make: () => SessionStore, sql?: Sql) {
  describe(`${name} request admission`, () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it.each(flows)(
      "%s original signed cookies have one winner while its upstream exchange is in flight",
      async (flow) => {
        const f = fixture(make(), sql);
        const original = await start(f.env, flow);
        const entered = deferred();
        const release = deferred();
        const fetch = mockDiscord({ entered, release });
        const path = `${callbackPath(flow)}?code=fixture-code&state=${original.state}`;
        const first = app.request(path, { headers: { cookie: original.cookie } }, f.env);
        await entered.promise;
        try {
          const duplicate = await app.request(
            path,
            { headers: { cookie: original.cookie } },
            f.env,
          );
          expect(sessionCookie(duplicate)).toBeUndefined();
          expect(fetch).toHaveBeenCalledTimes(1);
          expect(await f.attemptCount()).toBe(0);
        } finally {
          release.resolve();
        }
        const winner = await first;
        expect(sessionCookie(winner)).toBeDefined();
        expect(await f.store.get(await hashToken(sessionToken(winner)))).toMatchObject({
          member: true,
          moderator: false,
        });
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(f.create).toHaveBeenCalledTimes(1);
        expect(f.replace).not.toHaveBeenCalled();
        expect(await f.attemptCount()).toBe(flow === "join" ? 1 : 0);
        const replay = await app.request(path, { headers: { cookie: original.cookie } }, f.env);
        expect(sessionCookie(replay)).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(f.create).toHaveBeenCalledTimes(1);
        expect(await f.attemptCount()).toBe(flow === "join" ? 1 : 0);
        if (sql) {
          const rows = await sql<
            { n: number }[]
          >`select count(*)::int as n from web_sessions where revoked_at is null`;
          expect(rows[0]!.n).toBe(1);
        }
      },
    );

    it.each(flows)(
      "%s already-member re-entry invalidates the supplied prior session",
      async (flow) => {
        const f = fixture(make(), sql);
        const prior = await priorSession(f.store);
        const original = await start(f.env, flow);
        mockDiscord();
        const result = await app.request(
          `${callbackPath(flow)}?code=fixture-code&state=${original.state}`,
          { headers: { cookie: `${original.cookie}; ${prior.cookie}` } },
          f.env,
        );
        expect(sessionCookie(result)).toBeDefined();
        expect(await f.store.get(prior.hash)).toBeNull();
        expect(await f.store.get(await hashToken(sessionToken(result)))).toMatchObject({
          userId: "42",
          member: true,
        });
        expect(f.create).not.toHaveBeenCalled();
        expect(f.replace).toHaveBeenCalledTimes(1);
      },
    );

    it.each(flows)(
      "%s denial consumes state once, preserves the prior session and never elevates",
      async (flow) => {
        const f = fixture(make(), sql);
        const prior = await priorSession(f.store);
        const original = await start(f.env, flow);
        const fetch = mockDiscord();
        const headers = { cookie: `${original.cookie}; ${prior.cookie}` };
        const path = `${callbackPath(flow)}?error=access_denied&code=fixture-code&state=${original.state}`;
        for (let n = 0; n < 2; n++) {
          const denied = await app.request(path, { headers }, f.env);
          expect(sessionCookie(denied)).toBeUndefined();
          if (flow === "auth") expect(denied.headers.get("location")).toBe("/?n=signin_denied");
          else expect(await denied.text()).toContain("Join cancelled");
        }
        expect(await f.store.get(prior.hash)).toMatchObject({
          username: "Prior Member",
          moderator: true,
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(f.create).not.toHaveBeenCalled();
        expect(f.replace).not.toHaveBeenCalled();
        expect(await f.attemptCount()).toBe(flow === "join" ? 1 : 0);
        const replayAsSuccess = await app.request(
          `${callbackPath(flow)}?code=fixture-code&state=${original.state}`,
          { headers },
          f.env,
        );
        expect(sessionCookie(replayAsSuccess)).toBeUndefined();
        expect(fetch).not.toHaveBeenCalled();
      },
    );

    it.each(flows)(
      "%s an incomplete callback spends the journey without elevating or permitting a later exchange",
      async (flow) => {
        const f = fixture(make(), sql);
        const prior = await priorSession(f.store);
        const original = await start(f.env, flow);
        const fetch = mockDiscord();
        const headers = { cookie: `${original.cookie}; ${prior.cookie}` };
        const incomplete = await app.request(
          `${callbackPath(flow)}?state=${original.state}`,
          { headers },
          f.env,
        );
        expect(sessionCookie(incomplete)).toBeUndefined();
        const retry = await app.request(
          `${callbackPath(flow)}?state=${original.state}&code=fixture-code`,
          { headers },
          f.env,
        );
        expect(sessionCookie(retry)).toBeUndefined();
        expect(fetch).not.toHaveBeenCalled();
        expect(await f.store.get(prior.hash)).toMatchObject({
          moderator: true,
          username: "Prior Member",
        });
        expect(f.create).not.toHaveBeenCalled();
        expect(f.replace).not.toHaveBeenCalled();
        expect(await f.attemptCount()).toBe(flow === "join" ? 1 : 0);
      },
    );

    it.each(flows)(
      "%s an unavailable admission store permits no upstream call, attempt or session change",
      async (flow) => {
        const f = fixture(make(), sql);
        const prior = await priorSession(f.store);
        const original = await start(f.env, flow);
        const fetch = mockDiscord();
        vi.spyOn(f.store.journeys, "consume").mockRejectedValue(
          new Error("fixture store unavailable"),
        );
        const result = await app.request(
          `${callbackPath(flow)}?state=${original.state}&code=fixture-code`,
          { headers: { cookie: `${original.cookie}; ${prior.cookie}` } },
          f.env,
        );
        expect(sessionCookie(result)).toBeUndefined();
        expect(fetch).not.toHaveBeenCalled();
        expect(await f.store.get(prior.hash)).toMatchObject({
          moderator: true,
          username: "Prior Member",
        });
        expect(f.create).not.toHaveBeenCalled();
        expect(f.replace).not.toHaveBeenCalled();
        expect(await f.attemptCount()).toBe(0);
      },
    );

    it.each(flows)(
      "%s failure to acquire the admission store preserves the prior session without side effects",
      async (flow) => {
        const f = fixture(make(), sql);
        const prior = await priorSession(f.store);
        const original = await start(f.env, flow);
        const fetch = mockDiscord();
        Object.defineProperty(f.env, "SESSION_STORE", {
          get: () => {
            throw new Error("fixture store acquisition failed");
          },
        });
        const result = await app.request(
          `${callbackPath(flow)}?state=${original.state}&code=fixture-code`,
          { headers: { cookie: `${original.cookie}; ${prior.cookie}` } },
          f.env,
        );
        expect(result.status).toBe(flow === "join" ? 200 : 302);
        expect(sessionCookie(result)).toBeUndefined();
        expect(fetch).not.toHaveBeenCalled();
        expect(await f.store.get(prior.hash)).toMatchObject({
          moderator: true,
          username: "Prior Member",
        });
        expect(f.create).not.toHaveBeenCalled();
        expect(f.replace).not.toHaveBeenCalled();
        expect(await f.attemptCount()).toBe(0);
      },
    );

    it.each(flows)(
      "%s a refused admission record cannot issue signed cookies or an OAuth handoff",
      async (flow) => {
        const f = fixture(make(), sql);
        const fetch = mockDiscord();
        vi.spyOn(f.store.journeys, "issue").mockResolvedValue(false);
        const result = await app.request(startPath(flow), {}, f.env);
        expect(result.status).toBe(302);
        expect(result.headers.get("location")).toBe(
          flow === "join" ? "/join" : "/?n=signin_failed",
        );
        expect(result.headers.getSetCookie()).toHaveLength(0);
        expect(fetch).not.toHaveBeenCalled();
        expect(f.create).not.toHaveBeenCalled();
        expect(f.replace).not.toHaveBeenCalled();
        expect(await f.attemptCount()).toBe(0);
      },
    );

    it.each(flows)(
      "%s exchange failure preserves the prior session and cannot be retried with original cookies",
      async (flow) => {
        const f = fixture(make(), sql);
        const prior = await priorSession(f.store);
        const original = await start(f.env, flow);
        const fetch = mockDiscord({ failure: "exchange" });
        const headers = { cookie: `${original.cookie}; ${prior.cookie}` };
        const path = `${callbackPath(flow)}?code=fixture-code&state=${original.state}`;
        for (let n = 0; n < 2; n++)
          expect(sessionCookie(await app.request(path, { headers }, f.env))).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(await f.store.get(prior.hash)).toMatchObject({ username: "Prior Member" });
        expect(f.create).not.toHaveBeenCalled();
        expect(f.replace).not.toHaveBeenCalled();
        expect(await f.attemptCount()).toBe(flow === "join" ? 1 : 0);
      },
    );

    it.each(flows)(
      "%s rejects missing, mismatched, unsigned and unissued state before any upstream call or attempt",
      async (flow) => {
        const f = fixture(make(), sql);
        const original = await start(f.env, flow);
        const fetch = mockDiscord();
        const unissued = crypto.randomUUID();
        const name = flow === "auth" ? "__Host-two_oauth_state" : "__Host-two_join_state";
        const signedUnissued = (
          await serializeSigned(name, unissued, baseEnv.SESSION_SECRET, { path: "/", secure: true })
        ).split(";")[0]!;
        for (const [state, cookie] of [
          [original.state, ""],
          ["mismatch", original.cookie],
          [original.state, `${name}=${original.state}`],
          [unissued, signedUnissued],
        ] as const) {
          const res = await app.request(
            `${callbackPath(flow)}?code=fixture-code&state=${state}`,
            { headers: { cookie } },
            f.env,
          );
          expect(sessionCookie(res)).toBeUndefined();
        }
        expect(fetch).not.toHaveBeenCalled();
        expect(f.create).not.toHaveBeenCalled();
        expect(await f.attemptCount()).toBe(0);
      },
    );

    it.each(flows)(
      "%s expired original signed cookies fail before exchange, session or attempt",
      async (flow) => {
        const f = fixture(make(), sql);
        const original = await start(f.env, flow);
        const fetch = mockDiscord();
        if (sql) {
          await sql`update web_oauth_journeys set expires_at = now() where state_hash = ${await hashToken(original.state)}`;
        } else {
          const expired = Date.now() + 600_000;
          vi.spyOn(Date, "now").mockReturnValue(expired);
        }
        const res = await app.request(
          `${callbackPath(flow)}?code=fixture-code&state=${original.state}`,
          { headers: { cookie: original.cookie } },
          f.env,
        );
        expect(sessionCookie(res)).toBeUndefined();
        expect(fetch).not.toHaveBeenCalled();
        expect(f.create).not.toHaveBeenCalled();
        expect(await f.attemptCount()).toBe(0);
      },
    );

    it.each(flows)("%s bot refusal never grants member or moderator privileges", async (flow) => {
      const f = fixture(make(), sql);
      const prior = await priorSession(f.store);
      const original = await start(f.env, flow);
      const fetch = mockDiscord({ failure: "join" });
      const res = await app.request(
        `${callbackPath(flow)}?code=fixture-code&state=${original.state}`,
        { headers: { cookie: `${original.cookie}; ${prior.cookie}` } },
        f.env,
      );
      expect(fetch).toHaveBeenCalledTimes(3);
      if (flow === "auth") {
        // Recorded Next divergence: identified non-member sign-in may succeed,
        // but a failed auto-join cannot grant moderator or preserve the old token.
        expect(await f.store.get(await hashToken(sessionToken(res)))).toMatchObject({
          member: false,
          moderator: false,
        });
        expect(await f.store.get(prior.hash)).toBeNull();
      } else {
        expect(sessionCookie(res)).toBeUndefined();
        expect(await f.store.get(prior.hash)).toMatchObject({ username: "Prior Member" });
        expect(f.create).not.toHaveBeenCalled();
        expect(f.replace).not.toHaveBeenCalled();
        expect(await f.attemptCount()).toBe(1);
      }
    });

    it("a bot disabled after join start causes no exchange, handoff or member session", async () => {
      const f = fixture(make(), sql);
      const original = await start(f.env, "join");
      const fetch = mockDiscord();
      const disabled = { ...f.env, DISCORD_BOT_TOKEN: "  " };
      const res = await app.request(
        `/join/callback?code=fixture-code&state=${original.state}`,
        { headers: { cookie: original.cookie } },
        disabled,
      );
      expect(await res.text()).toContain("Automatic join is unavailable");
      expect(sessionCookie(res)).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(await f.attemptCount()).toBe(1);
      await app.request(
        `/join/callback?code=fixture-code&state=${original.state}`,
        { headers: { cookie: original.cookie } },
        disabled,
      );
      expect(await f.attemptCount()).toBe(1);
    });
  });
}

contract("memory", () => createMemorySessionStore(() => Date.now()));

it("an unconfigured join start does not even advertise OAuth", async () => {
  const f = fixture(createMemorySessionStore());
  const fetch = mockDiscord();
  const res = await app.request("/join/discord", {}, { ...f.env, DISCORD_BOT_TOKEN: "" });
  expect(res.headers.get("location")).toBe("/join");
  expect(res.headers.getSetCookie()).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe.skipIf(!url)("test-container persistence", () => {
  const sql = postgres(url!, { max: 8 }) as unknown as Sql & { end: () => Promise<void> };
  beforeAll(async () => {
    await migrate(sql);
    await migrateJoin(sql);
  });
  const clear = async () => {
    await sql`delete from web_sessions`;
    await sql`delete from web_oauth_journeys`;
    await sql`delete from join_attempts`;
    await sql`delete from web_throttle_hits`;
  };
  beforeEach(clear);
  afterAll(async () => {
    await clear();
    await sql.end();
  });
  contract("postgres", () => createPostgresSessionStore(sql), sql);
});
