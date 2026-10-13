// Joins opt-out exclusion for the public heatmap.
//
// Every aggregate excludes opted-out/erased members.
// Member ranking already filters `profiles.leaderboard_opt_out`; the joins
// grid must do the same via its `discord_id -> profiles.user_id` link.
// Erased members need no extra filter: erasure deletes their join_attempts
// rows. These cases fail while loadJoinsGrid counts with no profiles join
// and pass once opted-out discord_ids are excluded. Aggregate-only: the
// assertions read bucket counts, never identities.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadJoinsGrid } from "../src/hotzones/aggregates";
import type { SeasonWindow } from "../src/hotzones/season";
import { joinAttempts, profiles } from "../src/db/schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const slot = new Date("2026-09-07T20:05:00Z"); // a Monday, 20:00 UTC hour
const windowAll: SeasonWindow = { kind: "all", label: "all" };

const OPTED_OUT = "100000000000000401";
const OPTED_IN = "100000000000000402";

describe.skipIf(!process.env.DATABASE_URL)("loadJoinsGrid excludes opted-out members", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  it("counts an opted-in discord_id and ignores an opted-out one in the same slot", async () => {
    await fixture.reset();
    await db.insert(profiles).values([
      { userId: OPTED_OUT, leaderboardOptOut: true },
      { userId: OPTED_IN, leaderboardOptOut: false },
    ]);
    await db.insert(joinAttempts).values([
      {
        outcome: "added",
        source: "zxq-joins-optout",
        requestId: "zxq-joins-optout-0",
        discordId: OPTED_OUT,
        createdAt: slot,
      },
      {
        outcome: "added",
        source: "zxq-joins-optout",
        requestId: "zxq-joins-optout-1",
        discordId: OPTED_IN,
        createdAt: slot,
      },
    ]);
    const { cells, total } = await loadJoinsGrid(db, windowAll);
    // Monday (dow 1) 20:00 UTC holds exactly the opted-in attempt.
    expect(cells[1]![20]).toBe(1);
    expect(total).toBe(1);
  });

  it("still counts attempts with no discord_id and no profile row", async () => {
    await fixture.reset();
    await db.insert(joinAttempts).values({
      outcome: "already_member",
      source: "zxq-joins-optout",
      requestId: "zxq-joins-optout-2",
      discordId: null,
      createdAt: slot,
    });
    const { cells, total } = await loadJoinsGrid(db, windowAll);
    expect(cells[1]![20]).toBe(1);
    expect(total).toBe(1);
  });

  it("counts a discord_id whose profile row is absent (never opted out)", async () => {
    await fixture.reset();
    await db.insert(joinAttempts).values({
      outcome: "added",
      source: "zxq-joins-optout",
      requestId: "zxq-joins-optout-3",
      discordId: "100000000000000499",
      createdAt: slot,
    });
    const { total } = await loadJoinsGrid(db, windowAll);
    expect(total).toBe(1);
  });
});
