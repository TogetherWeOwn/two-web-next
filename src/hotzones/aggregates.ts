// Hot-zone 7x24 aggregates.
//
// - Joins cells aggregate real web data: `join_attempts.createdAt` in the
//   season window plus published `events.startsAt` in the window (aggregate
//   counts only, never per-user rows, timestamps, or identities).
// - Voice/games cells are the WhatPulse-seeded prior with rollup semantics by
//   contract (same 7x24 shape/seed/weekly re-weight), not a crate import:
//   deterministic seeded base, weekly re-weighted so each weekday
//   carries equal weight. Always rendered labeled as estimates until bot
//   event-store calibration.
//
// All grids are aggregates only: 7 weekdays x 24 hours of counts.
import { and, eq, gte, lt } from "drizzle-orm";
import { events } from "../db/admin-schema";
import { joinAttempts } from "../db/schema";
import type { Db } from "../db/index";
import type { SeasonWindow } from "./season";

export const HOTZONE_SIGNALS = ["joins", "voice", "games"] as const;
export type HotzoneSignal = (typeof HOTZONE_SIGNALS)[number];

export function isHotzoneSignal(raw: string): raw is HotzoneSignal {
  return (HOTZONE_SIGNALS as readonly string[]).includes(raw);
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type HeatGrid = number[][];

export function emptyGrid(): HeatGrid {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
}

export function gridTotal(cells: HeatGrid): number {
  let total = 0;
  for (const row of cells) for (const n of row) total += n;
  return total;
}

/**
 * Joins 7x24 cells from real web data in the season window.
 * Reads only `createdAt` (joins) and `startsAt`/`status` (events): never
 * discord_id, source, request_id, titles, or timestamps in the output.
 * `db = null` (DB-free render) yields an empty grid, never a 500.
 */
export async function loadJoinsGrid(
  db: Db | null,
  window: SeasonWindow,
): Promise<{ cells: HeatGrid; total: number; eventCount: number }> {
  const cells = emptyGrid();
  if (!db) return { cells, total: 0, eventCount: 0 };
  const inWindow = window.kind === "all" ? null : { start: window.start, end: window.end };
  // Join attempts in the window (createdAt only: aggregate, no identities).
  const joinRows = inWindow
    ? await db
        .select({ createdAt: joinAttempts.createdAt })
        .from(joinAttempts)
        .where(
          and(
            gte(joinAttempts.createdAt, inWindow.start),
            lt(joinAttempts.createdAt, inWindow.end),
          ),
        )
    : await db.select({ createdAt: joinAttempts.createdAt }).from(joinAttempts);
  for (const row of joinRows) {
    const d = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    if (Number.isNaN(d.getTime())) continue;
    cells[d.getUTCDay()]![d.getUTCHours()]! += 1;
  }
  // Published event starts in the window (aggregate count only, never titles).
  const eventRows = inWindow
    ? await db
        .select({ startsAt: events.startsAt })
        .from(events)
        .where(
          and(
            eq(events.status, "published"),
            gte(events.startsAt, inWindow.start),
            lt(events.startsAt, inWindow.end),
          ),
        )
    : await db
        .select({ startsAt: events.startsAt })
        .from(events)
        .where(eq(events.status, "published"));
  return { cells, total: gridTotal(cells), eventCount: eventRows.length };
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

/**
 * Deterministic WhatPulse-seeded prior for voice/games with rollup semantics
 * by contract: same 7x24 shape, same seed derivation, same weekly
 * re-weight (each weekday normalized to equal weight so no weekday dominates
 * the week). Pure function of signal; the season window does not move the
 * prior (the seeded priors keep their own re-weight schedule).
 */
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
