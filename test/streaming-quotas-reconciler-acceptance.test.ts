// ACCEPTANCE-OWNED (streaming S6: quotas + metering reconciler + session
// ledger). The Builder builds on this card's branch and never edits this
// file. Failing-first contract for spec section 9 S6 and decisions D1 + D7:
// per-tier monthly quotas, nightly metering reconciler, append-only session
// ledger, per-member usage page, and the spend-cannot-exceed-cap proof.
//
// Builder contract (all paths below are S6-owned; re-export from another
// file if you split them, but these import paths must keep working):
//
// - src/streaming/quotas.ts (pure, no I/O):
//   STREAMING_TIER_QUOTAS = { basic: { ingestMinutes: 300, destinations: 2,
//   outputMinutes: 600, fallbackMinutes: 500 }, plus: { ingestMinutes: 1200,
//   destinations: 5, outputMinutes: 6000, fallbackMinutes: 2000 } } (D1).
//   QUOTA_WARNING_RATIO = 0.8. quotaStatus(used, quota) -> "ok" | "warning"
//   | "exhausted" (warning at >= 80%, exhausted at >= 100%; zero/negative
//   quota with any state fails closed to "exhausted"; negative use clamps
//   to "ok"). canStartBroadcast(used, quota) -> { allowed, reason: "ok" |
//   "warning" | "quota_reached" } (blocked at >= 100%). outputMinutes(
//   ingest, enabledOutputs) = ingest * enabledOutputs. STREAMING_SESSION_
//   CAP_MS = 8h; sessionCapExceeded(elapsedMs) is elapsedMs >= 8h.
//   STREAMING_REENABLE_WINDOW_MS = 24h; canReEnableAfterCap(nowMs,
//   lastCapAtMs | null) is true when never capped or >= 24h elapsed.
// - src/streaming/ledger.ts: StreamingLedger = { openSession({ userId,
//   cfInputUid, startedAt: Date }), closeSession(id, { endedAt: Date,
//   ingestMinutes, outputMinutes, endedReason: string }), findByInputStart(
//   cfInputUid, startedAt: Date ), listOpenSessions({ limit, cursor? }) ->
//   { sessions, nextCursor: string | null } in ascending (startedAt, id)
//   order, periodUsage(userId, periodStart, periodEnd) -> { ingestMinutes,
//   outputMinutes } over closed sessions with startedAt in [start, end) }.
//   createMemoryStreamingLedger() and createPostgresStreamingLedger(sql)
//   (postgres.js Sql, same shape createPostgresSessionStore takes).
//   closeSession is write-once (second close rejects, row unchanged);
//   unknown ids reject; the interface exposes no delete/remove/purge.
// - src/streaming/reconciler.ts: reconcileStreamingSessions({ ledger,
//   analytics, enforcement, now?, limits?, cursor? }) -> { closed,
//   backfilled, capped, blocked, deferred, failed, apiCalls, nextCursor }.
//   analytics = { sessionReport(inputUid) -> { live, minutes,
//   enabledOutputs }, recentlyEnded(since: Date) -> [{ inputUid, userId,
//   startedAt, endedAt, minutes, enabledOutputs }] }. enforcement = {
//   usageFor(userId) -> { usedIngestMinutes, quotaIngestMinutes },
//   disableInput(inputUid, "quota" | "session_cap"), recordCap(userId,
//   at: Date) }. Backfill runs before the open scan (one recentlyEnded
//   call); per-input work (backfill inserts + open visits) is bounded by
//   maxInputsPerRun; analytics calls are bounded by maxApiCallsPerRun;
//   leftovers report as deferred with a resume nextCursor. Live sessions at
//   >= 100% stay open (current finishes) while disableInput("quota") fires;
//   live sessions at >= 8h close with endedReason "session_cap" plus
//   disableInput("session_cap") + recordCap. Analytics failures isolate per
//   input (failed++); enforcement/ledger errors propagate loudly.
//   DEFAULT_MAX_INPUTS_PER_RUN and DEFAULT_MAX_API_CALLS_PER_RUN are finite
//   (<= 1000 and <= 10000) with apiCalls default >= inputs default + 1.
// - Drizzle migration creating public.ingest_sessions per spec section 4
//   (id uuid PK, user_id text, cf_input_uid text, started_at timestamptz,
//   ended_at timestamptz null, ingest_minutes numeric null, output_minutes
//   numeric null, ended_reason text null; index on (user_id, started_at)),
//   registered in drizzle/meta/_journal.json so fixtures apply it.
// - src/streaming/usage-app.ts: streamingUsageApp({ ledger, sessionStore,
//   tierFor, now? }) -> Hono app serving GET /streaming/usage. tierFor(
//   userId) -> "basic" | "plus" | null is the S2 seam (null = no
//   subscription). Guest -> 302 /auth/discord before any store read;
//   signed-in non-member -> 403; member -> 200 private HTML with "Streaming
//   usage", "as of YYYY-MM-DD HH:MM UTC", ingest/output minutes for the
//   current UTC calendar month, "Approaching your streaming quota" at >=
//   80%, "Streaming quota reached" + href="/streaming" upgrade link at >=
//   100%, and "No active subscription" + href="/streaming" when tierFor is
//   null. The same route is mounted on the main app.
//
// Upstream seams this suite fakes (S2 subscriptions, S3 live inputs, S4
// destinations, S5 live page): the S6 Builder wires the real joins; the
// handoff manifest names each integration point. Usage periods are calendar
// months until S2 subscription periods land. The re-enable button and the
// setup-page surfacing of quota state belong to S3/S7 reusing the pure
// rules pinned here.
//
// Hermetic suites run everywhere; postgres + migration suites need
// DATABASE_URL (disposable agent-testdb or CI Postgres, isolated schema,
// dropped on dispose). No live Cloudflare, no Stripe, no network.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import type { Env } from "../src/env";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import app from "./app";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const ALICE = "100000000000000001";
const BOB = "100000000000000002";
const OUTSIDER = "100000000000000004";

const HOUR_MS = 3_600_000;
const SESSION_CAP_MS = 8 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;

const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET,
};

// Dynamic import through a non-literal specifier so this file typechecks
// before the Builder creates the modules (static imports of missing files
// would break tsc for the whole repo, and a missing module must read as a
// failed acceptance assertion naming the Builder contract, not a suite
// load error).
const dynamicSpecifier = (specifier: string) => specifier;

async function requireBuilderModule<T>(specifier: string, hint: string): Promise<T> {
  let mod: unknown = null;
  try {
    mod = await import(/* @vite-ignore */ dynamicSpecifier(specifier));
  } catch {
    mod = null;
  }
  expect(mod, `Builder: implement ${specifier} (${hint})`).not.toBeNull();
  return mod as T;
}

function requireExport<T>(mod: Record<string, unknown>, name: string, specifier: string): T {
  expect(typeof mod[name], `Builder: export ${name} from ${specifier}`).toBe("function");
  return mod[name] as T;
}

// Memoized per-test loader. Every test awaits its loader first, so a missing
// Builder module fails each test with the guided assertion (honest RED
// counts) instead of collapsing the suite into a beforeAll "skipped" blur.
function memoModule<T>(specifier: string, hint: string, exportNames: string[] = []) {
  let cached: T | null = null;
  return async (): Promise<T> => {
    if (cached) return cached;
    const mod = await requireBuilderModule<T>(specifier, hint);
    for (const name of exportNames) {
      requireExport(
        mod as unknown as Record<string, unknown>,
        name,
        specifier.replace(/^\.\.\//, ""),
      );
    }
    cached = mod;
    return mod;
  };
}

type QuotasContract = {
  STREAMING_TIER_QUOTAS: {
    basic: {
      ingestMinutes: number;
      destinations: number;
      outputMinutes: number;
      fallbackMinutes: number;
    };
    plus: {
      ingestMinutes: number;
      destinations: number;
      outputMinutes: number;
      fallbackMinutes: number;
    };
  };
  QUOTA_WARNING_RATIO: number;
  STREAMING_SESSION_CAP_MS: number;
  STREAMING_REENABLE_WINDOW_MS: number;
  quotaStatus: (usedMinutes: number, quotaMinutes: number) => string;
  canStartBroadcast: (
    usedMinutes: number,
    quotaMinutes: number,
  ) => { allowed: boolean; reason: string };
  outputMinutes: (ingestMinutes: number, enabledOutputs: number) => number;
  sessionCapExceeded: (elapsedMs: number) => boolean;
  canReEnableAfterCap: (nowMs: number, lastCapAtMs: number | null) => boolean;
};

type StreamingSessionRow = {
  id: string;
  userId: string;
  cfInputUid: string;
  startedAt: Date;
  endedAt: Date | null;
  ingestMinutes: number | null;
  outputMinutes: number | null;
  endedReason: string | null;
};

type StreamingLedger = {
  openSession: (input: {
    userId: string;
    cfInputUid: string;
    startedAt: Date;
  }) => Promise<StreamingSessionRow>;
  closeSession: (
    id: string,
    close: { endedAt: Date; ingestMinutes: number; outputMinutes: number; endedReason: string },
  ) => Promise<StreamingSessionRow>;
  findByInputStart: (cfInputUid: string, startedAt: Date) => Promise<StreamingSessionRow | null>;
  listOpenSessions: (opts: { limit: number; cursor?: string }) => Promise<{
    sessions: StreamingSessionRow[];
    nextCursor: string | null;
  }>;
  periodUsage: (
    userId: string,
    periodStart: Date,
    periodEnd: Date,
  ) => Promise<{ ingestMinutes: number; outputMinutes: number }>;
};

type LedgerContract = {
  createMemoryStreamingLedger: () => StreamingLedger;
  createPostgresStreamingLedger: (sql: Sql) => StreamingLedger;
};

type AnalyticsReport = { live: boolean; minutes: number; enabledOutputs: number };
type EndedEntry = {
  inputUid: string;
  userId: string;
  startedAt: Date;
  endedAt: Date;
  minutes: number;
  enabledOutputs: number;
};

type FakeAnalytics = {
  reports: Map<string, AnalyticsReport | Error>;
  ended: EndedEntry[];
  calls: string[];
  client: {
    sessionReport: (inputUid: string) => Promise<AnalyticsReport>;
    recentlyEnded: (since: Date) => Promise<EndedEntry[]>;
  };
};

function fakeAnalytics(): FakeAnalytics {
  const fake: FakeAnalytics = {
    reports: new Map(),
    ended: [],
    calls: [],
    client: {
      sessionReport: async (inputUid: string) => {
        fake.calls.push(`report:${inputUid}`);
        const entry = fake.reports.get(inputUid);
        if (entry instanceof Error) throw entry;
        if (!entry) throw new Error(`no fake report for ${inputUid}`);
        return entry;
      },
      recentlyEnded: async () => {
        fake.calls.push("recentlyEnded");
        return [...fake.ended];
      },
    },
  };
  return fake;
}

type FakeEnforcement = {
  usageByUser: Map<string, { usedIngestMinutes: number; quotaIngestMinutes: number }>;
  disabled: { inputUid: string; reason: string }[];
  caps: { userId: string; at: Date }[];
  failDisable: Error | null;
  client: {
    usageFor: (
      userId: string,
    ) => Promise<{ usedIngestMinutes: number; quotaIngestMinutes: number }>;
    disableInput: (inputUid: string, reason: "quota" | "session_cap") => Promise<void>;
    recordCap: (userId: string, at: Date) => Promise<void>;
  };
};

function fakeEnforcement(): FakeEnforcement {
  const fake: FakeEnforcement = {
    usageByUser: new Map(),
    disabled: [],
    caps: [],
    failDisable: null,
    client: {
      usageFor: async (userId: string) => {
        const usage = fake.usageByUser.get(userId);
        if (!usage) throw new Error(`no fake usage for ${userId}`);
        return usage;
      },
      disableInput: async (inputUid: string, reason: "quota" | "session_cap") => {
        if (fake.failDisable) throw fake.failDisable;
        if (!fake.disabled.some((d) => d.inputUid === inputUid && d.reason === reason)) {
          fake.disabled.push({ inputUid, reason });
        }
      },
      recordCap: async (userId: string, at: Date) => {
        fake.caps.push({ userId, at });
      },
    },
  };
  return fake;
}

type ReconcileResult = {
  closed: number;
  backfilled: number;
  capped: number;
  blocked: number;
  deferred: number;
  failed: number;
  apiCalls: number;
  nextCursor: string | null;
};

type ReconcilerContract = {
  DEFAULT_MAX_INPUTS_PER_RUN: number;
  DEFAULT_MAX_API_CALLS_PER_RUN: number;
  reconcileStreamingSessions: (deps: {
    ledger: StreamingLedger;
    analytics: FakeAnalytics["client"];
    enforcement: FakeEnforcement["client"];
    now?: () => Date;
    limits?: { maxInputsPerRun?: number; maxApiCallsPerRun?: number; pageSize?: number };
    cursor?: string;
  }) => Promise<ReconcileResult>;
};

type UsageAppContract = {
  streamingUsageApp: (deps: {
    ledger: StreamingLedger;
    sessionStore: SessionStore;
    tierFor: (userId: string) => Promise<"basic" | "plus" | null>;
    now?: () => Date;
  }) => { request: (input: string, init?: RequestInit) => Promise<Response> };
};

async function memberCookie(
  store: SessionStore,
  user: { userId: string; username: string; member: boolean },
): Promise<string> {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await store.create({
    tokenHash,
    userId: user.userId,
    username: user.username,
    avatar: null,
    member: user.member,
    moderator: false,
    expiresAt: new Date(Date.now() + HOUR_MS),
  });
  const session = (
    await serializeSigned(SESSION_COOKIE, token, SESSION_SECRET, { path: "/", secure: true })
  ).split(";")[0];
  const status = (
    await serializeSigned(AUTH_STATUS_COOKIE, tokenHash, SESSION_SECRET, {
      path: "/",
      secure: true,
    })
  ).split(";")[0];
  return `${session}; ${status}`;
}

const utcMonthBounds = (at: Date): { start: Date; end: Date } => {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
};

describe("streaming S6 quota math (spec section 3, D1 + D7)", () => {
  const loadQuotas = memoModule<QuotasContract>(
    "../src/streaming/quotas.ts",
    "pure quota math per this file's header",
    [
      "quotaStatus",
      "canStartBroadcast",
      "outputMinutes",
      "sessionCapExceeded",
      "canReEnableAfterCap",
    ],
  );

  it("pins the D1 tier quotas exactly", async () => {
    const quotas = await loadQuotas();
    expect(quotas.STREAMING_TIER_QUOTAS.basic).toEqual({
      ingestMinutes: 300,
      destinations: 2,
      outputMinutes: 600,
      fallbackMinutes: 500,
    });
    expect(quotas.STREAMING_TIER_QUOTAS.plus).toEqual({
      ingestMinutes: 1200,
      destinations: 5,
      outputMinutes: 6000,
      fallbackMinutes: 2000,
    });
  });

  it("holds the output-cap invariant: output = ingest x max destinations", async () => {
    const quotas = await loadQuotas();
    for (const tier of ["basic", "plus"] as const) {
      const q = quotas.STREAMING_TIER_QUOTAS[tier];
      expect(q.outputMinutes).toBe(q.ingestMinutes * q.destinations);
    }
  });

  it("warns at 80% and exhausts at 100% on the Basic 300-minute quota", async () => {
    const quotas = await loadQuotas();
    expect(quotas.QUOTA_WARNING_RATIO).toBe(0.8);
    expect(quotas.quotaStatus(0, 300)).toBe("ok");
    expect(quotas.quotaStatus(239.999, 300)).toBe("ok");
    expect(quotas.quotaStatus(240, 300)).toBe("warning");
    expect(quotas.quotaStatus(299.999, 300)).toBe("warning");
    expect(quotas.quotaStatus(300, 300)).toBe("exhausted");
    expect(quotas.quotaStatus(450, 300)).toBe("exhausted");
  });

  it("warns at 80% and exhausts at 100% on the Plus 1200-minute quota", async () => {
    const quotas = await loadQuotas();
    expect(quotas.quotaStatus(959.999, 1200)).toBe("ok");
    expect(quotas.quotaStatus(960, 1200)).toBe("warning");
    expect(quotas.quotaStatus(1199.999, 1200)).toBe("warning");
    expect(quotas.quotaStatus(1200, 1200)).toBe("exhausted");
    expect(quotas.quotaStatus(2400, 1200)).toBe("exhausted");
  });

  it("fails closed on zero quota and clamps negative use", async () => {
    const quotas = await loadQuotas();
    expect(quotas.quotaStatus(1, 0)).toBe("exhausted");
    expect(quotas.quotaStatus(0, 0)).toBe("exhausted");
    expect(quotas.quotaStatus(-5, 300)).toBe("ok");
  });

  it("blocks the next broadcast at 100% but allows ok and warning states", async () => {
    const quotas = await loadQuotas();
    expect(quotas.canStartBroadcast(100, 300)).toEqual({ allowed: true, reason: "ok" });
    expect(quotas.canStartBroadcast(240, 300)).toEqual({ allowed: true, reason: "warning" });
    expect(quotas.canStartBroadcast(299.999, 300)).toEqual({ allowed: true, reason: "warning" });
    expect(quotas.canStartBroadcast(300, 300)).toEqual({ allowed: false, reason: "quota_reached" });
    expect(quotas.canStartBroadcast(9999, 1200)).toEqual({
      allowed: false,
      reason: "quota_reached",
    });
  });

  it("prices output minutes as ingest x enabled outputs at session time", async () => {
    const quotas = await loadQuotas();
    expect(quotas.outputMinutes(60, 2)).toBe(120);
    expect(quotas.outputMinutes(480, 5)).toBe(2400);
    expect(quotas.outputMinutes(90, 0)).toBe(0);
    expect(quotas.outputMinutes(0, 5)).toBe(0);
  });

  it("caps a single session at 8 hours, boundary inclusive", async () => {
    const quotas = await loadQuotas();
    expect(quotas.STREAMING_SESSION_CAP_MS).toBe(SESSION_CAP_MS);
    expect(quotas.sessionCapExceeded(SESSION_CAP_MS - 1)).toBe(false);
    expect(quotas.sessionCapExceeded(SESSION_CAP_MS)).toBe(true);
    expect(quotas.sessionCapExceeded(SESSION_CAP_MS + 1)).toBe(true);
  });

  it("allows one re-enable per 24 hours after a cap", async () => {
    const quotas = await loadQuotas();
    expect(quotas.STREAMING_REENABLE_WINDOW_MS).toBe(DAY_MS);
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(quotas.canReEnableAfterCap(now, null)).toBe(true);
    expect(quotas.canReEnableAfterCap(now, now - DAY_MS + 60_000)).toBe(false);
    expect(quotas.canReEnableAfterCap(now, now - DAY_MS)).toBe(true);
    expect(quotas.canReEnableAfterCap(now, now - DAY_MS - 1)).toBe(true);
  });
});

describe("streaming S6 session ledger interface (memory)", () => {
  const loadLedger = memoModule<LedgerContract>(
    "../src/streaming/ledger.ts",
    "memory + postgres session ledger per this file's header",
    ["createMemoryStreamingLedger"],
  );

  it("opens a session with null close fields and finds it by input + start", async () => {
    const ledgerModule = await loadLedger();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const startedAt = new Date("2026-10-05T10:00:00Z");
    const row = await ledger.openSession({ userId: ALICE, cfInputUid: "input-1", startedAt });
    expect(row.userId).toBe(ALICE);
    expect(row.cfInputUid).toBe("input-1");
    expect(row.endedAt).toBeNull();
    expect(row.ingestMinutes).toBeNull();
    expect(row.outputMinutes).toBeNull();
    expect(row.endedReason).toBeNull();
    const found = await ledger.findByInputStart("input-1", startedAt);
    expect(found?.id).toBe(row.id);
    expect(await ledger.findByInputStart("input-1", new Date("2026-10-06T10:00:00Z"))).toBeNull();
  });

  it("closes write-once: a second close rejects and the row is unchanged", async () => {
    const ledgerModule = await loadLedger();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const row = await ledger.openSession({
      userId: ALICE,
      cfInputUid: "input-1",
      startedAt: new Date("2026-10-05T10:00:00Z"),
    });
    const closed = await ledger.closeSession(row.id, {
      endedAt: new Date("2026-10-05T11:00:00Z"),
      ingestMinutes: 60,
      outputMinutes: 120,
      endedReason: "member_stop",
    });
    expect(closed.endedReason).toBe("member_stop");
    await expect(
      ledger.closeSession(row.id, {
        endedAt: new Date("2026-10-05T12:00:00Z"),
        ingestMinutes: 120,
        outputMinutes: 240,
        endedReason: "session_cap",
      }),
    ).rejects.toThrow();
    const reread = await ledger.findByInputStart("input-1", new Date("2026-10-05T10:00:00Z"));
    expect(reread?.ingestMinutes).toBe(60);
    expect(reread?.endedReason).toBe("member_stop");
    await expect(
      ledger.closeSession("missing-id", {
        endedAt: new Date("2026-10-05T11:00:00Z"),
        ingestMinutes: 1,
        outputMinutes: 1,
        endedReason: "member_stop",
      }),
    ).rejects.toThrow();
  });

  it("exposes no delete path: the ledger is append-only", async () => {
    const ledgerModule = await loadLedger();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    for (const name of ["deleteSession", "removeSession", "purgeSession", "deleteByUser"]) {
      expect(
        (ledger as unknown as Record<string, unknown>)[name],
        `ledger must not expose ${name}`,
      ).toBeUndefined();
    }
  });

  it("pages open sessions with an opaque cursor in (startedAt, id) order", async () => {
    const ledgerModule = await loadLedger();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const starts = [
      "2026-10-05T10:00:00Z",
      "2026-10-05T10:05:00Z",
      "2026-10-05T10:10:00Z",
      "2026-10-05T10:15:00Z",
      "2026-10-05T10:20:00Z",
    ];
    // Open out of order: listing order must still be by start time.
    for (const started of [starts[2], starts[0], starts[4], starts[1], starts[3]]) {
      await ledger.openSession({
        userId: ALICE,
        cfInputUid: `input-${started}`,
        startedAt: new Date(started!),
      });
    }
    const first = await ledger.listOpenSessions({ limit: 2 });
    expect(first.sessions.map((s) => s.startedAt.toISOString())).toEqual([starts[0], starts[1]]);
    expect(first.nextCursor).not.toBeNull();
    const second = await ledger.listOpenSessions({ limit: 2, cursor: first.nextCursor! });
    expect(second.sessions.map((s) => s.startedAt.toISOString())).toEqual([starts[2], starts[3]]);
    const third = await ledger.listOpenSessions({ limit: 2, cursor: second.nextCursor! });
    expect(third.sessions.map((s) => s.startedAt.toISOString())).toEqual([starts[4]]);
    expect(third.nextCursor).toBeNull();
    // Closed sessions leave the open listing.
    await ledger.closeSession(first.sessions[0]!.id, {
      endedAt: new Date("2026-10-05T11:00:00Z"),
      ingestMinutes: 60,
      outputMinutes: 120,
      endedReason: "member_stop",
    });
    const relisted = await ledger.listOpenSessions({ limit: 10 });
    expect(relisted.sessions).toHaveLength(4);
    expect(relisted.nextCursor).toBeNull();
  });

  it("sums closed sessions only, in [periodStart, periodEnd), per member", async () => {
    const ledgerModule = await loadLedger();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const start = new Date("2026-10-01T00:00:00Z");
    const end = new Date("2026-11-01T00:00:00Z");
    const close = async (userId: string, cfInputUid: string, startedAt: Date, minutes: number) => {
      const row = await ledger.openSession({ userId, cfInputUid, startedAt });
      await ledger.closeSession(row.id, {
        endedAt: new Date(startedAt.getTime() + minutes * 60_000),
        ingestMinutes: minutes,
        outputMinutes: minutes * 2,
        endedReason: "member_stop",
      });
    };
    await close(ALICE, "input-a", new Date("2026-10-05T10:00:00Z"), 60);
    await close(ALICE, "input-b", start, 1.5);
    await close(ALICE, "input-c", end, 30);
    await close(BOB, "input-d", new Date("2026-10-06T10:00:00Z"), 25);
    await ledger.openSession({
      userId: ALICE,
      cfInputUid: "input-live",
      startedAt: new Date("2026-10-07T10:00:00Z"),
    });
    expect(await ledger.periodUsage(ALICE, start, end)).toEqual({
      ingestMinutes: 61.5,
      outputMinutes: 123,
    });
    expect(await ledger.periodUsage(BOB, start, end)).toEqual({
      ingestMinutes: 25,
      outputMinutes: 50,
    });
  });
});

describe("streaming S6 ingest_sessions migration", () => {
  it("ships a journaled drizzle migration creating ingest_sessions per spec section 4", () => {
    const journal = JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    const tags = new Set(journal.entries.map((entry) => entry.tag));
    const sqlFiles = readdirSync(join(root, "drizzle")).filter((name) => name.endsWith(".sql"));
    const hits = sqlFiles.filter((name) => {
      const tag = name.replace(/\.sql$/, "");
      if (!tags.has(tag)) return false;
      const sql = readFileSync(join(root, "drizzle", name), "utf8");
      return sql.includes("ingest_sessions") && sql.includes("ended_reason");
    });
    expect(
      hits,
      "Builder: add a drizzle migration creating ingest_sessions (spec section 4) and register it in drizzle/meta/_journal.json",
    ).not.toHaveLength(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("streaming S6 session ledger (postgres)", () => {
  let fixture: MemberDataFixture;
  const loadLedger = memoModule<LedgerContract>(
    "../src/streaming/ledger.ts",
    "memory + postgres session ledger per this file's header",
    ["createPostgresStreamingLedger"],
  );

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });

  afterAll(() => fixture?.dispose());

  let tableChecked = false;
  const pgLedger = async (): Promise<StreamingLedger> => {
    const ledgerModule = await loadLedger();
    if (!tableChecked) {
      const present = await fixture.client.unsafe("SELECT to_regclass('ingest_sessions') AS oid");
      expect(
        (present as unknown as { oid: string | null }[])[0]?.oid,
        "Builder: the ingest_sessions migration must apply from a clean checkout (see the migration test above)",
      ).not.toBeNull();
      tableChecked = true;
    }
    return ledgerModule.createPostgresStreamingLedger(fixture.client as unknown as Sql);
  };

  it("creates ingest_sessions with the spec columns and a (user_id, started_at) index", async () => {
    await pgLedger(); // guided failure when the migration is missing
    const columns = (await fixture.client.unsafe(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'ingest_sessions'`,
    )) as { column_name: string; data_type: string; is_nullable: string }[];
    const byName = new Map(columns.map((c) => [c.column_name, c]));
    expect([...byName.keys()].sort()).toEqual(
      [
        "cf_input_uid",
        "ended_at",
        "ended_reason",
        "id",
        "ingest_minutes",
        "output_minutes",
        "started_at",
        "user_id",
      ].sort(),
    );
    expect(byName.get("ingest_minutes")?.data_type).toBe("numeric");
    expect(byName.get("output_minutes")?.data_type).toBe("numeric");
    expect(byName.get("ended_at")?.is_nullable).toBe("YES");
    const indexes = (await fixture.client.unsafe(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'ingest_sessions'`,
    )) as { indexname: string; indexdef: string }[];
    expect(
      indexes.some((i) => i.indexdef.includes("user_id") && i.indexdef.includes("started_at")),
      `Builder: index ingest_sessions on (user_id, started_at); found: ${JSON.stringify(indexes)}`,
    ).toBe(true);
  });

  it("round-trips open/close/find with fractional minutes preserved", async () => {
    const ledger = await pgLedger();
    const startedAt = new Date("2026-10-05T10:00:00Z");
    const row = await ledger.openSession({ userId: ALICE, cfInputUid: "pg-input-1", startedAt });
    expect(row.endedAt).toBeNull();
    const closed = await ledger.closeSession(row.id, {
      endedAt: new Date("2026-10-05T11:31:30Z"),
      ingestMinutes: 91.5,
      outputMinutes: 457.5,
      endedReason: "member_stop",
    });
    expect(Number(closed.ingestMinutes)).toBe(91.5);
    expect(Number(closed.outputMinutes)).toBe(457.5);
    expect((await ledger.findByInputStart("pg-input-1", startedAt))?.id).toBe(row.id);
    await expect(
      ledger.closeSession(row.id, {
        endedAt: new Date("2026-10-05T12:00:00Z"),
        ingestMinutes: 1,
        outputMinutes: 1,
        endedReason: "member_stop",
      }),
    ).rejects.toThrow();
  });

  it("pages open sessions and sums closed-only period usage per member", async () => {
    const ledger = await pgLedger();
    const start = new Date("2026-10-01T00:00:00Z");
    const end = new Date("2026-11-01T00:00:00Z");
    for (const [index, started] of [
      "2026-10-05T10:00:00Z",
      "2026-10-05T10:05:00Z",
      "2026-10-05T10:10:00Z",
    ].entries()) {
      await ledger.openSession({
        userId: ALICE,
        cfInputUid: `pg-page-${index}`,
        startedAt: new Date(started),
      });
    }
    const first = await ledger.listOpenSessions({ limit: 2 });
    expect(first.sessions).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await ledger.listOpenSessions({ limit: 2, cursor: first.nextCursor! });
    expect(second.sessions).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    await ledger.closeSession(first.sessions[0]!.id, {
      endedAt: new Date("2026-10-05T11:00:00Z"),
      ingestMinutes: 60,
      outputMinutes: 300,
      endedReason: "member_stop",
    });
    expect(await ledger.periodUsage(ALICE, start, end)).toEqual({
      ingestMinutes: 60,
      outputMinutes: 300,
    });
  });
});

describe("streaming S6 metering reconciler", () => {
  const loadLedger = memoModule<LedgerContract>(
    "../src/streaming/ledger.ts",
    "memory + postgres session ledger per this file's header",
    ["createMemoryStreamingLedger"],
  );
  const loadReconciler = memoModule<ReconcilerContract>(
    "../src/streaming/reconciler.ts",
    "nightly metering reconciler per this file's header",
    ["reconcileStreamingSessions"],
  );
  const loadDeps = async () => {
    const [ledgerModule, reconciler] = await Promise.all([loadLedger(), loadReconciler()]);
    return { ledgerModule, reconciler };
  };

  const openLive = async (
    ledger: StreamingLedger,
    overrides: { userId?: string; cfInputUid?: string; startedAt?: Date } = {},
  ) => {
    const startedAt = overrides.startedAt ?? new Date("2026-10-05T10:00:00Z");
    return ledger.openSession({
      userId: overrides.userId ?? ALICE,
      cfInputUid: overrides.cfInputUid ?? `input-${startedAt.getTime()}`,
      startedAt,
    });
  };

  it("closes finished sessions with analytics minutes x outputs at session time", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    const now = new Date("2026-10-06T02:00:00Z");
    await openLive(ledger, { cfInputUid: "input-done" });
    analytics.reports.set("input-done", { live: false, minutes: 95.5, enabledOutputs: 3 });
    enforcement.usageByUser.set(ALICE, { usedIngestMinutes: 100, quotaIngestMinutes: 300 });
    const result = await reconciler.reconcileStreamingSessions({
      ledger,
      analytics: analytics.client,
      enforcement: enforcement.client,
      now: () => now,
    });
    expect(result.closed).toBe(1);
    expect(result.failed).toBe(0);
    const reread = await ledger.findByInputStart("input-done", new Date("2026-10-05T10:00:00Z"));
    expect(reread?.endedAt?.toISOString()).toBe(now.toISOString());
    expect(reread?.ingestMinutes).toBe(95.5);
    expect(reread?.outputMinutes).toBe(95.5 * 3);
    expect(reread?.endedReason).toBe("member_stop");
    expect(analytics.calls[0]).toBe("recentlyEnded");
  });

  it("leaves a live in-quota session open and disables nothing", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    await openLive(ledger, {
      cfInputUid: "input-live",
      startedAt: new Date("2026-10-06T01:00:00Z"),
    });
    analytics.reports.set("input-live", { live: true, minutes: 60, enabledOutputs: 2 });
    enforcement.usageByUser.set(ALICE, { usedIngestMinutes: 100, quotaIngestMinutes: 300 });
    const result = await reconciler.reconcileStreamingSessions({
      ledger,
      analytics: analytics.client,
      enforcement: enforcement.client,
      now: () => new Date("2026-10-06T02:00:00Z"),
    });
    expect(result.closed).toBe(0);
    expect(result.blocked).toBe(0);
    expect(result.capped).toBe(0);
    expect(enforcement.disabled).toEqual([]);
    expect(enforcement.caps).toEqual([]);
    expect((await ledger.listOpenSessions({ limit: 10 })).sessions).toHaveLength(1);
  });

  it("lets the current session finish at 100% but blocks the next broadcast", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    await openLive(ledger, {
      cfInputUid: "input-over",
      startedAt: new Date("2026-10-06T01:30:00Z"),
    });
    analytics.reports.set("input-over", { live: true, minutes: 30, enabledOutputs: 2 });
    enforcement.usageByUser.set(ALICE, { usedIngestMinutes: 300, quotaIngestMinutes: 300 });
    const result = await reconciler.reconcileStreamingSessions({
      ledger,
      analytics: analytics.client,
      enforcement: enforcement.client,
      now: () => new Date("2026-10-06T02:00:00Z"),
    });
    expect(result.blocked).toBe(1);
    expect(result.closed).toBe(0);
    expect(enforcement.disabled).toEqual([{ inputUid: "input-over", reason: "quota" }]);
    expect((await ledger.listOpenSessions({ limit: 10 })).sessions).toHaveLength(1);
  });

  it("caps a live session at 8 hours: close + disable + cap record", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    const now = new Date("2026-10-06T02:00:00Z");
    await openLive(ledger, {
      cfInputUid: "input-marathon",
      startedAt: new Date(now.getTime() - SESSION_CAP_MS - 60_000),
    });
    analytics.reports.set("input-marathon", { live: true, minutes: 481, enabledOutputs: 5 });
    enforcement.usageByUser.set(ALICE, { usedIngestMinutes: 100, quotaIngestMinutes: 1200 });
    const result = await reconciler.reconcileStreamingSessions({
      ledger,
      analytics: analytics.client,
      enforcement: enforcement.client,
      now: () => now,
    });
    expect(result.capped).toBe(1);
    expect(result.closed).toBe(1);
    expect(enforcement.disabled).toEqual([{ inputUid: "input-marathon", reason: "session_cap" }]);
    expect(enforcement.caps).toEqual([{ userId: ALICE, at: now }]);
    const reread = await ledger.findByInputStart(
      "input-marathon",
      new Date(now.getTime() - SESSION_CAP_MS - 60_000),
    );
    expect(reread?.endedReason).toBe("session_cap");
    expect(reread?.outputMinutes).toBe(481 * 5);
  });

  it("leaves a live session just under 8 hours alone", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    const now = new Date("2026-10-06T02:00:00Z");
    await openLive(ledger, {
      cfInputUid: "input-long",
      startedAt: new Date(now.getTime() - SESSION_CAP_MS + 60_000),
    });
    analytics.reports.set("input-long", { live: true, minutes: 479, enabledOutputs: 2 });
    enforcement.usageByUser.set(ALICE, { usedIngestMinutes: 100, quotaIngestMinutes: 300 });
    const result = await reconciler.reconcileStreamingSessions({
      ledger,
      analytics: analytics.client,
      enforcement: enforcement.client,
      now: () => now,
    });
    expect(result.capped).toBe(0);
    expect(result.closed).toBe(0);
    expect(enforcement.disabled).toEqual([]);
  });

  it("backfills a deploy-gap session from analytics exactly once", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    analytics.ended.push({
      inputUid: "input-gap",
      userId: ALICE,
      startedAt: new Date("2026-10-05T10:00:00Z"),
      endedAt: new Date("2026-10-05T11:00:00Z"),
      minutes: 60,
      enabledOutputs: 2,
    });
    const first = await reconciler.reconcileStreamingSessions({
      ledger,
      analytics: analytics.client,
      enforcement: enforcement.client,
      now: () => new Date("2026-10-06T02:00:00Z"),
    });
    expect(first.backfilled).toBe(1);
    expect(first.closed).toBe(0);
    const { start, end } = utcMonthBounds(new Date("2026-10-06T02:00:00Z"));
    expect(await ledger.periodUsage(ALICE, start, end)).toEqual({
      ingestMinutes: 60,
      outputMinutes: 120,
    });
    const second = await reconciler.reconcileStreamingSessions({
      ledger,
      analytics: analytics.client,
      enforcement: enforcement.client,
      now: () => new Date("2026-10-07T02:00:00Z"),
    });
    expect(second.backfilled).toBe(0);
    expect(await ledger.periodUsage(ALICE, start, end)).toEqual({
      ingestMinutes: 60,
      outputMinutes: 120,
    });
  });

  it("closes (not backfills) an open row the deploy-gap listing already covers", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    const startedAt = new Date("2026-10-05T10:00:00Z");
    await openLive(ledger, { cfInputUid: "input-gap-open", startedAt });
    analytics.ended.push({
      inputUid: "input-gap-open",
      userId: ALICE,
      startedAt,
      endedAt: new Date("2026-10-05T11:00:00Z"),
      minutes: 60,
      enabledOutputs: 2,
    });
    const result = await reconciler.reconcileStreamingSessions({
      ledger,
      analytics: analytics.client,
      enforcement: enforcement.client,
      now: () => new Date("2026-10-06T02:00:00Z"),
    });
    expect(result.closed).toBe(1);
    expect(result.backfilled).toBe(0);
    expect(analytics.calls).toEqual(["recentlyEnded"]);
    const reread = await ledger.findByInputStart("input-gap-open", startedAt);
    expect(reread?.endedAt?.toISOString()).toBe("2026-10-05T11:00:00Z");
  });

  it("bounds each run to N inputs and resumes by cursor", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    for (let i = 0; i < 5; i++) {
      const uid = `input-n-${i}`;
      await openLive(ledger, {
        cfInputUid: uid,
        startedAt: new Date(Date.parse("2026-10-05T10:00:00Z") + i * 60_000),
      });
      analytics.reports.set(uid, { live: false, minutes: 10, enabledOutputs: 1 });
    }
    enforcement.usageByUser.set(ALICE, { usedIngestMinutes: 0, quotaIngestMinutes: 300 });
    const run = (cursor?: string) =>
      reconciler.reconcileStreamingSessions({
        ledger,
        analytics: analytics.client,
        enforcement: enforcement.client,
        now: () => new Date("2026-10-06T02:00:00Z"),
        limits: { maxInputsPerRun: 2, maxApiCallsPerRun: 100, pageSize: 1 },
        cursor,
      });
    const first = await run();
    expect(first.closed).toBe(2);
    expect(first.deferred).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await run(first.nextCursor!);
    expect(second.closed).toBe(2);
    expect(second.deferred).toBe(1);
    const third = await run(second.nextCursor!);
    expect(third.closed).toBe(1);
    expect(third.deferred).toBe(0);
    expect(third.nextCursor).toBeNull();
  });

  it("stops issuing analytics calls past the per-run API budget", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    for (let i = 0; i < 3; i++) {
      const uid = `input-b-${i}`;
      await openLive(ledger, { cfInputUid: uid });
      analytics.reports.set(uid, { live: false, minutes: 10, enabledOutputs: 1 });
    }
    enforcement.usageByUser.set(ALICE, { usedIngestMinutes: 0, quotaIngestMinutes: 300 });
    const result = await reconciler.reconcileStreamingSessions({
      ledger,
      analytics: analytics.client,
      enforcement: enforcement.client,
      now: () => new Date("2026-10-06T02:00:00Z"),
      limits: { maxInputsPerRun: 100, maxApiCallsPerRun: 2 },
    });
    expect(analytics.calls).toHaveLength(2);
    expect(result.apiCalls).toBe(2);
    expect(result.closed).toBe(1);
    expect(result.deferred).toBe(2);
    expect(result.nextCursor).not.toBeNull();
  });

  it("isolates one throwing input: failed counts, the rest still close", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    await openLive(ledger, { cfInputUid: "input-poison" });
    await openLive(ledger, { cfInputUid: "input-fine" });
    analytics.reports.set("input-poison", new Error("analytics 500"));
    analytics.reports.set("input-fine", { live: false, minutes: 10, enabledOutputs: 1 });
    enforcement.usageByUser.set(ALICE, { usedIngestMinutes: 0, quotaIngestMinutes: 300 });
    const result = await reconciler.reconcileStreamingSessions({
      ledger,
      analytics: analytics.client,
      enforcement: enforcement.client,
      now: () => new Date("2026-10-06T02:00:00Z"),
    });
    expect(result.failed).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.apiCalls).toBe(3);
    expect(
      (await ledger.findByInputStart("input-poison", new Date("2026-10-05T10:00:00Z")))?.endedAt,
    ).toBeNull();
  });

  it("fails loudly when enforcement throws instead of swallowing the block", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    await openLive(ledger, {
      cfInputUid: "input-block",
      startedAt: new Date("2026-10-06T01:30:00Z"),
    });
    analytics.reports.set("input-block", { live: true, minutes: 30, enabledOutputs: 2 });
    enforcement.usageByUser.set(ALICE, { usedIngestMinutes: 300, quotaIngestMinutes: 300 });
    enforcement.failDisable = new Error("disable API down");
    await expect(
      reconciler.reconcileStreamingSessions({
        ledger,
        analytics: analytics.client,
        enforcement: enforcement.client,
        now: () => new Date("2026-10-06T02:00:00Z"),
      }),
    ).rejects.toThrow("disable API down");
  });

  it("ships finite default budgets that bound a 1500-input flood", async () => {
    const { ledgerModule, reconciler } = await loadDeps();
    expect(reconciler.DEFAULT_MAX_INPUTS_PER_RUN).toBeGreaterThanOrEqual(1);
    expect(reconciler.DEFAULT_MAX_INPUTS_PER_RUN).toBeLessThanOrEqual(1000);
    expect(reconciler.DEFAULT_MAX_API_CALLS_PER_RUN).toBeGreaterThanOrEqual(
      reconciler.DEFAULT_MAX_INPUTS_PER_RUN + 1,
    );
    expect(reconciler.DEFAULT_MAX_API_CALLS_PER_RUN).toBeLessThanOrEqual(10000);
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    for (let i = 0; i < 1500; i++) {
      const uid = `input-flood-${i}`;
      await openLive(ledger, {
        cfInputUid: uid,
        startedAt: new Date(Date.parse("2026-10-05T10:00:00Z") + i * 1000),
      });
      analytics.reports.set(uid, { live: false, minutes: 1, enabledOutputs: 1 });
    }
    enforcement.usageByUser.set(ALICE, { usedIngestMinutes: 0, quotaIngestMinutes: 1200 });
    const result = await reconciler.reconcileStreamingSessions({
      ledger,
      analytics: analytics.client,
      enforcement: enforcement.client,
      now: () => new Date("2026-10-06T02:00:00Z"),
    });
    expect(result.deferred).toBeGreaterThan(0);
    expect(result.nextCursor).not.toBeNull();
    expect(result.apiCalls).toBeLessThanOrEqual(reconciler.DEFAULT_MAX_API_CALLS_PER_RUN);
    expect(result.closed + result.deferred).toBe(1500);
  });
});

describe("streaming S6 spend-cannot-exceed-cap proof (D7)", () => {
  const loadQuotas = memoModule<QuotasContract>("../src/streaming/quotas.ts", "pure quota math", [
    "canStartBroadcast",
  ]);
  const loadLedger = memoModule<LedgerContract>("../src/streaming/ledger.ts", "session ledger", [
    "createMemoryStreamingLedger",
  ]);
  const loadReconciler = memoModule<ReconcilerContract>(
    "../src/streaming/reconciler.ts",
    "reconciler",
    ["reconcileStreamingSessions"],
  );

  it("caps Plus delivery at tier cap + one max session, then the gate holds", async () => {
    const [quotas, ledgerModule, reconciler] = await Promise.all([
      loadQuotas(),
      loadLedger(),
      loadReconciler(),
    ]);
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const analytics = fakeAnalytics();
    const enforcement = fakeEnforcement();
    // Worst case: Plus member (1200 ingest / 6000 output) with all 5
    // destinations enabled every session. The usage join reads the real
    // ledger, exactly as the production wiring must.
    const { start, end } = utcMonthBounds(new Date("2026-10-15T12:00:00Z"));
    enforcement.client.usageFor = async () => ({
      usedIngestMinutes: (await ledger.periodUsage(ALICE, start, end)).ingestMinutes,
      quotaIngestMinutes: quotas.STREAMING_TIER_QUOTAS.plus.ingestMinutes,
    });
    let now = new Date("2026-10-10T10:00:00Z");
    const gateAllows = async () => {
      const usage = await ledger.periodUsage(ALICE, start, end);
      return quotas.canStartBroadcast(
        usage.ingestMinutes,
        quotas.STREAMING_TIER_QUOTAS.plus.ingestMinutes,
      );
    };
    const reconcile = () =>
      reconciler.reconcileStreamingSessions({
        ledger,
        analytics: analytics.client,
        enforcement: enforcement.client,
        now: () => now,
      });

    expect(await gateAllows()).toEqual({ allowed: true, reason: "ok" });
    const s1 = await ledger.openSession({ userId: ALICE, cfInputUid: "proof-1", startedAt: now });
    expect(s1.id).not.toBe("");
    analytics.reports.set("proof-1", { live: false, minutes: 600, enabledOutputs: 5 });
    now = new Date("2026-10-11T02:00:00Z");
    expect((await reconcile()).closed).toBe(1);

    expect(await gateAllows()).toEqual({ allowed: true, reason: "ok" });
    await ledger.openSession({
      userId: ALICE,
      cfInputUid: "proof-2",
      startedAt: new Date("2026-10-11T10:00:00Z"),
    });
    analytics.reports.set("proof-2", { live: false, minutes: 500, enabledOutputs: 5 });
    now = new Date("2026-10-12T02:00:00Z");
    expect((await reconcile()).closed).toBe(1);

    // 1100 used: warning state still allows the next broadcast.
    expect(await gateAllows()).toEqual({ allowed: true, reason: "warning" });
    const s3Start = new Date("2026-10-12T10:00:00Z");
    await ledger.openSession({ userId: ALICE, cfInputUid: "proof-3", startedAt: s3Start });
    analytics.reports.set("proof-3", { live: true, minutes: 479, enabledOutputs: 5 });
    now = new Date(s3Start.getTime() + SESSION_CAP_MS - 60_000);
    const midRun = await reconcile();
    expect(midRun.capped).toBe(0);
    expect(midRun.closed).toBe(0);

    // The runaway session dies at 8h even though the member never stopped it.
    now = new Date(s3Start.getTime() + SESSION_CAP_MS + 60_000);
    analytics.reports.set("proof-3", { live: true, minutes: 481, enabledOutputs: 5 });
    const capRun = await reconcile();
    expect(capRun.capped).toBe(1);
    expect(enforcement.caps).toEqual([{ userId: ALICE, at: now }]);

    // 1581 used: the gate now holds, so no fourth session can start.
    const verdict = await gateAllows();
    expect(verdict).toEqual({ allowed: false, reason: "quota_reached" });
    const totals = await ledger.periodUsage(ALICE, start, end);
    expect(totals.ingestMinutes).toBe(600 + 500 + 481);
    expect(totals.outputMinutes).toBe((600 + 500 + 481) * 5);
    // THE PROOF: delivery minutes cannot exceed tier cap + one max session
    // (8h x 5 destinations). A mutant that skips the cap or re-opens the
    // gate past 100% blows this bound.
    expect(totals.ingestMinutes).toBeLessThanOrEqual(1200 + 480);
    expect(totals.outputMinutes).toBeLessThanOrEqual(6000 + 480 * 5);
  });
});

describe("streaming S6 per-member usage page", () => {
  const loadLedger = memoModule<LedgerContract>("../src/streaming/ledger.ts", "session ledger", [
    "createMemoryStreamingLedger",
  ]);
  const loadUsageApp = memoModule<UsageAppContract>(
    "../src/streaming/usage-app.ts",
    "streamingUsageApp sub-app per this file's header",
    ["streamingUsageApp"],
  );

  const harness = async (
    opts: { tiers?: Map<string, "basic" | "plus" | null>; now?: Date } = {},
  ) => {
    const [ledgerModule, usageAppModule] = await Promise.all([loadLedger(), loadUsageApp()]);
    const ledger = ledgerModule.createMemoryStreamingLedger();
    const sessions = createMemorySessionStore();
    const tiers = opts.tiers ?? new Map<string, "basic" | "plus" | null>([[ALICE, "basic"]]);
    const usageApp = usageAppModule.streamingUsageApp({
      ledger,
      sessionStore: sessions,
      tierFor: async (userId: string) => tiers.get(userId) ?? null,
      now: () => opts.now ?? new Date("2026-10-15T12:00:00Z"),
    });
    return { ledger, sessions, usageApp };
  };

  const seedClosed = async (
    ledger: StreamingLedger,
    userId: string,
    cfInputUid: string,
    startedAt: Date,
    minutes: number,
    outputs: number,
  ) => {
    const row = await ledger.openSession({ userId, cfInputUid, startedAt });
    await ledger.closeSession(row.id, {
      endedAt: new Date(startedAt.getTime() + minutes * 60_000),
      ingestMinutes: minutes,
      outputMinutes: minutes * outputs,
      endedReason: "member_stop",
    });
  };

  it("bounces a guest to sign-in before any store read", async () => {
    const { usageApp } = await harness();
    const res = await usageApp.request("/streaming/usage");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/auth\/discord/);
    expect(await res.text()).not.toContain("Streaming usage");
  });

  it("refuses a signed-in non-member with 403 and no usage numbers", async () => {
    const { sessions, usageApp } = await harness();
    const cookie = await memberCookie(sessions, {
      userId: OUTSIDER,
      username: "outsider",
      member: false,
    });
    const res = await usageApp.request("/streaming/usage", { headers: { cookie } });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain("95.5");
    expect(body).not.toContain("Streaming usage");
  });

  it("renders empty usage privately with an as-of stamp", async () => {
    const { sessions, usageApp } = await harness({ now: new Date("2026-10-15T12:34:00Z") });
    const cookie = await memberCookie(sessions, { userId: ALICE, username: "alice", member: true });
    const res = await usageApp.request("/streaming/usage", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toMatch(/private/);
    const body = await res.text();
    expect(body).toContain("Streaming usage");
    expect(body).toContain("as of 2026-10-15 12:34 UTC");
    expect(body).toContain("Ingest");
    expect(body).toContain("Output");
    expect(body).not.toContain("Streaming quota reached");
  });

  it("shows this month's minutes and quota for the member's tier only", async () => {
    const { ledger, sessions, usageApp } = await harness();
    await seedClosed(ledger, ALICE, "usage-1", new Date("2026-10-05T10:00:00Z"), 95.5, 2);
    await seedClosed(ledger, ALICE, "usage-2", new Date("2026-09-05T10:00:00Z"), 50, 2);
    const cookie = await memberCookie(sessions, { userId: ALICE, username: "alice", member: true });
    const res = await usageApp.request("/streaming/usage", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("95.5");
    expect(body).toContain("191");
    expect(body).toContain("300");
    expect(body).not.toContain("Streaming quota reached");
    expect(body).not.toContain("Approaching your streaming quota");
  });

  it("isolates members: nobody sees another member's minutes", async () => {
    const { ledger, sessions, usageApp } = await harness({
      tiers: new Map([
        [ALICE, "basic"],
        [BOB, "basic"],
      ]),
    });
    await seedClosed(ledger, ALICE, "usage-a", new Date("2026-10-05T10:00:00Z"), 95.5, 2);
    await seedClosed(ledger, BOB, "usage-b", new Date("2026-10-06T10:00:00Z"), 7.25, 1);
    const aliceCookie = await memberCookie(sessions, {
      userId: ALICE,
      username: "alice",
      member: true,
    });
    const alicePage = await (
      await usageApp.request("/streaming/usage", { headers: { cookie: aliceCookie } })
    ).text();
    expect(alicePage).toContain("95.5");
    expect(alicePage).not.toContain("7.25");
    expect(alicePage).not.toContain(BOB);
    const bobCookie = await memberCookie(sessions, { userId: BOB, username: "bob", member: true });
    const bobPage = await (
      await usageApp.request("/streaming/usage", { headers: { cookie: bobCookie } })
    ).text();
    expect(bobPage).toContain("7.25");
    expect(bobPage).not.toContain("95.5");
    expect(bobPage).not.toContain(ALICE);
  });

  it("warns at 80% with clear copy", async () => {
    const { ledger, sessions, usageApp } = await harness();
    await seedClosed(ledger, ALICE, "usage-w", new Date("2026-10-05T10:00:00Z"), 240, 1);
    const cookie = await memberCookie(sessions, { userId: ALICE, username: "alice", member: true });
    const body = await (await usageApp.request("/streaming/usage", { headers: { cookie } })).text();
    expect(body).toContain("Approaching your streaming quota");
    expect(body).not.toContain("Streaming quota reached");
  });

  it("tells an exhausted member the quota is reached and where to upgrade", async () => {
    const { ledger, sessions, usageApp } = await harness();
    await seedClosed(ledger, ALICE, "usage-x", new Date("2026-10-05T10:00:00Z"), 300, 2);
    const cookie = await memberCookie(sessions, { userId: ALICE, username: "alice", member: true });
    const body = await (await usageApp.request("/streaming/usage", { headers: { cookie } })).text();
    expect(body).toContain("Streaming quota reached");
    expect(body).toContain('href="/streaming"');
  });

  it("tells a member with no subscription to subscribe instead of showing quotas", async () => {
    const { sessions, usageApp } = await harness({ tiers: new Map([[ALICE, null]]) });
    const cookie = await memberCookie(sessions, { userId: ALICE, username: "alice", member: true });
    const res = await usageApp.request("/streaming/usage", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("No active subscription");
    expect(body).toContain('href="/streaming"');
    expect(body).not.toContain("Streaming quota reached");
  });
});

describe("streaming S6 usage route mount", () => {
  it("serves the usage route on the main app: guest bounces to sign-in", async () => {
    // No route-inventory comment here by design: the Builder adds the
    // inventory reference, fixture entry and parity row with the route.
    const res = await app.request("/streaming/usage", {}, baseEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/auth\/discord/);
  });
});
