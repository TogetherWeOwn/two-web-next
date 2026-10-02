import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  compareKeys,
  quoteIdentifier,
  renderMarkdown,
  validateMap,
  verify,
  type TableMapping,
  type VerificationReport,
} from "../bin/import/verify.mjs";
import { defaultTableMap } from "../bin/import/verify-map.mjs";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const script = fileURLToPath(new URL("../bin/import/verify.mjs", import.meta.url));
const cutoff = "2026-07-02T00:00:00Z";
const fixtureMap = (left = "legacy", right = "next"): TableMapping[] => [
  {
    name: "samples",
    legacy: { from: `${quoteIdentifier(left)}.samples l` },
    next: { from: `${quoteIdentifier(right)}.samples n` },
    keys: [
      { name: "id", legacy: "l.id", next: "n.id" },
      { name: "part", legacy: "l.part", next: "n.part" },
    ],
    columns: [
      { name: "label", legacy: "lower(l.label)", next: "n.label" },
      { name: "properties", legacy: "l.properties::jsonb", next: "n.properties" },
      { name: "instant", legacy: "l.instant AT TIME ZONE 'UTC'", next: "n.instant" },
    ],
  },
];

it("validates map identifiers, uniqueness, projections and nonempty coverage", () => {
  expect(validateMap(fixtureMap())).toHaveLength(1);
  expect(() => validateMap([])).toThrow("invalid_map");
  expect(() => quoteIdentifier('legacy";DROP SCHEMA public')).toThrow("invalid_identifier");
  expect(() => validateMap([...fixtureMap(), ...fixtureMap()])).toThrow("duplicate_table");
  const map = fixtureMap();
  map[0]!.columns = [];
  expect(() => validateMap(map)).toThrow("invalid_map");
});

it("uses UTF-8 byte ordering matching Postgres C collation, and collision-free composite keys", () => {
  expect(compareKeys([""], ["\u{10000}"])).toBeLessThan(0);
  expect(compareKeys(["a", "bc"], ["ab", "c"])).toBeLessThan(0);
  expect(compareKeys(["9007199254740993"], ["9007199254740993"])).toBe(0);
});

it("covers all twelve import tables, requires a fixed cutoff and exposes unresolved mappings", () => {
  const map = defaultTableMap({ cutoff });
  expect(map.map((t) => t.name)).toEqual([
    "users",
    "profiles",
    "events",
    "rsvps",
    "featured_contents",
    "join_attempts",
    "event_search_logs",
    "member_data_access_logs",
    "activity_log",
    "agent_event_grants",
    "agent_event_audits",
    "agent_event_idempotency_keys",
  ]);
  expect(() => defaultTableMap()).toThrow("fixed_cutoff_required");
  expect(() => defaultTableMap({ cutoff: "2026-07-02';SELECT 1--" })).toThrow(
    "fixed_cutoff_required",
  );
  expect(map.find((t) => t.name === "users")!.mappingGaps!.join()).toContain("member");
  expect(
    map.find((t) => t.name === "agent_event_grants")!.columns.find((f) => f.name === "disabled")!
      .legacy,
  ).toBe("TRUE");
});

it("CLI rejects missing env/URL arguments without printing a connection string or secret", () => {
  for (const args of [[], ["--database-url", "postgres://secret@production.example.test/data"]]) {
    const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: {} });
    expect(run.status).toBe(2);
    expect(run.stderr).not.toContain("secret");
    expect(run.stderr).not.toContain("production.example.test");
    expect(run.stdout).toBe("");
  }
  expect(
    spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", env: {} }).status,
  ).toBe(0);
});

it("CLI rejects required/invalid channel binding before connecting, without leaking DSNs", () => {
  for (const side of ["LEGACY_DATABASE_URL", "DATABASE_URL"]) {
    for (const query of [
      "channel_binding=require",
      "channel_binding=prefer&channel_binding=require",
      "channel_binding=require&channel_binding=disable",
      "channel_binding=invalid",
    ]) {
      const raw = `postgres://private-user:private-password@unreachable.example.test/data?sslmode=verify-full&${query}`;
      const run = spawnSync(process.execPath, [script, "--cutoff", cutoff], {
        encoding: "utf8",
        timeout: 5000,
        env: {
          LEGACY_DATABASE_URL: "postgres://agent_test@agent-testdb/two_web_next",
          DATABASE_URL: "postgres://agent_test@agent-testdb/two_web_next",
          [side]: raw,
        },
      });
      expect(run.status).toBe(2);
      expect(run.stderr.trim()).toBe(
        `Verification failed: ${query.endsWith("invalid") ? "invalid_channel_binding" : "unsupported_channel_binding_required"}`,
      );
      expect(run.stdout).toBe("");
      expect(run.stderr).not.toContain("private-");
      expect(run.stderr).not.toContain("example.test");
    }
  }
});

it("markdown escapes keys as data and never includes member payloads", () => {
  const report: VerificationReport = {
    version: 1,
    ok: false,
    batchSize: 1,
    detailLimit: 1,
    tables: [
      {
        table: "samples",
        keyColumns: ["id"],
        comparedColumns: ["bio"],
        legacyCount: 1,
        nextCount: 0,
        missingCount: 1,
        extraCount: 0,
        mismatchCount: 0,
        missingKeys: [["<img|`\n"]],
        extraKeys: [],
        mismatchKeys: [],
        mappingGaps: [],
        detailsTruncated: false,
      },
    ],
  };
  const markdown = renderMarkdown(report);
  expect(markdown).toContain("&#60;img&#124;&#96;");
  expect(markdown).not.toContain("<img");
  expect(markdown).toContain("DIFF");
});

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("two-schema verification on the authorized test database", () => {
  let destination: MemberDataFixture;
  let admin: postgres.Sql;
  let legacy: postgres.Sql;
  let next: postgres.Sql;
  let sourceSchema: string;
  let scratch: string;
  let map: TableMapping[];
  let sourceCreated = false;
  beforeAll(async () => {
    const url = testDatabaseUrl(databaseUrl!); // Refuse before creating a driver or spawning the CLI.
    if (url.hostname === "agent-testdb" && url.pathname !== "/two_web_next")
      throw new Error("verifier fixtures require two_web_next");
    const config = { max: 1, port: 5432, password: () => url.password, onnotice: () => {} };
    admin = postgres(url.href, config);
    legacy = postgres(url.href, config);
    next = postgres(url.href, config);
    destination = await createMemberDataFixture(url.href);
    sourceSchema = `verify_l_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${sourceSchema}"`);
    sourceCreated = true;
    await admin.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${sourceSchema}"`);
      await tx.unsafe(
        await readFile(new URL("./fixtures/legacy/verify.sql", import.meta.url), "utf8"),
      );
    });
    await admin.unsafe(
      `CREATE TABLE "${sourceSchema}".samples (id bigint, part text, label text, properties json, instant timestamp)`,
    );
    await admin.unsafe(
      `CREATE TABLE "${destination.schemaName}".samples (id bigint, part text, label text, properties jsonb, instant timestamptz)`,
    );
    await admin.unsafe(
      `CREATE TABLE "${sourceSchema}".retention_samples (id bigint, created_at timestamp, occurred_at timestamp)`,
    );
    await admin.unsafe(
      `CREATE TABLE "${destination.schemaName}".retention_samples (id bigint, created_at timestamptz, occurred_at timestamptz)`,
    );
    map = fixtureMap(sourceSchema, destination.schemaName);
    scratch = await mkdtemp(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
        "verify-fixture-",
      ),
    );
  }, 30000);
  afterAll(async () => {
    await Promise.allSettled([legacy?.end(), next?.end()]);
    try {
      if (sourceCreated) await admin.unsafe(`DROP SCHEMA "${sourceSchema}" CASCADE`);
      if (destination) await destination.dispose();
      if (scratch) await rm(scratch, { recursive: true, force: true });
    } finally {
      await admin?.end();
    }
  });
  beforeEach(async () => {
    await admin.unsafe(`TRUNCATE "${sourceSchema}".samples, "${destination.schemaName}".samples,
      "${sourceSchema}".retention_samples, "${destination.schemaName}".retention_samples,
      "${sourceSchema}".users, "${destination.schemaName}".users CASCADE`);
    await admin.unsafe(`INSERT INTO "${sourceSchema}".samples VALUES
      (1, 'a', 'MEMBER-FIELD-SENTINEL', '{"b":2,"a":1}', '2026-01-01 02:03:04.123456'),
      (1, 'bc', NULL, 'null', NULL), (2, 'c', 'UNCHANGED', '{"nested":{"z":0,"a":1}}', NULL),
      (3, U&'\\E000', 'UNICODE', '{}', NULL), (3, U&'\\+010000', 'UNICODE', '{}', NULL),
      (9007199254740993, 'large', 'LARGE', '{"integer":9007199254740993}', NULL)`);
    await admin.unsafe(`INSERT INTO "${destination.schemaName}".samples
      SELECT id, part, lower(label), properties::jsonb, instant AT TIME ZONE 'UTC' FROM "${sourceSchema}".samples`);
  });
  const runCli = async (tableMap = map, args: string[] = [], connectionUrl = databaseUrl!) => {
    const path = join(scratch, "map.json");
    await writeFile(path, JSON.stringify(tableMap));
    return spawnSync(process.execPath, [script, "--map", path, "--batch-size", "2", ...args], {
      encoding: "utf8",
      timeout: 30000,
      env: {
        LEGACY_DATABASE_URL: connectionUrl,
        DATABASE_URL: connectionUrl,
        PGPASSWORD: "must-not-inherit",
      },
    });
  };
  it("identical rows exit 0 across batches and emit JSON plus markdown without fields", async () => {
    const jsonPath = join(scratch, "report.json");
    const mdPath = join(scratch, "report.md");
    const run = await runCli(map, ["--json", jsonPath, "--markdown", mdPath]);
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(await readFile(jsonPath, "utf8"));
    expect(report.ok).toBe(true);
    expect(report.tables[0]).toMatchObject({
      legacyCount: 6,
      nextCount: 6,
      missingCount: 0,
      extraCount: 0,
      mismatchCount: 0,
    });
    expect(await readFile(mdPath, "utf8")).toContain("MATCH");
    for (const output of [
      run.stdout,
      run.stderr,
      await readFile(jsonPath, "utf8"),
      await readFile(mdPath, "utf8"),
    ]) {
      expect(output.toLowerCase()).not.toContain("member-field-sentinel");
      expect(output).not.toContain("must-not-inherit");
      expect(output).not.toContain("postgres://");
      expect(output).not.toContain("123456");
    }
  });
  it.each(["missing", "extra", "changed"])(
    "%s rows exit 1 and identify the key, not its values",
    async (kind) => {
      if (kind === "missing")
        await admin.unsafe(
          `DELETE FROM "${destination.schemaName}".samples WHERE id=1 AND part='a'`,
        );
      if (kind === "extra")
        await admin.unsafe(
          `INSERT INTO "${destination.schemaName}".samples VALUES(99,'extra','private-extra','{}',NULL)`,
        );
      if (kind === "changed")
        await admin.unsafe(
          `UPDATE "${destination.schemaName}".samples SET label='private-changed' WHERE id=1 AND part='a'`,
        );
      const jsonPath = join(scratch, "diff.json");
      const run = await runCli(map, ["--json", jsonPath]);
      expect(run.status, run.stderr).toBe(1);
      const table = JSON.parse(await readFile(jsonPath, "utf8")).tables[0];
      const category = kind === "changed" ? "mismatch" : kind;
      expect(table[`${category}Count`]).toBe(1);
      expect(table[`${category}Keys`]).toEqual([kind === "extra" ? ["99", "extra"] : ["1", "a"]]);
      expect(run.stdout).not.toContain("private-");
    },
  );
  it("reports simultaneous diffs with equal counts, limits samples but scans every row", async () => {
    await admin.unsafe(`DELETE FROM "${destination.schemaName}".samples WHERE id=1`);
    await admin.unsafe(
      `INSERT INTO "${destination.schemaName}".samples VALUES (99,'extra',NULL,NULL,NULL),(100,'extra',NULL,NULL,NULL)`,
    );
    await admin.unsafe(`UPDATE "${destination.schemaName}".samples SET label='changed' WHERE id=2`);
    const report = await verify({ legacy, next, map, batchSize: 1, detailLimit: 1 });
    expect(report.ok).toBe(false);
    expect(report.tables[0]).toMatchObject({
      legacyCount: 6,
      nextCount: 6,
      missingCount: 2,
      extraCount: 2,
      mismatchCount: 1,
      detailsTruncated: true,
    });
    expect(report.tables[0]!.missingKeys).toHaveLength(1);
    expect(report.tables[0]!.extraKeys).toHaveLength(1);
  });
  it("does not silently round microseconds, bigint keys or nested JSON changes", async () => {
    await admin.unsafe(
      `UPDATE "${destination.schemaName}".samples SET instant=instant+interval '1 microsecond' WHERE id=1 AND part='a'`,
    );
    await admin.unsafe(
      `UPDATE "${destination.schemaName}".samples SET properties='{"integer":9007199254740992}' WHERE id=9007199254740993`,
    );
    const report = await verify({ legacy, next, map, batchSize: 2 });
    expect(report.tables[0]!.mismatchKeys).toEqual([
      ["1", "a"],
      ["9007199254740993", "large"],
    ]);
  });
  it.each(["legacy", "next"])(
    "SQL NULL versus JSON null on %s exits 1, while identical SQL NULLs match",
    async (side) => {
      await admin.unsafe(
        `UPDATE "${sourceSchema}".samples SET properties=NULL WHERE id=1 AND part='bc'`,
      );
      await admin.unsafe(
        `UPDATE "${destination.schemaName}".samples SET properties=NULL WHERE id=1 AND part='bc'`,
      );
      expect((await runCli()).status).toBe(0);
      const schema = side === "legacy" ? sourceSchema : destination.schemaName;
      await admin.unsafe(
        `UPDATE "${schema}".samples SET properties='null' WHERE id=1 AND part='bc'`,
      );
      const jsonPath = join(scratch, "null-diff.json");
      const run = await runCli(map, ["--json", jsonPath]);
      expect(run.status, run.stderr).toBe(1);
      expect(JSON.parse(await readFile(jsonPath, "utf8")).tables[0].mismatchKeys).toEqual([
        ["1", "bc"],
      ]);
      expect(run.stdout).not.toContain("member-field-sentinel");
    },
  );
  it("canonicalizes nested JSON numeric scale without rounding integers, decimals or quoted numbers", async () => {
    const left = String.raw`{"number":1.000,"nested":[1e3,9007199254740993.000,0.00000000000000000000000000000000000000012300,-0.00,{"x":-123.4500}],"string":"1.00 \\\"9007199254740993.000\\\""}`;
    const right = String.raw`{"number":1,"nested":[1000,9007199254740993,0.000000000000000000000000000000000000000123,0,{"x":-123.45}],"string":"1.00 \\\"9007199254740993.000\\\""}`;
    await admin.unsafe(
      `UPDATE "${sourceSchema}".samples SET properties=$1::text::json WHERE id=2`,
      [left],
    );
    await admin.unsafe(
      `UPDATE "${destination.schemaName}".samples SET properties=$1::text::jsonb WHERE id=2`,
      [right],
    );
    expect(
      (await admin`SELECT ${left}::text::jsonb = ${right}::text::jsonb AS equal`)[0]!.equal,
    ).toBe(true);
    expect((await runCli()).status).toBe(0);
    for (const changed of [
      right.replace("9007199254740993,", "9007199254740992,"),
      right.replace("000123,", "000124,"),
      right.replace("1.00 ", "1.0 "),
    ]) {
      await admin.unsafe(
        `UPDATE "${destination.schemaName}".samples SET properties=$1::text::jsonb WHERE id=2`,
        [changed],
      );
      const report = await verify({ legacy, next, map, batchSize: 1 });
      expect(report.tables[0]!.mismatchKeys).toEqual([["2", "c"]]);
    }
  });
  it.each(["prefer", "disable"])(
    "optional channel_binding=%s is not sent as a startup GUC",
    async (binding) => {
      const url = new URL(databaseUrl!);
      url.searchParams.set("channel_binding", binding);
      const run = await runCli(map, [], url.href);
      expect(run.status, run.stderr).toBe(0);
    },
  );
  it.each(["join_attempts", "event_search_logs", "agent_event_idempotency_keys"])(
    "%s retention retains unknown-age rows on both sides",
    async (name) => {
      const baseline = defaultTableMap({
        legacySchema: sourceSchema,
        nextSchema: destination.schemaName,
        cutoff,
      });
      const table = baseline.find((t) => t.name === name)!;
      const time = name === "event_search_logs" ? "occurred_at" : "created_at";
      const retentionMap: TableMapping[] = [
        {
          ...table,
          mappingGaps: [],
          legacy: { ...table.legacy, from: `"${sourceSchema}".retention_samples l` },
          next: { ...table.next, from: `"${destination.schemaName}".retention_samples n` },
          columns: table.columns.filter((f) => f.name === time),
        },
      ];
      await admin.unsafe(`INSERT INTO "${sourceSchema}".retention_samples (id, ${time}) VALUES
      (1,NULL),(2,'2026-07-02'),(3,'2026-07-01'),(4,'2026-09-01')`);
      await admin.unsafe(`INSERT INTO "${destination.schemaName}".retention_samples (id, ${time}) VALUES
      (2,'2026-07-02+00'),(3,'2026-06-01+00'),(4,'2026-09-01+00'),(5,NULL)`);
      const jsonPath = join(scratch, "retention-diff.json");
      const run = await runCli(retentionMap, ["--json", jsonPath]);
      expect(run.status, run.stderr).toBe(1);
      expect(JSON.parse(await readFile(jsonPath, "utf8")).tables[0]).toMatchObject({
        legacyCount: 3,
        nextCount: 3,
        missingCount: 1,
        extraCount: 1,
        mismatchCount: 0,
        missingKeys: [["1"]],
        extraKeys: [["5"]],
      });
      await admin.unsafe(
        `INSERT INTO "${destination.schemaName}".retention_samples (id) VALUES(1)`,
      );
      await admin.unsafe(`INSERT INTO "${sourceSchema}".retention_samples (id) VALUES(5)`);
      expect((await runCli(retentionMap)).status).toBe(0);
    },
  );
  it.each(["null", "duplicate"])(
    "%s keys fail loudly instead of certifying a lossy projection",
    async (kind) => {
      await admin.unsafe(
        `INSERT INTO "${sourceSchema}".samples VALUES (${kind === "null" ? "NULL" : "1"},'a','x','{}',NULL)`,
      );
      const run = await runCli();
      expect(run.status, run.stderr).toBe(2);
      expect(run.stderr).toContain(kind === "null" ? "null_key" : "duplicate_or_unordered_key");
      expect(run.stdout).toBe("");
    },
  );
  it("custom SQL cannot mutate either database and driver errors do not leak values", async () => {
    await admin.unsafe(`CREATE FUNCTION "${sourceSchema}".forbidden_write() RETURNS text LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO "${sourceSchema}".samples VALUES(88,'bad','secret-driver-error',NULL,NULL); RETURN 'bad'; END $$`);
    const malicious = structuredClone(map);
    malicious[0]!.columns[0]!.legacy = `"${sourceSchema}".forbidden_write()`;
    const run = await runCli(malicious);
    expect(run.status).toBe(2);
    expect(run.stderr.trim()).toBe("Verification failed: operation_failed");
    const count = await admin.unsafe(
      `SELECT count(*)::integer AS n FROM "${sourceSchema}".samples`,
    );
    expect(count[0]!.n).toBe(6);
  });
  it("baseline map queries all migrated tables and refuses success on unresolved gaps", async () => {
    const baseline = defaultTableMap({
      legacySchema: sourceSchema,
      nextSchema: destination.schemaName,
      cutoff,
    });
    const report = await verify({ legacy, next, map: baseline, batchSize: 2 });
    expect(report.tables).toHaveLength(12);
    expect(report.ok).toBe(false);
    expect(
      report.tables.every((t) => t.legacyCount === 0 && t.nextCount === 0 && t.mismatchCount === 0),
    ).toBe(true);
    expect(renderMarkdown(report)).toContain("Incomplete mapping");
  });
  it.each([null, "", "PRIVATE-DISPLAY-NAME", " "])(
    "baseline username follows the importer for display_name=%s without certifying membership",
    async (displayName) => {
      const username = "PRIVATE-RAW-USERNAME";
      const expected = displayName === null || displayName === "" ? username : displayName;
      await admin.unsafe(
        `INSERT INTO "${sourceSchema}".users
      (id, discord_id, username, display_name, created_at, updated_at)
      VALUES (1,'42',$1,$2,'2026-09-01','2026-09-01')`,
        [username, displayName],
      );
      await admin.unsafe(
        `INSERT INTO "${destination.schemaName}".users
      (id, username, created_at, updated_at)
      VALUES ('42',$1,'2026-09-01+00','2026-09-01+00')`,
        [expected],
      );
      const baseline = defaultTableMap({
        legacySchema: sourceSchema,
        nextSchema: destination.schemaName,
        cutoff,
      });
      const usersMap = baseline.filter((t) => t.name === "users");
      const matched = await verify({ legacy, next, map: usersMap, batchSize: 1 });
      expect(matched.tables[0]).toMatchObject({
        legacyCount: 1,
        nextCount: 1,
        missingCount: 0,
        extraCount: 0,
        mismatchCount: 0,
      });
      expect(matched.tables[0]!.mappingGaps.join()).toContain("member");
      expect(matched.ok).toBe(false); // Name parity must not resolve the membership-policy gap.
      const wrong = expected === username ? "PRIVATE-WRONG-USERNAME" : username;
      await admin.unsafe(`UPDATE "${destination.schemaName}".users SET username=$1 WHERE id='42'`, [
        wrong,
      ]);
      const changed = await verify({ legacy, next, map: usersMap, batchSize: 1 });
      expect(changed.tables[0]!.mismatchKeys).toEqual([["42"]]);
      for (const output of [
        JSON.stringify(matched),
        renderMarkdown(matched),
        JSON.stringify(changed),
        renderMarkdown(changed),
      ]) {
        expect(output).not.toContain("PRIVATE-");
      }
    },
  );
  it("baseline natural keys remap users, event parents, RSVPs and audit subjects without losing instants", async () => {
    const l = `"${sourceSchema}"`;
    const n = `"${destination.schemaName}"`;
    await admin.unsafe(`
      INSERT INTO ${l}.users VALUES(1,'42','synthetic',NULL,NULL,false,'2026-09-01 01:02:03.123456','2026-09-01 01:02:03.123456');
      INSERT INTO ${n}.users VALUES('42','synthetic',NULL,true,'2026-09-01 01:02:03.123456+00','2026-09-01 01:02:03.123456+00');
      INSERT INTO ${l}.profiles VALUES(11,1,'private-bio','["game-b","game-a"]','UTC','2026-09-01 01:02:03','2026-09-01 01:02:03');
      INSERT INTO ${n}.profiles VALUES('42','private-bio','["game-b","game-a"]','UTC','2026-09-01 01:02:03+00','2026-09-01 01:02:03+00');
      INSERT INTO ${l}.events(id,event_key,title,starts_at,ends_at,created_by,parent_event_id,recurrence_ends_on,created_at,updated_at)
        VALUES(10,'parent','synthetic-parent','2026-09-01 01:02:03.123456+00','2026-09-01 02:02:03+00',1,NULL,'2026-09-30','2026-09-01','2026-09-01'),
              (20,'child','synthetic-child','2026-09-02 01:02:03+00','2026-09-02 02:02:03+00',1,10,NULL,'2026-09-01','2026-09-01');
      INSERT INTO ${n}.events(id,event_key,title,starts_at,ends_at,created_by,parent_event_id,recurrence_ends_on,created_at,updated_at)
        VALUES(100,'parent','synthetic-parent','2026-09-01 01:02:03.123456+00','2026-09-01 02:02:03+00','42',NULL,'2026-09-30','2026-09-01+00','2026-09-01+00'),
              (200,'child','synthetic-child','2026-09-02 01:02:03+00','2026-09-02 02:02:03+00','42',100,NULL,'2026-09-01+00','2026-09-01+00');
      INSERT INTO ${l}.rsvps VALUES(12,20,1,'waitlisted','2026-09-01 01:02:03.123456','2026-09-01','2026-09-01');
      INSERT INTO ${n}.rsvps(id,event_id,user_id,status,synced_to_discord_at,created_at,updated_at)
        VALUES(120,200,'42','waitlisted','2026-09-01 01:02:03.123456+00','2026-09-01+00','2026-09-01+00');
      INSERT INTO ${l}.member_data_access_logs VALUES(1,'42',1,'Users','read','[1]',1,'admin.users','2026-09-01');
      INSERT INTO ${n}.member_data_access_logs VALUES(1,'42','42','Users','read','["42"]',1,'admin.users','2026-09-01+00');
      INSERT INTO ${l}.join_attempts VALUES(1,'joined',NULL,NULL,'42','2026-07-02','2026-07-02'),(2,'joined',NULL,NULL,'42','2026-07-01','2026-07-01');
      INSERT INTO ${n}.join_attempts(id,outcome,discord_id,created_at) VALUES(1,'joined','42','2026-07-02+00'),(2,'denied','42','2026-07-01+00');
      INSERT INTO ${l}.event_search_logs VALUES(1,'private query',2,'2026-07-02'),(2,'ignored old',0,'2026-07-01');
      INSERT INTO ${n}.event_search_logs VALUES(1,'private query',2,'2026-07-02+00'),(2,'old mismatch ignored',1,'2026-07-01+00');
    `);
    const baseline = defaultTableMap({
      legacySchema: sourceSchema,
      nextSchema: destination.schemaName,
      cutoff,
    });
    const report = await verify({ legacy, next, map: baseline, batchSize: 1 });
    expect(report.tables.filter((t) => t.missingCount || t.extraCount || t.mismatchCount)).toEqual(
      [],
    );
    expect(report.tables.find((t) => t.table === "events")!.legacyCount).toBe(2);
    expect(report.tables.find((t) => t.table === "join_attempts")!.legacyCount).toBe(1);
    expect(report.tables.find((t) => t.table === "event_search_logs")!.nextCount).toBe(1);
    expect(report.ok).toBe(false); // Explicit gaps still prevent cutover certification.
    expect(JSON.stringify(report)).not.toContain("private-bio");
    // Changing only a remapped relationship must fail the row hash.
    await admin.unsafe(`UPDATE ${n}.events SET parent_event_id=NULL WHERE id=200`);
    // Audit rows are append-only (1018): only the owner, with the guard off, can tamper.
    await admin.begin(async (tx) => {
      await tx.unsafe(
        `ALTER TABLE ${n}.member_data_access_logs DISABLE TRIGGER member_data_access_logs_append_only`,
      );
      await tx.unsafe(
        `UPDATE ${n}.member_data_access_logs SET subject_user_ids='["43"]' WHERE id=1`,
      );
      await tx.unsafe(
        `ALTER TABLE ${n}.member_data_access_logs ENABLE TRIGGER member_data_access_logs_append_only`,
      );
    });
    const changed = await verify({ legacy, next, map: baseline, batchSize: 1 });
    expect(changed.tables.find((t) => t.table === "events")!.mismatchKeys).toEqual([["child"]]);
    expect(changed.tables.find((t) => t.table === "member_data_access_logs")!.mismatchKeys).toEqual(
      [["1"]],
    );
  });
});
