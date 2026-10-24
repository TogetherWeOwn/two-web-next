/// <reference types="vite/client" />
// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import type { JoinRouteDeps } from "../src/join/route";
import { createMemorySessionStore, type Sql } from "../src/sessions";

// Acceptance oracle: two tabs, one browser cookie jar.
//
// A member opens the join flow in tab A, then again in tab B. The jar now
// carries B's signed state/next/source cookies, and both journeys are live
// in the store. A callback hit that cannot be admitted to B — tab A's stale
// state, a bare or malformed hit, an oversized input, or a provider error
// carrying somebody else's state — must leave B's pending journey entirely
// alone: no journey cookie cleared or replaced, no code exchange, no bot
// call, no session, no join-attempt row. B's own callback afterwards still
// completes with B's safe next/source and consumes only B's journey.
//
// The converse line is admission. A callback whose state matches the jar's
// signed state cookie and consumes the stored journey is terminal for that
// journey in every existing flavor — success, matching-state consent
// denial, a failed code exchange, or a return without a code — and still
// clears its own state/next/source cookies and keeps its existing outcome
// and audit rules. Replay of a consumed callback records nothing new.
//
// Pre-fix failure mode: the callback clears the journey cookies before it
// checks state equality or one-use admission, so completing stale tab A
// against B's jar deletes B's cookies although B's stored journey is still
// valid, and B's genuine completion then fails.
//
// Hermetic: memory session store, stubbed fetch, fake SQL. No live
// Discord, database, or secrets.

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "",
};

const STATE = "__Host-two_join_state";
const SOURCE = "__Host-two_join_source";
const NEXT = "__Host-two_join_next";
const SESSION = "__Host-two_session";
const JOURNEY_COOKIES = [STATE, SOURCE, NEXT] as const;
// Comfortably above any legitimate code/state length, far below URL limits.
const OVERSIZED = "x".repeat(8192);

/** Browser-like cookie jar: merges Set-Cookie headers across responses. */
class Jar {
  private cookies = new Map<string, string>();

  apply(res: Response) {
    for (const header of res.headers.getSetCookie()) {
      const [pair, ...attrs] = header.split(";").map((p) => p.trim());
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      const expired =
        value === "" ||
        attrs.some((a) => /^Max-Age=0$/i.test(a)) ||
        attrs.some(
          (a) => /^Expires=/i.test(a) && Date.parse(a.slice("Expires=".length)) <= Date.now(),
        );
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return this;
  }

  get(name: string) {
    return this.cookies.get(name);
  }

  has(name: string) {
    return this.cookies.has(name);
  }

  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  snapshot() {
    return Object.fromEntries(this.cookies);
  }
}

function setCookieFor(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((h) => h.startsWith(`${name}=`));
}

/** A stray hit must not touch a journey cookie at all: no clear, no replace. */
function expectJourneyUntouched(res: Response, jar: Jar, before: Record<string, string>) {
  for (const name of JOURNEY_COOKIES) {
    expect(setCookieFor(res, name), `${name} must be untouched`).toBeUndefined();
  }
  jar.apply(res);
  for (const name of JOURNEY_COOKIES) {
    expect(jar.get(name), `${name} must survive in the jar`).toBe(before[name]);
    expect(jar.get(name), `${name} must still be present`).toBeTruthy();
  }
  expect(jar.has(SESSION)).toBe(false);
}

/** A deletion Set-Cookie mirrors the journey cookies' security attributes. */
function expectDeletion(res: Response, name: string) {
  const header = setCookieFor(res, name);
  expect(header, `${name} deletion header`).toBeDefined();
  expect(header).toContain(`${name}=;`);
  expect(header).toContain("Max-Age=0");
  expect(header).toContain("Path=/");
  expect(header).toContain("Secure");
  expect(header).toContain("HttpOnly");
  expect(header).toContain("SameSite=Lax");
}

/** A live journey cookie keeps its signed value, TTL and attributes. */
function expectLiveCookie(res: Response, name: string) {
  const header = setCookieFor(res, name);
  expect(header, `${name} live header`).toBeDefined();
  const value = header!.split(";")[0]!.slice(name.length + 1);
  expect(value.length, `${name} signed value`).toBeGreaterThan(0);
  expect(header).toContain("Max-Age=600");
  expect(header).toContain("Path=/");
  expect(header).toContain("Secure");
  expect(header).toContain("HttpOnly");
  expect(header).toContain("SameSite=Lax");
}

// In-memory Sql double for the journey's statements (same shape as join.test.ts).
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
    if (head.includes("pg_advisory_xact_lock")) return [];
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
  (sql as unknown as { begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown> }).begin = (
    run,
  ) => run(sql);
  return { sql, throttle, attempts };
}

function isolated(deps: Partial<JoinRouteDeps> = {}) {
  const fake = fakeSql();
  const store = createMemorySessionStore();
  const create = vi.fn(store.create.bind(store));
  const replace = vi.fn(store.replace.bind(store));
  const e = {
    ...env,
    SESSION_STORE: { ...store, create, replace },
    JOIN_DEPS: { store: async () => fake.sql, ...deps },
  } as unknown as Env;
  return { store, create, replace, fake, env: e };
}

function mockDiscord({ failExchange = false } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) {
        if (failExchange) return new Response("bad", { status: 500 });
        return Response.json({ access_token: "user-token" });
      }
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

async function startWithJar(e: Env, jar: Jar, query = "") {
  const res = await app.request(
    `/join/discord${query}`,
    jar.header() ? { headers: { cookie: jar.header() } } : {},
    e,
  );
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  jar.apply(res);
  return { res, state: location.searchParams.get("state")! };
}

/**
 * Start tab A, then tab B, in one jar. Afterwards the jar carries only B's
 * journey cookies; both stored journeys are live and unconsumed.
 */
async function twoTabs(e: Env) {
  const jar = new Jar();
  const a = await startWithJar(e, jar, "?source=first-source&next=/events");
  const aJarHeader = jar.header();
  const b = await startWithJar(e, jar, "?source=second-source&next=/profile");
  expect(b.state).not.toBe(a.state);
  for (const name of JOURNEY_COOKIES) expectLiveCookie(b.res, name);
  return { jar, a, b, aJarHeader, before: jar.snapshot() };
}

const callbackWithJar = (e: Env, jar: Jar, query: string) =>
  app.request(
    `/join/callback${query ? `?${query}` : ""}`,
    { headers: { cookie: jar.header() } },
    e,
  );

/** Complete tab B and pin everything its admission is supposed to do. */
async function expectBCompletes(
  e: Env,
  jar: Jar,
  stateB: string,
  fake: ReturnType<typeof fakeSql>,
  create: ReturnType<typeof vi.fn>,
) {
  const res = await callbackWithJar(e, jar, `code=abc&state=${stateB}`);
  expect(res.status).toBe(302);
  // B's safe next and B's source — never tab A's.
  expect(res.headers.get("location")).toBe("/profile");
  expect(setCookieFor(res, SESSION), "session issued for B").toBeDefined();
  expect(create).toHaveBeenCalledTimes(1);
  expect(fake.attempts).toEqual([
    { outcome: "added", source: "second-source", requestId: null, discordId: "42" },
  ]);
  for (const name of JOURNEY_COOKIES) expectDeletion(res, name);
  jar.apply(res);
  for (const name of JOURNEY_COOKIES) expect(jar.has(name)).toBe(false);
  return res;
}

afterEach(() => vi.unstubAllGlobals());

describe("stale-state callbacks preserve the newer tab's journey (acceptance)", () => {
  // Each stray is a callback hit that must NOT be admitted to tab B's
  // journey: it names the wrong journey, names none, is malformed or
  // oversized, or is a provider error for somebody else's journey.
  const strays: [string, (a: string, b: string) => string, "expired" | "cancelled"][] = [
    ["stale tab A completing against B's cookies", (a) => `code=abc&state=${a}`, "expired"],
    ["a bare hit with no params at all", () => "", "expired"],
    ["a malformed state", () => "code=abc&state=not-a-issued-state", "expired"],
    [
      "a well-formed but never-issued state",
      () => "code=abc&state=00000000-0000-4000-8000-000000000000",
      "expired",
    ],
    ["an oversized state", () => `code=abc&state=${OVERSIZED}`, "expired"],
    ["an oversized code naming B's state", (_a, b) => `code=${OVERSIZED}&state=${b}`, "expired"],
    [
      "a provider error carrying tab A's state",
      (a) => `error=access_denied&error_description=never-echo-stray&state=${a}`,
      "cancelled",
    ],
    [
      "a provider error with no state",
      () => "error=server_error&error_description=never-echo-stray",
      "expired",
    ],
  ];

  it.each(strays)(
    "stray hit (%s) does no work and B still completes",
    async (_name, strayQuery, expected) => {
      const { create, replace, fake, env: e } = isolated();
      const calls = mockDiscord();
      const { jar, a, b, before } = await twoTabs(e);

      const stray = await callbackWithJar(e, jar, strayQuery(a.state, b.state));

      // The stray's visible answer names the real outcome — the cancelled
      // copy for a Cancel, the expiry copy for everything else — and never
      // echoes provider details.
      expect(stray.status).toBe(200);
      const html = await stray.text();
      if (expected === "cancelled") {
        expect(html).toContain("Join cancelled");
        expect(html).toContain("You cancelled the Discord approval");
        expect(html).not.toContain("Join link expired");
      } else {
        expect(html).toContain("Join link expired");
        expect(html).not.toContain("Join cancelled");
      }
      expect(html).not.toContain("never-echo-stray");

      // Nothing downstream ran for the stray.
      expect(calls).toHaveLength(0);
      expect(create).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(setCookieFor(stray, SESSION)).toBeUndefined();
      expect(fake.attempts).toHaveLength(0);

      // B's pending journey is byte-for-byte intact in the browser jar.
      expectJourneyUntouched(stray, jar, before);

      await expectBCompletes(e, jar, b.state, fake, create);
      expect(calls.some((c) => c.url.endsWith("/oauth2/token"))).toBe(true);
    },
  );

  it("repeated stray hits in a row still leave B completable", async () => {
    const { create, fake, env: e } = isolated();
    const calls = mockDiscord();
    const { jar, a, b, before } = await twoTabs(e);

    for (const [query, expected] of [
      [`code=abc&state=${a.state}`, "Join link expired"],
      ["", "Join link expired"],
      [`code=${OVERSIZED}&state=${b.state}`, "Join link expired"],
      [`error=access_denied&error_description=never-echo-stray&state=${a.state}`, "Join cancelled"],
    ] as [string, string][]) {
      const stray = await callbackWithJar(e, jar, query);
      expect(stray.status).toBe(200);
      expect(await stray.text()).toContain(expected);
      expectJourneyUntouched(stray, jar, before);
    }
    expect(calls).toHaveLength(0);
    expect(fake.attempts).toHaveLength(0);

    await expectBCompletes(e, jar, b.state, fake, create);
  });

  it("rejecting stale tab A against B's jar does not consume A's journey either", async () => {
    const { fake, env: e } = isolated();
    const calls = mockDiscord();
    const { jar, a, aJarHeader, before } = await twoTabs(e);

    const stray = await callbackWithJar(e, jar, `code=abc&state=${a.state}`);
    expect(stray.status).toBe(200);
    expect(await stray.text()).toContain("Join link expired");
    expect(calls).toHaveLength(0);
    expect(fake.attempts).toHaveLength(0);
    expectJourneyUntouched(stray, jar, before);

    // Tab A presented with its own original cookies is still admissible:
    // the crossed hit consumed neither journey.
    const resA = await app.request(
      `/join/callback?code=abc&state=${a.state}`,
      { headers: { cookie: aJarHeader } },
      e,
    );
    expect(resA.status).toBe(302);
    expect(resA.headers.get("location")).toBe("/events");
    expect(fake.attempts).toEqual([
      { outcome: "added", source: "first-source", requestId: null, discordId: "42" },
    ]);
  });
});

describe("admitted terminal callbacks still clear only their own journey (controls)", () => {
  it("B's own success clears its cookies and a replay records nothing new", async () => {
    const { create, replace, fake, env: e } = isolated();
    const calls = mockDiscord();
    const { jar, b } = await twoTabs(e);
    const preCallbackHeader = jar.header();

    await expectBCompletes(e, jar, b.state, fake, create);
    const callsAfter = calls.length;

    const replay = await app.request(
      `/join/callback?code=abc&state=${b.state}`,
      { headers: { cookie: preCallbackHeader } },
      e,
    );
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("Join link expired");
    expect(setCookieFor(replay, SESSION)).toBeUndefined();
    expect(calls).toHaveLength(callsAfter);
    expect(fake.attempts).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("a matching-state consent denial is terminal: denied audit, own cookies cleared, one-use", async () => {
    const { create, replace, fake, env: e } = isolated();
    const calls = mockDiscord();
    const { jar, b } = await twoTabs(e);
    const preCallbackHeader = jar.header();

    const res = await callbackWithJar(
      e,
      jar,
      `error=access_denied&error_description=never-echo-denied&state=${b.state}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Join cancelled");
    expect(html).not.toContain("never-echo-denied");
    expect(calls).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(setCookieFor(res, SESSION)).toBeUndefined();
    expect(fake.attempts).toEqual([
      {
        outcome: "denied",
        source: "second-source",
        requestId: res.headers.get("x-request-id"),
        discordId: null,
      },
    ]);
    for (const name of JOURNEY_COOKIES) expectDeletion(res, name);
    jar.apply(res);
    for (const name of JOURNEY_COOKIES) expect(jar.has(name)).toBe(false);

    // The denied journey is consumed: completing it afterwards is a replay.
    const after = await app.request(
      `/join/callback?code=abc&state=${b.state}`,
      { headers: { cookie: preCallbackHeader } },
      e,
    );
    expect(after.status).toBe(200);
    expect(await after.text()).toContain("Join link expired");
    expect(calls).toHaveLength(0);
    expect(fake.attempts).toHaveLength(1);
  });

  it("a failed code exchange after admission keeps its 503/error outcome and clears its own cookies", async () => {
    const { create, replace, fake, env: e } = isolated();
    const calls = mockDiscord({ failExchange: true });
    const { jar, b } = await twoTabs(e);

    const res = await callbackWithJar(e, jar, `code=abc&state=${b.state}`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Discord is unreachable");
    expect(calls.some((c) => c.url.endsWith("/oauth2/token"))).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(setCookieFor(res, SESSION)).toBeUndefined();
    expect(fake.attempts).toEqual([
      {
        outcome: "error",
        source: "second-source",
        requestId: res.headers.get("x-request-id"),
        discordId: null,
      },
    ]);
    for (const name of JOURNEY_COOKIES) expectDeletion(res, name);
    jar.apply(res);
    for (const name of JOURNEY_COOKIES) expect(jar.has(name)).toBe(false);
  });

  it("an admitted return without a code keeps its expired/error outcome and clears its own cookies", async () => {
    const { create, replace, fake, env: e } = isolated();
    const calls = mockDiscord();
    const { jar, b } = await twoTabs(e);
    const preCallbackHeader = jar.header();

    const res = await callbackWithJar(e, jar, `state=${b.state}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(calls).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(setCookieFor(res, SESSION)).toBeUndefined();
    expect(fake.attempts).toEqual([
      {
        outcome: "error",
        source: "second-source",
        requestId: res.headers.get("x-request-id"),
        discordId: null,
      },
    ]);
    for (const name of JOURNEY_COOKIES) expectDeletion(res, name);
    jar.apply(res);
    for (const name of JOURNEY_COOKIES) expect(jar.has(name)).toBe(false);

    // That journey is consumed: a later completion attempt is a replay.
    const after = await app.request(
      `/join/callback?code=abc&state=${b.state}`,
      { headers: { cookie: preCallbackHeader } },
      e,
    );
    expect(after.status).toBe(200);
    expect(await after.text()).toContain("Join link expired");
    expect(calls).toHaveLength(0);
    expect(fake.attempts).toHaveLength(1);
  });
});
