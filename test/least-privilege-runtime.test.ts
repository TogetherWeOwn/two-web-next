// Runtime runs read/write-only (TOG-19721). Every statement below is real SQL
// against a disposable w15_* schema on agent-testdb or the CI Postgres
// service, issued by a throwaway non-owner, non-superuser role holding schema
// USAGE, table DML and sequence USAGE — deliberately no CREATE. The schema
// carries the full canonical chain (drizzle/1022 included) with no runtime
// helper call: this proves the request path — session store, journey
// admission, join throttle/attempts, roster upsert — works on a
// migrate-workflow database under a least-privilege role.
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertRosterUser } from "../src/db/roster";
import { checkJoinThrottle, recordAttempt } from "../src/join/service";
import { createPostgresOAuthJourneyStore, type OAuthJourneyStore } from "../src/oauth-journeys";
import { createPostgresSessionStore, type SessionStore, type Sql } from "../src/sessions";
import type { JobsFixture } from "./helpers/jobs-db";
import { createJobsFixture } from "./helpers/jobs-db";
import { testDatabaseUrl } from "./helpers/member-data-db";

type PgSql = postgres.Sql;
const hex = (n: number) =>
  [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

describe.skipIf(!process.env.DATABASE_URL)(
  "runtime request path works under a least-privilege app role",
  () => {
    const role = `w15_app_${randomUUID().replaceAll("-", "")}`;
    let fixture: JobsFixture | undefined;
    let admin: PgSql | undefined;
    let app: PgSql | undefined;
    let appSql: Sql;
    let owner: PgSql;
    let roleCreated = false;

    beforeAll(async () => {
      const url = testDatabaseUrl(process.env.DATABASE_URL!); // Refuse before any driver construction.
      const options = {
        port: 5432,
        connect_timeout: 5,
        password: () => url.password,
        onnotice: () => {},
      };
      admin = postgres(url.href, { ...options, max: 1 });
      // Canonical migrations only (drizzle/1022 owns web_sessions and
      // web_oauth_journeys now): no migrate()/migrateJoin()/migrateRoster()
      // call here — the tables must already exist, as on a workflow-migrated
      // database.
      fixture = await createJobsFixture(url.href, { max: 4 });
      owner = fixture.client;
      const schema = `"${fixture.schemaName}"`;
      await admin.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOINHERIT`);
      roleCreated = true;
      await admin.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO "${role}"`);
      await admin.unsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO "${role}"`,
      );
      await admin.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO "${role}"`);
      app = postgres(url.href, {
        ...options,
        max: 4,
        connection: { role, search_path: fixture.schemaName },
      });
      appSql = app as unknown as Sql;
    });

    afterAll(async () => {
      try {
        await app?.end();
        await fixture?.dispose(); // Drops the schema and every grant on it.
        if (roleCreated) await admin?.unsafe(`DROP ROLE "${role}"`);
      } finally {
        await admin?.end();
      }
    });

    it("the role cannot create schema objects", async () => {
      await expect(
        app!.unsafe(`CREATE TABLE w15_privilege_probe (id integer PRIMARY KEY)`),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("session lifecycle needs no DDL", async () => {
      const store: SessionStore = createPostgresSessionStore(appSql);
      const first = hex(32);
      const row = {
        userId: "7",
        username: "rick",
        avatar: null,
        member: true,
        moderator: false,
      };
      const expiresAt = new Date(Date.now() + 3_600_000);
      await store.create({ tokenHash: first, ...row, expiresAt });
      expect(await store.get(first)).toMatchObject({ userId: "7", username: "rick" });
      const probe = await store.statusHash(first);
      expect(probe).toBe(first);
      expect(await store.isActive(first!)).toBe(true);

      const second = hex(32);
      expect(await store.rotate(first, { tokenHash: second, ...row, expiresAt })).toBe(true);
      expect(await store.get(first)).toBeNull();
      expect(await store.get(second)).toMatchObject({ userId: "7" });

      await store.revokeUserSessions("7", second);
      expect(await store.get(second)).toMatchObject({ userId: "7" });
      await store.create({ tokenHash: first, ...row, expiresAt });
      await store.revokeUserSessions("7", second);
      expect(await store.get(first)).toBeNull();

      await store.revoke(second);
      expect(await store.get(second)).toBeNull();

      const expired = hex(32);
      await store.create({ tokenHash: expired, ...row, expiresAt: new Date(Date.now() - 1_000) });
      expect(await store.sweepExpired(new Date())).toBe(1);
      expect(await store.sweepExpired(new Date())).toBe(0);
    });

    it("journey admission needs no DDL", async () => {
      const journeys: OAuthJourneyStore = createPostgresOAuthJourneyStore(appSql);
      const state = hex(32);
      expect(await journeys.issue(state, "auth")).toBe(true);
      expect(await journeys.issue(state, "auth")).toBe(false);
      expect(await journeys.consume(state, "auth")).toBe(true);
      expect(await journeys.consume(state, "auth")).toBe(false);
      expect(await journeys.consume(state, "join")).toBe(false);
      expect(await journeys.sweepExpired()).toBe(0);
    });

    it("throttle, attempts and roster writes need no DDL", async () => {
      const bucket = `w15-probe-${randomUUID()}`;
      expect(await checkJoinThrottle(appSql, bucket, 2)).toEqual({ limited: false });
      expect(await checkJoinThrottle(appSql, bucket, 2)).toEqual({ limited: false });
      const verdict = await checkJoinThrottle(appSql, bucket, 2);
      expect(verdict.limited).toBe(true);

      await recordAttempt(appSql, {
        outcome: "added",
        source: "web-homepage",
        requestId: randomUUID(),
        discordId: "7",
      });
      const attempts = await owner<{ n: number }[]>`
        SELECT count(*)::int AS n FROM join_attempts WHERE discord_id = '7'`;
      expect(attempts[0]!.n).toBe(1);

      await upsertRosterUser(appSql, { id: "7", username: "rick", avatar: null, member: true });
      await upsertRosterUser(appSql, { id: "7", username: "Rick", avatar: "a", member: true });
      const roster = await owner<Record<string, unknown>[]>`SELECT * FROM users WHERE id = '7'`;
      expect(roster).toHaveLength(1);
      expect(roster[0]).toMatchObject({ username: "Rick", member: true });
    });
  },
);
