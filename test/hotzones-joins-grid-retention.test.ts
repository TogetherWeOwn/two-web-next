// Pins the three hot-zone behaviours added with the member-leaderboard
// slice: the joins outcome filter, the retention note (including windows
// that straddle the retention cutoff), and the statement timeout on the
// aggregate reads. None of these is covered by the locked acceptance
// files, which this file never edits.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  JOINS_GRID_STATEMENT_TIMEOUT_MS,
  joinsRetentionNote,
  loadJoinsGrid,
} from "../src/hotzones/aggregates";
import { JOIN_ATTEMPT_RETENTION_DAYS } from "../src/jobs/constants";
import type { SeasonWindow } from "../src/hotzones/season";
import { events } from "../src/db/admin-schema";
import { joinAttempts } from "../src/db/schema";
import type { Db } from "../src/db/index";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// Fixed clock from the review probe: cutoff = now - 90 days = 2026-07-15.
const NOW = new Date("2026-10-13T00:00:00Z");
const windowOf = (start: string, end: string): SeasonWindow => ({
  kind: "window",
  start: new Date(start),
  end: new Date(end),
  label: `${start}..${end}`,
});

describe("joinsRetentionNote covers every window older than retention", () => {
  it("labels the all-time view as the last 90 days", () => {
    const note = joinsRetentionNote({ kind: "all", label: "all" }, NOW);
    expect(note).toContain(`last ${JOIN_ATTEMPT_RETENTION_DAYS} days`);
  });

  it("labels a fully-pruned season as showing 0 joins", () => {
    const note = windowOf("2026-04-01T00:00:00Z", "2026-07-01T00:00:00Z");
    expect(joinsRetentionNote(note, NOW)).toContain("shows 0 joins");
  });

  it.each([
    ["year", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"],
    ["quarter", "2026-07-01T00:00:00Z", "2026-10-01T00:00:00Z"],
    ["month", "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"],
  ])("labels a straddling %s window instead of returning null", (_label, start, end) => {
    const note = joinsRetentionNote(windowOf(start, end), NOW);
    expect(note, `${start}..${end} starts before the cutoff`).not.toBeNull();
    expect(note).toContain(`last ${JOIN_ATTEMPT_RETENTION_DAYS} days`);
  });

  it("returns null for a window fully inside retention", () => {
    expect(
      joinsRetentionNote(windowOf("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"), NOW),
    ).toBeNull();
  });

  it("returns null for a window starting exactly at the cutoff", () => {
    const cutoff = new Date(NOW.getTime() - JOIN_ATTEMPT_RETENTION_DAYS * 86_400_000);
    expect(
      joinsRetentionNote(
        { kind: "window", start: cutoff, end: new Date("2026-10-01T00:00:00Z"), label: "edge" },
        NOW,
      ),
    ).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("loadJoinsGrid counts only successful joins", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  it("counts added + already_member in one slot and ignores denied/error/degraded", async () => {
    await fixture.reset();
    const slot = new Date("2026-09-07T20:05:00Z"); // a Monday, 20:00 UTC hour
    const outcomes = ["added", "already_member", "denied", "error", "degraded"];
    await db.insert(joinAttempts).values(
      outcomes.map((outcome, n) => ({
        outcome,
        source: "zxq-grid-probe",
        requestId: `zxq-grid-probe-${n}`,
        discordId: null,
        createdAt: slot,
      })),
    );
    await db.insert(events).values({
      eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      title: "zxq-grid-probe games",
      status: "published",
      startsAt: new Date("2026-09-07T20:00:00Z"),
      endsAt: new Date("2026-09-07T22:00:00Z"),
    });
    const { cells, total, eventCount } = await loadJoinsGrid(db, {
      kind: "all",
      label: "all",
    });
    // Monday = 1 in Postgres extract(dow), hour 20 UTC.
    expect(cells[1]![20]).toBe(2);
    expect(total).toBe(2);
    expect(eventCount).toBe(1);
  });
});

describe("loadJoinsGrid bounds its reads with a statement timeout", () => {
  it("runs SET LOCAL statement_timeout inside the transaction", async () => {
    const executed: unknown[] = [];
    const buckets: unknown[] = [];
    const counted = [{ n: 0 }];
    // Minimal fake transaction: where() is awaitable for the event count,
    // carries groupBy() for the bucketed joins count, and carries
    // orderBy().limit() for the bounded gatherings list. leftJoin mirrors
    // the opt-out exclusion (join_attempts.discord_id -> profiles.user_id).
    const whereResult = Object.assign(Promise.resolve(counted), {
      groupBy: async () => buckets,
      orderBy: () => ({ limit: async () => [] }),
    });
    const fakeTx = {
      execute: async (query: unknown) => {
        executed.push(query);
        return [];
      },
      select: () => ({
        from: () => ({
          where: () => whereResult,
          leftJoin: () => ({ where: () => whereResult }),
        }),
      }),
    };
    const fakeDb = {
      transaction: async <T>(fn: (tx: typeof fakeTx) => Promise<T>): Promise<T> => fn(fakeTx),
    } as unknown as Db;
    await loadJoinsGrid(fakeDb, { kind: "all", label: "all" });
    expect(executed).toHaveLength(1);
    const chunks = (executed[0] as { queryChunks?: { value?: unknown[] }[] }).queryChunks ?? [];
    const text = chunks.map((chunk) => (chunk.value ?? []).join("")).join("");
    expect(text).toContain("statement_timeout");
    expect(text).toContain(`${JOINS_GRID_STATEMENT_TIMEOUT_MS}ms`);
  });
});
