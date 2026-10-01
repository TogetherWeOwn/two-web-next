import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";
import { createImportFixtureClients } from "./helpers/import-events-rsvps-db";
// @ts-expect-error standalone operator script has no type declarations
import { assertSeparateTargets, assertSeparateUrls, connectDatabase, importEventsRsvps, main } from "../bin/import/events-rsvps.mjs";

type Identity = { name: string; relation_id: string | null; relkind: string; inherited: boolean };
const identities = (start = 100): Identity[] => ["events", "rsvps", "users"].map((name, index) => ({
  name, relation_id: String(start + index), relkind: "r", inherited: false,
}));

function stubClient(rows = identities(), acquired: unknown = true, failure?: "identity" | "probe") {
  const queries: { text: string; values: unknown[] }[] = [];
  const sql = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (text.includes("pg_catalog.pg_class")) {
      if (failure === "identity") throw new Error("synthetic postgres://user:do-not-print@alias/db row-content");
      return rows;
    }
    if (text.includes("pg_try_advisory_xact_lock")) {
      if (failure === "probe") throw new Error("synthetic probe denied password=do-not-print row-content");
      return acquired === "missing" ? [{}] : [{ acquired }];
    }
    if (/^(insert|update|delete|lock)\b|nextval|setval/i.test(text)) throw new Error("Unexpected mutation");
    return [];
  }, {
    begin: vi.fn(async (_mode: string, callback: (transaction: unknown) => Promise<unknown>) => callback(sql)),
  });
  return { sql, queries };
}

const syntheticUrl = "postgres://synthetic:do-not-print@source.invalid/database";

describe("events import static and effective target separation", () => {
  it.each([
    [syntheticUrl, syntheticUrl],
    [syntheticUrl, "postgresql://synthetic:other-password@SOURCE.INVALID:5432/database"],
    ["postgres://synthetic@source.invalid/%64atabase?application_name=test&sslmode=require",
      "postgresql://synthetic@source.invalid:5432/database?sslmode=require&application_name=test"],
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

  it.each([true, false])("CLI statically refuses aliases with dryRun=%s without leaking inputs", async (dryRun) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main([dryRun ? "--dry-run" : "--apply"], {
        LEGACY_DATABASE_URL: syntheticUrl,
        DATABASE_URL: "postgresql://synthetic:other-password@SOURCE.INVALID:5432/database",
      })).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledExactlyOnceWith(
        "events-rsvps: could not establish isolated import tables; no destination writes. Verify separate databases/schemas and identity-probe access.",
      );
    } finally { error.mockRestore(); log.mockRestore(); }
  });

  it.each([true, false])("refuses same lock-domain tables before data reads or mutations, dryRun=%s", async (dryRun) => {
    const source = stubClient();
    const target = stubClient(identities(), false);
    await expect(importEventsRsvps(source.sql, target.sql, { dryRun })).rejects.toThrow("no destination writes");
    expect(source.sql.begin).toHaveBeenCalledWith("isolation level repeatable read read only", expect.any(Function));
    expect(target.sql.begin).toHaveBeenCalledWith(
      `isolation level repeatable read ${dryRun ? "read only" : "read write"}`, expect.any(Function),
    );
    for (const client of [source, target]) {
      expect(client.queries).toHaveLength(3); // timezone, catalog identity, lock-domain probe only
      expect(client.queries.some(({ text }) => /from events|from rsvps|from users|insert|nextval|setval|lock table/.test(text))).toBe(false);
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
    await expect(importEventsRsvps(stubClient().sql, stubClient(targetRows, false).sql, { dryRun: false }))
      .resolves.toMatchObject({ dryRun: false, events: { read: 0 }, rsvps: { read: 0 } });
  });

  it("allows independent database lock domains with equal local OIDs and names", async () => {
    await expect(importEventsRsvps(stubClient().sql, stubClient().sql, { dryRun: false }))
      .resolves.toMatchObject({ dryRun: false, events: { read: 0 } });
  });

  it("refuses one shared client before entering a transaction", async () => {
    const client = stubClient();
    await expect(importEventsRsvps(client.sql, client.sql, { dryRun: false })).rejects.toThrow("no destination writes");
    expect(client.sql.begin).not.toHaveBeenCalled();
  });

  it.each(["identity", "probe"] as const)("fails closed on denied %s queries without exposing driver errors", async (failure) => {
    for (const side of ["source", "target"]) {
      const source = stubClient(identities(), true, side === "source" ? failure : undefined);
      const target = stubClient(identities(200), false, side === "target" ? failure : undefined);
      await expect(importEventsRsvps(source.sql, target.sql, { dryRun: false })).rejects.toThrow(
        "Could not establish isolated import tables; no destination writes.",
      );
      expect([...source.queries, ...target.queries].some(({ text }) => /from events|from rsvps|from users/.test(text))).toBe(false);
    }
  });

  it.each(["missing", null, "true", 1, false])("refuses an unconfirmed source probe (%s)", async (acquired) => {
    const source = stubClient(identities(), acquired);
    const target = stubClient(identities(200), true);
    await expect(assertSeparateTargets(source.sql, target.sql)).rejects.toThrow("no destination writes");
    expect(target.queries.some(({ text }) => text.includes("pg_try_advisory_xact_lock"))).toBe(false);
  });

  it.each([null, "false", 0])("refuses a malformed destination probe (%s)", async (acquired) => {
    await expect(assertSeparateTargets(stubClient().sql, stubClient(identities(200), acquired).sql)).rejects.toThrow("no destination writes");
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
      } finally { await fixture.dispose(); }
    }
  });

  async function snapshot(sql: ReturnType<typeof postgres>) {
    return {
      events: await sql`select * from events order by id`,
      rsvps: await sql`select * from rsvps order by id`,
      users: await sql`select * from users order by id`,
      eventsSequence: await sql`select last_value, is_called from events_id_seq`,
      rsvpsSequence: await sql`select last_value, is_called from rsvps_id_seq`,
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
    } finally { await Promise.all([source.end(), destination.end()]); }
  });

  it("refuses a different current_schema whose search_path falls back to source tables", async () => {
    const destination = connectDatabase(alias(`${emptySchema},${legacySchema}`, "synthetic_fallback"));
    const before = await snapshot(legacy);
    try {
      expect((await destination`select current_schema() as schema`)[0]!.schema).toBe(emptySchema);
      await expect(importEventsRsvps(legacy, destination, { dryRun: false })).rejects.toThrow("no destination writes");
      expect(await snapshot(legacy)).toEqual(before);
    } finally { await destination.end(); }
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

  it("allows isolated schemas and applies real fixture rows while source state stays unchanged", async () => {
    const sourceBefore = await snapshot(legacy);
    const dryBefore = await snapshot(target);
    expect((await importEventsRsvps(legacy, target)).events.inserted).toBe(4);
    expect(await snapshot(target)).toEqual(dryBefore);
    const report = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(report.events.inserted).toBe(4);
    expect(report.rsvps.inserted).toBe(3);
    expect(await snapshot(legacy)).toEqual(sourceBefore);
    expect((await importEventsRsvps(legacy, target, { dryRun: false })).events.unchanged).toBe(4);
  });

  it("fails closed on missing destination identity with both fixture states unchanged", async () => {
    const destination = connectDatabase(alias(emptySchema, "synthetic_missing"));
    const sourceBefore = await snapshot(legacy);
    const targetBefore = await snapshot(target);
    try {
      await expect(importEventsRsvps(legacy, destination, { dryRun: false })).rejects.toThrow("no destination writes");
      expect(await snapshot(legacy)).toEqual(sourceBefore);
      expect(await snapshot(target)).toEqual(targetBefore);
    } finally { await destination.end(); }
  });
});
