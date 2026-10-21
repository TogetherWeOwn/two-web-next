/// <reference types="vite/client" />
// route-inventory: GET /join/discord
// route-inventory: GET /join/callback
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import type { JoinRouteDeps } from "../src/join/route";
import { createMemorySessionStore, type Sql } from "../src/sessions";

// Acceptance oracle: a fresh /join/discord journey must isolate its optional
// intent cookies. After a new journey is successfully admitted, its
// next/source cookies reflect only that request's sanitized intent: absent or
// rejected values expire stale cookies left by an abandoned earlier start,
// and valid replacements are preserved. A browser-like jar that merges two
// starts and completes the second flow must use the second request's return
// target/default and source attribution, never the abandoned first journey's.
//
// Pre-fix failure mode: the start route sets the optional cookies only when
// the new sanitized values are truthy, so a plain second start inherits the
// first journey's cookies for the rest of their TTL.

const MOD_ROLE = "1546777856984481792";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
};

const STATE = "__Host-two_join_state";
const SOURCE = "__Host-two_join_source";
const NEXT = "__Host-two_join_next";

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

  has(name: string) {
    return this.cookies.has(name);
  }

  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function setCookieFor(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((h) => h.startsWith(`${name}=`));
}

/** A deletion Set-Cookie mirrors the callback's clearing attributes. */
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

/** A live intent cookie keeps its signed value and journey attributes. */
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
  const e = {
    ...env,
    SESSION_STORE: store,
    JOIN_DEPS: { store: async () => fake.sql, ...deps },
  } as unknown as Env;
  return { store, fake, env: e };
}

function mockDiscord(joinStatus = 201) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token" });
      if (url.endsWith("/users/@me"))
        return Response.json({ id: "42", username: "rick", global_name: "Rick", avatar: null });
      if (url.includes("/members/42") && init?.method === "PUT")
        return new Response(null, { status: joinStatus });
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
  const location = res.headers.get("location") ? new URL(res.headers.get("location")!) : null;
  jar.apply(res);
  return { res, state: location?.searchParams.get("state") ?? null };
}

const completeWithJar = (e: Env, jar: Jar, state: string) =>
  app.request(`/join/callback?code=abc&state=${state}`, { headers: { cookie: jar.header() } }, e);

afterEach(() => vi.unstubAllGlobals());

describe("fresh-journey intent-cookie isolation (acceptance)", () => {
  it("a plain second start expires stale source/next cookies from an abandoned first start", async () => {
    const { env: e } = isolated();
    const jar = new Jar();
    const first = await startWithJar(e, jar, "?source=web-homepage&next=/events");
    expect(first.res.status).toBe(302);
    expectLiveCookie(first.res, SOURCE);
    expectLiveCookie(first.res, NEXT);
    expect(jar.has(SOURCE)).toBe(true);
    expect(jar.has(NEXT)).toBe(true);

    // Abandon OAuth, then start plainly within the cookie TTL.
    const second = await startWithJar(e, jar);
    expect(second.res.status).toBe(302);
    expect(second.state).not.toBe(first.state);
    expectDeletion(second.res, SOURCE);
    expectDeletion(second.res, NEXT);
    expectLiveCookie(second.res, STATE);
    expect(jar.has(SOURCE)).toBe(false);
    expect(jar.has(NEXT)).toBe(false);
    expect(jar.has(STATE)).toBe(true);
  });

  it("completing the plain second flow uses the default redirect and no source, never the abandoned intent", async () => {
    const { fake, env: e } = isolated();
    mockDiscord();
    const jar = new Jar();
    await startWithJar(e, jar, "?source=web-homepage&next=/events");
    const second = await startWithJar(e, jar);

    const res = await completeWithJar(e, jar, second.state!);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(fake.attempts).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
    // Callback cleanup is preserved.
    for (const name of [STATE, SOURCE, NEXT]) expectDeletion(res, name);
  });

  it("rejected source/next values on the second start also expire the stale cookies", async () => {
    const { fake, env: e } = isolated();
    mockDiscord();
    const jar = new Jar();
    await startWithJar(e, jar, "?source=web-homepage&next=/events");

    const second = await startWithJar(
      e,
      jar,
      `?source=${encodeURIComponent("a/b")}&next=${encodeURIComponent("https://evil.test/")}`,
    );
    expect(second.res.status).toBe(302);
    expectDeletion(second.res, SOURCE);
    expectDeletion(second.res, NEXT);
    expect(jar.has(SOURCE)).toBe(false);
    expect(jar.has(NEXT)).toBe(false);

    const res = await completeWithJar(e, jar, second.state!);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(fake.attempts).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
  });

  it("a second start with only next expires the stale source and keeps the new return target", async () => {
    const { fake, env: e } = isolated();
    mockDiscord();
    const jar = new Jar();
    await startWithJar(e, jar, "?source=web-homepage&next=/events");

    const second = await startWithJar(e, jar, "?next=/profile");
    expectDeletion(second.res, SOURCE);
    expectLiveCookie(second.res, NEXT);
    expect(jar.has(SOURCE)).toBe(false);

    const res = await completeWithJar(e, jar, second.state!);
    expect(res.headers.get("location")).toBe("/profile");
    expect(fake.attempts).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
  });

  it("a second start with only source expires the stale next and keeps the new attribution", async () => {
    const { fake, env: e } = isolated();
    mockDiscord();
    const jar = new Jar();
    await startWithJar(e, jar, "?source=web-homepage&next=/events");

    const second = await startWithJar(e, jar, "?source=fresh-source");
    expectLiveCookie(second.res, SOURCE);
    expectDeletion(second.res, NEXT);
    expect(jar.has(NEXT)).toBe(false);

    const res = await completeWithJar(e, jar, second.state!);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(fake.attempts).toEqual([
      { outcome: "added", source: "fresh-source", requestId: null, discordId: "42" },
    ]);
  });

  it("valid replacements on the second start are preserved end to end", async () => {
    const { fake, env: e } = isolated();
    mockDiscord();
    const jar = new Jar();
    await startWithJar(e, jar, "?source=first-source&next=/events");

    const second = await startWithJar(e, jar, "?source=second-source&next=/profile");
    expectLiveCookie(second.res, SOURCE);
    expectLiveCookie(second.res, NEXT);
    expect(setCookieFor(second.res, SOURCE)).not.toContain("Max-Age=0");
    expect(setCookieFor(second.res, NEXT)).not.toContain("Max-Age=0");

    const res = await completeWithJar(e, jar, second.state!);
    expect(res.headers.get("location")).toBe("/profile");
    expect(fake.attempts).toEqual([
      { outcome: "added", source: "second-source", requestId: null, discordId: "42" },
    ]);
  });

  it("a single fresh start without optional intent sets no live source/next value", async () => {
    const { fake, env: e } = isolated();
    mockDiscord();
    const jar = new Jar();
    const start = await startWithJar(e, jar);
    // Either no header or a deletion is acceptable for a jar that never held
    // intent cookies; a live value is not.
    for (const name of [SOURCE, NEXT]) {
      const header = setCookieFor(start.res, name);
      if (header) expectDeletion(start.res, name);
      expect(jar.has(name)).toBe(false);
    }
    const res = await completeWithJar(e, jar, start.state!);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(fake.attempts).toEqual([
      { outcome: "added", source: null, requestId: null, discordId: "42" },
    ]);
  });

  it("journey-store failure on the second start sets and expires nothing: no new journey, jar untouched", async () => {
    const { store, env: e } = isolated();
    const jar = new Jar();
    await startWithJar(e, jar, "?source=web-homepage&next=/events");
    expect(jar.has(SOURCE)).toBe(true);

    store.journeys.issue = async () => {
      throw new Error("journey store down");
    };
    const res = await app.request("/join/discord", { headers: { cookie: jar.header() } }, e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/join?notice=start-failed");
    expect(res.headers.get("cache-control")).toContain("no-store");
    for (const name of [STATE, SOURCE, NEXT]) {
      expect(setCookieFor(res, name), `${name} untouched on store failure`).toBeUndefined();
    }
    jar.apply(res);
    expect(jar.has(SOURCE)).toBe(true);
    expect(jar.has(NEXT)).toBe(true);
  });

  it("one-use state admission survives isolation: replaying the completed second flow records nothing new", async () => {
    const { fake, env: e } = isolated();
    const calls = mockDiscord();
    const jar = new Jar();
    await startWithJar(e, jar, "?source=web-homepage&next=/events");
    const second = await startWithJar(e, jar, "?source=fresh-source&next=/profile");
    const preCallback = jar.header();

    const res = await completeWithJar(e, jar, second.state!);
    expect(res.headers.get("location")).toBe("/profile");
    const callsAfterFirst = calls.length;

    const replay = await app.request(
      `/join/callback?code=abc&state=${second.state}`,
      { headers: { cookie: preCallback } },
      e,
    );
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("Join link expired");
    expect(calls).toHaveLength(callsAfterFirst);
    expect(fake.attempts).toHaveLength(1);
  });

  it("the abandoned first state cannot complete against the merged jar", async () => {
    const { fake, env: e } = isolated();
    const calls = mockDiscord();
    const jar = new Jar();
    const first = await startWithJar(e, jar, "?source=web-homepage&next=/events");
    await startWithJar(e, jar);

    const res = await completeWithJar(e, jar, first.state!);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Join link expired");
    expect(calls).toHaveLength(0);
    expect(fake.attempts).toHaveLength(0);
  });
});
