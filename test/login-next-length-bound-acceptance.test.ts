// Acceptance: bound login_next / intended lengths at write and check time.
//
// Contract under test (failing-first; the implementation does not exist yet):
// - The documented bound is 512 characters for a return destination.
// - A value longer than 512 chars is rejected at WRITE time: an oversized
//   ?next= sets no live login_next cookie, and an auth-gate bounce whose
//   pathname+search is oversized records no live intended cookie (the bounce
//   itself still happens).
// - A value longer than 512 chars is rejected at CHECK time: even a validly
//   signed oversized login_next/intended cookie never becomes the callback
//   destination (or a Kit-visible returnTo); consumption falls back to the
//   next layer, then to the default landing, and still clears both cookies.
// - Destinations at or under the bound — including the recovery-retry
//   preserved target re-recorded after a failed auto-join — keep working.
// - Signed-cookie integrity semantics are unchanged (unsigned/tampered
//   values still read as absent; pinned elsewhere, one control kept here).
//
// Acceptance-owned file: the Builder must not edit it. Hermetic only —
// in-memory session store, mocked Discord, no database, no staging.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { safeNext } from "../src/join/service";
import { readReturnJourney } from "../src/kit-session";
import {
  bounceToLogin,
  consumeLoginReturn,
  LOGIN_INTENDED_COOKIE,
  LOGIN_NEXT_COOKIE,
  rememberLoginNext,
} from "../src/return-journey";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import { withThrottleTx } from "./helpers/throttle-tx-double";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const BOUND = 512;

/** A safe same-app path of exactly `n` characters: "/" + (n-1) letters. */
const pathOfLen = (n: number) => `/${"a".repeat(n - 1)}`;
const AT_BOUND = pathOfLen(BOUND);
const JUST_OVER = pathOfLen(BOUND + 1);
const MULTI_KB = pathOfLen(8192);

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

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
const setCookies = (res: Response) => res.headers.getSetCookie().join("\n");
const withJar = (j: Jar): { headers: Record<string, string> } =>
  sendJar(j) ? { headers: { cookie: sendJar(j) } } : { headers: {} };

const signedPair = async (name: string, value: string) =>
  (
    await serializeSigned(name, value, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
const signedJarValue = async (name: string, value: string) =>
  (await signedPair(name, value)).slice(name.length + 1);

// Direct module fixture, same shape as test/return-journey.test.ts.
function journey() {
  const fixture = new Hono<{ Bindings: Env }>();
  fixture.get("/remember", async (c) => {
    await rememberLoginNext(c, c.req.query("next"));
    return c.text("ok");
  });
  fixture.get("/consume", async (c) => {
    const dest = await consumeLoginReturn(c);
    return c.text(dest ?? "default");
  });
  fixture.get("/bounce", (c) => bounceToLogin(c));
  return fixture;
}
const fixtureApp = journey();
const remember = async (next: string, jar: Jar = {}) => {
  const res = await fixtureApp.request(
    `/remember?next=${encodeURIComponent(next)}`,
    withJar(jar),
    env,
  );
  return { res, jar: jarFrom(res) };
};
const consume = (jar: Jar) => fixtureApp.request("/consume", withJar(jar), env);

describe("safeNext length bound (check time, shared guard)", () => {
  it("accepts a safe destination at exactly 512 chars", () => {
    expect(AT_BOUND).toHaveLength(BOUND);
    expect(safeNext(AT_BOUND)).toBe(AT_BOUND);
  });

  it.each([
    ["513 chars (just over)", JUST_OVER],
    ["8192 chars (multi-KB)", MULTI_KB],
  ])("rejects a safe-shaped destination of %s", (_label, next) => {
    expect(safeNext(next)).toBeNull();
  });

  it("counts path plus query toward the bound", () => {
    const atBound = `/events?q=${"a".repeat(BOUND - "/events?q=".length)}`;
    expect(atBound).toHaveLength(BOUND);
    expect(safeNext(atBound)).toBe(atBound);
    expect(safeNext(`${atBound}a`)).toBeNull();
  });

  it("normal short destinations are untouched", () => {
    expect(safeNext("/e/sunday-squad-01")).toBe("/e/sunday-squad-01");
    expect(safeNext("/events?view=calendar&month=2099-11")).toBe(
      "/events?view=calendar&month=2099-11",
    );
  });
});

describe("rememberLoginNext write-time bound (explicit ?next=)", () => {
  it.each([
    ["513 chars (just over)", JUST_OVER],
    ["8192 chars (multi-KB)", MULTI_KB],
  ])("an oversized next of %s sets no live cookie and consumes as default", async (_l, next) => {
    const start = await remember(next);
    expect(start.jar[LOGIN_NEXT_COOKIE]).toBeUndefined();
    const cb = await consume(start.jar);
    expect(await cb.text()).toBe("default");
  });

  it("an oversized next also forgets a stale explicit cookie from an earlier login", async () => {
    const first = await remember("/events");
    expect(first.jar[LOGIN_NEXT_COOKIE]).toBeTruthy();
    const fresh = await remember(MULTI_KB, first.jar);
    const browser = jarFrom(fresh.res, first.jar);
    expect(browser[LOGIN_NEXT_COOKIE]).toBeUndefined();
    expect(setCookies(fresh.res)).toContain(`${LOGIN_NEXT_COOKIE}=; Max-Age=0`);
  });

  it("a destination at exactly 512 chars still rides and consumes", async () => {
    const start = await remember(AT_BOUND);
    expect(start.jar[LOGIN_NEXT_COOKIE]).toBeTruthy();
    const cb = await consume(start.jar);
    expect(await cb.text()).toBe(AT_BOUND);
  });

  it("a normal short destination still rides and consumes", async () => {
    const start = await remember("/e/sunday-squad-01");
    expect(start.jar[LOGIN_NEXT_COOKIE]).toBeTruthy();
    const cb = await consume(start.jar);
    expect(await cb.text()).toBe("/e/sunday-squad-01");
  });
});

describe("bounceToLogin write-time bound (gate-recorded intended)", () => {
  // bounceToLogin records pathname+search verbatim; the fixture path is
  // "/bounce?x=…" so the recorded length is 10 + the filler length.
  const bouncePathOfTotalLen = (total: number) => `/bounce?x=${"a".repeat(total - 10)}`;

  it.each([
    ["513 chars (just over)", BOUND + 1],
    ["8192 chars (multi-KB)", 8192],
  ])(
    "an intended page of %s still bounces to OAuth but records no live cookie",
    async (_label, total) => {
      const bounce = await fixtureApp.request(bouncePathOfTotalLen(total), {}, env);
      expect(bounce.status).toBe(302);
      expect(bounce.headers.get("location")).toBe("/auth/discord");
      expect(jarFrom(bounce)[LOGIN_INTENDED_COOKIE]).toBeUndefined();
      const cb = await consume(jarFrom(bounce));
      expect(await cb.text()).toBe("default");
    },
  );

  it("an intended page at exactly 512 chars is still recorded and consumed", async () => {
    const path = bouncePathOfTotalLen(BOUND);
    const bounce = await fixtureApp.request(path, {}, env);
    expect(jarFrom(bounce)[LOGIN_INTENDED_COOKIE]).toBeTruthy();
    const cb = await consume(jarFrom(bounce));
    expect(await cb.text()).toBe(path);
  });

  it("a normal intended page is still recorded and consumed", async () => {
    const bounce = await fixtureApp.request("/bounce?from=card", {}, env);
    expect(jarFrom(bounce)[LOGIN_INTENDED_COOKIE]).toBeTruthy();
    const cb = await consume(jarFrom(bounce));
    expect(await cb.text()).toBe("/bounce?from=card");
  });
});

describe("consumeLoginReturn check-time bound (signed but oversized)", () => {
  it("a signed oversized explicit next falls back to the recorded intended page", async () => {
    const bounce = await fixtureApp.request("/bounce?from=card", {}, env);
    const jar = jarFrom(bounce);
    const cb = await consume({
      ...jar,
      [LOGIN_NEXT_COOKIE]: await signedJarValue(LOGIN_NEXT_COOKIE, MULTI_KB),
    });
    expect(await cb.text()).toBe("/bounce?from=card");
  });

  it("a signed oversized explicit next with no intended falls back to the default", async () => {
    const cb = await consume({
      [LOGIN_NEXT_COOKIE]: await signedJarValue(LOGIN_NEXT_COOKIE, JUST_OVER),
    });
    expect(await cb.text()).toBe("default");
  });

  it("a signed oversized intended page falls back to the default", async () => {
    const cb = await consume({
      [LOGIN_INTENDED_COOKIE]: await signedJarValue(LOGIN_INTENDED_COOKIE, MULTI_KB),
    });
    expect(await cb.text()).toBe("default");
  });

  it("oversized cookies are still cleared on consume (both layers)", async () => {
    const cb = await consume({
      [LOGIN_NEXT_COOKIE]: await signedJarValue(LOGIN_NEXT_COOKIE, MULTI_KB),
      [LOGIN_INTENDED_COOKIE]: await signedJarValue(LOGIN_INTENDED_COOKIE, MULTI_KB),
    });
    expect(await cb.text()).toBe("default");
    const cleared = setCookies(cb);
    expect(cleared).toContain(`${LOGIN_NEXT_COOKIE}=; Max-Age=0`);
    expect(cleared).toContain(`${LOGIN_INTENDED_COOKIE}=; Max-Age=0`);
  });

  it("a signed explicit next at exactly 512 chars is still honored", async () => {
    const cb = await consume({
      [LOGIN_NEXT_COOKIE]: await signedJarValue(LOGIN_NEXT_COOKIE, AT_BOUND),
    });
    expect(await cb.text()).toBe(AT_BOUND);
  });
});

describe("readReturnJourney check-time bound (Kit-visible return state)", () => {
  const requestWith = (pairs: string[]) =>
    new Request(`${APP_URL}/events`, {
      headers: pairs.length ? { cookie: pairs.join("; ") } : {},
    });

  it("a signed oversized next never becomes a Kit destination; intended wins", async () => {
    const journey = await readReturnJourney(
      requestWith([
        await signedPair(LOGIN_NEXT_COOKIE, MULTI_KB),
        await signedPair(LOGIN_INTENDED_COOKIE, "/profile"),
      ]),
      SESSION_SECRET,
    );
    expect(journey.returnTo).toBe("/profile");
  });

  it("signed oversized next and intended read as no destination", async () => {
    const journey = await readReturnJourney(
      requestWith([
        await signedPair(LOGIN_NEXT_COOKIE, JUST_OVER),
        await signedPair(LOGIN_INTENDED_COOKIE, MULTI_KB),
      ]),
      SESSION_SECRET,
    );
    expect(journey.returnTo).toBeNull();
  });

  it("a signed next at exactly 512 chars still reads as the destination", async () => {
    const journey = await readReturnJourney(
      requestWith([await signedPair(LOGIN_NEXT_COOKIE, AT_BOUND)]),
      SESSION_SECRET,
    );
    expect(journey.returnTo).toBe(AT_BOUND);
  });
});

// Full-app route layer: same hermetic harness as test/login-return.test.ts.
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

function isolated() {
  const store = createMemorySessionStore();
  const fullEnv = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fakeSql() },
  } as unknown as Env;
  return { store, env: fullEnv };
}

function mockDiscord({ joinStatus = 201 } = {}) {
  const userId = "420000000000000042";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token" });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: userId, username: "rick", global_name: "Rick", avatar: null });
      if (url.includes(`/members/${userId}`) && init?.method === "PUT")
        return new Response(null, { status: joinStatus });
      if (url.includes(`/members/${userId}`))
        return Response.json({ roles: [], joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
}

const startLogin = async (e: Env, query = "", cookie = "") => {
  const res = await app.request(`/auth/discord${query}`, { headers: cookie ? { cookie } : {} }, e);
  const location = res.headers.get("location");
  return {
    res,
    state: location ? new URL(location).searchParams.get("state") : null,
    jar: jarFrom(res),
  };
};
const finishLogin = (e: Env, state: string | null, j: Jar) =>
  app.request(
    `/auth/discord/callback?code=abc${state ? `&state=${state}` : ""}`,
    { headers: { cookie: sendJar(j) } },
    e,
  );

afterEach(() => vi.unstubAllGlobals());

describe("route layer: oversized ?next= through real OAuth start/callback", () => {
  it.each([
    ["513 chars (just over)", JUST_OVER],
    ["8192 chars (multi-KB)", MULTI_KB],
  ])(
    "an oversized next of %s sets no return cookie and the callback uses the default landing",
    async (_label, next) => {
      mockDiscord();
      const { env: fullEnv } = isolated();
      const start = await startLogin(fullEnv, `?next=${encodeURIComponent(next)}`);
      expect(start.jar[LOGIN_NEXT_COOKIE]).toBeUndefined();
      const cb = await finishLogin(fullEnv, start.state, start.jar);
      expect(cb.status).toBe(302);
      expect(cb.headers.get("location")).toBe("/?n=joined");
    },
  );

  it("a signed oversized next presented at the callback never reaches the Location header", async () => {
    mockDiscord();
    const { env: fullEnv } = isolated();
    const start = await startLogin(fullEnv);
    const forged = await signedPair(LOGIN_NEXT_COOKIE, MULTI_KB);
    const cb = await app.request(
      `/auth/discord/callback?code=abc&state=${start.state}`,
      { headers: { cookie: `${sendJar(start.jar)}; ${forged}` } },
      fullEnv,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/?n=joined");
  });

  it("a normal short destination still round-trips through OAuth", async () => {
    mockDiscord();
    const { env: fullEnv } = isolated();
    const start = await startLogin(fullEnv, "?next=%2Fe%2Fsunday-squad-01");
    expect(start.jar[LOGIN_NEXT_COOKIE]).toBeTruthy();
    const cb = await finishLogin(fullEnv, start.state, start.jar);
    expect(cb.headers.get("location")).toBe("/e/sunday-squad-01");
  });

  it("a destination at exactly 512 chars still round-trips through OAuth", async () => {
    mockDiscord();
    const { env: fullEnv } = isolated();
    const start = await startLogin(fullEnv, `?next=${encodeURIComponent(AT_BOUND)}`);
    expect(start.jar[LOGIN_NEXT_COOKIE]).toBeTruthy();
    const cb = await finishLogin(fullEnv, start.state, start.jar);
    expect(cb.headers.get("location")).toBe(AT_BOUND);
  });
});

describe("route layer: oversized gate bounce and recovery-retry preservation", () => {
  it("a guest bounce with a multi-KB query records no intended and lands on the default", async () => {
    mockDiscord();
    const { env: fullEnv } = isolated();
    const bounce = await app.request(`/profile?x=${"a".repeat(8192)}`, {}, fullEnv);
    expect(bounce.status).toBe(302);
    expect(bounce.headers.get("location")).toBe("/auth/discord");
    const j = jarFrom(bounce);
    expect(j[LOGIN_INTENDED_COOKIE]).toBeUndefined();
    const start = await startLogin(fullEnv, "", sendJar(j));
    const cb = await finishLogin(fullEnv, start.state, { ...j, ...start.jar });
    expect(cb.headers.get("location")).toBe("/?n=joined");
  });

  it("a failed auto-join does not re-record a signed oversized intended for the retry", async () => {
    mockDiscord({ joinStatus: 500 });
    const { env: fullEnv } = isolated();
    const start = await startLogin(fullEnv);
    const oversized = await signedPair(LOGIN_INTENDED_COOKIE, MULTI_KB);
    const cb = await app.request(
      `/auth/discord/callback?code=abc&state=${start.state}`,
      { headers: { cookie: `${sendJar(start.jar)}; ${oversized}` } },
      fullEnv,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/?n=join_failed");
    const after = jarFrom(cb, { ...start.jar });
    expect(after[LOGIN_INTENDED_COOKIE]).toBeUndefined();
  });

  it("a failed auto-join still re-records a normal preserved target for the retry", async () => {
    mockDiscord({ joinStatus: 500 });
    const { env: fullEnv } = isolated();
    const bounce = await app.request("/profile", {}, fullEnv);
    const j = jarFrom(bounce);
    expect(j[LOGIN_INTENDED_COOKIE]).toBeTruthy();
    const start = await startLogin(fullEnv, "", sendJar(j));
    const cb = await finishLogin(fullEnv, start.state, { ...j, ...start.jar });
    expect(cb.headers.get("location")).toBe("/?n=join_failed");
    const after = jarFrom(cb, { ...j, ...start.jar });
    expect(after[LOGIN_INTENDED_COOKIE]).toBeTruthy();
  });

  it("signed-cookie integrity is unchanged: an unsigned oversized next reads as absent", async () => {
    mockDiscord();
    const { env: fullEnv } = isolated();
    const start = await startLogin(fullEnv);
    const cb = await app.request(
      `/auth/discord/callback?code=abc&state=${start.state}`,
      {
        headers: {
          cookie: `${sendJar(start.jar)}; ${LOGIN_NEXT_COOKIE}=${encodeURIComponent(MULTI_KB)}`,
        },
      },
      fullEnv,
    );
    expect(cb.headers.get("location")).toBe("/?n=joined");
  });
});
