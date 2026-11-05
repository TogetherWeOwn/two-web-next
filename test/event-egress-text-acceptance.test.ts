// Acceptance-owned: hermetic collection feed/sitemap stored-text admission.
// SQL receipts use the existing DATABASE_URL gate in review-p1-verify.test.ts:
//   npx vitest run test/event-egress-text-acceptance.test.ts test/review-p1-verify.test.ts --reporter=json
// EGRESS-TEXT-* names remain stable receipt IDs. No SQL/network is needed here.
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import { listFeed, sitemapEvents } from "../src/events/reads";

const NOW = new Date("2026-07-10T12:00:00Z");
const CAP = 1000;
const projection = (sql: string) => sql.slice(0, sql.search(/\bfrom\b/i));

const UNUSED_FEED = [
  "accessibility_notes",
  "join_url",
  "join_instructions",
  "discord_event_id",
  "discord_sync_failure_code",
  "proof_marker",
  "created_by",
  "recurrence_frequency",
  "capacity",
  "sync_revision",
  "synced_revision",
  "discord_sync_failed_at",
  "agent_grant_id",
  "agent_version",
  "rsvp_open",
  "recurrence_count",
  "recurrence_ends_on",
  "parent_event_id",
  "recurrence_index",
  "created_at",
];
const UNUSED_SITEMAP = [
  ...UNUSED_FEED,
  "title",
  "game",
  "description",
  "timezone",
  "location",
  "organizer_name",
];

async function capture(run: (db: Db) => Promise<unknown>) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params: [...params] });
    return { rows: [] };
  }) as unknown as Db;
  await run(db);
  expect(queries, "one bounded SELECT, no SET/count/full-row fallback").toHaveLength(1);
  expect(queries[0]!.sql).toMatch(/^select\b/i);
  return queries[0]!;
}

function assertLimit(query: { sql: string; params: unknown[] }) {
  const match = /\blimit\s+(?:\$(\d+)|(\d+))/i.exec(query.sql);
  expect(match, "SQL keeps the existing 1000-row ceiling").not.toBeNull();
  const value = match?.[2] ? Number(match[2]) : query.params[Number(match?.[1]) - 1];
  expect(value).toBe(CAP);
}

describe("stored-text SQL boundary (hermetic)", () => {
  it("EGRESS-TEXT-01 feed selects only export fields and admits bytes in SQL", async () => {
    const query = await capture((db) => listFeed(db, ["published", "cancelled"], NOW));
    assertLimit(query);
    expect(query.sql).toMatch(/\boctet_length\s*\(/i);
    expect(projection(query.sql)).not.toMatch(/\*/);
    for (const column of UNUSED_FEED)
      expect(projection(query.sql), `${column} is not a collection export input`).not.toContain(
        `"${column}"`,
      );
  });

  it("EGRESS-TEXT-02 sitemap selects no unused stored text and admits its key bytes in SQL", async () => {
    const query = await capture((db) => sitemapEvents(db));
    assertLimit(query);
    expect(query.sql).toMatch(/\boctet_length\s*\(/i);
    expect(projection(query.sql)).not.toMatch(/\*/);
    for (const column of UNUSED_SITEMAP)
      expect(projection(query.sql), `${column} is unused by sitemap`).not.toContain(`"${column}"`);
    // These are guard inputs, not permission to cast a partial row as a stored record.
    for (const column of ["event_key", "starts_at", "ends_at", "updated_at"])
      expect(projection(query.sql)).toContain(`"${column}"`);
  });

  it.each(["feed", "sitemap"] as const)(
    "EGRESS-TEXT-03 %s query/programming failures still reject, never empty success",
    async (surface) => {
      for (const error of [
        new TypeError("fixture programming fault"),
        Object.assign(new Error("fixture query fault"), { code: "42P01" }),
      ]) {
        const db = drizzle(async () => {
          throw error;
        }) as unknown as Db;
        await expect(
          surface === "feed" ? listFeed(db, ["published"], NOW) : sitemapEvents(db),
        ).rejects.toThrow();
      }
    },
  );
});
