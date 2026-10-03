// Native leg of the EventScheduleTest backfill proof (two-web@2eaefb8
// tests/Feature/Events/EventScheduleTest.php:58-96).
//
// The importer leg — replaying the 2026_08_25_000100_correct_events_schema
// statements (nullable ends_at, naive timestamps, missing key) and importing
// the result — is proved by test/import-backfill-portable.test.ts (PR #281):
// ULID preservation, default UTC zone, ends_at = starts_at + 2h, microsecond
// pairs across the BST change, and fail-closed NULL zones with no writes.
// That suite is not re-proved here.
//
// What remains is the native Next row contract any backfilled or newly
// created row must satisfy: keys are minted as ULIDs (never taken from
// input), an omitted timezone falls back to the DB 'UTC' default (the form
// parser itself defaults to Europe/London when the field is absent — the UTC
// default lives in the column, matching the legacy correction), the stored
// start/end pair round-trips exactly, the requested game survives a fresh
// read (legacy :92-96), and invalid rows are refused before any write.
// Runs only on owned agent-testdb/CI schemas via createMemberDataFixture;
// never production/staging.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEvent } from "../src/admin/store";
import { newEventKey, parseEventForm, ValidationError } from "../src/admin/validation";
import { events } from "../src/db/admin-schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// Str::ulid(): 26 Crockford base32 characters, 48-bit time prefix (first char 0-7).
const ulidPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
// The legacy backfill pair: ends_at = starts_at + 2 hours, read as UTC.
const STARTS_ISO = "2026-07-15T19:00:00.000Z";
const ENDS_ISO = "2026-07-15T21:00:00.000Z";
const GAME = "Helldivers 2";
const actor = { id: "synthetic-moderator", username: "Synthetic moderator" };

describe("newEventKey mints Str::ulid-shaped keys", () => {
  it("generates unique 26-char Crockford ULIDs", () => {
    const keys = Array.from({ length: 100 }, () => newEventKey());
    expect(new Set(keys).size).toBe(100);
    for (const key of keys) expect(key).toMatch(ulidPattern);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("native legacy-row backfill (agent-testdb)", () => {
  let fixture: MemberDataFixture;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    await fixture.reset();
  });

  const stored = async (key: string) =>
    (await fixture.db.select().from(events).where(eq(events.eventKey, key)))[0];
  const snapshot = async () => ({
    events: await fixture.db.select().from(events),
  });

  it("createEvent assigns a ULID, preserves the backfill start/end pair and persists the game", async () => {
    const input = parseEventForm({
      title: "Shipped before this migration existed",
      game: GAME,
      starts_at: "2026-07-15 19:00",
      ends_at: "2026-07-15 21:00",
      timezone: "UTC",
    });
    const { row } = await createEvent(fixture.db, actor, input);
    expect(row.eventKey).toMatch(ulidPattern);

    // Fresh read, like legacy's ->fresh(): the key, zone, pair and game survive.
    const fresh = await stored(row.eventKey);
    expect(fresh?.eventKey).toBe(row.eventKey);
    expect(fresh?.timezone).toBe("UTC");
    expect(fresh?.startsAt.toISOString()).toBe(STARTS_ISO);
    expect(fresh?.endsAt.toISOString()).toBe(ENDS_ISO);
    expect(fresh?.game).toBe(GAME);
    expect(fresh?.status).toBe("draft");

    // An omitted game stays null under a different key; nothing is re-keyed.
    const { row: gameless } = await createEvent(
      fixture.db,
      actor,
      parseEventForm({
        title: "No game asked for",
        starts_at: "2026-07-15 19:00",
        ends_at: "2026-07-15 21:00",
        timezone: "UTC",
      }),
    );
    expect(gameless.eventKey).toMatch(ulidPattern);
    expect(gameless.eventKey).not.toBe(row.eventKey);
    expect((await stored(gameless.eventKey))?.game).toBeNull();
  });

  it("an omitted timezone falls back to the DB UTC default", async () => {
    const key = newEventKey();
    await fixture.db.insert(events).values({
      eventKey: key,
      title: "Legacy-shaped row without a zone",
      startsAt: new Date(STARTS_ISO),
      endsAt: new Date(ENDS_ISO),
    });
    const fresh = await stored(key);
    expect(fresh?.timezone).toBe("UTC");
    expect(fresh?.startsAt.toISOString()).toBe(STARTS_ISO);
    expect(fresh?.endsAt.toISOString()).toBe(ENDS_ISO);
    expect(fresh?.game).toBeNull();
  });

  it("real SQL refuses null keys and null ends with nothing written", async () => {
    const before = await snapshot();
    for (const [column, sql] of [
      [
        "event_key",
        `INSERT INTO events (event_key, title, starts_at, ends_at) VALUES (NULL, 'No key', '${STARTS_ISO}', '${ENDS_ISO}')`,
      ],
      [
        "ends_at",
        `INSERT INTO events (event_key, title, starts_at, ends_at) VALUES ('01JNULLENDS00000000000000', 'Open-ended', '${STARTS_ISO}', NULL)`,
      ],
    ] as const) {
      let caught: unknown;
      try {
        await fixture.client.unsafe(sql);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "23502" });
      expect(String((caught as { message?: unknown })?.message ?? caught)).toContain(column);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("missing or backwards ends are refused before any write", async () => {
    const before = await snapshot();
    const base = { title: "Backwards", starts_at: "2026-07-15 19:00", timezone: "UTC" };
    for (const [label, body, field, message] of [
      ["missing end", base, "ends_at", "When does it end?"],
      [
        "end equal to the start",
        { ...base, ends_at: "2026-07-15 19:00" },
        "ends_at",
        "The end is after the start.",
      ],
      [
        "end before the start",
        { ...base, ends_at: "2026-07-15 18:00" },
        "ends_at",
        "The end is after the start.",
      ],
    ] as const) {
      let caught: unknown;
      try {
        parseEventForm(body);
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).fields).toEqual({ [field]: message });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("overlong games and unknown zones are refused before any write", async () => {
    const before = await snapshot();
    const base = {
      title: "Game night",
      starts_at: "2026-07-15 19:00",
      ends_at: "2026-07-15 21:00",
      timezone: "UTC",
    };
    for (const [label, body, fields] of [
      [
        "overlong game",
        { ...base, game: "x".repeat(101) },
        { game: "Keep the game to 100 characters." },
      ],
      [
        "unknown zone",
        { ...base, timezone: "Not/AZone" },
        { timezone: "Unknown timezone: Not/AZone." },
      ],
    ] as const) {
      let caught: unknown;
      try {
        parseEventForm(body);
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).fields).toEqual(fields);
    }
    // Only omitted zones default to UTC; a bogus zone never fabricates one.
    expect(await snapshot()).toEqual(before);
  });
});
