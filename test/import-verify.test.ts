import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compareKeys, quoteIdentifier, renderMarkdown, validateMap, verify, type TableMapping, type VerificationReport } from "../bin/import/verify.mjs";
import { defaultTableMap } from "../bin/import/verify-map.mjs";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";

const script = fileURLToPath(new URL("../bin/import/verify.mjs", import.meta.url));
const cutoff = "2026-07-02T00:00:00Z";
const fixtureMap = (left = "legacy", right = "next"): TableMapping[] => [{
  name: "samples", legacy: { from: `${quoteIdentifier(left)}.samples l` },
  next: { from: `${quoteIdentifier(right)}.samples n` },
  keys: [{ name: "id", legacy: "l.id", next: "n.id" }, { name: "part", legacy: "l.part", next: "n.part" }],
  columns: [{ name: "label", legacy: "lower(l.label)", next: "n.label" },
    { name: "properties", legacy: "l.properties::jsonb", next: "n.properties" },
    { name: "instant", legacy: "l.instant AT TIME ZONE 'UTC'", next: "n.instant" }],
}];

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
  expect(map.map((t) => t.name)).toEqual(["users", "profiles", "events", "rsvps", "featured_contents", "join_attempts",
    "event_search_logs", "member_data_access_logs", "activity_log", "agent_event_grants", "agent_event_audits", "agent_event_idempotency_keys"]);
  expect(() => defaultTableMap()).toThrow("fixed_cutoff_required");
  expect(() => defaultTableMap({ cutoff: "2026-07-02';SELECT 1--" })).toThrow("fixed_cutoff_required");
  expect(map.find((t) => t.name === "users")!.mappingGaps!.join()).toContain("member");
  expect(map.find((t) => t.name === "agent_event_grants")!.columns.find((f) => f.name === "disabled")!.legacy).toBe("TRUE");
});

it("CLI rejects missing env/URL arguments without printing a connection string or secret", () => {
  for (const args of [[], ["--database-url", "postgres://secret@production.example.test/data"]]) {
    const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: {} });
    expect(run.status).toBe(2);
    expect(run.stderr).not.toContain("secret");
    expect(run.stderr).not.toContain("production.example.test");
    expect(run.stdout).toBe("");
  }
  expect(spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", env: {} }).status).toBe(0);
});

it("markdown escapes keys as data and never includes member payloads", () => {
  const report: VerificationReport = { version: 1, ok: false, batchSize: 1, detailLimit: 1, tables: [{
    table: "samples", keyColumns: ["id"], comparedColumns: ["bio"], legacyCount: 1, nextCount: 0,
    missingCount: 1, extraCount: 0, mismatchCount: 0, missingKeys: [["<img|`\n"]], extraKeys: [], mismatchKeys: [],
    mappingGaps: [], detailsTruncated: false,
  }] };
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
    if (url.hostname === "agent-testdb" && url.pathname !== "/two_web_next") throw new Error("verifier fixtures require two_web_next");
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
      await tx.unsafe(await readFile(new URL("./fixtures/legacy/verify.sql", import.meta.url), "utf8"));
    });
    await admin.unsafe(`CREATE TABLE "${sourceSchema}".samples (id bigint, part text, label text, properties json, instant timestamp)`);
    await admin.unsafe(`CREATE TABLE "${destination.schemaName}".samples (id bigint, part text, label text, properties jsonb, instant timestamptz)`);
    map = fixtureMap(sourceSchema, destination.schemaName);
    scratch = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "verify-fixture-"));
  }, 30000);
  afterAll(async () => {
    await Promise.allSettled([legacy?.end(), next?.end()]);
    try {
      if (sourceCreated) await admin.unsafe(`DROP SCHEMA "${sourceSchema}" CASCADE`);
      if (destination) await destination.dispose();
      if (scratch) await rm(scratch, { recursive: true, force: true });
    } finally { await admin?.end(); }
  });
  beforeEach(async () => {
    await admin.unsafe(`TRUNCATE "${sourceSchema}".samples, "${destination.schemaName}".samples`);
    await admin.unsafe(`INSERT INTO "${sourceSchema}".samples VALUES
      (1, 'a', 'MEMBER-FIELD-SENTINEL', '{"b":2,"a":1}', '2026-01-01 02:03:04.123456'),
      (1, 'bc', NULL, 'null', NULL), (2, 'c', 'UNCHANGED', '{"nested":{"z":0,"a":1}}', NULL),
      (3, U&'\\E000', 'UNICODE', '{}', NULL), (3, U&'\\+010000', 'UNICODE', '{}', NULL),
      (9007199254740993, 'large', 'LARGE', '{"integer":9007199254740993}', NULL)`);
    await admin.unsafe(`INSERT INTO "${destination.schemaName}".samples
      SELECT id, part, lower(label), properties::jsonb, instant AT TIME ZONE 'UTC' FROM "${sourceSchema}".samples`);
  });
  const runCli = async (tableMap = map, args: string[] = []) => {
    const path = join(scratch, "map.json");
    await writeFile(path, JSON.stringify(tableMap));
    return spawnSync(process.execPath, [script, "--map", path, "--batch-size", "2", ...args], {
      encoding: "utf8", timeout: 30000,
      env: { LEGACY_DATABASE_URL: databaseUrl!, DATABASE_URL: databaseUrl!, PGPASSWORD: "must-not-inherit" },
    });
  };
  it("identical rows exit 0 across batches and emit JSON plus markdown without fields", async () => {
    const jsonPath = join(scratch, "report.json");
    const mdPath = join(scratch, "report.md");
    const run = await runCli(map, ["--json", jsonPath, "--markdown", mdPath]);
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(await readFile(jsonPath, "utf8"));
    expect(report.ok).toBe(true);
    expect(report.tables[0]).toMatchObject({ legacyCount: 6, nextCount: 6, missingCount: 0, extraCount: 0, mismatchCount: 0 });
    expect(await readFile(mdPath, "utf8")).toContain("MATCH");
    for (const output of [run.stdout, run.stderr, await readFile(jsonPath, "utf8"), await readFile(mdPath, "utf8")]) {
      expect(output.toLowerCase()).not.toContain("member-field-sentinel");
      expect(output).not.toContain("must-not-inherit");
      expect(output).not.toContain("postgres://");
      expect(output).not.toContain("123456");
    }
  });
  it.each(["missing", "extra", "changed"])("%s rows exit 1 and identify the key, not its values", async (kind) => {
    if (kind === "missing") await admin.unsafe(`DELETE FROM "${destination.schemaName}".samples WHERE id=1 AND part='a'`);
    if (kind === "extra") await admin.unsafe(`INSERT INTO "${destination.schemaName}".samples VALUES(99,'extra','private-extra','{}',NULL)`);
    if (kind === "changed") await admin.unsafe(`UPDATE "${destination.schemaName}".samples SET label='private-changed' WHERE id=1 AND part='a'`);
    const jsonPath = join(scratch, "diff.json");
    const run = await runCli(map, ["--json", jsonPath]);
    expect(run.status, run.stderr).toBe(1);
    const table = JSON.parse(await readFile(jsonPath, "utf8")).tables[0];
    const category = kind === "changed" ? "mismatch" : kind;
    expect(table[`${category}Count`]).toBe(1);
    expect(table[`${category}Keys`]).toEqual([kind === "extra" ? ["99", "extra"] : ["1", "a"]]);
    expect(run.stdout).not.toContain("private-");
  });
  it("reports simultaneous diffs with equal counts, limits samples but scans every row", async () => {
    await admin.unsafe(`DELETE FROM "${destination.schemaName}".samples WHERE id=1`);
    await admin.unsafe(`INSERT INTO "${destination.schemaName}".samples VALUES (99,'extra',NULL,NULL,NULL),(100,'extra',NULL,NULL,NULL)`);
    await admin.unsafe(`UPDATE "${destination.schemaName}".samples SET label='changed' WHERE id=2`);
    const report = await verify({ legacy, next, map, batchSize: 1, detailLimit: 1 });
    expect(report.ok).toBe(false);
    expect(report.tables[0]).toMatchObject({ legacyCount: 6, nextCount: 6, missingCount: 2, extraCount: 2, mismatchCount: 1, detailsTruncated: true });
    expect(report.tables[0]!.missingKeys).toHaveLength(1);
    expect(report.tables[0]!.extraKeys).toHaveLength(1);
  });
  it("does not silently round microseconds, bigint keys or nested JSON changes", async () => {
    await admin.unsafe(`UPDATE "${destination.schemaName}".samples SET instant=instant+interval '1 microsecond' WHERE id=1 AND part='a'`);
    await admin.unsafe(`UPDATE "${destination.schemaName}".samples SET properties='{"integer":9007199254740992}' WHERE id=9007199254740993`);
    const report = await verify({ legacy, next, map, batchSize: 2 });
    expect(report.tables[0]!.mismatchKeys).toEqual([["1", "a"], ["9007199254740993", "large"]]);
  });
  it.each(["null", "duplicate"])("%s keys fail loudly instead of certifying a lossy projection", async (kind) => {
    await admin.unsafe(`INSERT INTO "${sourceSchema}".samples VALUES (${kind === "null" ? "NULL" : "1"},'a','x','{}',NULL)`);
    const run = await runCli();
    expect(run.status, run.stderr).toBe(2);
    expect(run.stderr).toContain(kind === "null" ? "null_key" : "duplicate_or_unordered_key");
    expect(run.stdout).toBe("");
  });
  it("custom SQL cannot mutate either database and driver errors do not leak values", async () => {
    await admin.unsafe(`CREATE FUNCTION "${sourceSchema}".forbidden_write() RETURNS text LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO "${sourceSchema}".samples VALUES(88,'bad','secret-driver-error',NULL,NULL); RETURN 'bad'; END $$`);
    const malicious = structuredClone(map);
    malicious[0]!.columns[0]!.legacy = `"${sourceSchema}".forbidden_write()`;
    const run = await runCli(malicious);
    expect(run.status).toBe(2);
    expect(run.stderr.trim()).toBe("Verification failed: operation_failed");
    const count = await admin.unsafe(`SELECT count(*)::integer AS n FROM "${sourceSchema}".samples`);
    expect(count[0]!.n).toBe(6);
  });
  it("baseline map queries all migrated tables and refuses success on unresolved gaps", async () => {
    const baseline = defaultTableMap({ legacySchema: sourceSchema, nextSchema: destination.schemaName, cutoff });
    const report = await verify({ legacy, next, map: baseline, batchSize: 2 });
    expect(report.tables).toHaveLength(12);
    expect(report.ok).toBe(false);
    expect(report.tables.every((t) => t.legacyCount === 0 && t.nextCount === 0 && t.mismatchCount === 0)).toBe(true);
    expect(renderMarkdown(report)).toContain("Incomplete mapping");
  });
});
