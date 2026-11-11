// Fixture-only pins for the stale-save guard in the guarded admin stores. A
// mocked Drizzle transaction records every call so the tests prove the
// baseline comparison runs after the row lock (.for("update")) and before any
// mutation, audit, cache retirement, recurrence work or write-back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("../src/admin/store-shared", async (importActual) => ({
  ...(await importActual<typeof import("../src/admin/store-shared")>()),
  boundModeratorWrite: vi.fn(async () => {
    calls.push("bound");
  }),
  audit: vi.fn(async () => {
    calls.push("audit");
  }),
}));
vi.mock("../src/events/waitlist", () => ({
  CAPACITY_BELOW_GOING: "Capacity is below the number going.",
  goingCount: vi.fn(async () => {
    calls.push("goingCount");
    return 0;
  }),
  lockWaitlist: vi.fn(),
  promoteWaitlist: vi.fn(async () => {
    calls.push("promoteWaitlist");
  }),
}));
vi.mock("../src/events/anon-cache", () => ({
  retireAnonEventCaches: vi.fn(() => {
    calls.push("retireAnon");
  }),
}));
vi.mock("../src/public-data/cache", () => ({
  retireApiPublicEventCache: vi.fn(() => {
    calls.push("retireApi");
  }),
}));
vi.mock("../src/home-cache", () => ({
  retireHomeGuestCache: vi.fn(async () => {
    calls.push("retireHome");
  }),
}));

import {
  eventSaveBaseline,
  featuredSaveBaseline,
  StaleSaveError,
} from "../src/admin/save-baseline";
import { NotFoundError } from "../src/admin/store-shared";
import { updateEvent, type EventRow } from "../src/admin/store-event-writes";
import {
  unpublishFeatured,
  updateFeatured,
  type FeaturedEditRow,
} from "../src/admin/store-featured";
import type { Db } from "../src/db/index";
import type { EventFormInput, FeaturedFormInput } from "../src/admin/validation";

const actor = { id: "moderator-1" } as never;

type Chain = Record<string, unknown>;

// One fake transaction. `lockRows` is what .for("update") resolves to; the
// recorded `calls` expose the exact order of lock, guard and writes.
function fakeDb(lockRows: unknown[], returned: unknown[] = []) {
  const sets: Record<string, unknown>[] = [];
  const inserts: unknown[] = [];
  const tx = {
    execute: vi.fn(async () => undefined),
    select: vi.fn(() => {
      calls.push("select");
      const chain: Chain = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.for = async (mode: string) => {
        calls.push(`for:${mode}`);
        return lockRows;
      };
      return chain;
    }),
    update: vi.fn(() => {
      calls.push("update");
      const chain: Chain = {};
      chain.set = (values: Record<string, unknown>) => {
        sets.push(values);
        return chain;
      };
      chain.where = () => chain;
      chain.returning = async () => returned;
      // Awaiting the chain without .returning() (unpublish) also resolves.
      chain.then = (resolve: (v: unknown) => void) => resolve(undefined);
      return chain;
    }),
    insert: vi.fn(() => {
      calls.push("insert");
      return {
        values: async (values: unknown) => {
          inserts.push(values);
        },
      };
    }),
    delete: vi.fn(() => {
      calls.push("delete");
      return { where: async () => undefined };
    }),
  };
  const db = {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as Db;
  return { db, tx, sets, inserts };
}

const MUTATING = ["update", "insert", "delete", "audit", "goingCount", "promoteWaitlist"];
const CACHES = ["retireAnon", "retireApi", "retireHome"];

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

const eventRow = (over: Partial<EventRow> = {}): EventRow =>
  ({
    id: 1,
    eventKey: "evt_abc",
    title: "Board game night",
    game: "Wingspan",
    description: "Bring snacks.",
    accessibilityNotes: null,
    startsAt: new Date("2030-01-02T19:00:00.000Z"),
    endsAt: new Date("2030-01-02T21:00:00.000Z"),
    timezone: "Europe/London",
    location: "The Hall",
    capacity: 12,
    organizer_name: "Sam",
    join_url: null,
    join_instructions: null,
    status: "draft",
    rsvpOpen: true,
    updatedAt: new Date("2030-01-01T10:00:00.000Z"),
    agentVersion: 1,
    agentGrantId: null,
    recurrenceFrequency: null,
    createdBy: "moderator-1",
    ...over,
  }) as unknown as EventRow;

const eventInput = {
  title: "Renamed night",
  game: "Wingspan",
  description: "Bring snacks.",
  accessibilityNotes: null,
  startsAtUtc: new Date("2030-01-02T19:00:00.000Z"),
  endsAtUtc: new Date("2030-01-02T21:00:00.000Z"),
  timezone: "Europe/London",
  location: "The Hall",
  capacity: null,
  organizer_name: null,
  join_url: null,
  join_instructions: null,
} as unknown as EventFormInput;

describe("updateEvent stale-save guard", () => {
  it("rejects a mismatched baseline after the lock and before any side effect", async () => {
    const locked = eventRow({ recurrenceFrequency: "weekly" as never });
    const { db, tx, sets, inserts } = fakeDb([locked]);
    const stale = await eventSaveBaseline(eventRow({ title: "Older title" }));

    await expect(updateEvent(db, actor, "evt_abc", eventInput, stale)).rejects.toBeInstanceOf(
      StaleSaveError,
    );

    expect(calls).toEqual(["bound", "select", "for:update"]);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(sets).toEqual([]);
    expect(inserts).toEqual([]);
    for (const name of [...MUTATING, ...CACHES]) expect(calls).not.toContain(name);
  });

  it("treats a same-content revert at a later version as stale", async () => {
    const original = eventRow();
    const reviewed = await eventSaveBaseline(original);
    const reverted = eventRow({ updatedAt: new Date("2030-01-01T10:00:00.001Z") });
    const { db } = fakeDb([reverted]);

    await expect(updateEvent(db, actor, "evt_abc", eventInput, reviewed)).rejects.toBeInstanceOf(
      StaleSaveError,
    );
    expect(calls).toEqual(["bound", "select", "for:update"]);
  });

  it("reports a missing row as not found, before the baseline is judged", async () => {
    const { db } = fakeDb([]);
    await expect(
      updateEvent(db, actor, "evt_missing", eventInput, "0".repeat(64)),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toEqual(["bound", "select", "for:update"]);
  });

  it("commits through mutation, audit and cache retirement when the baseline matches", async () => {
    const locked = eventRow();
    const updated = eventRow({
      title: eventInput.title,
      updatedAt: new Date("2030-01-01T10:00:00.001Z"),
    });
    const { db, sets } = fakeDb([locked], [updated]);
    vi.useFakeTimers({ toFake: ["Date"] });
    // A clock behind the stored version must still advance it.
    vi.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));

    const out = await updateEvent(
      db,
      actor,
      "evt_abc",
      eventInput,
      await eventSaveBaseline(locked),
    );

    expect(out.row).toBe(updated);
    expect(calls.slice(0, 3)).toEqual(["bound", "select", "for:update"]);
    expect(calls.indexOf("update")).toBeGreaterThan(calls.indexOf("for:update"));
    expect(calls).toContain("promoteWaitlist");
    expect(calls).toContain("insert");
    expect(calls.slice(-3)).toEqual(CACHES);
    expect(sets[0]?.updatedAt).toEqual(new Date("2030-01-01T10:00:00.001Z"));
  });

  it("keeps the unguarded path when no baseline is supplied", async () => {
    const locked = eventRow();
    const { db } = fakeDb([locked], [eventRow({ title: eventInput.title })]);
    await updateEvent(db, actor, "evt_abc", eventInput);
    expect(calls).toContain("update");
    expect(calls.slice(-3)).toEqual(CACHES);
  });
});

const featuredLocked = (over: Partial<FeaturedEditRow> = {}): FeaturedEditRow =>
  ({
    id: 7,
    title: "Join us",
    body: "Body",
    url: "https://example.test/a",
    imageUrl: null,
    imageAlt: null,
    isPublished: true,
    position: 1,
    startsAt: new Date("2030-01-01T00:00:00.000Z"),
    endsAt: null,
    startsAtText: "2030-01-01 00:00:00.000000",
    endsAtText: null,
    updatedAt: new Date("2030-01-01T10:00:00.000Z"),
    ...over,
  }) as unknown as FeaturedEditRow;

const featuredInput = {
  title: "New title",
  body: "Body",
  url: "https://example.test/a",
  imageUrl: null,
  imageAlt: null,
  isPublished: true,
  position: 1,
  startsAtUtc: null,
  endsAtUtc: null,
} as unknown as FeaturedFormInput;

describe("updateFeatured stale-save guard", () => {
  it("rejects a mismatched baseline after the lock and before any side effect", async () => {
    const { db, tx, sets, inserts } = fakeDb([featuredLocked()]);
    // Same content, microsecond text drift only: the exact UTC text is hashed.
    const stale = await featuredSaveBaseline(
      featuredLocked({ startsAtText: "2030-01-01 00:00:00.000001" }),
    );

    await expect(updateFeatured(db, actor, 7, featuredInput, stale)).rejects.toBeInstanceOf(
      StaleSaveError,
    );

    expect(calls).toEqual(["bound", "select", "for:update"]);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(sets).toEqual([]);
    expect(inserts).toEqual([]);
    for (const name of [...MUTATING, ...CACHES]) expect(calls).not.toContain(name);
  });

  it("reports a missing row as not found", async () => {
    const { db } = fakeDb([]);
    await expect(
      updateFeatured(db, actor, 99, featuredInput, "0".repeat(64)),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toEqual(["bound", "select", "for:update"]);
  });

  it("writes, audits and retires the cache when the baseline matches, advancing a frozen clock", async () => {
    const locked = featuredLocked();
    const updated = featuredLocked({ title: featuredInput.title });
    const { db, sets, inserts } = fakeDb([locked], [updated]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(locked.updatedAt);

    const row = await updateFeatured(
      db,
      actor,
      7,
      featuredInput,
      await featuredSaveBaseline(locked),
    );

    expect(row).toBe(updated);
    expect(calls).toEqual(["bound", "select", "for:update", "update", "insert", "retireHome"]);
    expect(sets[0]?.updatedAt).toEqual(new Date(locked.updatedAt.getTime() + 1));
    expect(inserts).toHaveLength(1);
  });

  it("advances the version past a clock that moved backwards", async () => {
    const locked = featuredLocked();
    const { db, sets } = fakeDb([locked], [featuredLocked({ title: featuredInput.title })]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
    await updateFeatured(db, actor, 7, featuredInput);
    expect(sets[0]?.updatedAt).toEqual(new Date(locked.updatedAt.getTime() + 1));
  });
});

describe("unpublishFeatured version bump", () => {
  it("bumps the version past a frozen clock under the row lock", async () => {
    const previous = new Date("2030-01-01T10:00:00.000Z");
    const { db, sets } = fakeDb([{ title: "Join us", isPublished: true, updatedAt: previous }]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(previous);

    await unpublishFeatured(db, actor, 7);

    expect(calls).toEqual(["bound", "select", "for:update", "update", "audit", "retireHome"]);
    expect(sets[0]).toEqual({ isPublished: false, updatedAt: new Date(previous.getTime() + 1) });
  });

  it("is a no-op without writes or cache retirement when already unpublished", async () => {
    const { db } = fakeDb([{ title: "Join us", isPublished: false, updatedAt: new Date(0) }]);
    await unpublishFeatured(db, actor, 7);
    expect(calls).toEqual(["bound", "select", "for:update"]);
  });
});
