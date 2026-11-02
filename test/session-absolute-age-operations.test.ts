import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgPruneStores } from "../src/jobs/postgres";
import { countActiveMemberSessions, revokeMemberSessions } from "../src/session-revocation";
import {
  createPostgresSessionStore,
  SESSION_ABSOLUTE_MAX_AGE_SECONDS,
  SESSION_ROLE_RECHECK_SECONDS,
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

    // Mid-session role recheck (SESSION_ROLE_RECHECK_SECONDS): the DB clock
    // judges its own stamps, a null stamp dates the bits from lineage start,
    // and an applied recheck rewrites the bits and the stamp together.
    describe("mid-session role recheck", () => {
      const CADENCE = SESSION_ROLE_RECHECK_SECONDS * SECOND;
      const store = () => createPostgresSessionStore(fixture.client as unknown as Sql);

      async function seedRecheck(
        tokenHash: string,
        opts: {
          createdOffset: number;
          checkedOffset?: number | null;
          member?: boolean;
          moderator?: boolean;
          expiresOffset?: number;
        },
      ) {
        await fixture.client`insert into web_sessions
        (token_hash, user_id, username, member, moderator, created_at, expires_at, roles_checked_at)
        values (${tokenHash}, ${MEMBER}, 'fixture', ${opts.member ?? true},
          ${opts.moderator ?? true}, ${at(opts.createdOffset)},
          ${at(opts.expiresOffset ?? 3600 * SECOND)},
          ${opts.checkedOffset == null ? null : at(opts.checkedOffset)})`;
      }

      it("marks due only live privileged rows past the cadence, dating null stamps from lineage start", async () => {
        await seedRecheck("fresh-login", { createdOffset: -60 * SECOND });
        await seedRecheck("legacy-stale", { createdOffset: -3600 * SECOND });
        await seedRecheck("stamped-fresh", {
          createdOffset: -3600 * SECOND,
          checkedOffset: -60 * SECOND,
        });
        await seedRecheck("stamped-stale", {
          createdOffset: -3600 * SECOND,
          checkedOffset: -CADENCE - 60 * SECOND,
        });
        await seedRecheck("unprivileged-stale", {
          createdOffset: -3600 * SECOND,
          member: false,
          moderator: false,
        });
        await seedRecheck("expired-stale", {
          createdOffset: -3600 * SECOND,
          expiresOffset: -60 * SECOND,
        });

        const s = store();
        expect(await s.roleRecheckDue!("fresh-login")).toBe(false);
        expect(await s.roleRecheckDue!("legacy-stale")).toBe(true);
        expect(await s.roleRecheckDue!("stamped-fresh")).toBe(false);
        expect(await s.roleRecheckDue!("stamped-stale")).toBe(true);
        expect(await s.roleRecheckDue!("unprivileged-stale")).toBe(false);
        expect(await s.roleRecheckDue!("expired-stale")).toBe(false);
        expect(await s.roleRecheckDue!("missing")).toBe(false);
      });

      it("apply with bits rewrites them and restamps; apply with null only restamps", async () => {
        await seedRecheck("demoted", { createdOffset: -3600 * SECOND });
        await seedRecheck("outage", { createdOffset: -3600 * SECOND });
        const s = store();

        expect(await s.applyRoleRecheck!("demoted", { member: true, moderator: false })).toBe(true);
        expect(await s.get("demoted")).toMatchObject({ member: true, moderator: false });
        expect(await s.roleRecheckDue!("demoted")).toBe(false);

        expect(await s.applyRoleRecheck!("outage", null)).toBe(true);
        expect(await s.get("outage")).toMatchObject({ member: true, moderator: true });
        expect(await s.roleRecheckDue!("outage")).toBe(false);

        expect(await s.applyRoleRecheck!("missing", { member: false, moderator: false })).toBe(
          false,
        );
        expect(await s.applyRoleRecheck!("missing", null)).toBe(false);
      });

      it("a second apply after a landed recheck is discarded", async () => {
        await seedRecheck("raced", { createdOffset: -3600 * SECOND });
        const s = store();
        expect(await s.applyRoleRecheck!("raced", { member: true, moderator: false })).toBe(true);
        // Fresh stamp: an older-read privileged verdict (or a late restamp)
        // must not overwrite the landed demotion.
        expect(await s.applyRoleRecheck!("raced", { member: true, moderator: true })).toBe(false);
        expect(await s.applyRoleRecheck!("raced", null)).toBe(false);
        expect(await s.get("raced")).toMatchObject({ member: true, moderator: false });
      });

      it("rotation carries the recheck stamp to the successor and apply rewrites grace bits", async () => {
        const s = store();
        const row = {
          userId: MEMBER,
          username: "fixture",
          avatar: null,
          member: true,
          moderator: true,
        };
        await s.create({ ...row, tokenHash: "rotate-old", expiresAt: at(3600 * SECOND) });
        await fixture.client`update web_sessions
          set roles_checked_at = ${at(-3600 * SECOND)} where token_hash = 'rotate-old'`;
        expect(await s.roleRecheckDue!("rotate-old")).toBe(true);

        expect(
          await s.rotate("rotate-old", {
            ...row,
            tokenHash: "rotate-new",
            expiresAt: at(3600 * SECOND),
          }),
        ).toBe(true);
        // Stamp carried, not freshened: the successor is immediately due.
        expect(await s.roleRecheckDue!("rotate-new")).toBe(true);

        expect(await s.applyRoleRecheck!("rotate-new", { member: false, moderator: false })).toBe(
          true,
        );
        expect(await s.get("rotate-new")).toMatchObject({ member: false, moderator: false });
        // The predecessor grace authorizes with the same re-derived bits.
        expect(await s.get("rotate-old")).toMatchObject({ member: false, moderator: false });
      });

      it("rotation with bits a recheck already changed keeps the demotion and is immediately due", async () => {
        // The caller read the privileged row, a concurrent recheck demoted
        // it (fresh stamp), then the caller rotates with its stale snapshot.
        // Rotation never grants privilege: the successor carries the
        // least-privileged combination, so the cleared bit stays cleared,
        // and its stamp is null, so the next authorizing read re-derives
        // instead of trusting the bits for a fresh cadence.
        const s = store();
        const row = {
          userId: MEMBER,
          username: "fixture",
          avatar: null,
          member: true,
          moderator: true,
        };
        await seedRecheck("race-old", { createdOffset: -3600 * SECOND });
        expect(await s.applyRoleRecheck!("race-old", { member: true, moderator: false })).toBe(
          true,
        );
        expect(await s.roleRecheckDue!("race-old")).toBe(false);

        expect(
          await s.rotate("race-old", {
            ...row,
            tokenHash: "race-new",
            expiresAt: at(3600 * SECOND),
          }),
        ).toBe(true);
        expect(await s.get("race-new")).toMatchObject({ member: true, moderator: false });
        expect(await s.roleRecheckDue!("race-new")).toBe(true);
      });

      it("rotation carrying a demotion demotes the predecessor grace too", async () => {
        // The caller's replacement carries a demotion the stored row does
        // not have yet. The grace row takes the same least-privileged
        // combination as the successor, so the old bearer cannot outrank
        // its successor during the 10s overlap.
        const s = store();
        await seedRecheck("grace-old", { createdOffset: -3600 * SECOND });
        expect(
          await s.rotate("grace-old", {
            userId: MEMBER,
            username: "fixture",
            avatar: null,
            member: false,
            moderator: false,
            tokenHash: "grace-new",
            expiresAt: at(3600 * SECOND),
          }),
        ).toBe(true);
        expect(await s.get("grace-new")).toMatchObject({ member: false, moderator: false });
        expect(await s.get("grace-old")).toMatchObject({ member: false, moderator: false });
      });
    });
  },
);
