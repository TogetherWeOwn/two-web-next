// One aggregate round trip preserves the named badge/all-seat split. An
// INNER JOIN, counting non-going answers, or a second aggregate must fail.
// The same assertions run on a SQL-recording proxy offline and on guarded
// disposable Postgres when DATABASE_URL is set; no suite is skipped.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listUpcoming } from "../src/events/reads";
import { createEventsPerfFixture, type EventsPerfFixture } from "./helpers/events-perf-fixture";

describe("going aggregate is one statement", () => {
  let fixture: EventsPerfFixture;

  beforeAll(async () => {
    fixture = await createEventsPerfFixture();
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    await fixture.reset();
  });

  it("listUpcoming issues count + rows + one going aggregate with exact named/occupancy split", async () => {
    const base = Date.now();
    const row = await fixture.seedEvent({ eventKey: "going-single-0", title: "Going Single" });
    // One named answer, both nameless shapes, and a non-going answer. The
    // missing user must hold a seat without appearing in the named badge.
    await fixture.seedUser("going-single-named", "Named");
    await fixture.seedUser("going-single-empty", "");
    await fixture.seedUser("going-single-maybe", "Maybe");
    await fixture.seedAnswer(row.id, "going-single-named", "going");
    await fixture.seedAnswer(row.id, "going-single-empty", "going");
    await fixture.seedAnswer(row.id, "going-single-missing", "going");
    await fixture.seedAnswer(row.id, "going-single-maybe", "maybe");

    fixture.statements.length = 0;
    const page = await listUpcoming(fixture.db, new Date(base));
    expect(fixture.statements).toHaveLength(3);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.goingCount).toBe(1);
    expect(page.rows[0]!.goingOccupancy).toBe(3);
    const aggregate = fixture.statements[2]!;
    expect(aggregate.sql).toContain('left join "users"');
    expect(aggregate.sql).not.toContain('inner join "users"');
    expect(aggregate.sql).toContain('group by "rsvps"."event_id"');
    expect(aggregate.sql).toContain("count(case when");
    expect(aggregate.sql).toMatch(/count\(\*\)/);
    expect(aggregate.sql).toContain('"users"."username" <>');
    expect(aggregate.params).toEqual([row.id, "going"]);
    expect(fixture.statements.every(({ sql }) => sql.startsWith("select "))).toBe(true);
  });
});
