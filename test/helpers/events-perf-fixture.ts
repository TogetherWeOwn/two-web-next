// Run every case offline; DATABASE_URL opts the same assertions into guarded
// disposable Postgres. A configured URL must never fall back after a failure.
import { getTableColumns } from "drizzle-orm";
import { drizzle as proxyDrizzle } from "drizzle-orm/pg-proxy";
import { drizzle } from "drizzle-orm/postgres-js";
import { events, rsvps } from "../../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../../src/db/index";
import { users } from "../../src/db/schema";
import { createMemberDataFixture } from "./member-data-db";

type Event = typeof events.$inferSelect;
export type Statement = { sql: string; params: unknown[] };

export async function createEventsPerfFixture() {
  const live = process.env.DATABASE_URL
    ? await createMemberDataFixture(process.env.DATABASE_URL)
    : null;
  const statements: Statement[] = [];
  const records: Event[] = [];
  const names = new Map<string, string>();
  const answers: { eventId: number; userId: string; status: string }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof Event)[];
  const db = live
    ? drizzle(live.client, {
        schema: { ...schema, ...adminSchema },
        logger: { logQuery: (sql, params) => statements.push({ sql, params }) },
      })
    : (proxyDrizzle(async (sql, params) => {
        statements.push({ sql, params });
        if (!sql.startsWith("select ")) throw new Error(`Unexpected fixture write: ${sql}`);
        if (sql.includes('from "rsvps"')) {
          const selected = answers.filter(
            (a) => params.includes(a.eventId) && a.status === "going",
          );
          const ids = [...new Set(selected.map((a) => a.eventId))];
          return {
            rows: ids.map((id) => {
              const occupied = selected.filter((a) => a.eventId === id);
              const named = occupied.filter((a) => (names.get(a.userId) ?? "") !== "");
              return sql.includes('left join "users"') && sql.includes("group by")
                ? [id, named.length, occupied.length]
                : [id, sql.includes('inner join "users"') ? named.length : occupied.length];
            }),
          };
        }
        if (!sql.includes('from "events"')) throw new Error(`Unexpected fixture read: ${sql}`);
        let selected = records.filter((r) => r.status === "published");
        const boundary = sql.match(/"ends_at"\s*(>=|<)\s*\$(\d+)/);
        if (boundary) {
          const cutoff = new Date(String(params[Number(boundary[2]) - 1])).getTime();
          selected = selected.filter((r) =>
            boundary[1] === ">=" ? r.endsAt.getTime() >= cutoff : r.endsAt.getTime() < cutoff,
          );
        }
        if (/^select distinct\b/.test(sql)) {
          const games = [...new Set(selected.map((r) => r.game).filter((g) => g !== null))];
          return { rows: games.sort().map((game) => [game]) };
        }
        if (/^select count\(\*\)/.test(sql)) return { rows: [[selected.length]] };
        selected.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id);
        const limit = sql.match(/\blimit\s+\$(\d+)/);
        if (limit) selected = selected.slice(0, Number(params[Number(limit[1]) - 1]));
        return {
          rows: selected.map((row) =>
            columns.map((key) => {
              const value = row[key];
              return value instanceof Date ? value.toISOString() : value;
            }),
          ),
        };
      }) as unknown as Db);

  return {
    db,
    statements,
    async seedEvent(overrides: Partial<Event> = {}): Promise<Event> {
      const now = new Date();
      const row: Event = {
        id: records.length + 1,
        icsSequence: 1n,
        eventKey: `perf-event-${records.length + 1}`,
        title: "Cached game night",
        game: "Chess",
        description: null,
        startsAt: new Date(now.getTime() + 86_400_000),
        endsAt: new Date(now.getTime() + 90_000_000),
        timezone: "UTC",
        location: null,
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
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
      if (live) await live.db.insert(events).values(row);
      records.push(row);
      return row;
    },
    async seedUser(id: string, username: string) {
      if (live) await live.db.insert(users).values({ id, username });
      names.set(id, username);
    },
    async seedAnswer(eventId: number, userId: string, status: string) {
      if (live) await live.db.insert(rsvps).values({ eventId, userId, status });
      answers.push({ eventId, userId, status });
    },
    async reset() {
      await live?.reset();
      records.length = 0;
      names.clear();
      answers.length = 0;
      statements.length = 0;
    },
    async dispose() {
      await live?.dispose();
    },
  };
}
export type EventsPerfFixture = Awaited<ReturnType<typeof createEventsPerfFixture>>;
