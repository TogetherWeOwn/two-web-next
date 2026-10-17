// Calendar page-model server-time slice: the list-view reads (upcoming page,
// past drawer, Discord transients) are independent, so they must start
// together like the homepage reads (perf(home) #856). Sequential awaits sum
// every database round trip into /events server time, which the staging
// mobile Lighthouse budget (server-response-time <= 600 ms) measures.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { events } from "../src/db/admin-schema";
import type { DiscordEventsSource } from "../src/events/discord-transients-types";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";

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
  it("starts the past and Discord reads before a slow upcoming read resolves", async () => {
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
    const row = eventRow(1);
    const positional = columns.map((key) => {
      const value = row[key];
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "bigint") return value.toString();
      return value;
    });
    const upcomingRowsGate = deferred<{ rows: unknown[][] }>();
    let pastIssued = false;
    let discordCalled = false;
    const db = drizzle(async (sql: string) => {
      // PostgreSQL returns count(*) as int8 text; the proxy maps positionally.
      if (sql.startsWith("select count(*)")) return { rows: [["1"]] };
      if (sql.includes('from "rsvps"')) return { rows: [] };
      if (sql.startsWith('select "discord_event_id"')) return { rows: [] };
      // The upcoming page orders oldest-first; the past drawer newest-first.
      // (The select list itself names "description", so match the order key.)
      if (sql.includes('"starts_at" asc')) return upcomingRowsGate.promise;
      if (sql.includes('"starts_at" desc')) {
        pastIssued = true;
        return { rows: [] };
      }
      return { rows: [] };
    }) as unknown as Db;
    const discord: DiscordEventsSource = {
      upcoming: async () => {
        discordCalled = true;
        return [];
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
    // Every independent read starts synchronously: the past select is issued
    // and the Discord source is called while the upcoming rows are pending.
    // Sequential code would hold both behind the gated upcoming read.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pastIssued).toBe(true);
    expect(discordCalled).toBe(true);
    upcomingRowsGate.resolve({ rows: [positional] });
    const model = await pending;
    expect(model.upcoming).toHaveLength(1);
    expect(model.past).toEqual([]);
    expect(model.totalPages).toBe(1);
    expect(model.discordFailed).toBe(false);
    expect(model.robots).toBeUndefined();
  });
});
