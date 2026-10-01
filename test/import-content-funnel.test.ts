import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { connectionSettings, importContentFunnel, parseArgs } from "../bin/import/content-funnel.mjs";
import { joinFunnelStats, listJoinAttempts } from "../src/admin/reads";
import { adminSchema, schema } from "../src/db/index";
import { migrateJoin, recordAttempt } from "../src/join/service";
import type { Sql } from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { testDatabaseUrl } from "./helpers/member-data-db";

const script = fileURLToPath(new URL("../bin/import/content-funnel.mjs", import.meta.url).href);
const clock = new Date("2026-09-30T12:00:00Z");
const testUrl = "postgres://agent_test@agent-testdb:5432/two_web_next";
const fixtureSql = readFileSync(fileURLToPath(new URL("./fixtures/legacy/content-funnel.sql", import.meta.url).href), "utf8");

function command(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, ...env }, timeout: 15_000,
  });
}

describe("content-funnel CLI safety (no database needed)", () => {
  it("defaults to dry-run and requires an explicit single apply flag", () => {
    expect(parseArgs([])).toEqual({ help: false, dryRun: true });
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseArgs(["--apply"]).dryRun).toBe(false);
    for (const args of [["--apply", "--dry-run"], ["--apply", "--apply"], [testUrl], ["--unknown"]]) {
      expect(() => parseArgs(args)).toThrow();
    }
    expect(command(["--help"]).status).toBe(0);
  });

  it("refuses missing or ambiguous endpoints without logging arguments/URLs", () => {
    expect(command([]).status).toBe(1);
    const refused = command(["postgres://test-user:synthetic-only@invalid.example/db"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).not.toContain("synthetic-only");
    expect(refused.stderr).not.toContain("invalid.example");
    expect(() => connectionSettings({ LEGACY_DATABASE_URL: testUrl, DATABASE_URL: testUrl }, true)).toThrow("different");
    expect(() => connectionSettings({ LEGACY_DATABASE_URL: "postgres://agent-testdb/db", DATABASE_URL: testUrl }, true)).toThrow("specify");
    expect(() => connectionSettings({ LEGACY_DATABASE_URL: testUrl, DATABASE_URL: testUrl, LEGACY_DATABASE_SCHEMA: "legacy;drop schema public" }, true)).toThrow("schema");
  });

  it("refuses identity-changing URL query parameters without logging them", () => {
    // postgres.js forwards unknown query parameters as session startup
    // parameters, silently overriding the endpoint the guard compares.
    const spike = (param: string) => `${testUrl}?${param}`;
    for (const param of [
      "database=two_web_next",
      "db=two_web_next",
      "user=agent_test",
      "search_path=public",
      "options=-c%20search_path%3Dpublic",
      "role=agent_test",
      "session_authorization=agent_test",
      "datestyle=SQL%2CDMY",
      "default_transaction_read_only=off",
      "timezone=Pacific%2FAuckland",
    ]) {
      const key = param.split("=")[0]!;
      expect(() => connectionSettings({ LEGACY_DATABASE_URL: testUrl, DATABASE_URL: spike(param) }, true))
        .toThrow(`?${key}=`);
      expect(() => connectionSettings({ LEGACY_DATABASE_URL: spike(param), DATABASE_URL: testUrl }, true))
        .toThrow(`?${key}=`);
    }
  });

  it("pins the URL password and enforces read-only source and dry-run pools", () => {
    const settings = connectionSettings({ LEGACY_DATABASE_URL: testUrl, DATABASE_URL: testUrl, LEGACY_DATABASE_SCHEMA: "legacy" }, true);
    expect(settings.legacyOptions.connection?.default_transaction_read_only).toBe("on");
    expect(settings.targetOptions.connection?.default_transaction_read_only).toBe("on");
    expect(typeof settings.legacyOptions.password).toBe("function");
    expect((settings.legacyOptions.password as () => string)()).toBe("");
    expect(connectionSettings({ LEGACY_DATABASE_URL: testUrl, DATABASE_URL: testUrl, LEGACY_DATABASE_SCHEMA: "legacy" }, false)
      .targetOptions.connection?.default_transaction_read_only).toBe("off");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("legacy content-funnel import on disposable test schemas", () => {
  let fixture: JobsFixture | undefined;
  let legacy: postgres.Sql | undefined;
  let legacySchema: string;
  let sourceCreated = false;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    const url = testDatabaseUrl(process.env.DATABASE_URL!); // Refuse before any driver/DDL.
    if (url.hostname === "agent-testdb" && url.pathname !== "/two_web_next") throw new Error("Import fixtures require two_web_next");
    fixture = await createJobsFixture(url.href);
    legacySchema = `legacy_${fixture.schemaName}`; // Own schema: concurrent import cards cannot collide.
    await fixture.client.unsafe(fixtureSql.replaceAll(/\blegacy\b/g, legacySchema));
    sourceCreated = true;
    env = {
      LEGACY_DATABASE_URL: url.href, DATABASE_URL: url.href,
      LEGACY_DATABASE_SCHEMA: legacySchema, DATABASE_SCHEMA: fixture.schemaName,
    };
    const settings = connectionSettings(env, false);
    legacy = postgres(settings.legacyUrl, settings.legacyOptions);
    // Exercise native IDs colliding with source IDs. Import must not overwrite them.
    await fixture.client`insert into featured_contents (title) values ('Native featured entry')`;
    await fixture.client`insert into join_attempts (outcome, source) values ('added', 'native')`;
    await fixture.client`insert into event_search_logs (normalized_query, result_count) values ('native search', 1)`;
  });

  afterEach(async () => {
    try {
      await legacy?.end({ timeout: 1 });
      if (sourceCreated && fixture) await fixture.client.unsafe(`drop schema "${legacySchema}" cascade`);
    } finally {
      await fixture?.dispose();
      fixture = undefined;
      legacy = undefined;
      sourceCreated = false;
    }
  });

  function run(dryRun = true) {
    return importContentFunnel({ legacy: legacy!, target: fixture!.client, legacySchema, targetSchema: fixture!.schemaName, now: clock, dryRun });
  }

  async function counts() {
    const [row] = await fixture!.client`
      select (select count(*)::int from featured_contents) as featured,
        (select count(*)::int from join_attempts) as joins,
        (select count(*)::int from event_search_logs) as searches`;
    return row;
  }

  it("plans counts with SELECTs only, leaving rows and sequences unchanged", async () => {
    const report = await run();
    expect(report.map((r) => [r.total, r.eligible, r.skipped_old, r.skipped_missing_timestamp, r.would_insert, r.inserted]))
      .toEqual([[2, 2, 0, 0, 2, 0], [5, 3, 1, 1, 3, 0], [4, 3, 1, 0, 3, 0]]);
    expect(report.every((r) => r.dry_run && r.cutoff === "2026-07-02T12:00:00.000Z")).toBe(true);
    expect(await counts()).toEqual({ featured: 1, joins: 1, searches: 1 });
    const [next] = await fixture!.client`insert into featured_contents (title) values ('Still native') returning id`;
    expect(next!.id).toBe(2); // A default dry-run must not call nextval().
    await expect(legacy!`insert into ${legacy!(legacySchema)}.join_attempts (outcome) values ('denied')`)
      .rejects.toMatchObject({ code: "25006" });
  });

  it("imports exact fields and timestamps, keeps boundary/duplicate rows, maps creator to Discord", async () => {
    // Even a client whose session zone is not UTC must retain source UTC instants.
    await fixture!.client`set time zone 'Pacific/Auckland'`;
    const report = await run(false);
    expect(report.map((r) => r.inserted)).toEqual([2, 3, 3]);
    expect(await counts()).toEqual({ featured: 3, joins: 4, searches: 4 });
    const [featured] = await fixture!.client`
      select legacy_id, title, body, url, image_url, image_alt, is_published, position,
        created_by, extract(epoch from created_at)::text as created_epoch,
        (starts_at at time zone 'UTC')::text as starts_at,
        (ends_at at time zone 'UTC')::text as ends_at
      from featured_contents where legacy_id = '1'`;
    expect(featured).toEqual({
      legacy_id: "1", title: "Community night", body: "Bring a friend.", url: "https://example.invalid/night",
      image_url: "https://example.invalid/night.png", image_alt: "Synthetic game night poster", is_published: true,
      position: 2, created_by: "123456789012345678", created_epoch: "1735689600.000000",
      starts_at: "2026-09-01 18:00:00", ends_at: "2026-10-01 23:00:00",
    });
    const [nullable] = await fixture!.client`
      select body, image_url, image_alt, starts_at, ends_at, created_by, created_at = updated_at as fallback
      from featured_contents where legacy_id = '2'`;
    expect(nullable).toEqual({ body: null, image_url: null, image_alt: null, starts_at: null, ends_at: null, created_by: null, fallback: true });
    const joins = await fixture!.client`select legacy_id, outcome, source, request_id, discord_id,
      (created_at at time zone 'UTC')::text as at from join_attempts where legacy_id is not null order by legacy_id`;
    expect(joins).toEqual([
      { legacy_id: "2", outcome: "added", source: "landing", request_id: "synthetic-boundary", discord_id: "123456789012345678", at: "2026-07-02 12:00:00" },
      { legacy_id: "3", outcome: "denied", source: null, request_id: null, discord_id: null, at: "2026-09-29 12:00:00.123456" },
      { legacy_id: "4", outcome: "denied", source: null, request_id: null, discord_id: null, at: "2026-09-29 12:00:00.123456" },
    ]);
    const searches = await fixture!.client`select legacy_id, normalized_query, result_count,
      (occurred_at at time zone 'UTC')::text as at from event_search_logs where legacy_id is not null order by legacy_id`;
    expect(searches).toEqual([
      { legacy_id: "2", normalized_query: "boundary game", result_count: 0, at: "2026-07-02 12:00:00" },
      { legacy_id: "3", normalized_query: "game night", result_count: 2, at: "2026-07-02 12:00:00.000001" },
      { legacy_id: "4", normalized_query: "game night", result_count: 2, at: "2026-07-02 12:00:00.000001" },
    ]);
    const [native] = await fixture!.client`select title, legacy_id from featured_contents where id = 1`;
    expect(native).toEqual({ title: "Native featured entry", legacy_id: null });
  });

  it("imports identically under hostile source and target DateStyles, with a clean replay", async () => {
    // Ambiguous July 9 corrupts to September 7 when a DMY source feeds an MDY
    // destination; day>12 rows abort with 22008; formatting drift marks every
    // unchanged row for update on replay. The importer pins ISO, YMD in-txn.
    // Explicit IDs: the fixture seeds ids 1-2 without advancing the
    // sequence, so an id-less insert would collide with the pkey.
    await fixture!.client`insert into ${fixture!.client(legacySchema)}.featured_contents (id, title, starts_at, created_at)
      values (10, 'July nine', '2026-07-09 12:00:00', '2026-09-29 12:00:00'),
        (11, 'July thirteen', '2026-07-13 12:00:00', '2026-09-29 12:00:00')`;
    await legacy!`set datestyle to 'SQL, DMY'`;
    await fixture!.client`set datestyle to 'SQL, MDY'`;
    const report = await run(false);
    expect(report.map((r) => r.inserted)).toEqual([4, 3, 3]);
    // Reset to a deterministic style before reading text back: ::text output
    // itself is DateStyle-dependent, so asserting under the hostile style
    // would conflate the import with the assertion formatting.
    await fixture!.client`set datestyle to 'ISO, YMD'`;
    const probed = await fixture!.client`
      select title, (starts_at at time zone 'UTC')::text as at from featured_contents
      where title like 'July %' order by title`;
    expect(probed).toEqual([
      { title: "July nine", at: "2026-07-09 12:00:00" },
      { title: "July thirteen", at: "2026-07-13 12:00:00" },
    ]);
    await legacy!`set datestyle to 'SQL, DMY'`;
    await fixture!.client`set datestyle to 'SQL, MDY'`;
    const second = await run(false);
    expect(second.map((r) => [r.inserted, r.updated, r.unchanged])).toEqual([[0, 0, 4], [0, 0, 3], [0, 0, 3]]);
    await fixture!.client`set datestyle to 'ISO, YMD'`;
  });

  it("refuses live sessions that resolve to the same database and schema", async () => {
    // Same URL, same schema on both sides: the static endpoint guard already
    // refuses this, but the live current_database() check is the backstop for
    // DNS aliases and PgBouncer routing the static comparison cannot see.
    await expect(importContentFunnel({
      legacy: legacy!, target: fixture!.client,
      legacySchema: fixture!.schemaName, targetSchema: fixture!.schemaName,
      now: clock, dryRun: true,
    })).rejects.toThrow("same database and schema");
    expect(await counts()).toEqual({ featured: 1, joins: 1, searches: 1 });
  });

  it("re-runs idempotently, updates changed source keys and leaves native sequences usable", async () => {
    await run(false);
    const second = await run(false);
    expect(second.map((r) => [r.inserted, r.updated, r.unchanged])).toEqual([[0, 0, 2], [0, 0, 3], [0, 0, 3]]);
    await fixture!.client`update ${fixture!.client(legacySchema)}.featured_contents set title = 'Changed headline' where id = 1`;
    await fixture!.client`update ${fixture!.client(legacySchema)}.join_attempts set outcome = 'degraded' where id = 4`;
    await fixture!.client`update ${fixture!.client(legacySchema)}.event_search_logs set result_count = 5 where id = 3`;
    const planned = await run();
    expect(planned.map((r) => [r.would_insert, r.would_update, r.updated])).toEqual([[0, 1, 0], [0, 1, 0], [0, 1, 0]]);
    const third = await run(false);
    expect(third.map((r) => [r.inserted, r.updated])).toEqual([[0, 1], [0, 1], [0, 1]]);
    const [changed] = await fixture!.client`select title from featured_contents where legacy_id = '1'`;
    expect(changed!.title).toBe("Changed headline");
    expect(await counts()).toEqual({ featured: 3, joins: 4, searches: 4 });
    const [next] = await fixture!.client`insert into featured_contents (title) values ('After import') returning id, legacy_id`;
    expect(next!.id).toBeGreaterThan(3);
    expect(next!.legacy_id).toBeNull();
  });

  it("keeps bigint source keys lossless and handles more than one cursor batch", async () => {
    await fixture!.client`insert into ${fixture!.client(legacySchema)}.join_attempts (id, outcome, created_at)
      values ('9007199254740993', 'added', '2026-09-29 12:00:00')`;
    await fixture!.client`insert into ${fixture!.client(legacySchema)}.event_search_logs (id, normalized_query, result_count, occurred_at)
      select n, 'batch game', 1, '2026-09-29 12:00:00'::timestamp from generate_series(10, 519) n`;
    const report = await run(false);
    expect(report.map((r) => r.inserted)).toEqual([2, 4, 513]);
    const [largeKey] = await fixture!.client`select legacy_id from join_attempts where legacy_id = '9007199254740993'`;
    expect(largeKey!.legacy_id).toBe("9007199254740993");
    expect((await run(false)).map((r) => r.unchanged)).toEqual([2, 4, 513]);
  });

  it("rolls back all imported tables when a later table violates a target constraint", async () => {
    await fixture!.client`insert into ${fixture!.client(legacySchema)}.join_attempts (id, outcome, created_at)
      values (99, 'invalid-outcome-too-long', '2026-09-29 12:00:00')`;
    await expect(run(false)).rejects.toMatchObject({ code: "22001" });
    expect(await counts()).toEqual({ featured: 1, joins: 1, searches: 1 });
    const failed = command(["--apply"], env);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("22001");
    expect(failed.stdout).toBe("");
    for (const value of ["invalid-outcome-too-long", "Bring a friend", env.DATABASE_URL!]) expect(failed.stderr).not.toContain(value);
    expect(await counts()).toEqual({ featured: 1, joins: 1, searches: 1 });
  });

  it("reads a fresh migrateJoin bootstrap with the viewer, before and after 1011", async () => {
    // Fresh staging databases are bootstrapped by migrateJoin() (drizzle/1000
    // shape, no legacy_id). The viewer selects explicit columns so it stays
    // readable there, and 1011 still applies cleanly afterwards.
    const base = testDatabaseUrl(process.env.DATABASE_URL!);
    const bootstrapSchema = `bootstrap_${fixture!.schemaName}`.slice(0, 62);
    await fixture!.client.unsafe(`CREATE SCHEMA "${bootstrapSchema}"`);
    const bootstrap = postgres(base.href, {
      max: 1, port: 5432, connect_timeout: 5, password: () => base.password,
      connection: { search_path: bootstrapSchema }, onnotice: () => {},
    });
    try {
      await migrateJoin(bootstrap as unknown as Sql);
      await recordAttempt(bootstrap as unknown as Sql, {
        outcome: "added", source: "native", requestId: "bootstrap-req", discordId: "123456789012345678",
      });
      const columns = await bootstrap<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = ${bootstrapSchema} and table_name = 'join_attempts'`;
      expect(columns.map((c) => c.column_name)).not.toContain("legacy_id");
      const db = drizzle(bootstrap, { schema: { ...schema, ...adminSchema } });
      const before = await listJoinAttempts(db, {});
      expect(before).toHaveLength(1);
      expect(before[0]).toEqual({
        id: expect.any(Number),
        outcome: "added",
        source: "native",
        requestId: "bootstrap-req",
        discordId: "123456789012345678",
        createdAt: expect.any(Date),
      });
      expect(await joinFunnelStats(db)).toEqual({ added: 1 });
      // 1011 still applies cleanly on a bootstrapped database.
      await bootstrap.unsafe(`ALTER TABLE "${bootstrapSchema}"."join_attempts" ADD COLUMN "legacy_id" text`);
      await bootstrap.unsafe(`ALTER TABLE "${bootstrapSchema}"."join_attempts" ADD CONSTRAINT "join_attempts_legacy_id_unique" UNIQUE("legacy_id")`);
      const after = await listJoinAttempts(db, {});
      expect(after).toHaveLength(1);
      expect(after[0]).not.toHaveProperty("legacyId");
    } finally {
      await bootstrap.end({ timeout: 1 });
      await fixture!.client.unsafe(`DROP SCHEMA "${bootstrapSchema}" CASCADE`);
    }
  });

  it("the standalone CLI defaults to dry-run and requires --apply to mutate", async () => {
    // CLI uses wall time; keep its synthetic rows independent of the test date.
    await fixture!.client`update ${fixture!.client(legacySchema)}.join_attempts
      set created_at = case when id = 1 then '2000-01-01'::timestamp else now() at time zone 'UTC' end
      where created_at is not null`;
    await fixture!.client`update ${fixture!.client(legacySchema)}.event_search_logs
      set occurred_at = case when id = 1 then '2000-01-01'::timestamp else now() at time zone 'UTC' end`;
    const dry = command([], env);
    expect(dry.status, dry.stderr).toBe(0);
    const report = dry.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(report).toHaveLength(3);
    expect(report.every((r) => r.dry_run && r.inserted === 0)).toBe(true);
    expect(await counts()).toEqual({ featured: 1, joins: 1, searches: 1 });
    const applied = command(["--apply"], env);
    expect(applied.status, applied.stderr).toBe(0);
    const again = command(["--apply"], env);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout.trim().split("\n").map((line) => JSON.parse(line).inserted)).toEqual([0, 0, 0]);
    expect(await counts()).toEqual({ featured: 3, joins: 4, searches: 4 });
  });
});
