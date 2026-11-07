// Failed QA-token guesses draw on a per-client attempt budget (the ops-token
// shape in src/admin/ops-overrides.tsx): a presented credential takes an
// attempt before the digest comparison and a match refunds it, so only
// failed guesses drain a client. Exhaustion answers the same byte-identical
// 404 as any other refusal — never a 429, never a session — and the shared
// `qa-login` success bucket is never debited by a guess. A configured token
// under the minimum length leaves the route disabled entirely.
// Hermetic only: in-memory session store, in-memory throttle double,
// synthetic tokens, no network, no database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { MIN_QA_TOKEN_LENGTH, QA_HEADER, STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";

const TOKEN = "test-only-qa-failed-attempts-token";
const WRONG = "wrong-test-token";
const NOW = Date.UTC(2026, 10, 1);
const RAY = "0123456789abcdef-LHR";

function fakeThrottleStore() {
  const hits: { bucket: string; at: number }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const head = strings.join("?");
    if (head.includes("pg_advisory_xact_lock")) return [];
    if (head.includes("SELECT count(*)")) {
      const rows = hits.filter((h) => h.bucket === v[0] && h.at > Date.now() - 60_000);
      return [{ n: rows.length, wait: 30 }];
    }
    if (head.includes("INSERT INTO web_throttle_hits"))
      hits.push({ bucket: v[0] as string, at: Date.now() });
    return [];
  }) as unknown as Sql & { begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown> };
  sql.begin = (run) => run(sql);
  (sql as unknown as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql, hits };
}

function fixture(configured: string = TOKEN) {
  const throttle = fakeThrottleStore();
  const store = createMemorySessionStore(() => NOW);
  const create = vi.spyOn(store, "create");
  const bindings = {
    APP_URL: STAGING_APP_URL,
    DISCORD_CLIENT_ID: "test-client",
    DISCORD_CLIENT_SECRET: "test-client-secret",
    DISCORD_GUILD_ID: "test-guild",
    DISCORD_BOT_TOKEN: "test-bot-token",
    DISCORD_INVITE_URL: "https://discord.gg/test-invite",
    SESSION_SECRET: "test-session-signing-key-at-least-32-bytes",
    QA_AUTH_TOKEN: configured,
    SESSION_STORE: store,
    THROTTLE_STORE: async () => throttle.sql,
    ADMIN_DB: {
      transaction: async () => {
        throw new Error("no suggestions in this fixture");
      },
    },
  } as unknown as EnvWithThrottle;
  return { bindings, create, hits: throttle.hits };
}

const request = (bindings: Env, ip: string, token?: string) =>
  app.request(
    "/auth/qa/qa-member",
    {
      method: "POST",
      headers: {
        origin: STAGING_APP_URL,
        "cf-connecting-ip": ip,
        "cf-ray": RAY,
        ...(token === undefined ? {} : { [QA_HEADER]: token }),
      },
    },
    bindings,
  );

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("QA failed-attempt fixtures must not use the network");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("failed QA-token attempts", () => {
  it("the configured fixture token meets the minimum length", () => {
    expect(TOKEN.length).toBeGreaterThanOrEqual(MIN_QA_TOKEN_LENGTH);
  });

  it("repeated bad guesses exhaust the budget; further guesses 404 without a digest compare", async () => {
    const f = fixture();
    const ip = "203.0.113.20";
    const digest = vi.spyOn(crypto.subtle, "digest");
    let baseline: { headers: [string, string][]; body: string } | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await request(f.bindings, ip, WRONG);
      expect(res.status).toBe(404);
      expect(res.headers.getSetCookie()).toHaveLength(0);
      baseline ??= { headers: [...res.headers], body: await res.text() };
    }
    expect(digest).toHaveBeenCalled();
    digest.mockClear();
    // Budget spent: a further bad guess and even the correct token are
    // refused with the identical 404 before any digest runs.
    for (const presented of [WRONG, TOKEN]) {
      const res = await request(f.bindings, ip, presented);
      expect(res.status).toBe(404);
      expect([...res.headers]).toEqual(baseline!.headers);
      expect(await res.text()).toBe(baseline!.body);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    }
    expect(digest).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    // Guesses never debit the shared qa-login bucket (or any DB bucket).
    expect(f.hits).toHaveLength(0);
  });

  it("the budget refills over time and a valid login then succeeds", async () => {
    const f = fixture();
    const ip = "203.0.113.21";
    for (let i = 0; i < 10; i++) expect((await request(f.bindings, ip, WRONG)).status).toBe(404);
    expect((await request(f.bindings, ip, TOKEN)).status).toBe(404);
    vi.spyOn(Date, "now").mockReturnValue(NOW + 1_000);
    const res = await request(f.bindings, ip, TOKEN);
    expect(res.status).toBe(204);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("one client's failed guesses do not drain another client's budget", async () => {
    const f = fixture();
    for (let i = 0; i < 10; i++)
      expect((await request(f.bindings, "203.0.113.22", WRONG)).status).toBe(404);
    const res = await request(f.bindings, "203.0.113.23", TOKEN);
    expect(res.status).toBe(204);
  });

  it("missing-token probes present no credential and do not drain the budget", async () => {
    const f = fixture();
    const ip = "203.0.113.24";
    for (let i = 0; i < 12; i++) expect((await request(f.bindings, ip)).status).toBe(404);
    expect((await request(f.bindings, ip, TOKEN)).status).toBe(204);
  });

  it("failed guesses at the alert probe drain the same budget as the login gate", async () => {
    const f = fixture();
    const ip = "203.0.113.26";
    for (let i = 0; i < 10; i++) {
      const res = await app.request(
        "/__probe/alert",
        {
          method: "POST",
          headers: {
            origin: STAGING_APP_URL,
            "cf-connecting-ip": ip,
            "cf-ray": RAY,
            [QA_HEADER]: WRONG,
          },
        },
        f.bindings,
      );
      expect(res.status).toBe(404);
    }
    // One budget across surfaces: the login gate refuses this client until a refill.
    expect((await request(f.bindings, ip, TOKEN)).status).toBe(404);
    vi.spyOn(Date, "now").mockReturnValue(NOW + 1_000);
    expect((await request(f.bindings, ip, TOKEN)).status).toBe(204);
  });

  it("a configured token under the minimum length leaves the route disabled", async () => {
    const short = "x".repeat(MIN_QA_TOKEN_LENGTH - 1);
    const f = fixture(short);
    const res = await request(f.bindings, "203.0.113.25", short);
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(f.create).not.toHaveBeenCalled();
  });
});
