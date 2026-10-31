import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { listEvents } from "../src/admin/store-event-reads";
import { createPastFilterFixture } from "./helpers/admin-past-filter-db";

describe("Past-filter fixture backend selection", () => {
  it.each(["", "not a URL", "postgres://example.com/unapproved"])(
    "refuses a supplied unapproved URL instead of falling back: %j",
    async (raw) => {
      await expect(createPastFilterFixture(raw)).rejects.toThrow(
        "Tests require an approved PostgreSQL test database; refusing before connecting",
      );
    },
  );

  it("executes and settles local transactions only when the URL is absent", async () => {
    const fixture = await createPastFilterFixture(undefined);
    try {
      await expect(
        fixture.db.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
          throw new Error("fixture rollback");
        }),
      ).rejects.toThrow("fixture rollback");
      await expect(listEvents(fixture.db, { status: "past" })).resolves.toEqual([]);
      expect(fixture.statements.some((statement) => statement.includes('from "events"'))).toBe(
        true,
      );
    } finally {
      await fixture.dispose();
    }
  });
});
