import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgPruneStores } from "../src/jobs/postgres";
import { countActiveMemberSessions, revokeMemberSessions } from "../src/session-revocation";
import {
  createPostgresSessionStore,
  SESSION_ABSOLUTE_MAX_AGE_SECONDS,
  type Sql,
} from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const SECOND = 1000;
const CAP = SESSION_ABSOLUTE_MAX_AGE_SECONDS * SECOND;
const MEMBER = "100000000000000201";
const OTHER_MEMBER = "100000000000000202";

describe.skipIf(!process.env.DATABASE_URL)(
  "absolute session age in operator paths (test Postgres)",
  () => {
    let fixture: JobsFixture;
    let base: number;
    const at = (offset: number) => new Date(base + offset);
    const sql = () => fixture.client as unknown as Parameters<typeof revokeMemberSessions>[0];

    async function seed(tokenHash: string, createdOffset: number, userId = MEMBER) {
      await fixture.client`insert into web_sessions
      (token_hash, user_id, username, member, moderator, created_at, expires_at)
      values (${tokenHash}, ${userId}, 'fixture', true, true,
        ${at(createdOffset)}, ${at(3600 * SECOND)})`;
    }

    async function survivors() {
      const rows = await fixture.client<{ token_hash: string }[]>`select token_hash
      from web_sessions order by token_hash`;
      return rows.map((row) => row.token_hash);
    }

    beforeAll(async () => {
      fixture = await createJobsFixture(process.env.DATABASE_URL!);
    });

    beforeEach(async () => {
      await fixture.client`delete from web_sessions`;
      const [row] = await fixture.client<{ now: Date }[]>`select clock_timestamp() as now`;
      base = row!.now.getTime();
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    // Seed relative to the DB clock, not the worker's clock. Sliding expiry is
    // future for every row, so only the absolute-age clause can delete them.
    it.each([
      { clock: "ahead", callerOffset: 300 * SECOND, skewAgeOffset: 120 * SECOND },
      { clock: "behind", callerOffset: -300 * SECOND, skewAgeOffset: -120 * SECOND },
    ])(
      "scheduled prune with a caller clock $clock keeps one-clock-only aged rows",
      async ({ callerOffset, skewAgeOffset }) => {
        await seed("both-aged", -CAP - 600 * SECOND);
        await seed("skew-aged", -CAP + skewAgeOffset);
        await seed("live", -3600 * SECOND);

        const stores = pgPruneStores(fixture.client);
        expect(await stores.sessions.sweepExpired(at(callerOffset))).toBe(1);
        expect(await survivors()).toEqual(["live", "skew-aged"]);
        expect(await stores.sessions.sweepExpired(at(callerOffset))).toBe(0);
        expect(await survivors()).toEqual(["live", "skew-aged"]);
      },
    );

    it("count and dry-run agree with the session store for past-cap and live rows", async () => {
      await seed("aged", -CAP - 120 * SECOND);
      await seed("cap-exact", -CAP);
      const store = createPostgresSessionStore(fixture.client as unknown as Sql);
      expect(await store.get("aged")).toBeNull();
      expect(await store.get("cap-exact")).toBeNull();
      expect(await countActiveMemberSessions(sql(), MEMBER)).toEqual({ web_sessions: 0 });
      expect(await revokeMemberSessions(sql(), MEMBER, { dryRun: true })).toEqual({
        web_sessions: 0,
        passes: 0,
        stampsPerPass: [],
      });

      await seed("live", -3600 * SECOND);
      expect(await store.get("live")).not.toBeNull();
      expect(await countActiveMemberSessions(sql(), MEMBER)).toEqual({ web_sessions: 1 });
      expect(await revokeMemberSessions(sql(), MEMBER, { dryRun: true })).toEqual({
        web_sessions: 1,
        passes: 0,
        stampsPerPass: [],
      });
      const [row] = await fixture.client<{ n: number }[]>`select count(*)::int as n
      from web_sessions where revoked_at is not null`;
      expect(row!.n).toBe(0);
    });

    it("apply stamps and reports only usable target sessions, leaving aged rows untouched", async () => {
      await seed("aged", -CAP - 120 * SECOND);
      await seed("cap-exact", -CAP);
      await seed("live", -3600 * SECOND);
      await seed("other-member", -3600 * SECOND, OTHER_MEMBER);
      await seed("expired", -3600 * SECOND);
      await fixture.client`update web_sessions set expires_at = ${at(-120 * SECOND)}
      where token_hash = 'expired'`;
      await seed("revoked", -3600 * SECOND);
      await fixture.client`update web_sessions set revoked_at = ${at(-60 * SECOND)}
      where token_hash = 'revoked'`;

      expect(await revokeMemberSessions(sql(), MEMBER, { dryRun: false })).toEqual({
        web_sessions: 1,
        passes: 1,
        stampsPerPass: [1],
      });
      const rows = await fixture.client<{ token_hash: string; revoked: boolean }[]>`select
      token_hash, revoked_at is not null as revoked from web_sessions order by token_hash`;
      expect(rows).toEqual([
        { token_hash: "aged", revoked: false },
        { token_hash: "cap-exact", revoked: false },
        { token_hash: "expired", revoked: false },
        { token_hash: "live", revoked: true },
        { token_hash: "other-member", revoked: false },
        { token_hash: "revoked", revoked: true },
      ]);
      expect(await countActiveMemberSessions(sql(), MEMBER)).toEqual({ web_sessions: 0 });
      expect(await revokeMemberSessions(sql(), MEMBER, { dryRun: false })).toEqual({
        web_sessions: 0,
        passes: 1,
        stampsPerPass: [0],
      });
    });
  },
);
