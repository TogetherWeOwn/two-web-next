// Fixture-only pins for the full-form save baseline: it must be deterministic
// and move with every editable field, the write version, identity and state,
// so a stale moderator draft can never be mistaken for the current row.
import { describe, expect, it } from "vitest";
import {
  eventSaveBaseline,
  featuredSaveBaseline,
  isSaveBaseline,
  nextSaveVersion,
  SAVE_BASELINE_FIELD,
  StaleSaveError,
  type EventSaveSnapshot,
} from "../src/admin/save-baseline";
import type { FeaturedEditRow } from "../src/admin/store-featured";

const eventRow = (over: Partial<EventSaveSnapshot> = {}): EventSaveSnapshot => ({
  eventKey: "evt_abc",
  title: "Board game night",
  game: "Wingspan",
  description: "Bring snacks.",
  accessibilityNotes: "Step-free entrance.",
  startsAt: new Date("2030-01-02T19:00:00.000Z"),
  endsAt: new Date("2030-01-02T21:00:00.000Z"),
  timezone: "Europe/London",
  location: "The Hall",
  capacity: 12,
  organizer_name: "Sam",
  join_url: "https://example.test/join",
  join_instructions: "Ring the bell.",
  status: "draft",
  rsvpOpen: true,
  updatedAt: new Date("2030-01-01T10:00:00.000Z"),
  agentVersion: 3,
  ...over,
});

const featuredRow = (over: Partial<FeaturedEditRow> = {}): FeaturedEditRow =>
  ({
    id: 7,
    title: "Join us",
    body: "Body",
    url: "https://example.test/a",
    imageUrl: "https://example.test/a.png",
    imageAlt: "Alt",
    isPublished: true,
    position: 2,
    startsAt: new Date("2030-01-01T00:00:00.000Z"),
    endsAt: new Date("2030-02-01T00:00:00.000Z"),
    startsAtText: "2030-01-01 00:00:00.000000",
    endsAtText: "2030-02-01 00:00:00.000000",
    updatedAt: new Date("2030-01-01T10:00:00.000Z"),
    ...over,
  }) as unknown as FeaturedEditRow;

describe("save baseline helpers", () => {
  it("exposes the field name, a strict digest check and a named error", () => {
    expect(SAVE_BASELINE_FIELD).toBe("saved_baseline");
    expect(isSaveBaseline("a".repeat(64))).toBe(true);
    for (const bad of [
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      "",
      5,
      null,
    ]) {
      expect(isSaveBaseline(bad)).toBe(false);
    }
    const error = new StaleSaveError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StaleSaveError");
  });
});

describe("eventSaveBaseline", () => {
  it("is a deterministic 64-hex digest independent of object identity", async () => {
    const first = await eventSaveBaseline(eventRow());
    expect(isSaveBaseline(first)).toBe(true);
    expect(await eventSaveBaseline(eventRow())).toBe(first);
  });

  const changes: Array<[string, Partial<EventSaveSnapshot>]> = [
    ["eventKey", { eventKey: "evt_other" }],
    ["title", { title: "Other" }],
    ["game", { game: "Other" }],
    ["description", { description: "Changed." }],
    ["accessibilityNotes", { accessibilityNotes: "Changed." }],
    ["accessibilityNotes cleared", { accessibilityNotes: null }],
    ["startsAt", { startsAt: new Date("2030-01-02T19:00:00.001Z") }],
    ["endsAt", { endsAt: new Date("2030-01-02T21:00:00.001Z") }],
    ["timezone", { timezone: "America/New_York" }],
    ["location", { location: "Elsewhere" }],
    ["capacity", { capacity: 13 }],
    ["capacity cleared", { capacity: null }],
    ["organizer_name", { organizer_name: "Alex" }],
    ["organizer_name cleared", { organizer_name: null }],
    ["join_url", { join_url: "https://example.test/other" }],
    ["join_url cleared", { join_url: null }],
    ["join_instructions", { join_instructions: "Knock." }],
    ["join_instructions cleared", { join_instructions: null }],
    ["status", { status: "published" }],
    ["rsvpOpen", { rsvpOpen: false }],
    ["updatedAt", { updatedAt: new Date("2030-01-01T10:00:00.001Z") }],
    ["agentVersion", { agentVersion: 4 }],
  ];

  it.each(changes)("changes when %s changes", async (_name, over) => {
    expect(await eventSaveBaseline(eventRow(over))).not.toBe(await eventSaveBaseline(eventRow()));
  });

  it("produces a distinct digest for every single-field change", async () => {
    const digests = new Set(
      await Promise.all(
        [{}, ...changes.map(([, over]) => over)].map((o) => eventSaveBaseline(eventRow(o))),
      ),
    );
    expect(digests.size).toBe(changes.length + 1);
  });

  it("rejects an A-B-A revert: same content with a later version is a new baseline", async () => {
    const original = await eventSaveBaseline(eventRow());
    const reverted = await eventSaveBaseline(
      eventRow({ updatedAt: new Date("2030-01-01T10:00:00.001Z"), agentVersion: 4 }),
    );
    expect(reverted).not.toBe(original);
    const sameMillisecondNewAgent = await eventSaveBaseline(eventRow({ agentVersion: 4 }));
    expect(sameMillisecondNewAgent).not.toBe(original);
  });

  it("treats an omitted optional field like null", async () => {
    const omitted: EventSaveSnapshot = eventRow();
    delete omitted.accessibilityNotes;
    delete omitted.organizer_name;
    delete omitted.join_url;
    delete omitted.join_instructions;
    delete omitted.updatedAt;
    delete omitted.agentVersion;
    const nulls: EventSaveSnapshot = {
      ...omitted,
      accessibilityNotes: null,
      organizer_name: null,
      join_url: null,
      join_instructions: null,
    };
    expect(await eventSaveBaseline(omitted)).toBe(await eventSaveBaseline(nulls));
  });

  it("distinguishes an empty string from null", async () => {
    expect(await eventSaveBaseline(eventRow({ organizer_name: "" }))).not.toBe(
      await eventSaveBaseline(eventRow({ organizer_name: null })),
    );
  });

  it("hashes legacy nonfinite dates without throwing and keeps them distinct from finite ones", async () => {
    const bad = new Date(Number.NaN);
    const nonfiniteStart = await eventSaveBaseline(eventRow({ startsAt: bad }));
    const nonfiniteEnd = await eventSaveBaseline(eventRow({ endsAt: bad }));
    const nonfiniteVersion = await eventSaveBaseline(eventRow({ updatedAt: bad }));
    const finite = await eventSaveBaseline(eventRow());
    expect(new Set([nonfiniteStart, nonfiniteEnd, nonfiniteVersion, finite]).size).toBe(4);
    expect(
      await eventSaveBaseline(eventRow({ startsAt: new Date(Number.POSITIVE_INFINITY) })),
    ).toBe(nonfiniteStart);
  });
});

describe("featuredSaveBaseline", () => {
  it("is a deterministic 64-hex digest", async () => {
    const first = await featuredSaveBaseline(featuredRow());
    expect(isSaveBaseline(first)).toBe(true);
    expect(await featuredSaveBaseline(featuredRow())).toBe(first);
  });

  const changes: Array<[string, Partial<FeaturedEditRow>]> = [
    ["id", { id: 8 }],
    ["updatedAt", { updatedAt: new Date("2030-01-01T10:00:00.001Z") }],
    ["title", { title: "Other" }],
    ["body", { body: "Other" }],
    ["url", { url: "https://example.test/b" }],
    ["imageUrl", { imageUrl: "https://example.test/b.png" }],
    ["imageAlt", { imageAlt: "Other" }],
    ["isPublished", { isPublished: false }],
    ["position", { position: 3 }],
    ["startsAtText microseconds", { startsAtText: "2030-01-01 00:00:00.000001" }],
    ["endsAtText microseconds", { endsAtText: "2030-02-01 00:00:00.000001" }],
    ["startsAtText BC era", { startsAtText: "2030-01-01 00:00:00.000000 BC" }],
    ["startsAtText infinity", { startsAtText: "infinity" }],
    ["endsAtText -infinity", { endsAtText: "-infinity" }],
    ["startsAtText cleared", { startsAtText: null }],
    ["endsAtText cleared", { endsAtText: null }],
  ];

  it.each(changes)("changes when %s changes", async (_name, over) => {
    expect(await featuredSaveBaseline(featuredRow(over))).not.toBe(
      await featuredSaveBaseline(featuredRow()),
    );
  });

  it("produces a distinct digest for every single-field change", async () => {
    const digests = new Set(
      await Promise.all(
        [{}, ...changes.map(([, over]) => over)].map((o) => featuredSaveBaseline(featuredRow(o))),
      ),
    );
    expect(digests.size).toBe(changes.length + 1);
  });

  it("reads the exact UTC SQL text, not the decoded Date column", async () => {
    // Decoded dates lose microseconds; the text carries them.
    const a = featuredRow({ startsAt: new Date("2030-01-01T00:00:00.000Z") });
    const b = featuredRow({ startsAt: new Date("2031-06-06T00:00:00.000Z") });
    expect(await featuredSaveBaseline(a)).toBe(await featuredSaveBaseline(b));
  });

  it("hashes a nonfinite updatedAt without throwing", async () => {
    const bad = await featuredSaveBaseline(featuredRow({ updatedAt: new Date(Number.NaN) }));
    expect(isSaveBaseline(bad)).toBe(true);
    expect(bad).not.toBe(await featuredSaveBaseline(featuredRow()));
  });

  it("is not equal to an event digest of coincident content", async () => {
    expect(await featuredSaveBaseline(featuredRow())).not.toBe(await eventSaveBaseline(eventRow()));
  });
});

describe("nextSaveVersion", () => {
  const previous = new Date("2030-01-01T10:00:00.000Z");

  it("uses the clock when it is ahead of the previous version", () => {
    const now = new Date("2030-01-01T10:00:05.000Z");
    expect(nextSaveVersion(previous, now).getTime()).toBe(now.getTime());
  });

  it("advances one millisecond when the clock is frozen", () => {
    expect(nextSaveVersion(previous, new Date(previous)).getTime()).toBe(previous.getTime() + 1);
  });

  it("stays ahead when the clock moves backwards", () => {
    const now = new Date("2029-12-31T00:00:00.000Z");
    expect(nextSaveVersion(previous, now).getTime()).toBe(previous.getTime() + 1);
  });

  it("returns a new Date and never mutates the previous one", () => {
    const copy = previous.getTime();
    const next = nextSaveVersion(previous, new Date(0));
    expect(next).not.toBe(previous);
    expect(previous.getTime()).toBe(copy);
  });

  it("repairs a nonfinite previous version with the clock", () => {
    const now = new Date("2030-01-01T10:00:05.000Z");
    expect(nextSaveVersion(new Date(Number.NaN), now).getTime()).toBe(now.getTime());
  });

  it("defaults to the current clock", () => {
    const before = Date.now();
    const next = nextSaveVersion(new Date(0)).getTime();
    expect(next).toBeGreaterThanOrEqual(before);
    expect(next).toBeLessThanOrEqual(Date.now());
  });

  it("never reissues the version of a prior save across repeated frozen-clock saves", () => {
    const frozen = new Date("2030-01-01T10:00:00.000Z");
    const seen = new Set<number>([previous.getTime()]);
    let current = previous;
    for (let i = 0; i < 5; i++) {
      current = nextSaveVersion(current, frozen);
      expect(seen.has(current.getTime())).toBe(false);
      seen.add(current.getTime());
    }
  });
});
