// The going aggregate is one statement, not two: `withGoing` used to issue a
// named-count query plus an occupancy-count query per read. On the /events
// miss path that is four aggregate round trips (upcoming + past drawer) over
// a max:1 client, where they serialize. A single conditional-aggregation
// statement returns both counts with identical semantics.
//
// Real Postgres through the disposable fixture (skipped without DATABASE_URL).
// Statement counts come from a Drizzle logger on a second handle over the
// same pool, so seeds never touch the counter.
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminSchema, schema } from "../src/db/index";
import { listUpcoming } from "../src/events/reads";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

describe.skipIf(!process.env.DATABASE_URL)(
  "going aggregate is one statement (agent-testdb)",
  () => {
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

    it("listUpcoming issues count + rows + one going aggregate with exact named/occupancy split", async () => {
      const dayMs = 86_400_000;
      const base = Date.now();
      const startsAt = new Date(base + dayMs).toISOString();
      const endsAt = new Date(base + dayMs + 2 * 3_600_000).toISOString();
      const [row] = await fixture.client<{ id: number }[]>`
      insert into events (event_key, title, starts_at, ends_at, status)
      values ('going-single-0', 'Going Single', ${startsAt}, ${endsAt}, 'published')
      returning id`;
      const eventId = row!.id;
      // One named going row, one empty-name going row, one going row with no
      // user row at all, plus one non-going answer that must not count.
      await fixture.client`
      insert into users (id, username) values ('going-single-named', 'Named'), ('going-single-empty', ''), ('going-single-maybe', 'Maybe')
      on conflict (id) do nothing`;
      await fixture.client`
      insert into rsvps (event_id, user_id, status) values
      (${eventId}, 'going-single-named', 'going'),
      (${eventId}, 'going-single-empty', 'going'),
      (${eventId}, 'going-single-missing', 'going'),
      (${eventId}, 'going-single-maybe', 'maybe')`;

      statements = 0;
      const page = await listUpcoming(countedDb, new Date(base));
      // Count + rows + ONE going aggregate. Two aggregates (named + occupancy
      // as separate statements) fails this pin.
      expect(statements).toBe(3);
      expect(page.rows).toHaveLength(1);
      // Named-only badge excludes both nameless shapes; occupancy holds every seat.
      expect(page.rows[0]!.goingCount).toBe(1);
      expect(page.rows[0]!.goingOccupancy).toBe(3);
    });
  },
);
