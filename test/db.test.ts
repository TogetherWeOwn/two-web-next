import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../src/db/index";

// Live round-trip against agent-testdb. Skipped when DATABASE_URL is unset
// (CI has no test-DB access), so the cold CI run stays green.
describe.skipIf(!process.env.DATABASE_URL)("users table", () => {
  it("inserts, reads, updates and deletes a row", async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const id = `test-${Date.now()}`;

    await db.insert(schema.users).values({ id, username: "rick", member: false });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    expect(row?.username).toBe("rick");
    expect(row?.member).toBe(false);
    expect(row?.createdAt).toBeInstanceOf(Date);

    await db.update(schema.users).set({ member: true }).where(eq(schema.users.id, id));
    const [updated] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    expect(updated?.member).toBe(true);

    await db.delete(schema.users).where(eq(schema.users.id, id));
    const after = await db.select().from(schema.users).where(eq(schema.users.id, id));
    expect(after).toHaveLength(0);
  });
});
