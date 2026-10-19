// Calendar page-model server-time slice: the list-view reads (upcoming page,
// past drawer, Discord transients) are independent, so they must start
// together like the homepage reads (perf(home) #856). Sequential awaits sum
// every database round trip into /events server time, which the staging
// mobile Lighthouse budget (server-response-time <= 600 ms) measures.
//
// The barrier below holds all three reads pending at once: each read signals
// when it is issued, the test waits for all three signals (no settle-timer
// guess), proves none has resolved while the model is still pending, then
// releases all three and asserts each read's rows land in the model shape.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { events } from "../src/db/admin-schema";
import type { DiscordEventsSource } from "../src/events/discord-transients-types";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";
import type { DiscordTransient } from "../src/islands/contracts-calendar";

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    throw new Error("database unavailable");
  }),
}));

const NOW = new Date("2060-06-01T00:00:00Z");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function signal() {
  let fire!: () => void;
  const promise = new Promise<void>((r) => {
    fire = () => r();
  });
  return { promise, fire };
}

function eventRow(id: number): typeof events.$inferSelect {
  const startsAt = new Date(NOW.getTime() + id * 3600_000);
  return {
    id,
    icsSequence: 1n,
    eventKey: `event-${id}`,
    title: `Game night ${id}`,
    game: null,
    description: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: "Voice lobby",
    capacity: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("calendar page-model concurrent reads", () => {
  it("holds the upcoming, past and Discord reads pending in a sustained barrier", async () => {
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
    const toPositional = (row: typeof events.$inferSelect): unknown[] =>
      columns.map((key) => {
        const value = row[key];
        if (value instanceof Date) return value.toISOString();
        if (typeof value === "bigint") return value.toString();
        return value;
      });
    const upcomingRow = eventRow(1);
    const pastRow: typeof events.$inferSelect = {
      ...eventRow(2),
      startsAt: new Date(NOW.getTime() - 3 * 3600_000),
      endsAt: new Date(NOW.getTime() - 3600_000),
    };
    const transient: DiscordTransient = {
      discordId: "discord-1",
      status: "scheduled",
      title: "Discord game night",
      description: null,
      location: "Voice lobby",
      startsAt: new Date(NOW.getTime() + 30 * 60_000),
      endsAt: null,
    };
    const upcomingRowsGate = deferred<{ rows: unknown[][] }>();
    const pastRowsGate = deferred<{ rows: unknown[][] }>();
    const discordGate = deferred<DiscordTransient[]>();
    const upcomingIssued = signal();
    const pastIssued = signal();
    const discordIssued = signal();
    let upcomingReleased = false;
    let pastReleased = false;
    let discordReleased = false;
    upcomingRowsGate.promise.then(
      () => {
        upcomingReleased = true;
      },
      () => {
        upcomingReleased = true;
      },
    );
    pastRowsGate.promise.then(
      () => {
        pastReleased = true;
      },
      () => {
        pastReleased = true;
      },
    );
    discordGate.promise.then(
      () => {
        discordReleased = true;
      },
      () => {
        discordReleased = true;
      },
    );
    const db = drizzle(async (sql: string) => {
      // PostgreSQL returns count(*) as int8 text; the proxy maps positionally.
      if (sql.startsWith("select count(*)")) return { rows: [["1"]] };
      if (sql.includes('from "rsvps"')) return { rows: [] };
      if (sql.startsWith('select "discord_event_id"')) return { rows: [] };
      // The upcoming page orders oldest-first; the past drawer newest-first.
      // (The select list itself names "description", so match the order key.)
      if (sql.includes('"starts_at" asc')) {
        upcomingIssued.fire();
        return upcomingRowsGate.promise;
      }
      if (sql.includes('"starts_at" desc')) {
        pastIssued.fire();
        return pastRowsGate.promise;
      }
      return { rows: [] };
    }) as unknown as Db;
    const discord: DiscordEventsSource = {
      upcoming: async () => {
        discordIssued.fire();
        return discordGate.promise;
      },
      lastReadFailed: () => false,
    };
    const pending = loadCalendarPageModel({
      db,
      input: resolveCalendarInput({}),
      includeDrafts: false,
      discord,
      now: NOW,
    });
    let modelSettled = false;
    pending.then(
      () => {
        modelSettled = true;
      },
      () => {
        modelSettled = true;
      },
    );
    // Sustained three-way barrier: every read is issued while all three stay
    // pending. Sequential code would hold the later reads behind the first
    // gate, so the barrier below would never complete.
    await Promise.all([upcomingIssued.promise, pastIssued.promise, discordIssued.promise]);
    // Let an early-release mutant settle so the pending checks bite.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(upcomingReleased).toBe(false);
    expect(pastReleased).toBe(false);
    expect(discordReleased).toBe(false);
    expect(modelSettled).toBe(false);
    upcomingRowsGate.resolve({ rows: [toPositional(upcomingRow)] });
    pastRowsGate.resolve({ rows: [toPositional(pastRow)] });
    discordGate.resolve([transient]);
    const model = await pending;
    expect(model.upcoming).toHaveLength(2);
    expect(model.upcoming.some((row) => "eventKey" in row && row.eventKey === "event-1")).toBe(
      true,
    );
    expect(model.upcoming.some((row) => "discordId" in row && row.discordId === "discord-1")).toBe(
      true,
    );
    expect(model.past).toHaveLength(1);
    expect(model.past[0]?.eventKey).toBe("event-2");
    expect(model.totalPages).toBe(1);
    expect(model.discordFailed).toBe(false);
    expect(model.robots).toBeUndefined();
  });
});
