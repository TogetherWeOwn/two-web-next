// Chains the real audit importer into the verifier on synthetic fixtures: the five
// audit tables must compare every column the importer preserves, with no mapping gaps.
// Mismatches are injected on the legacy side after a clean import; the audit tables
// on the Next side are append-only, so the legacy snapshot is the one that drifts.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderMarkdown, verify, type VerificationReport } from "../bin/import/verify.mjs";
import { defaultTableMap } from "../bin/import/verify-map.mjs";
import { AUDIT_TABLES, truncateLiftingAuditGuard } from "./helpers/audit-rows";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
// @ts-expect-error Standalone operator CLI has no declaration file.
import { IDEMPOTENCY_RETENTION_DAYS, importAudit } from "../bin/import/audit.mjs";

const databaseUrl = process.env.DATABASE_URL;
const now = new Date("2026-09-30T00:00:00Z");
// The importer's retention window; verify must share it as its fixed cutoff.
const cutoff = new Date(now.getTime() - IDEMPOTENCY_RETENTION_DAYS * 86400000).toISOString();
const names = [
  "member_data_access_logs",
  "activity_log",
  "agent_event_grants",
  "agent_event_audits",
  "agent_event_idempotency_keys",
] as const;
type AuditName = (typeof names)[number];

const grantA = "22222222-2222-4222-8222-222222222222";
const grantB = "33333333-3333-4333-8333-333333333333";
const hashA = "a".repeat(64);
// Extra synthetic rows on top of test/fixtures/legacy/audit.sql: an out-of-order
// subject array, and replay keys on both sides of the retention window.
const extraRows = (schema: string) => `
  INSERT INTO "${schema}".member_data_access_logs VALUES
    (92003, '100000000000000002', 91001, 'member', 'list', '[91002, 91001]', 2, NULL,
     '2026-09-03 10:11:12.987654');
  INSERT INTO "${schema}".agent_event_idempotency_keys VALUES
    (94003, '${grantA}', 'synthetic-null-clock', repeat('e', 64), 200, '{"ok":true}', NULL, NULL, NULL),
    (94004, '${grantA}', 'synthetic-infinity', repeat('e', 64), 200, '{"ok":true}', NULL, 'infinity', NULL),
    (94005, '${grantA}', 'synthetic-at-cutoff', repeat('f', 64), 200, '{"ok":true}', NULL,
     '2026-07-02 00:00:00', '2026-07-02 00:00:00.000001');`;

describe.skipIf(!databaseUrl)("importer output verifies clean for the audit tables", () => {
  let fixture: MemberDataFixture;
  let legacy: postgres.Sql;
  let target: postgres.Sql;
  let schema: string;

  beforeAll(async () => {
    const url = testDatabaseUrl(databaseUrl!); // Refuse before creating a driver or schema.
    fixture = await createMemberDataFixture(url.href);
    // Raw drivers like the CLIs; the fixture's Drizzle client overrides serializers.
    const config = { max: 1, port: 5432, password: () => url.password, onnotice: () => {} };
    legacy = postgres(url.href, { ...config, connection: { timezone: "Pacific/Honolulu" } });
    target = postgres(url.href, {
      ...config,
      connection: { search_path: fixture.schemaName, timezone: "Asia/Tokyo" },
    });
  }, 30000);

  afterAll(async () => {
    await Promise.allSettled([legacy?.end(), target?.end()]);
    await fixture?.dispose();
  });

  beforeEach(async () => {
    schema = `verify_audit_l_${randomUUID().replaceAll("-", "")}`;
    const ddl = await readFile(new URL("./fixtures/legacy/audit.sql", import.meta.url), "utf8");
    await legacy.unsafe(
      ddl
        .replaceAll("CREATE SCHEMA legacy;", `CREATE SCHEMA "${schema}";`)
        .replaceAll("legacy.", `"${schema}".`),
    );
    await legacy.unsafe(extraRows(schema));
    // Owner-only reset lifting the TRUNCATE guard (drizzle/1018); the importer never does this.
    await truncateLiftingAuditGuard(
      fixture.client,
      AUDIT_TABLES,
      `TRUNCATE ${names.map((n) => `"${n}"`).join(", ")} RESTART IDENTITY CASCADE`,
    );
  });

  afterEach(async () => {
    await legacy.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });

  const importAll = () =>
    importAudit({
      legacy,
      target,
      legacySchema: schema,
      targetSchema: fixture.schemaName,
      dryRun: false,
      now,
    });

  const verifyAudit = (): Promise<VerificationReport> =>
    verify({
      legacy,
      next: target,
      batchSize: 1,
      map: defaultTableMap({
        legacySchema: schema,
        nextSchema: fixture.schemaName,
        cutoff,
      }).filter((t) => (names as readonly string[]).includes(t.name)),
    });

  const table = (report: VerificationReport, name: AuditName) =>
    report.tables.find((t) => t.table === name)!;

  const importedClean = async () => {
    await importAll();
    return verifyAudit();
  };

  it("reports zero diffs and no mapping gaps for every audit table after a real import", async () => {
    const counts = await importAll();
    // Three of the five fixture keys sit outside the window: old, NULL clock, infinity.
    expect(counts.tables.agent_event_idempotency_keys).toMatchObject({
      read: 5,
      inserted: 2,
      expired: 3,
    });
    const report = await verifyAudit();
    expect(report.tables.map((t) => t.table)).toEqual([...names]);
    for (const t of report.tables) {
      expect(t, t.table).toMatchObject({
        missingCount: 0,
        extraCount: 0,
        mismatchCount: 0,
        mappingGaps: [],
      });
      expect(t.legacyCount, t.table).toBe(t.nextCount);
    }
    expect(report.tables.map((t) => t.legacyCount)).toEqual([3, 2, 2, 2, 2]);
    expect(report.ok).toBe(true);
  });

  it("compares every preserved column", async () => {
    const report = await verifyAudit();
    const compared = (name: AuditName) => table(report, name).comparedColumns;
    expect(compared("member_data_access_logs")).toEqual([
      "viewer_discord_id",
      "resource",
      "action",
      "subject_count",
      "route",
      "viewer_user_id",
      "occurred_at",
      "subject_user_ids",
    ]);
    expect(compared("activity_log")).toEqual([
      "log_name",
      "description",
      "subject_type",
      "subject_id",
      "causer_type",
      "causer_id",
      "event",
      "batch_uuid",
      "properties",
      "created_at",
      "updated_at",
    ]);
    expect(compared("agent_event_grants")).toEqual([
      "agent_id",
      "company_id",
      "guild_id",
      "verifier_hash",
      "max_events",
      "expires_at",
      "created_at",
      "updated_at",
      "disabled",
    ]);
    expect(compared("agent_event_audits")).toEqual([
      "grant_id",
      "operation",
      "event_key",
      "idempotency_key",
      "payload_digest",
      "request_id",
      "result",
      "reason_code",
      "discord_event_id",
      "created_at",
      "updated_at",
    ]);
    expect(compared("agent_event_idempotency_keys")).toEqual([
      "grant_id",
      "key",
      "payload_digest",
      "status",
      "event_key",
      "body",
      "created_at",
      "updated_at",
    ]);
  });

  it("keeps legacy user references as legacy IDs, array order and NULL log names", async () => {
    await importAll();
    const [view] = await target.unsafe(
      `SELECT viewer_user_id, subject_user_ids::text AS subjects
         FROM "${fixture.schemaName}".member_data_access_logs WHERE id = 92003`,
    );
    expect(view).toEqual({ viewer_user_id: "91001", subjects: "[91002, 91001]" });
    const [log] = await target.unsafe(
      `SELECT log_name, updated_at, causer_type, event, batch_uuid
         FROM "${fixture.schemaName}".activity_log WHERE id = 93002`,
    );
    expect(log).toEqual({
      log_name: null,
      updated_at: null,
      causer_type: null,
      event: null,
      batch_uuid: null,
    });
    expect(table(await verifyAudit(), "activity_log")).toMatchObject({ mismatchCount: 0 });
  });

  // Every column the importer preserves, drifted on the legacy side after a clean import.
  const drifts: [AuditName, string, string, string][] = [
    ["member_data_access_logs", "viewer_user_id", "viewer_user_id = NULL", "92001"],
    ["member_data_access_logs", "subject_user_ids", "subject_user_ids = '[91001, 91002]'", "92003"],
    ["activity_log", "log_name (NULL is not default)", "log_name = 'default'", "93002"],
    ["activity_log", "subject_id", "subject_id = 91002", "93001"],
    ["activity_log", "causer_type", "causer_type = 'App\\Models\\Other'", "93001"],
    ["activity_log", "causer_id", "causer_id = 91002", "93001"],
    ["activity_log", "event", "event = 'updated'", "93001"],
    ["activity_log", "batch_uuid", "batch_uuid = '44444444-4444-4444-8444-444444444444'", "93001"],
    ["activity_log", "properties", `properties = '{"attributes":{"synthetic":false}}'`, "93001"],
    ["agent_event_grants", "max_events", "max_events = 5", grantA],
    ["agent_event_grants", "updated_at", "updated_at = '2026-09-01 10:11:12.234568'", grantA],
    ["agent_event_audits", "discord_event_id", "discord_event_id = '100000000000000009'", "95001"],
    ["agent_event_audits", "updated_at", "updated_at = '2026-09-29 00:00:00.234568'", "95001"],
    [
      "agent_event_idempotency_keys",
      "updated_at",
      "updated_at = '2026-09-29 00:00:00.234568'",
      "94001",
    ],
  ];

  it.each(drifts)("%s: a drifted %s is a mismatch on that row only", async (name, _, set, id) => {
    expect((await importedClean()).ok).toBe(true);
    await legacy.unsafe(`UPDATE "${schema}"."${name}" SET ${set} WHERE id = '${id}'`);
    const report = await verifyAudit();
    expect(table(report, name)).toMatchObject({
      missingCount: 0,
      extraCount: 0,
      mismatchCount: 1,
      mismatchKeys: [[id]],
      mappingGaps: [],
    });
    for (const other of report.tables.filter((t) => t.table !== name))
      expect(other, other.table).toMatchObject({ mismatchCount: 0, mappingGaps: [] });
  });

  it("reports rows missing from Next and extra in Next, with no mapping gaps", async () => {
    await importAll();
    await legacy.unsafe(
      `INSERT INTO "${schema}".agent_event_audits (id, operation, request_id, result)
         VALUES (95099, 'create', 'synthetic-late', 'denied')`,
    );
    await legacy.unsafe(`DELETE FROM "${schema}".member_data_access_logs WHERE id = 92002`);
    const report = await verifyAudit();
    expect(table(report, "agent_event_audits")).toMatchObject({
      missingCount: 1,
      missingKeys: [["95099"]],
      mappingGaps: [],
    });
    expect(table(report, "member_data_access_logs")).toMatchObject({
      extraCount: 1,
      extraKeys: [["92002"]],
      mappingGaps: [],
    });
    expect(report.ok).toBe(false);
  });

  it("selects replay keys exactly as the importer does", async () => {
    const report = await importedClean();
    const keys = table(report, "agent_event_idempotency_keys");
    // 94001 (recent) and 94005 (exactly at the cutoff) survive; the old, NULL-clock
    // and infinite keys are counted expired by the importer and absent from both sides.
    expect(keys).toMatchObject({ legacyCount: 2, nextCount: 2, missingCount: 0, extraCount: 0 });
    const rows = await target.unsafe(
      `SELECT id::text FROM "${fixture.schemaName}".agent_event_idempotency_keys ORDER BY id`,
    );
    expect(rows.map((r) => r.id)).toEqual(["94001", "94005"]);
  });

  it("never emits verifier hashes, replay bodies or compared values, even for drifted rows", async () => {
    await importAll();
    await legacy.unsafe(
      `UPDATE "${schema}".agent_event_grants SET verifier_hash = repeat('9', 64) WHERE id = '${grantB}'`,
    );
    await legacy.unsafe(
      `UPDATE "${schema}".agent_event_idempotency_keys SET body = '{"BODY-SENTINEL":1}' WHERE id = 94001`,
    );
    await legacy.unsafe(
      `UPDATE "${schema}".activity_log SET description = 'DESCRIPTION-SENTINEL' WHERE id = 93001`,
    );
    const report = await verifyAudit();
    expect(table(report, "agent_event_grants").mismatchKeys).toEqual([[grantB]]);
    expect(table(report, "agent_event_idempotency_keys").mismatchKeys).toEqual([["94001"]]);
    expect(table(report, "activity_log").mismatchKeys).toEqual([["93001"]]);
    for (const output of [JSON.stringify(report), renderMarkdown(report)]) {
      for (const secret of [
        hashA,
        "9".repeat(64),
        "BODY-SENTINEL",
        "DESCRIPTION-SENTINEL",
        "synthetic-agent",
        "synthetic-recent",
        "100000000000000001",
      ])
        expect(output).not.toContain(secret);
    }
  });
});
