import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";
import { createImportFixtureClients } from "./helpers/import-events-rsvps-db";
// @ts-expect-error standalone operator script has no type declarations
import { assertSeparateTargets, assertSeparateUrls, connectDatabase, importEventsRsvps, main } from "../bin/import/events-rsvps.mjs";

type Identity = { name: string; relation_id: string | null; relkind: string; inherited: boolean };
const identities = (start = 100): Identity[] =>
  ["events", "rsvps", "users"].map((name, index) => ({
    name,
    relation_id: String(start + index),
    relkind: "r",
    inherited: false,
  }));

type Allocator = {
  name: string;
  column_name: string;
  identity_kind: string;
  generated_kind: string;
  default_expression: string | null;
  unsafe_default_dependency: unknown;
  domain_type: unknown;
  owned_sequence: string | null;
  default_sequence_ids: string[];
  sequence_ids: string[];
  schema_sequence_ids: string[];
};
const allocators = (rows = identities()): Allocator[] =>
  rows.map((row) => {
    const id = String(Number(row.relation_id) + 1000);
    return {
      name: row.name,
      column_name: "id",
      identity_kind: "",
      generated_kind: "",
      default_expression: `nextval('synthetic.sequence_${id}'::regclass)`,
      unsafe_default_dependency: false,
      domain_type: false,
      owned_sequence: id,
      default_sequence_ids: [id],
      sequence_ids: [id],
      schema_sequence_ids: rows.map((table) => String(Number(table.relation_id) + 1000)),
    };
  });

function stubClient(
  rows = identities(),
  acquired: unknown = true,
  failure?: "identity" | "probe" | "allocator",
  allocatorRows = allocators(rows),
) {
  const queries: { text: string; values: unknown[] }[] = [];
  const sql = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join("?").replace(/\s+/g, " ").trim();
      queries.push({ text, values });
      if (text.includes("pg_get_serial_sequence")) {
        if (failure === "allocator") throw new Error("synthetic allocator denied password=do-not-print row-content");
        return allocatorRows;
      }
      if (text.includes("pg_catalog.pg_class")) {
        if (failure === "identity") throw new Error("synthetic postgres://user:do-not-print@alias/db row-content");
        return rows;
      }
      if (text.includes("pg_try_advisory_xact_lock")) {
        if (failure === "probe") throw new Error("synthetic probe denied password=do-not-print row-content");
        return acquired === "missing" ? [{}] : [{ acquired }];
      }
      if (text.includes("from pg_attribute")) return [{ present: false }];
      if (text.includes("from pg_trigger")) return [{ tgenabled: "O" }];
      if (
        text === "lock table events in access exclusive mode" ||
        text === "alter table events disable trigger events_ics_sequence" ||
        text === "alter table events enable trigger events_ics_sequence"
      )
        return [];
      if (/^(insert|update|delete|lock|alter)\b|nextval|setval/i.test(text)) throw new Error("Unexpected mutation");
      return [];
    },
    {
      begin: vi.fn(async (_mode: string, callback: (transaction: unknown) => Promise<unknown>) => callback(sql)),
    },
  );
  return { sql, queries };
}

const syntheticUrl = "postgres://synthetic:do-not-print@source.invalid/database";

describe("events import static and effective target separation", () => {
  it.each([
    [syntheticUrl, syntheticUrl],
    [syntheticUrl, "postgresql://synthetic:other-password@SOURCE.INVALID:5432/database"],
    [
      "postgres://synthetic@source.invalid/%64atabase?application_name=test&sslmode=require",
      "postgresql://synthetic@source.invalid:5432/database?sslmode=require&application_name=test",
    ],
  ])("refuses normalized equivalent endpoints without connecting", (source, target) => {
    expect(() => assertSeparateUrls(source, target)).toThrow("no destination writes");
  });

  it.each([
    [syntheticUrl, "postgres://synthetic@other.invalid/database"],
    [syntheticUrl, "postgres://synthetic@source.invalid/other_database"],
    [syntheticUrl, "postgres://other_role@source.invalid/database"],
    [`${syntheticUrl}?search_path=legacy`, `${syntheticUrl}?search_path=target`],
  ])("defers potentially distinct identities to the live probe", (source, target) => {
    expect(() => assertSeparateUrls(source, target)).not.toThrow();
  });

  it("normalizes duplicate parameters with the driver's last-value-wins precedence", () => {
    const source = `${syntheticUrl}?search_path=target&search_path=legacy`;
    const target = `${syntheticUrl}?search_path=legacy&search_path=target`;
    expect(() => assertSeparateUrls(source, target)).not.toThrow();
    expect(() => assertSeparateUrls(source, `${syntheticUrl}?search_path=legacy`)).toThrow("no destination writes");
  });

  it.each([true, false])("CLI statically refuses aliases with dryRun=%s without leaking inputs", async (dryRun) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(
        await main([dryRun ? "--dry-run" : "--apply"], {
          LEGACY_DATABASE_URL: syntheticUrl,
          DATABASE_URL: "postgresql://synthetic:other-password@SOURCE.INVALID:5432/database",
        }),
      ).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledExactlyOnceWith(
        "events-rsvps: could not establish isolated import tables; no destination writes. Verify separate databases/schemas and identity-probe access.",
      );
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it.each([true, false])("refuses same lock-domain tables before data reads or mutations, dryRun=%s", async (dryRun) => {
    const source = stubClient();
    const target = stubClient(identities(), false);
    await expect(importEventsRsvps(source.sql, target.sql, { dryRun })).rejects.toThrow("no destination writes");
    expect(source.sql.begin).toHaveBeenCalledWith("isolation level repeatable read read only", expect.any(Function));
    expect(target.sql.begin).toHaveBeenCalledWith(
      `isolation level repeatable read ${dryRun ? "read only" : "read write"}`,
      expect.any(Function),
    );
    for (const client of [source, target]) {
      expect(client.queries).toHaveLength(3); // timezone, catalog identity, lock-domain probe only
      expect(
        client.queries.some(({ text }) => /from events|from rsvps|from users|insert|nextval|setval|lock table|alter table/.test(text)),
      ).toBe(false);
    }
    expect(source.queries[2]!.values).toEqual(target.queries[2]!.values);
  });

  it("rejects a single shared writable table, even when the rest resolve separately", async () => {
    const targetRows = identities(200);
    targetRows[1]!.relation_id = "101";
    await expect(assertSeparateTargets(stubClient().sql, stubClient(targetRows, false).sql)).rejects.toThrow("no destination writes");
  });

  it("allows separate resolved tables within one database, including shared read-only users", async () => {
    const targetRows = identities(200);
    targetRows[2]!.relation_id = "102";
    const source = stubClient();
    const target = stubClient(targetRows, false);
    await expect(importEventsRsvps(source.sql, target.sql, { dryRun: false })).resolves.toMatchObject({
      dryRun: false,
      events: { read: 0 },
      rsvps: { read: 0 },
    });
    const texts = target.queries.map(({ text }) => text);
    expect(texts.indexOf("lock table events in access exclusive mode")).toBeGreaterThan(
      texts.findIndex((text) => text.includes("pg_get_serial_sequence")),
    );
    expect(texts.indexOf("alter table events disable trigger events_ics_sequence")).toBeGreaterThan(
      texts.indexOf("lock table events in access exclusive mode"),
    );
    expect(texts.at(-1)).toBe("alter table events enable trigger events_ics_sequence");
  });

  it("allows shared users in the destination schema without protecting unrelated destination sequences", async () => {
    const sourceRows = allocators();
    sourceRows[2]!.schema_sequence_ids = ["1200", "1201", "1102"];
    const targetRows = identities(200);
    targetRows[2]!.relation_id = "102";
    await expect(
      importEventsRsvps(stubClient(identities(), true, undefined, sourceRows).sql, stubClient(targetRows, false).sql, { dryRun: false }),
    ).resolves.toMatchObject({ events: { read: 0 } });
  });

  it.each(["sequence_ids", "owned_sequence"] as const)("still protects shared users allocators from %s", async (field) => {
    const sourceRows = allocators();
    if (field === "owned_sequence") sourceRows[2]![field] = "1200";
    else sourceRows[2]![field].push("1200");
    await expect(
      assertSeparateTargets(stubClient(identities(), true, undefined, sourceRows).sql, stubClient(identities(200), false).sql),
    ).rejects.toThrow("no destination writes");
  });

  it.each([true, null, "false"])("refuses custom or unconfirmed ID function identity (%s)", async (unsafe_default_dependency) => {
    const targetRows = identities(200);
    const allocatorRows = allocators(targetRows);
    allocatorRows[0]!.unsafe_default_dependency = unsafe_default_dependency;
    await expect(
      importEventsRsvps(stubClient().sql, stubClient(targetRows, false, undefined, allocatorRows).sql, { dryRun: false }),
    ).rejects.toThrow("no destination writes");
  });

  it.each(["source-id", "source-extra", "target-extra"])(
    "refuses unproven %s defaults before source reads and destination locks/DDL",
    async (kind) => {
      for (const dryRun of [true, false]) {
        const sourceRows = allocators();
        const targetRows = allocators(identities(200));
        const row = {
          ...(kind === "target-extra" ? targetRows : sourceRows)[0]!,
          default_expression: "nextval('synthetic.external_ids'::text)",
          default_sequence_ids: [],
          owned_sequence: null,
          sequence_ids: [],
        };
        if (kind === "source-id") sourceRows[0] = row;
        else (kind === "target-extra" ? targetRows : sourceRows).push({ ...row, column_name: "omitted_allocator" });
        const source = stubClient(identities(), true, undefined, sourceRows);
        const target = stubClient(identities(200), false, undefined, targetRows);
        await expect(importEventsRsvps(source.sql, target.sql, { dryRun })).rejects.toThrow("no destination writes");
        for (const client of [source, target]) {
          expect(client.queries.some(({ text }) => /from events|from rsvps|from users|lock table|alter table|^insert/.test(text))).toBe(
            false,
          );
        }
      }
    },
  );

  it.each(["source", "target"])("refuses %s domain defaults before reads/locks/DDL in both modes", async (side) => {
    for (const default_expression of [null, "42", "nextval('synthetic.sequence_1200'::regclass)"]) {
      for (const dryRun of [true, false]) {
        const sourceRows = allocators(),
          targetRows = allocators(identities(200));
        const rows = side === "source" ? sourceRows : targetRows;
        rows.push({ ...rows[0]!, column_name: "domain_column", domain_type: true, default_expression });
        const source = stubClient(identities(), true, undefined, sourceRows);
        const target = stubClient(identities(200), false, undefined, targetRows);
        await expect(importEventsRsvps(source.sql, target.sql, { dryRun })).rejects.toThrow("no destination writes");
        expect(
          [...source.queries, ...target.queries].some(({ text }) =>
            /from events|from rsvps|from users|lock table|alter table|^insert/.test(text),
          ),
        ).toBe(false);
      }
    }
  });

  it.each([undefined, null, "false", 0])("refuses incomplete or malformed domain metadata (%s)", async (domain_type) => {
    const sourceRows = allocators();
    sourceRows[0]!.domain_type = domain_type;
    await expect(
      importEventsRsvps(stubClient(identities(), true, undefined, sourceRows).sql, stubClient(identities(200), false).sql),
    ).rejects.toThrow("no destination writes");
  });

  it("skips domain defaults on supplied destination columns", async () => {
    const targetRows = allocators(identities(200));
    targetRows.push({ ...targetRows[0]!, column_name: "description", domain_type: true, default_expression: null });
    await expect(
      importEventsRsvps(stubClient().sql, stubClient(identities(200), false, undefined, targetRows).sql, { dryRun: false }),
    ).resolves.toMatchObject({ events: { read: 0 } });
  });

  it.each([null, "42", "'42'::bigint"])("permits non-allocating source IDs (%s)", async (default_expression) => {
    const sourceRows = allocators().map((row) => ({ ...row, default_expression, default_sequence_ids: [] }));
    await expect(
      importEventsRsvps(stubClient(identities(), true, undefined, sourceRows).sql, stubClient(identities(200), false).sql),
    ).resolves.toMatchObject({ events: { read: 0 } });
  });

  it.each([null, "0", "'draft'::text", "false", "now()", "CURRENT_TIMESTAMP", "CURRENT_DATE"])(
    "permits proven omitted non-allocating defaults (%s)",
    async (default_expression) => {
      const targetRows = allocators(identities(200));
      targetRows.push({
        ...targetRows[0]!,
        column_name: "omitted_default",
        default_expression,
        default_sequence_ids: [],
        sequence_ids: [],
        owned_sequence: null,
      });
      await expect(
        importEventsRsvps(stubClient().sql, stubClient(identities(200), false, undefined, targetRows).sql, { dryRun: false }),
      ).resolves.toMatchObject({ events: { read: 0 } });
    },
  );

  it("still refuses omitted builtin-looking defaults with custom dependencies", async () => {
    const targetRows = allocators(identities(200));
    targetRows.push({
      ...targetRows[0]!,
      column_name: "omitted_default",
      default_expression: "now()",
      unsafe_default_dependency: true,
      default_sequence_ids: [],
      sequence_ids: [],
      owned_sequence: null,
    });
    await expect(importEventsRsvps(stubClient().sql, stubClient(identities(200), false, undefined, targetRows).sql)).rejects.toThrow(
      "no destination writes",
    );
  });

  it("does not execute supplied-column defaults", async () => {
    const targetRows = allocators(identities(200));
    targetRows.push({
      ...targetRows[0]!,
      column_name: "title",
      default_expression: "nextval('synthetic.source_ids'::text)",
      default_sequence_ids: [],
      sequence_ids: [],
      owned_sequence: null,
    });
    await expect(
      importEventsRsvps(stubClient().sql, stubClient(identities(200), false, undefined, targetRows).sql, { dryRun: false }),
    ).resolves.toMatchObject({ events: { read: 0 } });
  });

  it("allows an explicitly qualified builtin nextval allocator", async () => {
    const targetRows = identities(200);
    const allocatorRows = allocators(targetRows);
    allocatorRows[0]!.default_expression = "pg_catalog.nextval('synthetic.sequence_1200'::regclass)";
    await expect(importEventsRsvps(stubClient().sql, stubClient(targetRows, false, undefined, allocatorRows).sql)).resolves.toMatchObject({
      events: { read: 0 },
    });
  });

  it.each(["events", "rsvps"])("refuses distinct writable %s tables with a shared source allocator", async (table) => {
    const targetRows = identities(200);
    const allocatorRows = allocators(targetRows);
    const row = allocatorRows.find((allocator) => allocator.name === table)!;
    row.default_sequence_ids = ["1100"];
    row.sequence_ids.push("1100");
    const source = stubClient();
    const target = stubClient(targetRows, false, undefined, allocatorRows);
    await expect(importEventsRsvps(source.sql, target.sql, { dryRun: false })).rejects.toThrow("no destination writes");
    expect([...source.queries, ...target.queries].some(({ text }) => /from events|from rsvps|from users/.test(text))).toBe(false);
  });

  it.each(["dynamic", "missing", "malformed"])("fails closed on an unprovable %s target allocator", async (kind) => {
    const targetRows = identities(200);
    const allocatorRows = allocators(targetRows);
    if (kind === "dynamic") allocatorRows[0]!.default_expression = "synthetic_allocator()";
    if (kind === "missing") allocatorRows[0]!.default_sequence_ids = [];
    if (kind === "malformed") allocatorRows[0]!.sequence_ids = ["not-an-oid"];
    await expect(
      importEventsRsvps(stubClient().sql, stubClient(targetRows, false, undefined, allocatorRows).sql, { dryRun: false }),
    ).rejects.toThrow("no destination writes");
  });

  it.each(["schema_sequence_ids", "sequence_ids", "owned_sequence"] as const)(
    "protects source allocators found through %s",
    async (field) => {
      const sourceRows = allocators();
      if (field === "owned_sequence") sourceRows[0]![field] = "1200";
      else sourceRows[0]![field].push("1200");
      await expect(
        importEventsRsvps(stubClient(identities(), true, undefined, sourceRows).sql, stubClient(identities(200), false).sql),
      ).rejects.toThrow("no destination writes");
    },
  );

  it.each(["source", "target"])("fails closed on incomplete %s allocator metadata", async (side) => {
    const sourceRows = allocators();
    const targetRows = allocators(identities(200));
    (side === "source" ? sourceRows : targetRows).pop();
    await expect(
      importEventsRsvps(
        stubClient(identities(), true, undefined, sourceRows).sql,
        stubClient(identities(200), false, undefined, targetRows).sql,
        { dryRun: false },
      ),
    ).rejects.toThrow("no destination writes");
  });

  it.each(["a", "d"])("allows disjoint catalog-owned identity allocators (%s)", async (identity_kind) => {
    const targetRows = identities(200);
    const allocatorRows = allocators(targetRows).map((row) => ({
      ...row,
      identity_kind,
      default_expression: null,
      default_sequence_ids: [],
    }));
    await expect(
      importEventsRsvps(stubClient().sql, stubClient(targetRows, false, undefined, allocatorRows).sql, { dryRun: false }),
    ).resolves.toMatchObject({ events: { read: 0 } });
  });

  it("allows independent database lock domains with equal local OIDs and names", async () => {
    await expect(importEventsRsvps(stubClient().sql, stubClient().sql, { dryRun: false })).resolves.toMatchObject({
      dryRun: false,
      events: { read: 0 },
    });
  });

  it("refuses one shared client before entering a transaction", async () => {
    const client = stubClient();
    await expect(importEventsRsvps(client.sql, client.sql, { dryRun: false })).rejects.toThrow("no destination writes");
    expect(client.sql.begin).not.toHaveBeenCalled();
  });

  it.each(["identity", "probe", "allocator"] as const)(
    "fails closed on denied %s queries without exposing driver errors",
    async (failure) => {
      for (const side of ["source", "target"]) {
        const source = stubClient(identities(), true, side === "source" ? failure : undefined);
        const target = stubClient(identities(200), false, side === "target" ? failure : undefined);
        await expect(importEventsRsvps(source.sql, target.sql, { dryRun: false })).rejects.toThrow(
          "Could not establish isolated import tables; no destination writes.",
        );
        expect([...source.queries, ...target.queries].some(({ text }) => /from events|from rsvps|from users/.test(text))).toBe(false);
      }
    },
  );

  it.each(["missing", null, "true", 1, false])("refuses an unconfirmed source probe (%s)", async (acquired) => {
    const source = stubClient(identities(), acquired);
    const target = stubClient(identities(200), true);
    await expect(assertSeparateTargets(source.sql, target.sql)).rejects.toThrow("no destination writes");
    expect(target.queries.some(({ text }) => text.includes("pg_try_advisory_xact_lock"))).toBe(false);
  });

  it.each([null, "false", 0])("refuses a malformed destination probe (%s)", async (acquired) => {
    await expect(assertSeparateTargets(stubClient().sql, stubClient(identities(200), acquired).sql)).rejects.toThrow(
      "no destination writes",
    );
  });

  it.each(["missing", "view", "foreign", "inherited", "incomplete"])("refuses %s table identity", async (kind) => {
    const rows = identities(200);
    if (kind === "missing") rows[0]!.relation_id = null;
    if (kind === "view") rows[0]!.relkind = "v";
    if (kind === "foreign") rows[0]!.relkind = "f";
    if (kind === "inherited") rows[0]!.inherited = true;
    if (kind === "incomplete") rows.pop();
    const target = stubClient(rows, true);
    await expect(importEventsRsvps(stubClient().sql, target.sql, { dryRun: false })).rejects.toThrow("no destination writes");
    expect(target.queries).toHaveLength(2); // no probe or data access after invalid catalog identity
  });
});

const url = process.env.DATABASE_URL;
const fixtureSql = readFileSync(new URL("./fixtures/legacy/events-rsvps.sql", import.meta.url), "utf8");

describe.skipIf(!url)("events import separation on disposable test schemas", () => {
  let fixture: MemberDataFixture;
  let legacy: ReturnType<typeof postgres>;
  let target: ReturnType<typeof postgres>;
  let legacySchema: string;
  let emptySchema: string;
  let safeUrl: string;

  beforeAll(async () => {
    const safe = testDatabaseUrl(url!); // reject every non-test endpoint before DDL
    if (safe.hostname === "agent-testdb" && safe.pathname !== "/two_web_next") throw new Error("Requires two_web_next test database");
    safeUrl = safe.href;
    fixture = await createMemberDataFixture(safeUrl);
    legacySchema = `${fixture.schemaName}_legacy`;
    emptySchema = `${fixture.schemaName}_empty`;
    ({ legacy, target } = createImportFixtureClients(safeUrl, legacySchema, fixture.schemaName));
    await fixture.client`create schema ${fixture.client(emptySchema)}`;
  });

  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`drop schema if exists ${fixture.client(legacySchema)} cascade`;
    await fixture.client`create schema ${fixture.client(legacySchema)}`;
    await legacy.unsafe(fixtureSql.replaceAll("legacy.", `"${legacySchema}".`));
    await target`insert into users (id, username) values
      ('100000000000000901', 'Synthetic going'), ('100000000000000902', 'Synthetic waitlisted')`;
  });

  afterAll(async () => {
    await Promise.all([legacy?.end(), target?.end()]);
    if (fixture) {
      try {
        await fixture.client`drop schema if exists ${fixture.client(legacySchema)} cascade`;
        await fixture.client`drop schema if exists ${fixture.client(emptySchema)} cascade`;
      } finally {
        await fixture.dispose();
      }
    }
  });

  async function snapshot(sql: ReturnType<typeof postgres>) {
    return {
      events: await sql`select * from events order by id`,
      rsvps: await sql`select * from rsvps order by id`,
      users: await sql`select * from users order by id`,
      eventsSequence: await sql`select last_value, is_called from events_id_seq`,
      rsvpsSequence: await sql`select last_value, is_called from rsvps_id_seq`,
      revisionTrigger: await sql`select tgenabled from pg_catalog.pg_trigger
        where tgrelid = 'events'::regclass and tgname = 'events_ics_sequence' and not tgisinternal`,
    };
  }

  function alias(schemaPath: string, applicationName: string) {
    const parsed = new URL(safeUrl);
    parsed.protocol = "postgresql:";
    parsed.searchParams.set("search_path", schemaPath);
    parsed.searchParams.set("application_name", applicationName);
    return parsed.href;
  }

  it.each([true, false])("refuses two URL aliases to the same schema with rows/sequences unchanged, dryRun=%s", async (dryRun) => {
    const sourceUrl = alias(legacySchema, "synthetic_source");
    const targetUrl = alias(legacySchema, "synthetic_target");
    expect(() => assertSeparateUrls(sourceUrl, targetUrl)).not.toThrow(); // exercise the effective guard
    const before = await snapshot(legacy);
    const source = connectDatabase(sourceUrl);
    const destination = connectDatabase(targetUrl);
    try {
      await expect(importEventsRsvps(source, destination, { dryRun })).rejects.toThrow("no destination writes");
      expect(await snapshot(legacy)).toEqual(before);
    } finally {
      await Promise.all([source.end(), destination.end()]);
    }
  });

  it("refuses a different current_schema whose search_path falls back to source tables", async () => {
    const destination = connectDatabase(alias(`${emptySchema},${legacySchema}`, "synthetic_fallback"));
    const before = await snapshot(legacy);
    try {
      expect((await destination`select current_schema() as schema`)[0]!.schema).toBe(emptySchema);
      await expect(importEventsRsvps(legacy, destination, { dryRun: false })).rejects.toThrow("no destination writes");
      expect(await snapshot(legacy)).toEqual(before);
    } finally {
      await destination.end();
    }
  });

  it("refuses partial table overlap through search_path fallback before sequences advance", async () => {
    await target`create table ${target(emptySchema)}.events (like events including all)`;
    const destination = connectDatabase(alias(`${emptySchema},${legacySchema}`, "synthetic_partial"));
    const sourceBefore = await snapshot(legacy);
    const targetBefore = await snapshot(target);
    try {
      await expect(importEventsRsvps(legacy, destination, { dryRun: false })).rejects.toThrow("no destination writes");
      expect(await snapshot(legacy)).toEqual(sourceBefore);
      expect(await snapshot(target)).toEqual(targetBefore);
      expect(await destination`select * from events`).toHaveLength(0);
    } finally {
      await destination.end();
      await target`drop table ${target(emptySchema)}.events`;
    }
  });

  it("refuses a visible custom nextval that hides a source allocator behind a disjoint argument", async () => {
    await target.unsafe(`CREATE FUNCTION "${emptySchema}".nextval(pg_catalog.regclass) RETURNS integer
      LANGUAGE sql VOLATILE AS $body$ SELECT pg_catalog.nextval('"${legacySchema}"."events_id_seq"'::regclass)::integer $body$`);
    const destination = connectDatabase(alias(`${emptySchema},${fixture.schemaName},pg_catalog`, "synthetic_nextval_collision"));
    try {
      for (const table of ["events", "rsvps"]) {
        await destination.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}" ALTER COLUMN id
          SET DEFAULT nextval('"${fixture.schemaName}"."${table}_id_seq"'::regclass)`);
      }
      const expressions = await destination`select pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) as value,
        (select count(*)::integer from pg_catalog.pg_depend d join pg_catalog.pg_class s on s.oid = d.refobjid and s.relkind = 'S'
          where d.classid = 'pg_catalog.pg_attrdef'::regclass and d.objid = ad.oid
            and d.refclassid = 'pg_catalog.pg_class'::regclass) as sequences,
        exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_attrdef'::regclass and d.objid = ad.oid
          and d.refclassid = 'pg_catalog.pg_proc'::regclass
          and d.refobjid <> 'pg_catalog.nextval(pg_catalog.regclass)'::regprocedure) as custom_function
        from pg_catalog.pg_attrdef ad join pg_catalog.pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
        where ad.adrelid in ('events'::regclass, 'rsvps'::regclass) and a.attname = 'id'`;
      expect(expressions).toHaveLength(2);
      // Both defaults match the old text check but depend on the custom function.
      for (const expression of expressions) {
        expect(expression.value).toMatch(/^nextval\('(?:[^']|'')+'::regclass\)$/);
        expect(expression.sequences).toBe(1);
        expect(expression.custom_function).toBe(true);
      }
      const sourceBefore = await snapshot(legacy);
      const targetBefore = await snapshot(target);
      for (const dryRun of [true, false]) {
        await expect(importEventsRsvps(legacy, destination, { dryRun })).rejects.toThrow("no destination writes");
        expect(await snapshot(legacy)).toEqual(sourceBefore);
        expect(await snapshot(target)).toEqual(targetBefore);
      }
      for (const table of ["events", "rsvps"]) {
        await destination.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}" ALTER COLUMN id
          SET DEFAULT pg_catalog.nextval('"${fixture.schemaName}"."${table}_id_seq"'::regclass)`);
      }
      expect((await importEventsRsvps(legacy, destination, { dryRun: false })).events.inserted).toBe(4);
      expect(await snapshot(legacy)).toEqual(sourceBefore);
    } finally {
      for (const table of ["events", "rsvps"]) {
        await target.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}" ALTER COLUMN id
          SET DEFAULT pg_catalog.nextval('"${fixture.schemaName}"."${table}_id_seq"'::regclass)`);
      }
      await destination.end();
      await target.unsafe(`DROP FUNCTION "${emptySchema}".nextval(pg_catalog.regclass)`);
    }
  });

  it("allows isolated writable tables when shared users resolve in the destination schema", async () => {
    // Rename only the owned legacy fixture table; its dependencies stay intact.
    await legacy.unsafe(`ALTER TABLE "${legacySchema}".users RENAME TO users_private`);
    const source = connectDatabase(alias(`${legacySchema},${fixture.schemaName}`, "synthetic_shared_users"));
    try {
      const sourceBefore = await snapshot(source);
      const targetBefore = await snapshot(target);
      for (const dryRun of [true, false]) {
        await expect(
          source.begin("isolation level repeatable read read only", (sourceTx: unknown) =>
            target.begin(`isolation level repeatable read ${dryRun ? "read only" : "read write"}`, (targetTx) =>
              assertSeparateTargets(sourceTx, targetTx),
            ),
          ),
        ).resolves.toBeUndefined();
        expect(await snapshot(source)).toEqual(sourceBefore);
        expect(await snapshot(target)).toEqual(targetBefore);
      }
    } finally {
      await source.end();
      await legacy.unsafe(`ALTER TABLE "${legacySchema}".users_private RENAME TO users`);
    }
  });

  it.each(["events", "rsvps"])("refuses distinct target tables that allocate IDs from source %s sequence", async (table) => {
    // These identifiers are generated fixture schema names and a fixed table list.
    await target.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}" ALTER COLUMN id
      SET DEFAULT nextval('"${legacySchema}"."${table}_id_seq"'::regclass)`);
    const sourceBefore = await snapshot(legacy);
    const targetBefore = await snapshot(target);
    try {
      for (const dryRun of [true, false]) {
        await expect(importEventsRsvps(legacy, target, { dryRun })).rejects.toThrow("no destination writes");
        expect(await snapshot(legacy)).toEqual(sourceBefore);
        expect(await snapshot(target)).toEqual(targetBefore);
      }
    } finally {
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}" ALTER COLUMN id
        SET DEFAULT nextval('"${fixture.schemaName}"."${table}_id_seq"'::regclass)`);
    }
  });

  it.each(["schema-only", "external-reference"])("protects a %s source sequence without relying on table ownership", async (kind) => {
    const sequenceSchema = kind === "schema-only" ? legacySchema : emptySchema;
    const sequence = `"${sequenceSchema}"."synthetic_allocator"`;
    await target.unsafe(`CREATE SEQUENCE ${sequence}`);
    const sequenceState = () => target.unsafe(`SELECT last_value, is_called FROM ${sequence}`);
    try {
      if (kind === "external-reference") {
        await legacy.unsafe(`ALTER TABLE "${legacySchema}".events ALTER COLUMN id SET DEFAULT nextval('${sequence}'::regclass)`);
      }
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN id SET DEFAULT nextval('${sequence}'::regclass)`);
      const sourceBefore = await snapshot(legacy);
      const targetBefore = await snapshot(target);
      const sequenceBefore = await sequenceState();
      for (const dryRun of [true, false]) {
        await expect(importEventsRsvps(legacy, target, { dryRun })).rejects.toThrow("no destination writes");
        expect(await snapshot(legacy)).toEqual(sourceBefore);
        expect(await snapshot(target)).toEqual(targetBefore);
        expect(await sequenceState()).toEqual(sequenceBefore);
      }
    } finally {
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN id
        SET DEFAULT nextval('"${fixture.schemaName}"."events_id_seq"'::regclass)`);
      if (kind === "external-reference") {
        await legacy.unsafe(
          `ALTER TABLE "${legacySchema}".events ALTER COLUMN id SET DEFAULT nextval('"${legacySchema}"."events_id_seq"'::regclass)`,
        );
      }
      await target.unsafe(`DROP SEQUENCE ${sequence}`);
    }
  });

  it.each(["events", "rsvps", "users"])("fails closed on a late-bound external source %s allocator", async (table) => {
    const sequence = `"${emptySchema}"."late_bound_source_ids"`;
    await target.unsafe(`CREATE SEQUENCE ${sequence} START 10000`);
    const sequenceState = () => target.unsafe(`SELECT last_value, is_called FROM ${sequence}`);
    try {
      await legacy.unsafe(`ALTER TABLE "${legacySchema}"."${table}" ALTER COLUMN id
        SET DEFAULT pg_catalog.nextval('${sequence}'::text)`);
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN id
        SET DEFAULT pg_catalog.nextval('${sequence}'::regclass)`);
      const [dependencies] = await legacy`select count(*)::integer as count
        from pg_catalog.pg_attrdef ad join pg_catalog.pg_depend d on d.objid = ad.oid
          and d.classid = 'pg_catalog.pg_attrdef'::regclass
          and d.refclassid = 'pg_catalog.pg_class'::regclass
        join pg_catalog.pg_class s on s.oid = d.refobjid and s.relkind = 'S'
        where ad.adrelid = ${`${legacySchema}.${table}`}::regclass`;
      expect(dependencies!.count).toBe(0);
      const sourceBefore = await snapshot(legacy);
      const targetBefore = await snapshot(target);
      const sequenceBefore = await sequenceState();
      for (const dryRun of [true, false]) {
        await expect(importEventsRsvps(legacy, target, { dryRun })).rejects.toThrow("no destination writes");
        expect(await snapshot(legacy)).toEqual(sourceBefore);
        expect(await snapshot(target)).toEqual(targetBefore);
        expect(await sequenceState()).toEqual(sequenceBefore);
      }
    } finally {
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN id
        SET DEFAULT pg_catalog.nextval('"${fixture.schemaName}"."events_id_seq"'::regclass)`);
      await legacy.unsafe(`ALTER TABLE "${legacySchema}"."${table}" ALTER COLUMN id
        SET DEFAULT pg_catalog.nextval('"${legacySchema}"."${table}_id_seq"'::regclass)`);
      await target.unsafe(`DROP SEQUENCE ${sequence}`);
    }
  });

  it.each(["events", "rsvps"])("refuses an omitted %s column with a late-bound source sequence default", async (table) => {
    await target.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}" ADD COLUMN omitted_allocator bigint
      DEFAULT pg_catalog.nextval('"${legacySchema}"."events_id_seq"'::text)`);
    try {
      const sourceBefore = await snapshot(legacy);
      const targetBefore = await snapshot(target);
      for (const dryRun of [true, false]) {
        await expect(importEventsRsvps(legacy, target, { dryRun })).rejects.toThrow("no destination writes");
        expect(await snapshot(legacy)).toEqual(sourceBefore);
        expect(await snapshot(target)).toEqual(targetBefore);
      }
    } finally {
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}" DROP COLUMN omitted_allocator`);
    }
  });

  it.each(["events", "rsvps"].flatMap((table) => [false, true].map((nested) => ({ table, nested }))))(
    "refuses omitted $table domain defaults before reads/locks/DDL, nested=$nested",
    async ({ table, nested }) => {
      const domain = `"${emptySchema}"."omitted_domain"`;
      const outer = `"${emptySchema}"."outer_domain"`;
      await target.unsafe(`CREATE DOMAIN ${domain} AS bigint DEFAULT pg_catalog.nextval('"${legacySchema}"."${table}_id_seq"'::regclass)`);
      if (nested) await target.unsafe(`CREATE DOMAIN ${outer} AS ${domain}`);
      const queries: string[] = [];
      const traced = (schema: string) =>
        postgres(safeUrl, {
          max: 1,
          port: 5432,
          password: () => new URL(safeUrl).password,
          fetch_types: false,
          onnotice: () => {},
          connection: { search_path: schema },
          debug: (_connection, query) => queries.push(query),
        });
      const source = traced(legacySchema),
        destination = traced(fixture.schemaName);
      try {
        await target.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}" ADD COLUMN omitted_allocator ${nested ? outer : domain}`);
        const [metadata] = await target`select t.typtype, ad.oid as column_default
          from pg_catalog.pg_attribute a join pg_catalog.pg_type t on t.oid = a.atttypid
          left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
          where a.attrelid = ${`${fixture.schemaName}.${table}`}::regclass and a.attname = 'omitted_allocator'`;
        expect(metadata).toMatchObject({ typtype: "d", column_default: null });
        const sourceBefore = await snapshot(legacy),
          targetBefore = await snapshot(target);
        for (const dryRun of [true, false]) {
          queries.length = 0;
          await expect(importEventsRsvps(source, destination, { dryRun })).rejects.toThrow("no destination writes");
          expect(
            queries.some((query) =>
              /\bfrom events\b|\bfrom rsvps\b|\bfrom users\b|\block table\b|\balter table\b|\binsert into\b|\bsetval\s*\(/i.test(query),
            ),
          ).toBe(false);
          expect(await snapshot(legacy)).toEqual(sourceBefore);
          expect(await snapshot(target)).toEqual(targetBefore);
        }
      } finally {
        await Promise.all([source.end(), destination.end()]);
        await target.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}" DROP COLUMN IF EXISTS omitted_allocator`);
        if (nested) await target.unsafe(`DROP DOMAIN ${outer}`);
        await target.unsafe(`DROP DOMAIN ${domain}`);
      }
    },
  );

  it.each(["events", "rsvps", "users"])("fails closed on a source %s domain's external allocator", async (table) => {
    const domain = `"${emptySchema}"."source_domain"`;
    const sequence = `"${emptySchema}"."domain_source_ids"`;
    await target.unsafe(`CREATE SEQUENCE ${sequence} START 10000`);
    await target.unsafe(`CREATE DOMAIN ${domain} AS bigint DEFAULT pg_catalog.nextval('${sequence}'::regclass)`);
    try {
      // Seed nulls without executing the type default, then expose it without pg_attrdef.
      await legacy.unsafe(`ALTER TABLE "${legacySchema}"."${table}" ADD COLUMN source_allocator ${domain} DEFAULT NULL`);
      await legacy.unsafe(`ALTER TABLE "${legacySchema}"."${table}" ALTER COLUMN source_allocator DROP DEFAULT`);
      await target.unsafe(
        `ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN id SET DEFAULT pg_catalog.nextval('${sequence}'::regclass)`,
      );
      const sourceBefore = await snapshot(legacy),
        targetBefore = await snapshot(target);
      const sequenceBefore = await target.unsafe(`SELECT last_value, is_called FROM ${sequence}`);
      for (const dryRun of [true, false]) {
        await expect(importEventsRsvps(legacy, target, { dryRun })).rejects.toThrow("no destination writes");
        expect(await snapshot(legacy)).toEqual(sourceBefore);
        expect(await snapshot(target)).toEqual(targetBefore);
        expect(await target.unsafe(`SELECT last_value, is_called FROM ${sequence}`)).toEqual(sequenceBefore);
      }
    } finally {
      await target.unsafe(
        `ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN id SET DEFAULT pg_catalog.nextval('"${fixture.schemaName}"."events_id_seq"'::regclass)`,
      );
      await legacy.unsafe(`ALTER TABLE "${legacySchema}"."${table}" DROP COLUMN IF EXISTS source_allocator`);
      await target.unsafe(`DROP DOMAIN ${domain}`);
      await target.unsafe(`DROP SEQUENCE ${sequence}`);
    }
  });

  it("does not execute a supplied target column's domain default", async () => {
    const domain = `"${emptySchema}"."supplied_domain"`;
    const destination = connectDatabase(alias(fixture.schemaName, "synthetic_supplied_domain"));
    await target.unsafe(`CREATE DOMAIN ${domain} AS text DEFAULT pg_catalog.nextval('"${legacySchema}"."events_id_seq"'::regclass)::text`);
    try {
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN description TYPE ${domain}`);
      const sourceBefore = await snapshot(legacy);
      expect((await importEventsRsvps(legacy, destination, { dryRun: false })).events.inserted).toBe(4);
      expect(await snapshot(legacy)).toEqual(sourceBefore);
    } finally {
      await destination.end();
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN description TYPE text`);
      await target.unsafe(`DROP DOMAIN ${domain}`);
    }
  });

  it("protects a late-bound external source non-ID default", async () => {
    const sequence = `"${emptySchema}"."source_default_ids"`;
    await target.unsafe(`CREATE SEQUENCE ${sequence} START 10000`);
    const sequenceState = () => target.unsafe(`SELECT last_value, is_called FROM ${sequence}`);
    try {
      await legacy.unsafe(`ALTER TABLE "${legacySchema}".events ADD COLUMN source_allocator bigint`);
      await legacy.unsafe(`ALTER TABLE "${legacySchema}".events ALTER COLUMN source_allocator
        SET DEFAULT pg_catalog.nextval('${sequence}'::text)`);
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN id
        SET DEFAULT pg_catalog.nextval('${sequence}'::regclass)`);
      const sourceBefore = await snapshot(legacy);
      const targetBefore = await snapshot(target);
      const sequenceBefore = await sequenceState();
      for (const dryRun of [true, false]) {
        await expect(importEventsRsvps(legacy, target, { dryRun })).rejects.toThrow("no destination writes");
        expect(await snapshot(legacy)).toEqual(sourceBefore);
        expect(await snapshot(target)).toEqual(targetBefore);
        expect(await sequenceState()).toEqual(sequenceBefore);
      }
    } finally {
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN id
        SET DEFAULT pg_catalog.nextval('"${fixture.schemaName}"."events_id_seq"'::regclass)`);
      await legacy.unsafe(`ALTER TABLE "${legacySchema}".events DROP COLUMN source_allocator`);
      await target.unsafe(`DROP SEQUENCE ${sequence}`);
    }
  });

  it.each(["events", "rsvps"])("permits proven disjoint omitted %s defaults, not supplied-column defaults", async (table) => {
    const sequence = `"${emptySchema}"."isolated_omitted_ids"`;
    await target.unsafe(`CREATE SEQUENCE ${sequence} START 10000`);
    try {
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}"
        ADD COLUMN omitted_allocator bigint DEFAULT pg_catalog.nextval('${sequence}'::regclass),
        ADD COLUMN omitted_constant text DEFAULT 'synthetic', ADD COLUMN omitted_time timestamptz DEFAULT now()`);
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN title
        SET DEFAULT pg_catalog.nextval('"${legacySchema}"."events_id_seq"'::text)::text`);
      const sourceBefore = await snapshot(legacy);
      expect((await importEventsRsvps(legacy, target, { dryRun: false })).events.inserted).toBe(4);
      expect(await snapshot(legacy)).toEqual(sourceBefore);
      const values = await target.unsafe(
        `SELECT omitted_allocator, omitted_constant, omitted_time FROM "${fixture.schemaName}"."${table}"`,
      );
      expect(values).toHaveLength(table === "events" ? 4 : 3);
      expect(new Set(values.map((row) => row.omitted_allocator)).size).toBe(values.length);
      for (const row of values) {
        expect(row.omitted_constant).toBe("synthetic");
        expect(row.omitted_time).not.toBeNull();
      }
    } finally {
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}".events ALTER COLUMN title DROP DEFAULT`);
      await target.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}"
        DROP COLUMN omitted_allocator, DROP COLUMN omitted_constant, DROP COLUMN omitted_time`);
      await target.unsafe(`DROP SEQUENCE ${sequence}`);
    }
  });

  it.each(["none", "constant"])("preserves non-allocating source IDs (%s)", async (kind) => {
    for (const table of ["events", "rsvps", "users"]) {
      await legacy.unsafe(
        `ALTER TABLE "${legacySchema}"."${table}" ALTER COLUMN id ${kind === "none" ? "DROP DEFAULT" : "SET DEFAULT 42"}`,
      );
    }
    const sourceBefore = await snapshot(legacy);
    expect((await importEventsRsvps(legacy, target, { dryRun: false })).events.inserted).toBe(4);
    expect(await snapshot(legacy)).toEqual(sourceBefore);
  });

  it("allows opposite-order duplicate search paths with CLI clients", async () => {
    const sourceUrl = alias(fixture.schemaName, "synthetic_duplicates");
    const source = new URL(sourceUrl);
    source.searchParams.append("search_path", legacySchema);
    const destination = new URL(alias(legacySchema, "synthetic_duplicates"));
    destination.searchParams.append("search_path", fixture.schemaName);
    const sourceClient = connectDatabase(source.href);
    const destinationClient = connectDatabase(destination.href);
    try {
      expect((await sourceClient`select current_schema() as schema`)[0]!.schema).toBe(legacySchema);
      expect((await destinationClient`select current_schema() as schema`)[0]!.schema).toBe(fixture.schemaName);
      expect(() => assertSeparateUrls(source.href, destination.href)).not.toThrow();
      const sourceBefore = await snapshot(sourceClient);
      expect((await importEventsRsvps(sourceClient, destinationClient, { dryRun: false })).events.inserted).toBe(4);
      expect(await snapshot(sourceClient)).toEqual(sourceBefore);
    } finally {
      await Promise.all([sourceClient.end(), destinationClient.end()]);
    }
  });

  it("allows isolated catalog-owned identity columns with source state unchanged", async () => {
    const sourceBefore = await snapshot(legacy);
    try {
      for (const table of ["events", "rsvps"]) {
        await target.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}" ALTER COLUMN id DROP DEFAULT,
          ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY`);
      }
      const report = await importEventsRsvps(legacy, target, { dryRun: false });
      expect(report.events.inserted).toBe(4);
      expect(report.rsvps.inserted).toBe(3);
      expect(await snapshot(legacy)).toEqual(sourceBefore);
    } finally {
      for (const table of ["events", "rsvps"]) {
        await target.unsafe(`ALTER TABLE "${fixture.schemaName}"."${table}" ALTER COLUMN id DROP IDENTITY IF EXISTS,
          ALTER COLUMN id SET DEFAULT nextval('"${fixture.schemaName}"."${table}_id_seq"'::regclass)`);
      }
    }
  });

  it("allows isolated schemas with CLI clients and keeps source state unchanged through apply/replay", async () => {
    const source = connectDatabase(alias(legacySchema, "synthetic_cli_source"));
    const destination = connectDatabase(alias(fixture.schemaName, "synthetic_cli_target"));
    try {
      const sourceBefore = await snapshot(source);
      const dryBefore = await snapshot(destination);
      expect((await importEventsRsvps(source, destination)).events.inserted).toBe(4);
      expect(await snapshot(destination)).toEqual(dryBefore);
      const report = await importEventsRsvps(source, destination, { dryRun: false });
      expect(report.events.inserted).toBe(4);
      expect(report.rsvps.inserted).toBe(3);
      expect(await snapshot(source)).toEqual(sourceBefore);
      expect((await importEventsRsvps(source, destination, { dryRun: false })).events.unchanged).toBe(4);
    } finally {
      await Promise.all([source.end(), destination.end()]);
    }
  });

  it("fails closed on missing destination identity with both fixture states unchanged", async () => {
    const destination = connectDatabase(alias(emptySchema, "synthetic_missing"));
    const sourceBefore = await snapshot(legacy);
    const targetBefore = await snapshot(target);
    try {
      await expect(importEventsRsvps(legacy, destination, { dryRun: false })).rejects.toThrow("no destination writes");
      expect(await snapshot(legacy)).toEqual(sourceBefore);
      expect(await snapshot(target)).toEqual(targetBefore);
    } finally {
      await destination.end();
    }
  });
});
