import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// The operator CLI is standalone JS, not part of the Workers TypeScript bundle.
// @ts-expect-error Standalone import tooling has no declaration file.
import { importAudit } from "../bin/import/audit.mjs";

// DB-free coverage of the legacy-audit -> Next-schema mapping. The DB-gated
// suites (import-audit-db, import-audit-datestyle-db) prove the same mapping
// against real Postgres only when AUDIT_IMPORT_TEST_DATABASE_URL is set; this
// suite drives importAudit with in-memory fake postgres.js clients instead, so
// it runs in the default CI pass with no env var and no connection attempt.
// The fakes answer with the rows the generated SELECT projection would return
// for the checked-in fixture inserts (ids/timestamps/JSON as text), and record
// every statement + bound parameter for the mapping assertions below.

const TABLES = [
  "member_data_access_logs",
  "activity_log",
  "agent_event_grants",
  "agent_event_audits",
  "agent_event_idempotency_keys",
] as const;
const now = new Date("2026-09-30T00:00:00Z");

// ---- expected schema, derived from the checked-in legacy fixture ----------

const fixtureSql = readFileSync(new URL("./fixtures/legacy/audit.sql", import.meta.url), "utf8");

function fixtureColumnTypes(table: string): Map<string, string> {
  const block = fixtureSql.match(
    new RegExp(`CREATE TABLE legacy\\.${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  expect(block, `fixture DDL for ${table}`).not.toBeNull();
  const columns = new Map<string, string>();
  for (const line of block![1]!.split("\n")) {
    const parsed = line.trim().match(/^([a-z_]+) ([a-z]+)/);
    if (parsed) columns.set(parsed[1]!, parsed[2]!);
  }
  return columns;
}

// ---- projected source rows for the fixture INSERTs -------------------------
// Shape mirrors the generated SELECT: timestamp columns come back as UTC text
// with full microseconds, bigint ids/references and JSON as text, the rest in
// their native driver types. import_unused/import_expired are the SELECT's
// computed flags.

type Row = Record<string, unknown>;

function fixtureRows(): Record<(typeof TABLES)[number], Row[]> {
  return {
    member_data_access_logs: [
      {
        id: "92001",
        viewer_discord_id: "100000000000000001",
        viewer_user_id: "91001",
        resource: "member",
        action: "view",
        subject_user_ids: "[91001]",
        subject_count: 1,
        route: "admin.members.view",
        occurred_at: "2026-09-01 10:11:12.123456+00",
      },
      {
        id: "92002",
        viewer_discord_id: "unauthenticated",
        viewer_user_id: null,
        resource: "member",
        action: "list",
        subject_user_ids: "[]",
        subject_count: 0,
        route: null,
        occurred_at: "2026-09-02 10:11:12.654321+00",
      },
    ],
    activity_log: [
      {
        id: "93001",
        log_name: "default",
        description: "Synthetic member viewed",
        subject_type: "App\\Models\\User",
        subject_id: "91001",
        causer_type: "App\\Models\\User",
        causer_id: "91001",
        properties: '{"attributes":{"synthetic":true}}',
        created_at: "2026-09-01 10:11:12.123456+00",
        updated_at: "2026-09-01 10:11:12.234567+00",
        event: "viewed",
        batch_uuid: "11111111-1111-4111-8111-111111111111",
      },
      {
        id: "93002",
        log_name: null,
        description: "Synthetic system action",
        subject_type: null,
        subject_id: null,
        causer_type: null,
        causer_id: null,
        properties: null,
        created_at: "2026-09-02 10:11:12.654321+00",
        updated_at: null,
        event: null,
        batch_uuid: null,
      },
    ],
    agent_event_grants: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        agent_id: "synthetic-agent",
        company_id: "synthetic-company",
        guild_id: "100000000000000002",
        verifier_hash: "a".repeat(64),
        expires_at: "2026-10-10 00:00:00.345678+00",
        disabled_at: null,
        max_events: 1,
        created_at: "2026-09-01 10:11:12.123456+00",
        updated_at: "2026-09-01 10:11:12.234567+00",
        import_unused: false,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        agent_id: "synthetic-disabled-agent",
        company_id: "synthetic-company",
        guild_id: "100000000000000002",
        verifier_hash: "b".repeat(64),
        expires_at: null,
        disabled_at: "2026-09-02 00:00:00.456789+00",
        max_events: 1,
        created_at: "2026-09-01 10:11:12.123456+00",
        updated_at: "2026-09-02 00:00:00.234567+00",
        import_unused: false,
      },
    ],
    agent_event_audits: [
      {
        id: "95001",
        grant_id: "22222222-2222-4222-8222-222222222222",
        operation: "create",
        event_key: "01K5SYNTHETIC0000000000001",
        idempotency_key: "synthetic-recent",
        payload_digest: "c".repeat(64),
        request_id: "synthetic-request",
        result: "accepted",
        reason_code: null,
        discord_event_id: "100000000000000003",
        created_at: "2026-09-29 00:00:00.123456+00",
        updated_at: "2026-09-29 00:00:00.234567+00",
      },
      {
        id: "95002",
        grant_id: null,
        operation: "create",
        event_key: null,
        idempotency_key: null,
        payload_digest: null,
        request_id: "synthetic-denial",
        result: "denied",
        reason_code: "missing_credential",
        discord_event_id: null,
        created_at: "2026-09-29 01:00:00.654321+00",
        updated_at: null,
      },
    ],
    agent_event_idempotency_keys: [
      {
        id: "94001",
        grant_id: "22222222-2222-4222-8222-222222222222",
        key: "synthetic-recent",
        payload_digest: "c".repeat(64),
        status: 201,
        body: '{"event_key":"01K5SYNTHETIC0000000000001"}',
        event_key: "01K5SYNTHETIC0000000000001",
        created_at: "2026-09-29 00:00:00.123456+00",
        updated_at: "2026-09-29 00:00:00.234567+00",
        import_expired: false,
      },
      {
        id: "94002",
        grant_id: "22222222-2222-4222-8222-222222222222",
        key: "synthetic-old",
        payload_digest: "d".repeat(64),
        status: 200,
        body: '{"ok":true}',
        event_key: null,
        created_at: "2026-01-01 00:00:00+00",
        updated_at: "2026-01-01 00:00:00+00",
        import_expired: true,
      },
    ],
  };
}

// ---- fake postgres.js clients -----------------------------------------------

type Call = { kind: "tag" | "unsafe"; sql: string; params: unknown[] };
type Insert = { table: string; columns: string[]; casts: string[]; params: unknown[] };

function fakeClient(handlers: {
  tag: (sql: string) => unknown[];
  unsafe: (sql: string, params: unknown[]) => unknown[];
}) {
  const calls: Call[] = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    calls.push({ kind: "tag", sql, params: values });
    return handlers.tag(sql);
  };
  const callable = Object.assign(tag, {
    unsafe: async (sql: string, params: unknown[] = []) => {
      calls.push({ kind: "unsafe", sql, params });
      return handlers.unsafe(sql, params);
    },
    begin: async (_options: unknown, run: (tx: unknown) => Promise<unknown>) => run(callable),
  });
  return { client: callable, calls };
}

type RunOverrides = {
  rows?: Record<string, Row[]>;
  existing?: Set<string>;
  ownershipAvailable?: boolean;
  dryRun?: boolean;
  enableGrants?: boolean;
  schemas?: { legacySchema: string; targetSchema: string };
};

async function runImport(overrides: RunOverrides = {}) {
  const rows: Record<string, Row[]> = overrides.rows ?? fixtureRows();
  const existing = overrides.existing ?? new Set<string>();
  const pages = new Map<string, number>();
  const inserts: Insert[] = [];

  const source = fakeClient({
    tag: (sql) =>
      sql.includes("pg_attribute") ? [{ available: overrides.ownershipAvailable ?? false }] : [],
    unsafe: (sql) => {
      const table = /FROM "legacy"\."([a-z_]+)" AS source/.exec(sql)?.[1];
      if (!table) throw new Error(`unrouted source statement: ${sql.slice(0, 80)}`);
      const page = pages.get(table) ?? 0;
      pages.set(table, page + 1);
      return page === 0 ? structuredClone(rows[table] ?? []) : [];
    },
  });
  const dest = fakeClient({
    tag: (sql) => (sql.includes("pg_get_serial_sequence") ? [{ name: '"public"."fake_seq"' }] : []),
    unsafe: (sql, params) => {
      if (sql.startsWith("LOCK TABLE") || sql.startsWith("SELECT setval")) return [];
      const probe = /SELECT id::text FROM "public"\."([a-z_]+)"/.exec(sql);
      if (probe) return existing.has(`${probe[1]}:${String(params[0])}`) ? [{ id: params[0] }] : [];
      const insert = /INSERT INTO "public"\."([a-z_]+)" \(([^)]*)\) VALUES \(([^)]*)\)/.exec(sql);
      if (insert) {
        inserts.push({
          table: insert[1]!,
          columns: insert[2]!.split(", ").map((c) => c.replaceAll('"', "")),
          casts: insert[3]!.split(", "),
          params,
        });
        return [{ id: params[0] }];
      }
      throw new Error(`unrouted destination statement: ${sql.slice(0, 80)}`);
    },
  });

  try {
    const result = await importAudit({
      legacy: source.client,
      target: dest.client,
      legacySchema: "legacy",
      targetSchema: "public",
      dryRun: overrides.dryRun ?? false,
      enableGrants: overrides.enableGrants ?? false,
      now,
      ...overrides.schemas,
    });
    return { result, source, dest, inserts };
  } catch (error) {
    // Refusal tests still need the recorded statements/inserts up to the abort.
    throw Object.assign(error as Error, { harness: { source, dest, inserts } });
  }
}

const selectsFor = (calls: Call[], table: string) =>
  calls.filter((c) => c.kind === "unsafe" && c.sql.includes(`FROM "legacy"."${table}" AS source`));

describe("audit import legacy mapping (no database)", () => {
  it("maps every checked-in fixture column verbatim into the Next insert, in order", async () => {
    // The importer covers exactly the fixture's audit tables: legacy.users is
    // an FK helper and legacy.events only the grant-ownership projection.
    const fixtureTables = [...fixtureSql.matchAll(/CREATE TABLE legacy\.([a-z_]+)/g)].map(
      (m) => m[1],
    );
    expect(fixtureTables.filter((t) => t !== "users" && t !== "events").sort()).toEqual(
      [...TABLES].sort(),
    );

    const { result, inserts } = await runImport();
    const expected = fixtureRows();
    for (const table of TABLES) {
      const columns = [...fixtureColumnTypes(table).keys()];
      const tableInserts = inserts.filter((i) => i.table === table);
      const expectedRows = table === "agent_event_idempotency_keys" ? 1 : 2; // old replay key is expired
      expect(tableInserts.length, table).toBe(expectedRows);
      expect(result.tables[table]).toMatchObject({ read: 2, inserted: expectedRows, updated: 0 });
      for (const [index, insert] of tableInserts.entries()) {
        expect(insert.columns, `${table} insert columns`).toEqual(columns);
        // Every bound value is the projected legacy value for that column —
        // no renaming, no Discord-snowflake remapping, no fabricated values.
        // (Grant disabled_at is the one documented exception, pinned below.)
        for (const [position, column] of columns.entries()) {
          if (table === "agent_event_grants" && column === "disabled_at") continue;
          expect(insert.params[position], `${table}.${column}`).toEqual(
            expected[table][index]![column],
          );
        }
      }
    }
  });

  it("pins UTC + ISO DateStyle and text casts at both boundaries, preserving microseconds and raw JSON", async () => {
    const { source, dest, inserts } = await runImport();

    for (const [label, fake] of [
      ["source", source],
      ["destination", dest],
    ] as const) {
      const sqls = fake.calls.map((c) => c.sql);
      const firstUnsafe = fake.calls.findIndex((c) => c.kind === "unsafe");
      expect(sqls.indexOf("SET LOCAL TIME ZONE 'UTC'"), label).toBeGreaterThanOrEqual(0);
      expect(sqls.indexOf("SET LOCAL TIME ZONE 'UTC'"), label).toBeLessThan(firstUnsafe);
      expect(sqls.indexOf("SET LOCAL DateStyle TO 'ISO, YMD'"), label).toBeGreaterThanOrEqual(0);
      expect(sqls.indexOf("SET LOCAL DateStyle TO 'ISO, YMD'"), label).toBeLessThan(firstUnsafe);
    }

    for (const table of TABLES) {
      const types = fixtureColumnTypes(table);
      const timestamps = [...types].filter(([, t]) => t === "timestamp").map(([c]) => c);
      const json = [...types].filter(([, t]) => t === "json" || t === "jsonb").map(([c]) => c);
      const bigints = [...types]
        .filter(([, t]) => t === "bigint" || t === "bigserial")
        .map(([c]) => c);

      const [select] = selectsFor(source.calls, table);
      const head = select!.sql.split(" FROM ")[0]!;
      // Columns are projected in fixture order with lossless text casts:
      // timestamps via AT TIME ZONE 'UTC', JSON and bigints as ::text.
      let cursor = -1;
      for (const column of types.keys()) {
        const at = head.indexOf(`"${column}"`, cursor + 1);
        expect(at, `${table}.${column} projection order`).toBeGreaterThan(cursor);
        cursor = at;
      }
      for (const column of timestamps) {
        expect(head, `${table}.${column}`).toContain(
          `("${column}" AT TIME ZONE 'UTC')::text AS "${column}"`,
        );
      }
      for (const column of [...json, ...bigints]) {
        expect(head, `${table}.${column}`).toContain(`"${column}"::text AS "${column}"`);
      }

      // The insert re-enters through text casts so the driver cannot truncate
      // microseconds or double-encode JSON at the write boundary.
      const insert = inserts.find((i) => i.table === table)!;
      for (const [position, column] of insert.columns.entries()) {
        const cast = json.includes(column)
          ? `$${position + 1}::text::jsonb`
          : timestamps.includes(column)
            ? `$${position + 1}::text::timestamptz`
            : `$${position + 1}`;
        expect(insert.casts[position], `${table}.${column} insert cast`).toBe(cast);
        expect(insert.params[position], `${table}.${column} is not a JS Date`).not.toBeInstanceOf(
          Date,
        );
      }
    }

    const member = inserts.find((i) => i.table === "member_data_access_logs")!;
    expect(member.params[member.columns.indexOf("occurred_at")]).toBe(
      "2026-09-01 10:11:12.123456+00",
    );
    expect(member.params[member.columns.indexOf("subject_user_ids")]).toBe("[91001]");
    const nullActivity = inserts.filter((i) => i.table === "activity_log")[1]!;
    expect(nullActivity.params[nullActivity.columns.indexOf("properties")]).toBeNull();
    expect(nullActivity.params[nullActivity.columns.indexOf("updated_at")]).toBeNull();
  });

  it("refuses an invalid grant row before inserting it or any later table", async () => {
    const rows = fixtureRows();
    rows.agent_event_grants[0]!.verifier_hash = "synthetic-not-a-hash";
    let failure: (Error & { harness?: { inserts: Insert[] } }) | undefined;
    try {
      await runImport({ rows });
    } catch (error) {
      failure = error as Error & { harness?: { inserts: Insert[] } };
    }
    const inserts = failure?.harness?.inserts ?? [];
    expect(failure?.message).toBe("invalid_grant_digest");
    // Tables before grants were attempted, so the harness did run.
    expect(inserts.map((i) => i.table)).toContain("activity_log");
    // The bad grant is invalid_grant_digest and the run aborts: no grant, audit
    // or replay-key insert was attempted (a real run would roll back the rest).
    expect(inserts.map((i) => i.table)).not.toContain("agent_event_grants");
    expect(inserts.map((i) => i.table)).not.toContain("agent_event_audits");
    expect(inserts.map((i) => i.table)).not.toContain("agent_event_idempotency_keys");
  });

  it("refuses an invalid schema identifier before touching either client", async () => {
    let failure:
      | (Error & { harness?: { source: { calls: Call[] }; dest: { calls: Call[] } } })
      | undefined;
    try {
      await runImport({ schemas: { legacySchema: "legacy; drop table", targetSchema: "public" } });
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure?.message).toBe("invalid_identifier");
    expect(failure?.harness?.source.calls).toEqual([]);
    expect(failure?.harness?.dest.calls).toEqual([]);
  });

  it("dry-run counts would_insert/existing/expired with no inserts, locks or sequence writes", async () => {
    const { result, source, dest, inserts } = await runImport({
      dryRun: true,
      existing: new Set(["activity_log:93001"]),
    });
    expect(result.mode).toBe("dry-run");
    expect(inserts).toEqual([]);
    expect(dest.calls.some((c) => c.sql.startsWith("LOCK TABLE"))).toBe(false);
    expect(dest.calls.some((c) => c.sql.includes("setval"))).toBe(false);
    for (const table of TABLES) {
      expect(result.tables[table]).toMatchObject({ read: 2, inserted: 0, updated: 0 });
    }
    expect(result.tables.activity_log).toMatchObject({ would_insert: 1, existing: 1 });
    expect(result.tables.agent_event_idempotency_keys).toMatchObject({
      would_insert: 1,
      expired: 1,
    });

    // Retention is decided in Postgres at full precision: null / non-finite /
    // older-than-cutoff created_at is expired, with the cutoff bound as a
    // parameter exactly 90 days before the injected now.
    const [replaySelect] = selectsFor(source.calls, "agent_event_idempotency_keys");
    expect(replaySelect!.sql).toContain(
      "(created_at IS NULL OR NOT isfinite(created_at) OR created_at < $1::timestamp) AS import_expired",
    );
    expect(replaySelect!.params[0]).toBe("2026-07-02T00:00:00.000Z");
    // Replay rows also de-duplicate on the (grant_id, key) natural key.
    const probe = dest.calls.find(
      (c) => c.sql.includes("agent_event_idempotency_keys") && c.sql.includes("grant_id = $2"),
    );
    expect(probe?.sql).toContain("WHERE id = $1 OR (grant_id = $2 AND key = $3)");
  });

  it("disables grants by default and preserves legacy disabled state", async () => {
    const { source, inserts } = await runImport();
    const [select] = selectsFor(source.calls, "agent_event_grants");
    expect(select!.sql).toContain("(false) AS import_unused");
    const grants = inserts.filter((i) => i.table === "agent_event_grants");
    const disabledAt = (insert: Insert) => insert.params[insert.columns.indexOf("disabled_at")];
    expect(disabledAt(grants[0]!)).toBe("2026-09-30T00:00:00.000Z"); // enabled legacy grant -> disabled at import now
    expect(disabledAt(grants[1]!)).toBe("2026-09-02 00:00:00.456789+00"); // already disabled -> untouched
  });

  it("with --enable-grants, only a proven-unused grant stays enabled; unknown ownership stays disabled", async () => {
    const unusedRows = fixtureRows();
    unusedRows.agent_event_grants[0]!.import_unused = true; // what the admission SELECT returns for an untouched grant
    const proven = await runImport({
      rows: unusedRows,
      enableGrants: true,
      ownershipAvailable: true,
    });
    const [select] = selectsFor(proven.source.calls, "agent_event_grants");
    expect(select!.sql).toContain("max_events > 0");
    expect(select!.sql).toContain(
      'NOT EXISTS (SELECT 1 FROM "legacy"."events" WHERE agent_grant_id = source.id)',
    );
    expect(select!.sql).toContain(
      'NOT EXISTS (SELECT 1 FROM "legacy"."agent_event_audits" WHERE grant_id = source.id)',
    );
    expect(select!.sql).toContain(
      'NOT EXISTS (SELECT 1 FROM "legacy"."agent_event_idempotency_keys" WHERE grant_id = source.id)',
    );
    const firstGrant = proven.inserts.find((i) => i.table === "agent_event_grants")!;
    expect(firstGrant.params[firstGrant.columns.indexOf("disabled_at")]).toBeNull();

    // Ownership contract missing -> admission collapses to false and the same
    // grant imports disabled even though activation was requested.
    const unknown = await runImport({ enableGrants: true, ownershipAvailable: false });
    const [unknownSelect] = selectsFor(unknown.source.calls, "agent_event_grants");
    expect(unknownSelect!.sql).toContain("(false) AS import_unused");
    const unknownGrant = unknown.inserts.find((i) => i.table === "agent_event_grants")!;
    expect(unknownGrant.params[unknownGrant.columns.indexOf("disabled_at")]).toBe(
      "2026-09-30T00:00:00.000Z",
    );
  });
});
