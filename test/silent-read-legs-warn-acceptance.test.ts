// ACCEPTANCE-OWNED (silent read-leg warnings): the Builder builds on this
// branch and never edits this file. Fail-first contract for the three
// remaining silent read legs:
//
//   - Content-gap read (src/events/search-log.ts topZeroResultSearches)
//     warns CONTENT_GAP_READ once (class-only) on ordinary failure; the
//     dashboard omits the widget (undefined). Classified DB outages still
//     propagate (reject) to the dashboard's shared 503 boundary, silently.
//   - Member-stats (src/profiles/stats.ts memberStatsWithBudget and
//     readMemberStats) warns MEMBER_STATS once with the exception class
//     plus an aborted flag; the profile renders the explicit unavailable
//     state (membershipUnavailable). A milestones-only failure warns
//     MEMBER_MILESTONES once and keeps the membership facts.
//   - Counts (src/counts.ts readCounts) warns COUNTS_READ once per failed
//     view with the view key plus the exception class; fallbacks unchanged.
//
// Boundaries: success stays silent on every leg; the content-gap deadline
// omits silently and an unconfigured database keeps the silent UNAVAILABLE
// fallback. A stats budget trip settles the unavailable outcome and warns
// once with aborted:true; Every new field is class-only —
// never a message, token, cookie, URL, query text or member identity.
//
// Hermetic only: fake Db/tx fixtures, stubbed postgres module, fake timers
// for the budget test. No DATABASE_URL, no live bot database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { topZeroResultSearches } from "../src/events/search-log";
import {
  MEMBER_STATS_BUDGET_MS,
  memberStatsWithBudget,
  readMemberStats,
  type MemberStats,
} from "../src/profiles/stats";
import {
  captureDiagnosticStream,
  channelCounts,
  scanDiagnosticStream,
  withheld,
  type DiagnosticRecord,
} from "./helpers/diagnostic-stream";

const CONTENT_GAP_READ = "Event search unavailable for content-gap read; omitting the widget.";
const MEMBER_STATS = "Member stats unavailable; showing the unavailable state.";
const MEMBER_MILESTONES = "Member milestones unavailable; keeping membership facts.";
const COUNTS_READ = "Counts read unavailable";

const TOK = "***synthetic-access-2w7q***";
const SECRET = "***synthetic-secret-9d4f***";
const MEMBER = "100000000000000037";
const VALID_RAY = "0123456789abcdef-LHR";
const VALID_ULID = "01K9N8Q2R5T7V3W4X6Y8Z0A2B4";
const MALFORMED_ID = "not-a-request-id!!";
const GAP_DSN = "postgres://gap-user:gap-s3cret@gap-host.test/gapdb";
const COUNTS_URL = "postgres://counts-user:counts-s3cret@127.0.0.1:9/countsdb";

class ContentGapReadFailed extends Error {}
class MemberStatsReadFailed extends Error {}
class CountsReadFailed extends Error {}

/** The records written under one message, marker-free so a failing diff cannot print a leak. */
const recordsFor = (logs: DiagnosticRecord[], message: string) =>
  logs
    .filter((record) => record.args[0] === message)
    .map((record) => ({
      channel: record.channel,
      args: withheld(record.args, [TOK, SECRET]) as unknown[],
    }));

/** Nothing the stream captured may carry a synthetic secret, in any field or split form. */
const streamClean = (logs: DiagnosticRecord[], markers: readonly string[]) => {
  const scan = scanDiagnosticStream(logs, markers);
  expect(scan.incomplete, "every diagnostic value inspected to the end").toEqual([]);
  expect(scan.hits, "marker found in diagnostic stream (labels only)").toEqual([]);
};

/** Fake Db whose transaction runs the callback against a fake tx with the given SELECT terminal. */
const fakeGapDb = (terminal: () => Promise<Record<string, unknown>[]>) => {
  const chain: Record<string, () => unknown> = {};
  for (const method of ["from", "where", "groupBy", "orderBy"]) chain[method] = () => chain;
  chain.limit = terminal;
  return {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: async () => {}, select: () => chain }),
  } as unknown as Db;
};

const classifiedOutage = (name: string, code: string, message: string) => {
  const err = new Error(message);
  err.name = name;
  (err as Error & { code: string }).code = code;
  return err;
};

const healthyStats: MemberStats = {
  joinedAt: new Date("2025-01-01T00:00:00Z"),
  tenureDays: 637,
  rankKey: "community_regular",
  isCurrentMember: true,
  milestones: [],
  milestonesTruncated: false,
};

const pgState = vi.hoisted(() => ({
  live: [] as Record<string, unknown>[],
  ranks: [] as Record<string, unknown>[],
  liveError: null as Error | null,
  ranksError: null as Error | null,
  queries: [] as string[],
  urls: [] as string[],
}));
vi.mock("postgres", () => ({
  default: (url: string) => {
    pgState.urls.push(url);
    const sql = async (parts: TemplateStringsArray) => {
      const query = parts.join("");
      pgState.queries.push(query);
      const live = query.includes("web_v1.live_counts");
      const error = live ? pgState.liveError : pgState.ranksError;
      if (error) throw error;
      return (live ? pgState.live : pgState.ranks).map((row) => ({ ...row }));
    };
    sql.end = async () => {};
    return sql;
  },
}));

const countsEnv = { BOT_DB: { connectionString: COUNTS_URL } } as Env;
const freshLive = () => [
  { human_member_count: "84", online_count: "12", counts_updated_at: new Date() },
];
const freshRanks = () => [{ rank_key: "prospect", rank_label: "Prospect", member_count: "24" }];

let counts: typeof import("../src/counts");

beforeEach(async () => {
  vi.resetModules();
  Object.assign(pgState, {
    live: freshLive(),
    ranks: freshRanks(),
    liveError: null,
    ranksError: null,
    queries: [],
    urls: [],
  });
  counts = await import("../src/counts");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("content-gap read warns once on ordinary failure", () => {
  it("ordinary failure warns once, class-only; the widget omits (undefined)", async () => {
    const db = fakeGapDb(async () => {
      throw new ContentGapReadFailed(`gap select failed ${TOK}; dsn ${GAP_DSN}`);
    });
    const logs = captureDiagnosticStream();
    await expect(topZeroResultSearches(db)).resolves.toBeUndefined();
    const line = recordsFor(logs, CONTENT_GAP_READ);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([CONTENT_GAP_READ, { exception: "ContentGapReadFailed" }]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, [TOK, SECRET, GAP_DSN, "gap-user", "gap-s3cret", "gap-host.test"]);
  });

  it.each([
    ["transport outage", classifiedOutage("Error", "ECONNREFUSED", `connect refused ${TOK}`)],
    [
      "classified server outage",
      classifiedOutage("PostgresError", "57P03", `lock timeout ${SECRET}`),
    ],
  ])("%s propagates to the 503 boundary, silently", async (_name, err) => {
    const db = fakeGapDb(async () => {
      throw err;
    });
    const logs = captureDiagnosticStream();
    await expect(topZeroResultSearches(db)).rejects.toBe(err);
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
  });

  it("control: a healthy read returns rows and stays silent", async () => {
    const at = new Date("2026-10-01T00:00:00Z");
    const db = fakeGapDb(async () => [{ query: "valorant", searches: "3", lastSearchedAt: at }]);
    const logs = captureDiagnosticStream();
    await expect(topZeroResultSearches(db)).resolves.toEqual([
      { query: "valorant", searches: 3, lastSearchedAt: at },
    ]);
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
  });

  it("deadline expiry omits the widget (behavior pin)", async () => {
    let release!: (rows: Record<string, unknown>[]) => void;
    const gate = new Promise<Record<string, unknown>[]>((resolve) => {
      release = resolve;
    });
    const db = fakeGapDb(() => gate);
    const logs = captureDiagnosticStream();
    await expect(topZeroResultSearches(db, 10, 25)).resolves.toBeUndefined();
    release([]);
    await gate;
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
  });
});

describe("member-stats warn carries class plus aborted flag", () => {
  it("wrapper: throwing source warns once with class + aborted:false; stats read unavailable", async () => {
    const logs = captureDiagnosticStream();
    await expect(
      memberStatsWithBudget(async () => {
        throw new MemberStatsReadFailed(
          `stats select failed ${TOK}; cookie __Host-two_session=${SECRET}`,
        );
      }, MEMBER),
    ).resolves.toMatchObject({
      membershipUnavailable: true,
      joinedAt: null,
      tenureDays: null,
      rankKey: null,
      milestones: [],
    });
    const line = recordsFor(logs, MEMBER_STATS);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      MEMBER_STATS,
      { exception: "MemberStatsReadFailed", aborted: false },
    ]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, [TOK, SECRET, MEMBER, "__Host-two_session"]);
  });

  it("control: a healthy source resolves and stays silent", async () => {
    const logs = captureDiagnosticStream();
    await expect(memberStatsWithBudget(async () => healthyStats, MEMBER)).resolves.toEqual(
      healthyStats,
    );
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
  });

  it("budget expiry settles the unavailable outcome and warns once with aborted:true", async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn().mockReturnValue(new Promise(() => {}));
      const logs = captureDiagnosticStream();
      const pending = readMemberStats({ execute } as unknown as Db, MEMBER);
      await vi.advanceTimersByTimeAsync(MEMBER_STATS_BUDGET_MS + 50);
      await expect(pending).resolves.toMatchObject({
        membershipUnavailable: true,
        joinedAt: null,
        tenureDays: null,
        rankKey: null,
        milestones: [],
      });
      const line = recordsFor(logs, MEMBER_STATS);
      expect(line).toHaveLength(1);
      expect(line[0]!.channel).toBe("warn");
      expect(line[0]!.args).toEqual([MEMBER_STATS, { exception: "DOMException", aborted: true }]);
      expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
      streamClean(logs, [TOK, SECRET, MEMBER]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("direct read with an aborted signal warns with aborted:true; stats read unavailable", async () => {
    const execute = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const logs = captureDiagnosticStream();
    await expect(
      readMemberStats({ execute } as unknown as Db, MEMBER, controller.signal),
    ).resolves.toMatchObject({
      membershipUnavailable: true,
      joinedAt: null,
      tenureDays: null,
      rankKey: null,
      milestones: [],
    });
    expect(execute).not.toHaveBeenCalled();
    const line = recordsFor(logs, MEMBER_STATS);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([MEMBER_STATS, { exception: "DOMException", aborted: true }]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, [TOK, SECRET, MEMBER]);
  });

  it("direct read with a throwing execute warns with aborted:false; stats read unavailable", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new MemberStatsReadFailed(`members select failed ${TOK} ${SECRET}`));
    const controller = new AbortController();
    const logs = captureDiagnosticStream();
    await expect(
      readMemberStats({ execute } as unknown as Db, MEMBER, controller.signal),
    ).resolves.toMatchObject({
      membershipUnavailable: true,
      joinedAt: null,
      tenureDays: null,
      rankKey: null,
      milestones: [],
    });
    expect(execute).toHaveBeenCalledOnce();
    const line = recordsFor(logs, MEMBER_STATS);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      MEMBER_STATS,
      { exception: "MemberStatsReadFailed", aborted: false },
    ]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, [TOK, SECRET, MEMBER]);
  });

  it("milestones-only failure warns once and keeps the membership facts", async () => {
    const fullMember = {
      member_id: MEMBER,
      joined_at: "2025-01-01T00:00:00Z",
      tenure_days: 637,
      rank_key: "community_regular",
      is_current_member: true,
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce([fullMember])
      .mockRejectedValueOnce(
        new MemberStatsReadFailed(`milestones select failed ${TOK} ${SECRET}`),
      );
    const controller = new AbortController();
    const logs = captureDiagnosticStream();
    await expect(
      readMemberStats({ execute } as unknown as Db, MEMBER, controller.signal),
    ).resolves.toEqual({
      joinedAt: new Date("2025-01-01T00:00:00Z"),
      tenureDays: 637,
      rankKey: "community_regular",
      isCurrentMember: true,
      milestones: [],
      milestonesTruncated: false,
      milestonesUnavailable: true,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    const line = recordsFor(logs, MEMBER_MILESTONES);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      MEMBER_MILESTONES,
      { exception: "MemberStatsReadFailed", aborted: false },
    ]);
    expect(recordsFor(logs, MEMBER_STATS)).toHaveLength(0);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, [TOK, SECRET, MEMBER]);
  });

  it("wrapper: a valid request id travels on the warn", async () => {
    const logs = captureDiagnosticStream();
    await expect(
      memberStatsWithBudget(
        async () => {
          throw new MemberStatsReadFailed(
            `stats select failed ${TOK}; cookie __Host-two_session=${SECRET}`,
          );
        },
        MEMBER,
        VALID_RAY,
      ),
    ).resolves.toMatchObject({
      membershipUnavailable: true,
      joinedAt: null,
      tenureDays: null,
      rankKey: null,
      milestones: [],
    });
    const line = recordsFor(logs, MEMBER_STATS);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      MEMBER_STATS,
      { exception: "MemberStatsReadFailed", aborted: false, request_id: VALID_RAY },
    ]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, [TOK, SECRET, MEMBER, "__Host-two_session"]);
  });

  it("wrapper: a malformed request id is omitted from the warn", async () => {
    const logs = captureDiagnosticStream();
    await expect(
      memberStatsWithBudget(
        async () => {
          throw new MemberStatsReadFailed(
            `stats select failed ${TOK}; cookie __Host-two_session=${SECRET}`,
          );
        },
        MEMBER,
        MALFORMED_ID,
      ),
    ).resolves.toMatchObject({
      membershipUnavailable: true,
      joinedAt: null,
      tenureDays: null,
      rankKey: null,
      milestones: [],
    });
    const line = recordsFor(logs, MEMBER_STATS);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      MEMBER_STATS,
      { exception: "MemberStatsReadFailed", aborted: false },
    ]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, [TOK, SECRET, MEMBER, "__Host-two_session"]);
  });

  it("direct read: a valid ULID travels on the warn", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new MemberStatsReadFailed(`members select failed ${TOK} ${SECRET}`));
    const controller = new AbortController();
    const logs = captureDiagnosticStream();
    await expect(
      readMemberStats({ execute } as unknown as Db, MEMBER, controller.signal, VALID_ULID),
    ).resolves.toMatchObject({
      membershipUnavailable: true,
      joinedAt: null,
      tenureDays: null,
      rankKey: null,
      milestones: [],
    });
    expect(execute).toHaveBeenCalledOnce();
    const line = recordsFor(logs, MEMBER_STATS);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      MEMBER_STATS,
      { exception: "MemberStatsReadFailed", aborted: false, request_id: VALID_ULID },
    ]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, [TOK, SECRET, MEMBER]);
  });
});

describe("counts warn carries the exception class", () => {
  it("live-view failure warns once with key + class; the ranks view survives", async () => {
    pgState.liveError = new CountsReadFailed(`live select failed ${TOK} ${SECRET}`);
    const logs = captureDiagnosticStream();
    await expect(counts.readCounts(countsEnv)).resolves.toEqual({
      memberCount: null,
      onlineCount: null,
      ranks: [{ key: "prospect", label: "Prospect", memberCount: 24 }],
    });
    const line = recordsFor(logs, COUNTS_READ);
    expect(line).toHaveLength(1);
    expect(line[0]!.channel).toBe("warn");
    expect(line[0]!.args).toEqual([
      COUNTS_READ,
      { key: "counts.live", exception: "CountsReadFailed" },
    ]);
    expect(channelCounts(logs)).toMatchObject({ warn: 1, error: 0 });
    streamClean(logs, [TOK, SECRET, COUNTS_URL, "counts-user", "counts-s3cret", "127.0.0.1"]);
  });

  it("both views failing warns once per key; full UNAVAILABLE", async () => {
    pgState.liveError = new CountsReadFailed(`live select failed ${TOK}`);
    pgState.ranksError = new CountsReadFailed(`ranks select failed ${SECRET}`);
    const logs = captureDiagnosticStream();
    await expect(counts.readCounts(countsEnv)).resolves.toEqual(counts.UNAVAILABLE);
    const line = recordsFor(logs, COUNTS_READ);
    expect(line).toHaveLength(2);
    expect(line.map((record) => record.channel)).toEqual(["warn", "warn"]);
    expect(line.map((record) => record.args)).toEqual([
      [COUNTS_READ, { key: "counts.live", exception: "CountsReadFailed" }],
      [COUNTS_READ, { key: "counts.ranks", exception: "CountsReadFailed" }],
    ]);
    expect(channelCounts(logs)).toMatchObject({ warn: 2, error: 0 });
    streamClean(logs, [TOK, SECRET, COUNTS_URL, "counts-user", "counts-s3cret", "127.0.0.1"]);
  });

  it("no database configured: silent UNAVAILABLE (fallback pin)", async () => {
    const logs = captureDiagnosticStream();
    await expect(counts.readCounts({} as Env)).resolves.toEqual(counts.UNAVAILABLE);
    expect(pgState.urls).toEqual([]);
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
  });

  it("control: healthy views stay silent", async () => {
    const logs = captureDiagnosticStream();
    await expect(counts.readCounts(countsEnv)).resolves.toEqual({
      memberCount: 84,
      onlineCount: 12,
      ranks: [{ key: "prospect", label: "Prospect", memberCount: 24 }],
    });
    expect(channelCounts(logs)).toMatchObject({ warn: 0, error: 0 });
  });
});
