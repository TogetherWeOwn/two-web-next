/// <reference types="vite/client" />
// Acceptance: the join funnel degrades to allow when the throttle store
// throws. The auth routes already fail open through throttleGuard ("a missed
// count beats a 500"); the two join routes must land on the same verdict
// instead of turning a store outage into a 500 on the highest-value funnel.
// Hermetic throughout: in-memory Sql doubles, no database.
//
// What is pinned:
// - throttled() admits (null) when the store double's transaction throws,
//   when a throttle statement throws, and when resolving the store itself
//   rejects — the three failures throttleGuard already absorbs.
// - GET /join/discord and GET /join/callback answer their normal 302s with
//   a throwing store, and the journey actually proceeds (Discord redirect,
//   state cookie, signed-in session, recorded attempt), not a bare bounce.
// - A throwing store never flips to a refusal: repeated starts past the
//   healthy budget all admit, because no hit was ever recorded.
// - The thrown error's text is never echoed to the console (a store error
//   can carry connection detail; the degrade path stays silent about it).
//
// Controls that must stay green before and after the fix:
// - Healthy store: throttled() admits the budget, then refuses with a 429
//   response carrying Retry-After; /join/discord refuses the 11th start.
// - Missing store (null) admits, as today.
// - throttleGuard's existing throw-to-allow behavior (the parity target).
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { throttled, type JoinRouteDeps } from "../src/join/route-shared";
import { JOIN_THROTTLE_PER_MINUTE } from "../src/join/service";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import { throttleGuard, type EnvWithThrottle } from "../src/throttle";
import app from "./app";

const CANARY = "throttle-store-down-canary-secret";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: "1546777856984481792",
};

type ThrowMode = "begin" | "statement" | null;

// In-memory Sql double speaking the statements the join journey emits.
// "begin" fails only the throttle transaction, so attempt recording (now its
// own BEGIN plus SET LOCAL statement_timeout) still works and the failure
// stays isolated to the throttle check. "statement" fails every
// web_throttle_hits statement.
function makeSql(mode: ThrowMode = null) {
  const hits: { bucket: string; at: number }[] = [];
  const attempts: { outcome: string; discordId: string | null }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings.join("?");
    if (mode === "statement" && head.includes("web_throttle_hits")) throw new Error(CANARY);
    if (head.includes("pg_advisory_xact_lock")) return [];
    if (head.includes("count(*)")) {
      const cutoff = Date.now() - 60_000;
      const rows = hits.filter((r) => r.bucket === values[0] && r.at > cutoff);
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
      hits.push({ bucket: values[0] as string, at: Date.now() });
      return [];
    }
    if (head.includes("DELETE FROM web_throttle_hits")) return [];
    if (head.includes("INSERT INTO join_attempts")) {
      attempts.push({ outcome: values[0] as string, discordId: values[3] as string | null });
      return [];
    }
    throw new Error(`makeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql & {
    begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
    unsafe: (q: string) => Promise<unknown>;
  };
  sql.unsafe = async () => [];
  sql.begin =
    mode === "begin"
      ? async (run: (tx: Sql) => Promise<unknown>) => {
          // Fail only the throttle transaction: it opens with
          // SET LOCAL lock_timeout and touches the advisory lock /
          // web_throttle_hits. The analytics transaction opens with
          // SET LOCAL statement_timeout and writes join_attempts, which
          // must stay healthy so the callback journey still records.
          const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const head = strings.join("?");
            if (
              head.includes("pg_advisory_xact_lock") ||
              head.includes("web_throttle_hits") ||
              head.includes("lock_timeout")
            )
              throw new Error(CANARY);
            return (sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(
              strings,
              ...values,
            );
          }) as unknown as Sql & {
            begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
            unsafe: (q: string) => Promise<unknown>;
          };
          tx.unsafe = async (q: string) => {
            if (q.includes("lock_timeout") || q.includes("pg_advisory_xact_lock"))
              throw new Error(CANARY);
            return [];
          };
          tx.begin = (nested: (tx: Sql) => Promise<unknown>) => nested(tx as unknown as Sql);
          return run(tx as unknown as Sql);
        }
      : (run) => run(sql);
  return { sql, hits, attempts };
}

function joinEnv(store: JoinRouteDeps["store"]): Env {
  return {
    ...baseEnv,
    SESSION_STORE: createMemorySessionStore(),
    JOIN_DEPS: { store },
  } as unknown as Env;
}

// Drive throttled()/throttleGuard() through a real Hono context so the
// client key, env seam and 429 rendering all run for real.
function probe() {
  const a = new Hono<{ Bindings: Env }>();
  a.get("/join-verdict", async (c) => (await throttled(c)) ?? c.body(null, 204));
  a.get("/guard-verdict", async (c) => (await throttleGuard(c, "probe", 2)) ?? c.body(null, 204));
  return a;
}

function mockDiscord() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
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
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("throttled() degrades to allow when the throttle store throws", () => {
  it("admits when the store transaction (begin) throws", async () => {
    const { sql } = makeSql("begin");
    const res = await probe().request(
      "/join-verdict",
      {},
      joinEnv(async () => sql),
    );
    expect(res.status).toBe(204);
  });

  it("admits when a throttle statement throws inside the transaction", async () => {
    const { sql } = makeSql("statement");
    const res = await probe().request(
      "/join-verdict",
      {},
      joinEnv(async () => sql),
    );
    expect(res.status).toBe(204);
  });

  it("admits when resolving the store itself rejects", async () => {
    const res = await probe().request(
      "/join-verdict",
      {},
      joinEnv(async () => {
        throw new Error(CANARY);
      }),
    );
    expect(res.status).toBe(204);
  });

  it("never echoes the thrown store error to the console", async () => {
    const calls: unknown[][] = [];
    for (const level of ["error", "warn", "log"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });
    }
    const { sql } = makeSql("begin");
    const res = await probe().request(
      "/join-verdict",
      {},
      joinEnv(async () => sql),
    );
    expect(res.status).toBe(204);
    expect(JSON.stringify(calls)).not.toContain(CANARY);
  });

  it("healthy store: admits the budget, then refuses with 429 + Retry-After", async () => {
    const { sql, hits } = makeSql();
    const env = joinEnv(async () => sql);
    const a = probe();
    for (let i = 0; i < JOIN_THROTTLE_PER_MINUTE; i++) {
      expect((await a.request("/join-verdict", {}, env)).status).toBe(204);
    }
    const refused = await a.request(
      "/join-verdict",
      { headers: { accept: "application/json" } },
      env,
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(hits).toHaveLength(JOIN_THROTTLE_PER_MINUTE);
  });

  it("missing store (null) still admits", async () => {
    const res = await probe().request(
      "/join-verdict",
      {},
      joinEnv(async () => null),
    );
    expect(res.status).toBe(204);
  });
});

describe("throttleGuard parity target (existing behavior, must not move)", () => {
  it("admits when its store transaction throws", async () => {
    const { sql } = makeSql("begin");
    const env = { ...baseEnv, THROTTLE_STORE: async () => sql } as unknown as EnvWithThrottle;
    expect((await probe().request("/guard-verdict", {}, env)).status).toBe(204);
  });

  it("admits when resolving its store rejects", async () => {
    const env = {
      ...baseEnv,
      THROTTLE_STORE: async () => {
        throw new Error(CANARY);
      },
    } as unknown as EnvWithThrottle;
    expect((await probe().request("/guard-verdict", {}, env)).status).toBe(204);
  });
});

describe("join routes with a throwing throttle store", () => {
  it("GET /join/discord answers the Discord 302 (not 500, not a /join bounce)", async () => {
    const { sql } = makeSql("begin");
    const res = await app.request(
      "/join/discord",
      {},
      joinEnv(async () => sql),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_join_state=");
  });

  it("repeated starts past the healthy budget all admit: no phantom hits, no refusal", async () => {
    const { sql, hits } = makeSql("begin");
    const env = joinEnv(async () => sql);
    for (let i = 0; i < JOIN_THROTTLE_PER_MINUTE + 2; i++) {
      expect((await app.request("/join/discord", {}, env)).status).toBe(302);
    }
    expect(hits).toHaveLength(0);
  });

  it("GET /join/callback completes the journey: 302, session issued, attempt recorded", async () => {
    const { sql, attempts } = makeSql("begin");
    const env = joinEnv(async () => sql);
    mockDiscord();
    const start = await app.request("/join/discord", {}, env);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const cookie = start.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const res = await app.request(
      `/join/callback?code=abc&state=${state}`,
      { headers: { cookie } },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=joined");
    expect(res.headers.getSetCookie().join("\n")).toContain("__Host-two_session=");
    expect(attempts).toEqual([{ outcome: "added", discordId: "42" }]);
  });

  it("healthy store: /join/discord still refuses the 11th start with the 429 envelope", async () => {
    const { sql, hits } = makeSql();
    const env = joinEnv(async () => sql);
    for (let i = 0; i < JOIN_THROTTLE_PER_MINUTE; i++) {
      expect((await app.request("/join/discord", {}, env)).status).toBe(302);
    }
    const refused = await app.request(
      "/join/discord",
      { headers: { accept: "application/json" } },
      env,
    );
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ reason: "rate_limited" });
    expect(hits).toHaveLength(JOIN_THROTTLE_PER_MINUTE);
  });
});
