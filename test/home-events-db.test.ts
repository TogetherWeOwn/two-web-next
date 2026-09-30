// Server-side cancellation proof: agent-testdb or the CI service container only.
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/index";
import { listHomeUpcoming } from "../src/events/reads";

const url = process.env.DATABASE_URL;
if (url) {
  const target = new URL(url);
  const agentTest = target.hostname === "agent-testdb" && target.username === "agent_test" && target.pathname === "/two_web_next";
  const ciService = process.env.CI === "true" && target.hostname === "localhost" && target.pathname === "/postgres";
  if (!agentTest && !ciService) throw new Error("Homepage DB tests require agent-testdb or the disposable CI service.");
}

describe.skipIf(!url)("homepage read cancellation (isolated test DB)", () => {
  it.each(["events", "rsvps"] as const)("cancels the read blocked on %s and leaves no lock-waiting backend", async (table) => {
    const setup = postgres(url!, { max: 1 });
    const db = createDb(url!);
    const eventKey = `home-timeout-${crypto.randomUUID()}`;
    try {
      // Own fixture only; no deletion of another test's events. It is always eligible at the fixed clock.
      await setup`insert into events (event_key, title, starts_at, ends_at, status)
        values (${eventKey}, 'Home timeout fixture', '2070-01-01T18:00:00Z', '2070-01-01T20:00:00Z', 'published')`;
      await setup.begin(async (locker) => {
        await locker.unsafe(`lock table ${table} in access exclusive mode`);
        const t0 = Date.now();
        await expect(listHomeUpcoming(db, new Date("2069-01-01T00:00:00Z"))).rejects.toMatchObject({
          // Equal lock/statement budgets: either Postgres timer can win, never a client-side deadline.
          cause: { code: expect.stringMatching(/^(55P03|57014)$/) },
        });
        expect(Date.now() - t0).toBeLessThan(1500);
        const [active] = await locker`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
          and query ilike ${`%${table}%`} and pid <> pg_backend_pid()`;
        expect(active!.n).toBe(0);
      });
      // LOCAL settings must not leak into the pooled connection's next request.
      const [settings] = await db.$client`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`;
      expect(settings).toMatchObject({ lock: "0", statement: "0" });
    } finally {
      await setup`delete from events where event_key = ${eventKey}`;
      await Promise.all([setup.end({ timeout: 1 }), db.$client.end({ timeout: 1 })]);
    }
  });
});
