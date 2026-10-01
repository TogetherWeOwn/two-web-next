// W15 acceptance port: the hot-path index half of legacy
// tests/Feature/Events/HotPathIndexTest (TOG-9278). The legacy test also
// audited EXPLAIN query volumes; that half is deferred to the W16 pre-flip
// review (see docs/w15-events-acceptance-ledger.md). Here we pin that the
// indexes backing the merged events/RSVP read paths still exist after any
// migration change — dropping one regresses every feed/roster query silently.
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/index";

describe.skipIf(!process.env.DATABASE_URL)("hot-path indexes (agent-testdb)", () => {
  const db = createDb(process.env.DATABASE_URL!);

  const indexes = async (table: string) =>
    (await db.execute(
      sql`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = ${table}`,
    )) as unknown as { indexname: string; indexdef: string }[];

  it("keeps the feed and archive read-path indexes on events", async () => {
    const rows = await indexes("events");
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    // Feeds/archive scan by status then start order (listFeed, listUpcoming, listPast).
    expect(byName.get("events_status_starts_at_idx")).toContain("(status, starts_at)");
    // Series materialisation resolves children by parent.
    expect(byName.get("events_parent_event_id_idx")).toContain("parent_event_id");
  });

  it("keeps the RSVP roster and idempotency indexes on rsvps", async () => {
    const rows = await indexes("rsvps");
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    // Member roster lookups ("which events am I going to?").
    expect(byName.get("rsvps_user_id_idx")).toContain("(user_id)");
    // One RSVP per member per event: the unique constraint backs the
    // FOR UPDATE upsert race handling in test/rsvp.test.ts.
    expect(byName.get("rsvps_event_user_unique")).toMatch(/UNIQUE.*\(event_id, user_id\)/);
  });
});
