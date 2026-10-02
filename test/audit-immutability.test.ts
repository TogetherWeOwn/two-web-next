// Audit evidence is append-only (TOG-10289, drizzle/1018_audit-immutability.sql).
// Every statement below is real SQL against a disposable w15_* schema on
// agent-testdb or the CI Postgres service, issued by a throwaway non-owner,
// non-superuser role holding plain DML (UPDATE and DELETE included, so a
// refusal comes from the guard, not a missing grant) and no TRUNCATE. The
// role starts each connection via the `role` startup parameter: no new
// credential, and privileges and ownership are checked as that role.
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores, pgSingleFlight } from "../src/jobs/postgres";
import { AUDIT_TABLES, clearAuditRows, type AuditTable } from "./helpers/audit-rows";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { testDatabaseUrl } from "./helpers/member-data-db";

const DAY = 86_400_000;
const RETENTION = 90 * DAY;

type Sql = postgres.Sql;
const insert: Record<AuditTable, (sql: Sql, at: Date) => Promise<number>> = {
  agent_event_audits: async (sql, at) =>
    Number(
      (
        await sql<{ id: string }[]>`insert into agent_event_audits
    (operation, request_id, result, created_at) values ('create', ${randomUUID()}, 'ok', ${at}) returning id`
      )[0]!.id,
    ),
  member_data_access_logs: async (sql, at) =>
    (
      await sql<{ id: number }[]>`insert into member_data_access_logs
    (viewer_discord_id, resource, action, subject_user_ids, subject_count, occurred_at)
    values ('1', 'members', 'view', '["2"]', 1, ${at}) returning id`
    )[0]!.id,
  activity_log: async (sql, at) =>
    (
      await sql<{ id: number }[]>`insert into activity_log
    (description, created_at) values ('w15 audit fixture', ${at}) returning id`
    )[0]!.id,
};
const ageColumn: Record<AuditTable, string> = {
  agent_event_audits: "created_at",
  member_data_access_logs: "occurred_at",
  activity_log: "created_at",
};
const refused = (op: "UPDATE" | "DELETE" | "TRUNCATE", table: string) => ({
  code: "42501",
  message: `audit rows are append-only: ${op} on ${table} refused`,
});

describe.skipIf(!process.env.DATABASE_URL)(
  "audit tables are append-only for a non-owner app role",
  () => {
    const role = `w15_app_${randomUUID().replaceAll("-", "")}`;
    const shadow = `w15_shadow_${randomUUID().replaceAll("-", "")}`; // The only schema the role may CREATE in.
    let fixture: JobsFixture | undefined;
    let admin: Sql | undefined;
    let app: Sql | undefined;
    let owner: Sql;
    let roleCreated = false;
    const rows = (table: AuditTable) => owner.unsafe(`select * from "${table}" order by id`);

    beforeAll(async () => {
      const url = testDatabaseUrl(process.env.DATABASE_URL!); // Refuse before any driver construction.
      const options = {
        port: 5432,
        connect_timeout: 5,
        password: () => url.password,
        onnotice: () => {},
      };
      admin = postgres(url.href, { ...options, max: 1 });
      fixture = await createJobsFixture(url.href, { max: 4 });
      owner = fixture.client;
      const { migrate } = await import("../src/sessions");
      await migrate(owner as unknown as Parameters<typeof migrate>[0]); // web_sessions, swept by model:prune
      const schema = `"${fixture.schemaName}"`;
      await admin.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOINHERIT`);
      roleCreated = true;
      await admin.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO "${role}"`);
      await admin.unsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO "${role}"`,
      );
      await admin.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO "${role}"`);
      await admin.unsafe(`CREATE SCHEMA "${shadow}"`);
      await admin.unsafe(`GRANT USAGE, CREATE ON SCHEMA "${shadow}" TO "${role}"`);
      app = postgres(url.href, {
        ...options,
        max: 4,
        connection: { role, search_path: fixture.schemaName },
      });
    });
    afterAll(async () => {
      try {
        await app?.end();
        await fixture?.dispose(); // Drops the schema and every grant on it.
        await admin?.unsafe(`DROP SCHEMA IF EXISTS "${shadow}" CASCADE`);
        if (roleCreated) await admin?.unsafe(`DROP ROLE "${role}"`);
      } finally {
        await admin?.end();
      }
    });
    beforeEach(async () => {
      await clearAuditRows(owner);
    });

    it("runs as a role that neither owns the tables nor can lift the guard", async () => {
      const [who] =
        await app!`select current_user as name, (select rolsuper from pg_roles where rolname = current_user) as superuser`;
      expect(who).toEqual({ name: role, superuser: false });
      const owners = await app!`select tablename, tableowner from pg_tables
      where schemaname = ${fixture!.schemaName} and tablename in ${app!([...AUDIT_TABLES])}`;
      expect(owners).toHaveLength(3);
      for (const t of owners) expect(t.tableowner).not.toBe(role);
      for (const table of AUDIT_TABLES) {
        await expect(
          app!.unsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${table}_append_only"`),
        ).rejects.toMatchObject({ code: "42501" });
      }
      await expect(app!`set session_replication_role = replica`).rejects.toMatchObject({
        code: "42501",
      });
      // No caller-controlled escape hatch: the guard reads no setting or identity.
      const [fn] = await owner`select prosrc, proconfig from pg_proc
      where proname = 'audit_rows_append_only' and pronamespace = ${fixture!.schemaName}::regnamespace`;
      expect(fn!.prosrc).not.toMatch(/current_setting|session_user|current_user|pg_has_role/);
      // Nor does it resolve names through the caller's search_path.
      expect(fn!.proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
    });

    it.each(AUDIT_TABLES)(
      "%s: INSERT succeeds and UPDATE is refused at the database, rows unchanged",
      async (table) => {
        const now = Date.now();
        const fresh = await insert[table](app!, new Date(now));
        const old = await insert[table](app!, new Date(now - RETENTION - DAY));
        const [defaulted] = await app!.unsafe(`insert into "${table}" ${
          table === "activity_log"
            ? "(description) values ('w15 default age')"
            : table === "agent_event_audits"
              ? "(operation, request_id, result) values ('read', 'w15-default', 'ok')"
              : `(viewer_discord_id, resource, action, subject_user_ids, subject_count) values ('1', 'members', 'view', '[]', 0)`
        }
      returning ${ageColumn[table]} as at`);
        expect(Math.abs((defaulted!.at as Date).getTime() - now)).toBeLessThan(60_000);
        const before = await rows(table);
        expect(before).toHaveLength(3);
        const age = ageColumn[table];
        await expect(
          app!.unsafe(`update "${table}" set ${age} = ${age} where id = $1`, [fresh]),
        ).rejects.toMatchObject(refused("UPDATE", table));
        await expect(
          app!.unsafe(`update "${table}" set ${age} = now() where id = $1`, [old]),
        ).rejects.toMatchObject(refused("UPDATE", table));
        await expect(app!.unsafe(`update "${table}" set id = id`)).rejects.toMatchObject(
          refused("UPDATE", table),
        );
        expect(await rows(table)).toEqual(before);
      },
    );

    it.each(AUDIT_TABLES)(
      "%s: DELETE is refused for current, future and in-window rows, rows unchanged",
      async (table) => {
        const now = Date.now();
        const ids = {
          future: await insert[table](app!, new Date(now + DAY)),
          current: await insert[table](app!, new Date(now)),
          inWindow: await insert[table](app!, new Date(now - RETENTION + 60_000)),
          old: await insert[table](app!, new Date(now - RETENTION - DAY)),
        };
        const before = await rows(table);
        for (const id of [ids.future, ids.current, ids.inWindow]) {
          await expect(
            app!.unsafe(`delete from "${table}" where id = $1`, [id]),
          ).rejects.toMatchObject(refused("DELETE", table));
        }
        // One protected row refuses the whole statement: the deletable old row stays too.
        await expect(app!.unsafe(`delete from "${table}"`)).rejects.toMatchObject(
          refused("DELETE", table),
        );
        expect(await rows(table)).toEqual(before);
      },
    );

    it.each(AUDIT_TABLES)(
      "%s: DELETE passes only for rows strictly older than 90 days",
      async (table) => {
        const now = Date.now();
        const old = await insert[table](app!, new Date(now - RETENTION - DAY));
        const justOut = await insert[table](app!, new Date(now - RETENTION - 60_000));
        const justIn = await insert[table](app!, new Date(now - RETENTION + 60_000));
        const age = ageColumn[table];
        const gone = await app!.unsafe(
          `delete from "${table}" where ${age} < clock_timestamp() - interval '2160 hours' returning id`,
        );
        expect(gone.map((r) => Number(r.id)).sort((a, b) => a - b)).toEqual([old, justOut]);
        expect((await rows(table)).map((r) => Number(r.id))).toEqual([justIn]);
        expect(
          await app!.unsafe(
            `delete from "${table}" where ${age} < clock_timestamp() - interval '2160 hours' returning id`,
          ),
        ).toHaveLength(0);
      },
    );

    it.each(AUDIT_TABLES)(
      "%s: TRUNCATE is refused without the privilege and by the guard with it",
      async (table) => {
        await insert[table](app!, new Date(Date.now() - RETENTION - DAY));
        await insert[table](app!, new Date());
        const before = await rows(table);
        await expect(app!.unsafe(`truncate "${table}"`)).rejects.toMatchObject({
          code: "42501",
          message: `permission denied for table ${table}`,
        });
        await admin!.unsafe(`GRANT TRUNCATE ON "${fixture!.schemaName}"."${table}" TO "${role}"`);
        try {
          await expect(app!.unsafe(`truncate "${table}"`)).rejects.toMatchObject(
            refused("TRUNCATE", table),
          );
        } finally {
          await admin!.unsafe(
            `REVOKE TRUNCATE ON "${fixture!.schemaName}"."${table}" FROM "${role}"`,
          );
        }
        expect(await rows(table)).toEqual(before);
      },
    );

    // A role that may CREATE in any schema can put it ahead of pg_catalog and
    // shadow what the guard calls. Each shadow below resolves for the caller,
    // and would let the DELETE through if the guard used the caller's path.
    const shadows: Record<string, { create: string[]; live: string }> = {
      "clock_timestamp()": {
        create: [
          `create function clock_timestamp() returns timestamptz language sql
        as $$ select 'infinity'::pg_catalog.timestamptz $$`,
        ],
        live: "select clock_timestamp() = 'infinity'::timestamptz as live",
      },
      "timestamptz < timestamptz": {
        create: [
          "create function shadow_lt(timestamptz, timestamptz) returns boolean language sql as $$ select true $$",
          "create operator < (leftarg = timestamptz, rightarg = timestamptz, function = shadow_lt)",
        ],
        live: "select now() < '-infinity'::timestamptz as live",
      },
    };
    it.each(Object.keys(shadows))(
      "a caller-shadowed %s cannot open DELETE on a fresh row",
      async (name) => {
        const table = "member_data_access_logs";
        const fresh = await insert[table](app!, new Date());
        const before = await rows(table);
        await expect(
          app!.begin(async (tx) => {
            await tx.unsafe(
              `set local search_path = "${shadow}", pg_catalog, "${fixture!.schemaName}"`,
            );
            for (const ddl of shadows[name]!.create) await tx.unsafe(ddl);
            expect((await tx.unsafe(shadows[name]!.live))[0]!.live).toBe(true);
            await tx.unsafe(`delete from "${table}" where id = $1`, [fresh]);
          }),
        ).rejects.toMatchObject(refused("DELETE", table));
        expect(await rows(table)).toEqual(before);
      },
    );

    it("refuses deleting a grant whose audits would be rewritten by ON DELETE SET NULL", async () => {
      const [grant] = await app!<
        { id: string }[]
      >`insert into agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      values ('a', 'co', 'g', ${`h-${randomUUID()}`}) returning id`;
      await app!`insert into agent_event_audits (grant_id, operation, request_id, result, created_at)
      values (${grant!.id}, 'create', ${randomUUID()}, 'ok', ${new Date(Date.now() - RETENTION - DAY)})`;
      const before = await rows("agent_event_audits");
      await expect(
        app!`delete from agent_event_grants where id = ${grant!.id}`,
      ).rejects.toMatchObject(refused("UPDATE", "agent_event_audits"));
      expect(await app!`select id from agent_event_grants where id = ${grant!.id}`).toHaveLength(1);
      expect(await rows("agent_event_audits")).toEqual(before);
    });

    it("model:prune stays compatible: strictly-old rows go, re-runs are clean and single-flight holds", async () => {
      const now = new Date();
      const at = {
        old: new Date(now.getTime() - RETENTION - DAY),
        edge: new Date(now.getTime() - RETENTION),
        fresh: new Date(now.getTime() - DAY),
        future: new Date(now.getTime() + DAY),
      };
      for (const when of Object.values(at)) await insert.member_data_access_logs(app!, when);
      const flight = pgSingleFlight(app!);
      const name = `w15-audit-prune-${randomUUID()}`;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let counts: Awaited<ReturnType<typeof pruneModelTables>> | undefined;
      const first = flight(name, async (db) => {
        counts = await pruneModelTables(pgPruneStores(db), now);
        await gate;
      });
      await vi.waitFor(() => expect(counts).toBeDefined());
      expect(
        await flight(name, async () => {
          throw new Error("overlapping prune ran");
        }),
      ).toBe(false);
      release();
      expect(await first).toBe(true);
      expect(counts).toEqual({
        accessLog: 1,
        joinAttempts: 0,
        idempotencyKeys: 0,
        searchLog: 0,
        sessions: 0,
      });
      const survivors = await owner<
        { occurred_at: Date }[]
      >`select occurred_at from member_data_access_logs order by id`;
      expect(survivors.map((r) => r.occurred_at.getTime())).toEqual(
        [at.edge, at.fresh, at.future].map((d) => d.getTime()),
      );
      let again: typeof counts;
      expect(
        await flight(name, async (db) => {
          again = await pruneModelTables(pgPruneStores(db), now);
        }),
      ).toBe(true);
      expect(again).toEqual({
        accessLog: 0,
        joinAttempts: 0,
        idempotencyKeys: 0,
        searchLog: 0,
        sessions: 0,
      });
    });

    it("model:prune skips, never raises on, rows a fast caller clock already counts as expired", async () => {
      const inWindow = new Date(Date.now() - RETENTION + 60_000); // 89d 23h 59m old by the database clock
      await insert.member_data_access_logs(app!, inWindow);
      const ahead = new Date(Date.now() + 120_000); // A worker clock two minutes fast.
      expect((await pruneModelTables(pgPruneStores(app!), ahead)).accessLog).toBe(0);
      const left = await owner<
        { occurred_at: Date }[]
      >`select occurred_at from member_data_access_logs`;
      expect(left.map((r) => r.occurred_at.getTime())).toEqual([inWindow.getTime()]);
    });
  },
);
