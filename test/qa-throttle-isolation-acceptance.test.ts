// Acceptance oracle: unauthenticated QA-seam probes must not consume the
// shared `qa-login` throttle counter that legitimate QA sign-ins rely on.
//
// Production change that must make this fail if reverted: moving QA throttle
// accounting back in front of the token/identity gate on POST /auth/qa/:identity
// (any probe, authenticated or not, debits `qa-login:<client ip>` in the shared
// web_throttle_hits counter). The oracle is deliberately agnostic about the
// fix shape — isolated accounting for probes or post-gate enforcement both
// satisfy it — and pins only the observable contract:
//   1. probes debit nothing from the `qa-login:<ip>` shared bucket;
//   2. a valid QA login from the same client still succeeds after a probe
//      flood that would have exhausted the old shared budget;
//   3. missing-token, bad-token and unknown-identity refusals stay
//      byte-identical 404s (status, headers, body, no session cookie);
//   4. legitimate QA logins keep the existing 10/min throttle protection.
// Hermetic only: in-memory session store, in-memory throttle double,
// synthetic tokens, no network, no database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { QA_HEADER, STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import { AUTH_THROTTLE_PER_MINUTE, type EnvWithThrottle } from "../src/throttle";

const TOKEN = "test-only-qa-throttle-isolation-token";
const NOW = Date.UTC(2026, 9, 18);
const RAY = "0123456789abcdef-LHR";
const SESSION_COOKIE = "__Host-two_session";

// In-memory stand-in for the shared Postgres fixed-window counter
// (web_throttle_hits via checkJoinThrottle). Records every debited bucket so
// tests can assert exactly which bucket a request consumed. Mirrors the
// statement shapes in test/throttle.test.ts.
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
  // The throttle sets `SET LOCAL lock_timeout` through `unsafe` before the
  // advisory lock (as in test/join.test.ts); the double passes it through.
  (sql as unknown as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql, hits };
}

function fixture() {
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
    QA_AUTH_TOKEN: TOKEN,
    SESSION_STORE: store,
    THROTTLE_STORE: async () => throttle.sql,
    // Every 404 page reads upcoming events through ADMIN_DB; a failing seam
    // keeps the suggestions empty and the refusal bytes deterministic.
    ADMIN_DB: {
      transaction: async () => {
        throw new Error("no suggestions in this fixture");
      },
    },
  } as unknown as EnvWithThrottle;
  const qaLoginHits = (ip: string) => throttle.hits.filter((h) => h.bucket === `qa-login:${ip}`);
  return { bindings, create, hits: throttle.hits, qaLoginHits };
}

type Probe = { identity: string; token?: string };

const request = (bindings: Env, ip: string, { identity, token }: Probe) =>
  app.request(
    `/auth/qa/${identity}`,
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

const UNAUTHENTICATED_PROBES: Probe[] = [
  { identity: "qa-member" }, // missing token
  { identity: "qa-member", token: "wrong-test-token" }, // bad token
  { identity: "not-a-qa-identity", token: TOKEN }, // unknown identity, valid token
  { identity: "not-a-qa-identity", token: "wrong-test-token" }, // unknown identity, bad token
];

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("QA throttle fixtures must not use the network");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("QA throttle isolation from the shared counter", () => {
  it("unauthenticated probes debit nothing from the shared qa-login bucket", async () => {
    const f = fixture();
    const ip = "203.0.113.10";
    // Two rounds of every probe shape: 8 requests, under the 10/min budget, so
    // a pre-gate throttle admits and counts every one of them (no 429 masking).
    for (let round = 0; round < 2; round++) {
      for (const probe of UNAUTHENTICATED_PROBES) {
        const res = await request(f.bindings, ip, probe);
        expect(res.status).toBe(404);
        expect(res.headers.getSetCookie()).toHaveLength(0);
      }
    }
    expect(f.create).not.toHaveBeenCalled();
    expect(f.qaLoginHits(ip)).toHaveLength(0);
    // QA probes must not spill into the real auth-route buckets either.
    expect(f.hits.filter((h) => h.bucket.startsWith("login-"))).toHaveLength(0);
  });

  it("a valid QA login still succeeds after probes exhaust the old shared budget", async () => {
    const f = fixture();
    const ip = "203.0.113.11";
    // Flood past AUTH_THROTTLE_PER_MINUTE with bad-token probes. Their own
    // statuses are not pinned beyond refusal (404, or 429 if probes get an
    // isolated bucket of their own) — what matters is the valid login after.
    for (let i = 0; i < AUTH_THROTTLE_PER_MINUTE + 5; i++) {
      const res = await request(f.bindings, ip, {
        identity: "qa-member",
        token: "wrong-test-token",
      });
      expect([404, 429]).toContain(res.status);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    }
    // The guesses drain this client's per-client attempt budget (src/qa.ts),
    // which refills over time; advance the clock for one refill. The shared
    // qa-login budget below was never debited, so the valid login is not
    // locked out of it.
    vi.spyOn(Date, "now").mockReturnValue(NOW + 1_000);
    const res = await request(f.bindings, ip, { identity: "qa-member", token: TOKEN });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(f.create).toHaveBeenCalledTimes(1);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
  });

  it("missing-token, bad-token and unknown-identity refusals are byte-identical 404s", async () => {
    const f = fixture();
    const ip = "203.0.113.12";
    const responses: Response[] = [];
    for (const probe of UNAUTHENTICATED_PROBES)
      responses.push(await request(f.bindings, ip, probe));
    const [baseline, ...rest] = responses;
    expect(baseline!.status).toBe(404);
    const baselineBody = await baseline!.text();
    expect(baselineBody.length).toBeGreaterThan(0);
    for (const res of rest) {
      expect(res.status).toBe(404);
      expect([...res.headers]).toEqual([...baseline!.headers]);
      expect(await res.text()).toBe(baselineBody);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    }
    expect(baseline!.headers.getSetCookie()).toHaveLength(0);
    expect(f.create).not.toHaveBeenCalled();
  });

  it("legitimate QA logins keep the existing per-minute throttle protection", async () => {
    const f = fixture();
    const ip = "203.0.113.13";
    for (let i = 0; i < AUTH_THROTTLE_PER_MINUTE; i++) {
      const res = await request(f.bindings, ip, { identity: "qa-member", token: TOKEN });
      expect(res.status).toBe(204);
    }
    const refused = await request(f.bindings, ip, { identity: "qa-member", token: TOKEN });
    expect(refused.status).toBe(429);
    expect(f.create).toHaveBeenCalledTimes(AUTH_THROTTLE_PER_MINUTE);
    // The budget is per client: a different client is unaffected.
    const other = await request(f.bindings, "203.0.113.14", {
      identity: "qa-moderator",
      token: TOKEN,
    });
    expect(other.status).toBe(204);
  });
});
