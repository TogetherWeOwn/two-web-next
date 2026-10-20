// Hot-zone 7x24 aggregates.
//
// - Joins cells aggregate real web data: `join_attempts.createdAt` in the
//   season window plus published `events.startsAt` in the window (aggregate
//   counts only, never per-user rows, timestamps, or identities). Attempts
//   whose `discord_id` links to an opted-out profile
//   (`profiles.leaderboard_opt_out`) never count, mirroring the member
//   ranking filter; erased members need no extra filter because erasure
//   deletes their join_attempts rows.
// - Voice/games cells are the WhatPulse-seeded prior with rollup semantics by
//   contract (same 7x24 shape/seed/weekly re-weight), not a crate import:
//   deterministic seeded base, weekly re-weighted so each weekday
//   carries equal weight. Always rendered labeled as estimates until bot
//   event-store calibration.
//
// All grids are aggregates only: 7 weekdays x 24 hours of counts.
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { events } from "../db/admin-schema";
import { joinAttempts, profiles } from "../db/schema";
import type { Db } from "../db/index";
import { JOIN_ATTEMPT_RETENTION_DAYS } from "../jobs/constants";
import type { SeasonWindow } from "./season";
import { WEEKDAY_NAMES as WEEKDAY_NAMES_SOURCE } from "./weekday-names";

export const HOTZONE_SIGNALS = ["joins", "voice", "games"] as const;
export type HotzoneSignal = (typeof HOTZONE_SIGNALS)[number];

export function isHotzoneSignal(raw: string): raw is HotzoneSignal {
  return (HOTZONE_SIGNALS as readonly string[]).includes(raw);
}

// Re-exported from the client-safe ./weekday-names module so server readers
// keep importing from here; Kit pages must import from ./weekday-names
// directly to avoid bundling drizzle-orm into the client.
export const WEEKDAY_NAMES = WEEKDAY_NAMES_SOURCE;

export type HeatGrid = number[][];

export function emptyGrid(): HeatGrid {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
}

export function gridTotal(cells: HeatGrid): number {
  let total = 0;
  for (const row of cells) for (const n of row) total += n;
  return total;
}

export type HotzonePeak = { weekday: number; hour: number; count: number };

// Peak cell of a 7x24 grid: weekday (0..6, WEEKDAY_NAMES/Postgres dow order)
// and hour (0..23 UTC) of the max cell plus its count. Deterministic
// tie-break: earliest weekday wins, then earliest hour (scan weekday outer,
// hour inner, strict `>` keeps the first max). Empty/all-zero grids (no cell
// > 0) return null and render no callout. Pure function of cells: no reads,
// no dates, no seasons. Both twins compute peak lines from already-loaded
// cells through this helper.
export function peakCell(cells: HeatGrid): HotzonePeak | null {
  let best: HotzonePeak | null = null;
  for (let weekday = 0; weekday < 7; weekday++) {
    const row = cells[weekday];
    if (!row) continue;
    for (let hour = 0; hour < 24; hour++) {
      const n = row[hour] ?? 0;
      if (n > (best?.count ?? 0)) best = { weekday, hour, count: n };
    }
  }
  return best;
}

// Outcomes that mean a join succeeded (added or already a member).
export const JOIN_SUCCESS_OUTCOMES = ["added", "already_member"] as const;

// Statement timeout for the public aggregate reads (fail fast, never hold the response).
export const JOINS_GRID_STATEMENT_TIMEOUT_MS = 2000;

// Joins 7x24 cells from real web data in the season window.
// SQL-side aggregation only: one grouped count (at most 168 rows) plus one
// event count, never per-user rows. Only `added`/`already_member` outcomes
// count as joins; denied/error/degraded attempts never do. Attempts from
// opted-out members never count: the left join on `profiles` drops rows
// whose `discord_id` maps to `leaderboard_opt_out = true`, while null
// discord_ids and absent profile rows still count. Join attempts are
// pruned after JOIN_ATTEMPT_RETENTION_DAYS, so windows older than retention
// read 0 by design (see joinsRetentionNote).
// `db = null` (DB-free render) yields an empty grid, never a 500.
export async function loadJoinsGrid(
  db: Db | null,
  window: SeasonWindow,
): Promise<{ cells: HeatGrid; total: number; eventCount: number }> {
  const cells = emptyGrid();
  if (!db) return { cells, total: 0, eventCount: 0 };
  const inWindow = window.kind === "all" ? null : { start: window.start, end: window.end };
  // Bound both aggregate statements server-side inside one transaction, like
  // recordBoardView's write deadline: SET LOCAL is transaction-local, so the
  // timeout cannot leak to the pooled session. The grouped joins count emits
  // at most 168 bucket rows plus one event count, never per-attempt rows.
  // Built from the joinAttempts/events table objects (not raw table names) so
  // the join-attempt write-policy pin keeps matching and the query-builder
  // serializes Date bounds (raw sql`` interpolation does not).
  const dow = sql`extract(dow from ${joinAttempts.createdAt} at time zone 'UTC')::int`;
  const hr = sql`extract(hour from ${joinAttempts.createdAt} at time zone 'UTC')::int`;
  const { buckets, eventCount } = await db.transaction(async (tx) => {
    // SET LOCAL takes a literal, not a bind param; the value is the numeric
    // constant above, so there is no injection surface.
    await tx.execute(
      sql.raw(`SET LOCAL statement_timeout = '${JOINS_GRID_STATEMENT_TIMEOUT_MS}ms'`),
    );
    const buckets = await tx
      .select({ dow, hr, n: sql`count(*)::int` })
      .from(joinAttempts)
      .leftJoin(profiles, eq(profiles.userId, joinAttempts.discordId))
      .where(
        and(
          inArray(joinAttempts.outcome, [...JOIN_SUCCESS_OUTCOMES]),
          or(isNull(profiles.leaderboardOptOut), eq(profiles.leaderboardOptOut, false)),
          inWindow ? gte(joinAttempts.createdAt, inWindow.start) : undefined,
          inWindow ? lt(joinAttempts.createdAt, inWindow.end) : undefined,
        ),
      )
      .groupBy(dow, hr);
    const counted = await tx
      .select({ n: sql`count(*)::int` })
      .from(events)
      .where(
        and(
          eq(events.status, "published"),
          inWindow ? gte(events.startsAt, inWindow.start) : undefined,
          inWindow ? lt(events.startsAt, inWindow.end) : undefined,
        ),
      );
    return { buckets, eventCount: Number(counted[0]?.n ?? 0) };
  });
  for (const row of buckets) {
    const dow = Number(row.dow);
    const hr = Number(row.hr);
    const n = Number(row.n);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    if (!Number.isInteger(hr) || hr < 0 || hr > 23) continue;
    if (!Number.isFinite(n) || n <= 0) continue;
    cells[dow]![hr]! += n;
  }
  return { cells, total: gridTotal(cells), eventCount };
}

// Human retention note for the joins grid. Join attempts delete after
// JOIN_ATTEMPT_RETENTION_DAYS, so a season window ending before the cutoff
// reads 0 joins while events (unpruned) still count; a window starting
// before the cutoff but ending after it undercounts the same way, and `all`
// silently covers only the retention window. Returns null only when the
// whole window is inside retention.
export function joinsRetentionNote(window: SeasonWindow, now: Date = new Date()): string | null {
  const cutoff = now.getTime() - JOIN_ATTEMPT_RETENTION_DAYS * 86_400_000;
  if (window.kind === "all")
    return `Join data is kept ${JOIN_ATTEMPT_RETENTION_DAYS} days, so the all-time view covers the last ${JOIN_ATTEMPT_RETENTION_DAYS} days.`;
  if (window.end.getTime() < cutoff)
    return `Join data is kept ${JOIN_ATTEMPT_RETENTION_DAYS} days, so this season shows 0 joins while scheduled gatherings remain.`;
  if (window.start.getTime() < cutoff)
    return `Join data is kept ${JOIN_ATTEMPT_RETENTION_DAYS} days, so this season covers only the last ${JOIN_ATTEMPT_RETENTION_DAYS} days; earlier joins are deleted while scheduled gatherings remain.`;
  return null;
}

// --- WhatPulse-seeded prior (voice/games, estimates) ---

// Contract seed for the rollup (by contract, not import).
const PRIOR_SEED_BASE = 0x22857;

function hashSignal(signal: string): number {
  let h = 2166136261;
  for (let i = 0; i < signal.length; i++) {
    h ^= signal.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic WhatPulse-seeded prior for voice/games with rollup semantics
// by contract: same 7x24 shape, same seed derivation, same weekly
// re-weight (each weekday normalized to equal weight so no weekday dominates
// the week). Pure function of signal; the season window does not move the
// prior (the seeded priors keep their own re-weight schedule).
export function priorGrid(signal: "voice" | "games"): { cells: HeatGrid; total: number } {
  const rand = mulberry32((PRIOR_SEED_BASE + hashSignal(signal)) >>> 0);
  const cells = emptyGrid();
  for (let weekday = 0; weekday < 7; weekday++) {
    let rowTotal = 0;
    const raw: number[] = [];
    for (let hour = 0; hour < 24; hour++) {
      // Base activity curve: evenings busier than dawn, plus seeded jitter.
      const curve = 8 + 10 * Math.exp(-((hour - 20) ** 2) / 18) + 4 * rand();
      raw.push(curve);
      rowTotal += curve;
    }
    // Weekly re-weight: each weekday carries 1/7 of the week (row sums to 100).
    for (let hour = 0; hour < 24; hour++) {
      cells[weekday]![hour]! = Math.max(1, Math.round((raw[hour]! / rowTotal) * 100));
    }
  }
  return { cells, total: gridTotal(cells) };
}
