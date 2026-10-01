// Server-side cancellation proof: agent-testdb or the CI service container only.
import { describe, expect, it } from "vitest";
import { listHomeUpcoming } from "../src/events/reads";
import { createMemberDataFixture, testDatabaseUrl } from "./helpers/member-data-db";

const raw = process.env.DATABASE_URL;
const url = raw ? testDatabaseUrl(raw).href : undefined;

describe.skipIf(!url)("homepage read cancellation (isolated test DB)", () => {
  it.each(["events", "rsvps"] as const)("cancels the read blocked on %s and leaves no lock-waiting backend", async (table) => {
    // Trace setup separately from the protected read; never log connection or row data.
    const started = Date.now();
    const trace = (phase: string) => console.info("Home cancellation phase", { table, phase, elapsedMs: Date.now() - started });
    trace("fixture:start");
    // The shared fixture validates before connecting and pins the password/port.
    // Two connections let the lock holder and read race inside our own schema.
    const fixture = await createMemberDataFixture(url!, { max: 2 });
    trace("fixture:ready");
    const { client, db, schemaName } = fixture;
    const eventKey = `home-timeout-${crypto.randomUUID()}`;
    try {
      await client`insert into events (event_key, title, starts_at, ends_at, status)
        values (${eventKey}, 'Home timeout fixture', '2070-01-01T18:00:00Z', '2070-01-01T20:00:00Z', 'published')`;
      trace("event:seeded");
      await client.begin(async (locker) => {
        trace("locker:started");
        await locker.unsafe(`lock table ${table} in access exclusive mode`);
        trace("locker:held");
        const t0 = Date.now();
        await expect(listHomeUpcoming(db, new Date("2069-01-01T00:00:00Z"))).rejects.toMatchObject({
          // Equal lock/statement budgets: either Postgres timer can win, never a client-side deadline.
          cause: { code: expect.stringMatching(/^(55P03|57014)$/) },
        });
        trace("reader:cancelled");
        expect(Date.now() - t0).toBeLessThan(1500);
        const [active] = await locker`select count(*)::int as n from pg_stat_activity a
          join pg_locks l on l.pid = a.pid
          where a.datname = current_database() and a.state = 'active' and a.wait_event_type = 'Lock'
          and l.relation = to_regclass(${`${schemaName}.${table}`}) and not l.granted and a.pid <> pg_backend_pid()`;
        expect(active!.n).toBe(0);
        trace("reader:no-waiter");
      });
      trace("locker:released");
      // LOCAL settings must not leak into the pooled connection's next request.
      const [settings] = await client`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`;
      expect(settings).toMatchObject({ lock: "0", statement: "0" });
      trace("settings:restored");
    } finally {
      trace("fixture:disposing");
      await fixture.dispose();
      trace("fixture:disposed");
    }
  });
});
