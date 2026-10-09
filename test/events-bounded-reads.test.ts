// Bounded event reads + correct aggregates on the home, JSON collection and
// show read paths (ports legacy EventQueryCountTest.php; recorded as row A7 in
// docs/w15-events-acceptance-ledger.md).
//
// Real Postgres through the disposable W15 fixture (skipped without
// DATABASE_URL, like the other live suites). Statement counts come from a
// Drizzle logger on a second database handle over the same pool, so every
// Drizzle-issued statement is observed — including the timeout-scoping
// `set_config` selects inside transactions — while transaction BEGIN/COMMIT
// framing stays uncounted, matching the legacy query-log semantics. Each
// path is asserted two ways: under the legacy bar (fewer than five
// statements with ten rows present) and flat (the same count with more rows),
// so an N+1 regression — one extra per-row query — fails the suite. The
// aggregates are asserted exactly, with non-going answers present, so a
// wrong aggregate fails too.
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminSchema, schema } from "../src/db/index";
import { getPublicEvent, listHomeUpcoming, listJson } from "../src/events/reads";
import { goingCount } from "../src/events/waitlist";
import { listVisibleFeatured } from "../src/featured";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Static containment pin: the guard this file wires below refuses non-test
// URLs before any driver exists. Always runs, needs no database.
describe("bounded-reads test containment", () => {
  it("refuses a non-test DATABASE_URL before driver construction", () => {
    expect(() => testDatabaseUrl("postgres://agent_test@staging.example.test/some_db", {})).toThrow(
      "refusing before connecting",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("event bounded reads (agent-testdb)", () => {
  // Owned disposable schema: raw seeds and resets below resolve unqualified
  // names inside `w15_<uuid>`, never in the caller's tables. The counted
  // handle shares the fixture pool, so seeds issued through fixture.client
  // never touch the statement counter — only Drizzle reads do.
  let fixture: MemberDataFixture;
  let statements = 0;
  let countedDb: MemberDataFixture["db"];

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    countedDb = drizzle(fixture.client, {
      schema: { ...schema, ...adminSchema },
      logger: {
        logQuery() {
          statements += 1;
        },
      },
    });
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  beforeEach(async () => {
    await fixture.reset();
    statements = 0;
  });

  async function countStatements<T>(fn: () => Promise<T>): Promise<{ result: T; count: number }> {
    statements = 0;
    const result = await fn();
    return { result, count: statements };
  }

  const dayMs = 86_400_000;
  const base = Date.now();

  // Ten published events, soonest first. Every event carries three going
  // answers plus one of each non-going answer, so only an exact going-only
  // aggregate reads back three.
  async function seedUpcoming(n: number, keyPrefix: string): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const key = `${keyPrefix}-${i}`;
      const startsAt = new Date(base + (i + 1) * dayMs).toISOString();
      const endsAt = new Date(base + (i + 1) * dayMs + 2 * 3_600_000).toISOString();
      const [row] = await fixture.client<{ id: number }[]>`
        insert into events (event_key, title, starts_at, ends_at, status)
        values (${key}, ${`Event ${key}`}, ${startsAt}, ${endsAt}, 'published')
        returning id`;
      const eventId = row!.id;
      const answers = ["going", "going", "going", "maybe", "not_going", "waitlisted"];
      for (let j = 0; j < answers.length; j += 1) {
        await fixture.client`
          insert into rsvps (event_id, user_id, status)
          values (${eventId}, ${`${keyPrefix}-user-${i}-${j}`}, ${answers[j]!})`;
      }
    }
  }

  async function seedFeatured(n: number, keyPrefix: string): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await fixture.client`
        insert into featured_contents (title, is_published, position)
        values (${`Featured ${keyPrefix} ${i}`}, true, ${i})`;
    }
  }

  it("serves the home teaser and featured rows in a bounded, flat statement count", async () => {
    await seedUpcoming(10, "home");
    await seedFeatured(10, "home");

    const first = await countStatements(async () => ({
      teaser: await listHomeUpcoming(countedDb),
      featured: await listVisibleFeatured(countedDb),
    }));
    // The teaser caps at three rows; the featured read has no cap.
    expect(first.result.teaser).toHaveLength(3);
    expect(first.result.featured).toHaveLength(10);
    // The teaser aggregates stay exact with non-going answers present.
    for (const row of first.result.teaser) expect(row.goingCount).toBe(3);
    // Each read stays under the legacy bar on its own: teaser
    // (timeout scope + event rows + one going aggregate), featured
    // (timeout scope + rows). The combined set is pinned below as flat.
    const teaserOnly = await countStatements(() => listHomeUpcoming(countedDb));
    const featuredOnly = await countStatements(() => listVisibleFeatured(countedDb));
    expect(teaserOnly.count).toBeLessThan(5);
    expect(featuredOnly.count).toBeLessThan(5);
    expect(first.count).toBe(teaserOnly.count + featuredOnly.count);

    // Doubling both row sets issues no further statements.
    await seedUpcoming(10, "home-more");
    await seedFeatured(10, "home-more");
    const second = await countStatements(async () => ({
      teaser: await listHomeUpcoming(countedDb),
      featured: await listVisibleFeatured(countedDb),
    }));
    expect(second.result.teaser).toHaveLength(3);
    expect(second.result.featured).toHaveLength(20);
    for (const row of second.result.teaser) expect(row.goingCount).toBe(3);
    expect(second.count).toBe(first.count);
  });

  it("serves the JSON collection with one aggregate and a flat statement count", async () => {
    await seedUpcoming(10, "collection");

    const first = await countStatements(() =>
      listJson(countedDb, { limit: 10, offset: 0, includeDrafts: false }),
    );
    expect(first.result.total).toBe(10);
    expect(first.result.rows).toHaveLength(10);
    // Correct on every row, not just cheap: three going each, with maybe,
    // not-going and waitlisted answers present on every event.
    for (const row of first.result.rows) expect(row.goingCount).toBe(3);
    // Total count + page rows + one grouped going aggregate.
    expect(first.count).toBeLessThan(5);

    // Twice the rows, same statements: no per-row query.
    await seedUpcoming(10, "collection-more");
    const second = await countStatements(() =>
      listJson(countedDb, { limit: 20, offset: 0, includeDrafts: false }),
    );
    expect(second.result.total).toBe(20);
    expect(second.result.rows).toHaveLength(20);
    for (const row of second.result.rows) expect(row.goingCount).toBe(3);
    expect(second.count).toBe(first.count);
    expect(second.count).toBeLessThan(5);
  });

  it("counts going on a single event, excluding maybe answers", async () => {
    // The legacy show shape: two going, one maybe, one not-going.
    const startsAt = new Date(base + dayMs).toISOString();
    const endsAt = new Date(base + dayMs + 2 * 3_600_000).toISOString();
    const [row] = await fixture.client<{ id: number; event_key: string }[]>`
      insert into events (event_key, title, starts_at, ends_at, status)
      values ('show-single', 'Single show', ${startsAt}, ${endsAt}, 'published')
      returning id, event_key`;
    for (const [user, status] of [
      ["show-user-0", "going"],
      ["show-user-1", "going"],
      ["show-user-2", "maybe"],
      ["show-user-3", "not_going"],
    ] as const) {
      await fixture.client`
        insert into rsvps (event_id, user_id, status) values (${row!.id}, ${user}, ${status})`;
    }

    const measured = await countStatements(() => getPublicEvent(countedDb, row!.event_key));
    // The single-event read builds no listing aggregate, yet still counts
    // exactly the going answers — the maybe is excluded.
    expect(measured.result?.goingCount).toBe(2);
    // Event row + one going aggregate.
    expect(measured.count).toBeLessThan(5);
  });

  it("detects an N+1 regression: one query per row exceeds the collection bound", async () => {
    await seedUpcoming(10, "n-plus-one");
    const { rows } = await listJson(countedDb, { limit: 10, offset: 0, includeDrafts: false });
    expect(rows).toHaveLength(10);

    // The per-row pattern a regression would reintroduce: one count query
    // per event instead of the single grouped aggregate in withGoing.
    const measured = await countStatements(async () => {
      for (const row of rows) await goingCount(countedDb, row.id);
    });
    expect(measured.count).toBe(10);
    expect(measured.count).not.toBeLessThan(5);
  });
});
