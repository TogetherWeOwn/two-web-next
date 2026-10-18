// Acceptance contract (acceptance-owned; the implementation change must not
// edit this file): a model:prune pass that hits the per-table batch cap
// pages instead of merely warning, because sustained over-cap inflow would
// otherwise violate retention indefinitely with no page.
//
// Contract pinned here:
// - A capped drain outcome (a full PRUNE_DELETE_BATCH_SIZE batch on the
//   PRUNE_DELETE_MAX_BATCHES-th batch, for any age table or for sessions)
//   emits exactly ONE critical scheduled-failure source line for the whole
//   pass: a single console.error call whose only argument is one-line JSON
//   with exactly the documented scheduled.failing fields
//   { level: "critical", event: "scheduled.failing", job: "model:prune",
//     exception: <identifier-shaped class>, error_class: <same class>,
//     build_sha: <40-hex | null>, release: <same as build_sha> }.
//   No other fields: no table names, counts, capped-table lists, messages,
//   SQL, cron expressions or row material ever reach the page line.
// - The pass still resolves with the same counts as today and never throws
//   on a cap hit; it does not also console.warn about the cap.
// - Every capped pass pages (no source-side mute across passes), matching
//   the one-line-per-failed-invocation rule for scheduled failures.
// - The real Tail parser accepts the captured line and fingerprints it
//   "scheduled.failing@model:prune", which is what actually pages.
// - Uncapped passes are unchanged: same counts, nothing at warn/error
//   level (info-level count logging stays allowed).
//
// Mutations that must fail this file: keeping the cap at console.warn,
// dropping the critical line, emitting one line per capped table instead
// of one per pass, throwing on a cap hit, changing the returned counts,
// paging an uncapped/short-final-batch pass, or adding any extra field
// (table names, counts, messages) to the page line.
//
// Hermetic seams only: pruneModelTables with in-memory stub tables and
// sweepers, exactly like test/prune.test.ts. No database is contacted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRUNE_DELETE_BATCH_SIZE, PRUNE_DELETE_MAX_BATCHES } from "../src/jobs/constants";
import { pruneModelTables } from "../src/jobs/cron";
import type { PruneStores } from "../src/jobs/types";
import { createMemorySessionStore } from "../src/sessions";
import { parseAlert } from "../tail/worker";

const NOW = new Date("2026-09-30T00:00:00Z");
const TIMESTAMP = NOW.getTime();
const PER_PASS_CAP = PRUNE_DELETE_BATCH_SIZE * PRUNE_DELETE_MAX_BATCHES;
const TABLE_NAMES = [
  "agentEventAudits",
  "accessLog",
  "joinAttempts",
  "idempotencyKeys",
  "searchLog",
  "boardViews",
] as const;

type AgeTableName = (typeof TABLE_NAMES)[number];

const zeroTable = () => ({
  async pruneOlderThan(_cutoff: Date): Promise<number> {
    return 0;
  },
});

function emptyTables(): Record<AgeTableName, ReturnType<typeof zeroTable>> {
  return {
    agentEventAudits: zeroTable(),
    accessLog: zeroTable(),
    joinAttempts: zeroTable(),
    idempotencyKeys: zeroTable(),
    searchLog: zeroTable(),
    boardViews: zeroTable(),
  };
}

/** A table whose every batch is full: draining it always hits the cap. */
function endlessTable(counter: { n: number }) {
  return {
    async pruneOlderThan(_cutoff: Date): Promise<number> {
      counter.n++;
      return PRUNE_DELETE_BATCH_SIZE;
    },
  };
}

function sequenceTable(returns: number[], counter: { n: number }) {
  const queue = [...returns];
  return {
    async pruneOlderThan(_cutoff: Date): Promise<number> {
      counter.n++;
      return queue.length > 0 ? queue.shift()! : 0;
    },
  };
}

function storesWith(
  tables: Partial<Record<AgeTableName, { pruneOlderThan(c: Date): Promise<number> }>>,
  sessions: PruneStores["sessions"] = createMemorySessionStore(() => NOW.getTime()),
): PruneStores {
  return { ...emptyTables(), ...tables, sessions } as PruneStores;
}

let errorCalls: unknown[][] = [];
let warnCalls: unknown[][] = [];
let spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  errorCalls = [];
  warnCalls = [];
  spies = [
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorCalls.push(args);
    }),
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnCalls.push(args);
    }),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "log").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

/** Strictly parse the single expected page line, reporting any deviation. */
function pageLines(): { raw: string; line: Record<string, unknown> }[] {
  const found: { raw: string; line: Record<string, unknown> }[] = [];
  for (const args of errorCalls) {
    expect(args, "page line must be a single-argument console.error call").toHaveLength(1);
    const raw = args[0];
    expect(typeof raw, "page line must be a string").toBe("string");
    expect(raw as string, "page line must be single-line").not.toContain("\n");
    const line: unknown = JSON.parse(raw as string);
    expect(line, "page line must be a JSON object").toBeTypeOf("object");
    found.push({ raw: raw as string, line: line as Record<string, unknown> });
  }
  return found;
}

function expectPageLine(entry: { raw: string; line: Record<string, unknown> }): void {
  const { raw, line } = entry;
  // Exactly the documented scheduled.failing fields, nothing more: this is
  // what keeps table names, counts and cap detail out of the page.
  expect(Object.keys(line).sort()).toEqual([
    "build_sha",
    "error_class",
    "event",
    "exception",
    "job",
    "level",
    "release",
  ]);
  expect(line.level).toBe("critical");
  expect(line.event).toBe("scheduled.failing");
  expect(line.job).toBe("model:prune");
  expect(typeof line.exception).toBe("string");
  expect(line.exception as string).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  expect(line.error_class).toBe(line.exception);
  expect(line.release).toBe(line.build_sha);
  if (line.build_sha !== null) {
    expect(line.build_sha).toMatch(/^[0-9a-f]{40}$/);
  }
  for (const name of TABLE_NAMES) expect(raw).not.toContain(name);
  expect(raw).not.toContain("cappedTables");
  expect(raw).not.toContain("batch cap");
}

describe("prune batch-cap paging (acceptance)", () => {
  it("one capped table pages once for the pass and still returns its counts", async () => {
    const calls = { n: 0 };
    const counts = await pruneModelTables(storesWith({ joinAttempts: endlessTable(calls) }), NOW);

    expect(counts).toMatchObject({
      agentEventAudits: 0,
      accessLog: 0,
      joinAttempts: PER_PASS_CAP,
      idempotencyKeys: 0,
      searchLog: 0,
      boardViews: 0,
      sessions: 0,
    });
    expect(calls.n).toBe(PRUNE_DELETE_MAX_BATCHES);
    expect(warnCalls, "a capped pass pages instead of warning").toHaveLength(0);
    const pages = pageLines();
    expect(pages).toHaveLength(1);
    expectPageLine(pages[0]!);
  });

  it("all six tables capped still emit exactly one page line, counts unchanged", async () => {
    const calls = { n: 0 };
    const endless = endlessTable(calls);
    const tables = Object.fromEntries(TABLE_NAMES.map((name) => [name, endless]));
    const counts = await pruneModelTables(storesWith(tables), NOW);

    for (const name of TABLE_NAMES) expect(counts[name]).toBe(PER_PASS_CAP);
    expect(counts.sessions).toBe(0);
    expect(calls.n).toBe(TABLE_NAMES.length * PRUNE_DELETE_MAX_BATCHES);
    expect(warnCalls).toHaveLength(0);
    const pages = pageLines();
    expect(pages, "one page per capped pass, not one per capped table").toHaveLength(1);
    expectPageLine(pages[0]!);
  });

  it("a sessions-only cap pages once through the same signal", async () => {
    let sweepCalls = 0;
    const sessions = {
      async sweepExpired(_now: Date): Promise<number> {
        sweepCalls++;
        return PRUNE_DELETE_BATCH_SIZE;
      },
    } as unknown as PruneStores["sessions"];
    const counts = await pruneModelTables(storesWith({}, sessions), NOW);

    expect(counts.sessions).toBe(PER_PASS_CAP);
    expect(sweepCalls).toBe(PRUNE_DELETE_MAX_BATCHES);
    for (const name of TABLE_NAMES) expect(counts[name]).toBe(0);
    expect(warnCalls).toHaveLength(0);
    const pages = pageLines();
    expect(pages).toHaveLength(1);
    expectPageLine(pages[0]!);
    // The raw line carries no session material or table detail.
    expect(pages[0]!.raw).not.toContain("sessions");
  });

  it("every capped pass pages: two capped passes write two source lines", async () => {
    const calls = { n: 0 };
    const stores = storesWith({ searchLog: endlessTable(calls) });

    await expect(pruneModelTables(stores, NOW)).resolves.toMatchObject({
      searchLog: PER_PASS_CAP,
    });
    await expect(pruneModelTables(stores, NOW)).resolves.toMatchObject({
      searchLog: PER_PASS_CAP,
    });

    expect(warnCalls).toHaveLength(0);
    const pages = pageLines();
    expect(pages).toHaveLength(2);
    for (const page of pages) expectPageLine(page);
  });

  it("the captured cap line pages through the real Tail parser as scheduled.failing@model:prune", async () => {
    const calls = { n: 0 };
    await pruneModelTables(storesWith({ accessLog: endlessTable(calls) }), NOW);
    const pages = pageLines();
    expect(pages).toHaveLength(1);
    expectPageLine(pages[0]!);

    const alert = await parseAlert(pages[0]!.raw, TIMESTAMP);
    expect(alert).toMatchObject({
      event: "scheduled.failing",
      fingerprint: "scheduled.failing@model:prune",
      job: "model:prune",
      exception: pages[0]!.line.exception,
    });
    expect(JSON.stringify(alert)).not.toContain("accessLog");
  });
});

describe("prune batch-cap paging positive controls (acceptance)", () => {
  it("a multi-batch uncapped drain keeps its counts and stays below warn level", async () => {
    const counts = await pruneModelTables(
      storesWith(
        Object.fromEntries(
          TABLE_NAMES.map((name) => [name, sequenceTable([PRUNE_DELETE_BATCH_SIZE, 3], { n: 0 })]),
        ),
      ),
      NOW,
    );

    for (const name of TABLE_NAMES) expect(counts[name]).toBe(PRUNE_DELETE_BATCH_SIZE + 3);
    expect(counts.sessions).toBe(0);
    expect(errorCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(0);
  });

  it("a short final batch on the last allowed batch is uncapped and silent", async () => {
    const calls = { n: 0 };
    const returns = [
      ...Array.from({ length: PRUNE_DELETE_MAX_BATCHES - 1 }, () => PRUNE_DELETE_BATCH_SIZE),
      3,
    ];
    const counts = await pruneModelTables(
      storesWith({ boardViews: sequenceTable(returns, calls) }),
      NOW,
    );

    expect(calls.n).toBe(PRUNE_DELETE_MAX_BATCHES);
    expect(counts.boardViews).toBe((PRUNE_DELETE_MAX_BATCHES - 1) * PRUNE_DELETE_BATCH_SIZE + 3);
    expect(errorCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(0);
  });

  it("an empty pass returns zero counts and emits nothing at warn or error level", async () => {
    const counts = await pruneModelTables(storesWith({}), NOW);

    for (const name of TABLE_NAMES) expect(counts[name]).toBe(0);
    expect(counts.sessions).toBe(0);
    expect(errorCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(0);
  });
});
