// route-inventory: GET / (home events + featured)
// route-inventory: GET /events.json
// route-inventory: GET /e/:key
// A7 (docs/w15-events-acceptance-ledger.md): portable EventQueryCountTest proof.
// Real SQL against agent-testdb/CI Postgres in an owned disposable schema; the
// postgres-js `debug` hook counts one entry per statement the driver sends the
// server (BEGIN/COMMIT included), so the counter is a true round-trip count.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, featuredContents, rsvps } from "../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../src/db/index";
import { getPublicEvent, listHomeUpcoming, listJson } from "../src/events/reads";
import { listVisibleFeatured } from "../src/featured";
import { testDatabaseUrl } from "./helpers/member-data-db";

// Static containment pin: the guard refuses non-test URLs before any driver
// exists. Always runs, needs no database.
describe("bounded-reads test containment", () => {
  it("refuses a non-test DATABASE_URL before driver construction", () => {
    expect(() => testDatabaseUrl("postgres://agent_test@staging.example.test/some_db", {})).toThrow(
      "refusing before connecting",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("event bounded reads (agent-testdb)", () => {
  // Owned disposable schema like test/helpers/member-data-db.ts, but with the
  // postgres-js `debug` hook wired as the round-trip counter. The shared helper
  // has no debug injection point, so this file builds its own scoped pools;
  // unqualified names still resolve inside the owned schema only.
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: Db;
  let schemaName: string;
  let created = false;
  // One entry per statement sent to the server (debug fires in connection.js
  // per execution, including BEGIN/COMMIT issued via unsafe).
  let roundTrips: string[] = [];

  beforeAll(async () => {
    const url = testDatabaseUrl(process.env.DATABASE_URL!);
    schemaName = `w15_${randomUUID().replaceAll("-", "")}`;
    const base = { max: 1, port: 5432, connect_timeout: 5, password: () => url.password, onnotice: () => {} };
    admin = postgres(url.href, base);
    client = postgres(url.href, {
      ...base,
      connection: { search_path: schemaName },
      debug: (_id: unknown, query: string) => void roundTrips.push(query),
    });
    db = drizzle(client, { schema: { ...schema, ...adminSchema } });
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url).href) });
    for (const migration of migrations) {
      for (const statement of migration.sql) {
        if (statement.trim()) await client.unsafe(statement.replaceAll('"public".', `"${schemaName}".`));
      }
    }
  });

  afterAll(async () => {
    try {
      await client?.end();
      if (created) await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    } finally {
      await admin?.end();
    }
  });

  const NOW = new Date("2069-06-01T12:00:00Z");

  // Each seeded event carries 3 going + 2 maybe + 1 not_going + 1 waitlisted:
  // every going_count assertion below must read exactly 3.
  async function seedEvents(n: number, tag: string): Promise<{ id: number; key: string }[]> {
    const out: { id: number; key: string }[] = [];
    for (let i = 0; i < n; i++) {
      const key = `01BND${tag}${String(i).padStart(2, "0")}00000000000000`.slice(0, 26);
      const [row] = await db
        .insert(events)
        .values({
          eventKey: key,
          title: `Bounded ${tag}-${i}`,
          startsAt: new Date(NOW.getTime() + (out.length + 1) * 3600000),
          endsAt: new Date(NOW.getTime() + (out.length + 1) * 3600000 + 7200000),
          status: "published",
        })
        .returning();
      await db.insert(rsvps).values([
        { eventId: row!.id, userId: `going-a-${tag}-${i}`, status: "going" },
        { eventId: row!.id, userId: `going-b-${tag}-${i}`, status: "going" },
        { eventId: row!.id, userId: `going-c-${tag}-${i}`, status: "going" },
        { eventId: row!.id, userId: `maybe-a-${tag}-${i}`, status: "maybe" },
        { eventId: row!.id, userId: `maybe-b-${tag}-${i}`, status: "maybe" },
        { eventId: row!.id, userId: `notgoing-${tag}-${i}`, status: "not_going" },
        { eventId: row!.id, userId: `wait-${tag}-${i}`, status: "waitlisted" },
      ]);
      out.push({ id: row!.id, key });
    }
    return out;
  }

  async function seedFeatured(n: number, tag: string): Promise<void> {
    for (let i = 0; i < n; i++) {
      await db.insert(featuredContents).values({ title: `Slot ${tag}-${i}`, isPublished: true, position: i });
    }
  }

  it("home teaser: bounded round trips and correct per-row aggregates", async () => {
    await seedEvents(10, "H");
    roundTrips = [];
    const rows = await listHomeUpcoming(db, NOW);
    const firstPass = roundTrips.length;
    // The teaser caps at 3 soonest rows; every one carries its going-only count.
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.goingCount).toBe(3);
    // BEGIN + set_config + events SELECT + one batched going aggregate + COMMIT.
    expect(firstPass).toBeLessThanOrEqual(5);
    // No per-row queries: doubling the seeded rows changes nothing.
    await seedEvents(10, "H2");
    roundTrips = [];
    const again = await listHomeUpcoming(db, NOW);
    expect(again).toHaveLength(3);
    expect(roundTrips.length).toBe(firstPass);
  });

  it("featured rail: bounded round trips, all seeded rows visible", async () => {
    await seedFeatured(10, "F");
    roundTrips = [];
    const rows = await listVisibleFeatured(db, NOW);
    const firstPass = roundTrips.length;
    expect(rows).toHaveLength(10);
    // BEGIN + set_config + one SELECT + COMMIT; no aggregates, no per-row reads.
    expect(firstPass).toBeLessThanOrEqual(4);
    await seedFeatured(10, "F2");
    roundTrips = [];
    expect(await listVisibleFeatured(db, NOW)).toHaveLength(20);
    expect(roundTrips.length).toBe(firstPass);
  });

  it("JSON collection: two round trips at both sizes, going-only counts", async () => {
    // Standalone-safe: top up to 10 collection-visible rows whatever ran before.
    const existing = await db.select().from(events);
    if (existing.length < 10) await seedEvents(10 - existing.length, "C");
    roundTrips = [];
    const rows = await listJson(db, { limit: 10, offset: 0, includeDrafts: false });
    expect(rows).toHaveLength(10);
    // One rows SELECT + one batched going aggregate: no per-row queries.
    expect(roundTrips.length).toBe(2);
    for (const row of rows) expect(row.goingCount).toBe(3);
    // Growing the collection keeps the count identical: growth is bounded.
    await seedEvents(10, "C2");
    roundTrips = [];
    const grown = await listJson(db, { limit: 100, offset: 0, includeDrafts: false });
    expect(grown.length).toBeGreaterThan(10);
    expect(roundTrips.length).toBe(2);
    for (const row of grown) expect(row.goingCount).toBe(3);
  });

  it("single event: two round trips, going count excludes maybe/waitlisted", async () => {
    const [seeded] = await seedEvents(1, "S");
    roundTrips = [];
    const row = await getPublicEvent(db, seeded!.key);
    // One row SELECT + one going-only aggregate.
    expect(roundTrips.length).toBe(2);
    expect(row?.goingCount).toBe(3);
  });
});
