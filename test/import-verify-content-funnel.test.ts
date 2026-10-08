import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionSettings, importContentFunnel } from "../bin/import/content-funnel.mjs";
import { verify, type TableReport } from "../bin/import/verify.mjs";
import { defaultTableMap } from "../bin/import/verify-map.mjs";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { testDatabaseUrl } from "./helpers/member-data-db";

// The importer upserts on the preserved source PK (legacy_id) and never copies
// native ids, so the verifier must key these three tables the same way.
const funnelTables = ["featured_contents", "join_attempts", "event_search_logs"];
const clock = new Date("2026-09-30T12:00:00Z"); // Importer cutoff: 2026-07-02T12:00:00Z.
const fixtureSql = readFileSync(
  fileURLToPath(new URL("./fixtures/legacy/content-funnel.sql", import.meta.url).href),
  "utf8",
);

describe("content/funnel verify map identity (no database needed)", () => {
  const map = defaultTableMap({ cutoff: "2026-07-02T12:00:00Z" }).filter((t) =>
    funnelTables.includes(t.name),
  );

  it("keys legacy l.id against next legacy_id, never the native id", () => {
    expect(map.map((t) => t.name)).toEqual(funnelTables);
    for (const table of map) {
      expect(table.keys).toEqual([
        { name: "legacy_id", legacy: "l.id::text", next: "n.legacy_id" },
      ]);
      expect(table.mappingGaps ?? []).toEqual([]);
    }
  });

  it("selects only imported next rows and the importer's retention window", () => {
    for (const table of map) {
      expect(table.next.where).toMatch(/^n\.legacy_id IS NOT NULL/);
      expect(table.legacy.where).toMatch(/^l\.\w+ IS NOT NULL/); // Importer skips rows with no clock.
    }
    const [featured, ...pruned] = map;
    // Featured content is not pruned; join attempts and search logs share the cutoff.
    expect(featured!.legacy.where).not.toContain("2026-07-02");
    expect(featured!.next.where).not.toContain("2026-07-02");
    for (const table of pruned) {
      expect(table.legacy.where).toContain(">= '2026-07-02T12:00:00Z'::timestamptz");
      expect(table.next.where).toContain(">= '2026-07-02T12:00:00Z'::timestamptz");
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "verify chains to the real content-funnel importer on disposable test schemas",
  () => {
    let fixture: JobsFixture | undefined;
    let importSource: postgres.Sql | undefined;
    let legacyRead: postgres.Sql | undefined;
    let nextRead: postgres.Sql | undefined;
    let legacySchema: string;
    let sourceCreated = false;
    let cutoff: string;

    beforeEach(async () => {
      const url = testDatabaseUrl(process.env.DATABASE_URL!); // Refuse before any driver/DDL.
      fixture = await createJobsFixture(url.href);
      legacySchema = `legacy_${fixture.schemaName}`;
      await fixture.client.unsafe(fixtureSql.replaceAll(/\blegacy\b/g, legacySchema));
      sourceCreated = true;
      const settings = connectionSettings(
        {
          LEGACY_DATABASE_URL: url.href,
          DATABASE_URL: url.href,
          LEGACY_DATABASE_SCHEMA: legacySchema,
          DATABASE_SCHEMA: fixture.schemaName,
        },
        false,
      );
      importSource = postgres(settings.legacyUrl, settings.legacyOptions);
      const reader = { max: 1, port: 5432, password: () => url.password, onnotice: () => {} };
      legacyRead = postgres(url.href, reader);
      nextRead = postgres(url.href, reader);
      // Native ids deliberately collide with source ids; their legacy_id stays NULL.
      await fixture.client`insert into featured_contents (title) values ('Native featured entry')`;
      await fixture.client`insert into join_attempts (outcome, source) values ('added', 'native')`;
      await fixture.client`insert into event_search_logs (normalized_query, result_count) values ('native search', 1)`;
    });

    afterEach(async () => {
      try {
        await Promise.allSettled([
          importSource?.end({ timeout: 1 }),
          legacyRead?.end({ timeout: 1 }),
          nextRead?.end({ timeout: 1 }),
        ]);
        if (sourceCreated && fixture)
          await fixture.client.unsafe(`drop schema "${legacySchema}" cascade`);
      } finally {
        await fixture?.dispose();
        fixture = undefined;
        importSource = legacyRead = nextRead = undefined;
        sourceCreated = false;
      }
    });

    async function applyImport() {
      const report = await importContentFunnel({
        legacy: importSource!,
        target: fixture!.client,
        legacySchema,
        targetSchema: fixture!.schemaName,
        now: clock,
        dryRun: false,
      });
      // Verify with exactly the importer's anchor-minus-90-days instant.
      cutoff = report[0]!.cutoff;
      return report;
    }

    async function check() {
      const map = defaultTableMap({
        legacySchema,
        nextSchema: fixture!.schemaName,
        cutoff,
      }).filter((t) => funnelTables.includes(t.name));
      const report = await verify({ legacy: legacyRead!, next: nextRead!, map, batchSize: 2 });
      return Object.fromEntries(report.tables.map((t) => [t.table, t])) as Record<
        string,
        TableReport
      >;
    }

    // Per-table outcome only: the global exit code also folds in other tables' gaps.
    const outcome = (t: TableReport) => ({
      missing: t.missingKeys,
      extra: t.extraKeys,
      mismatch: t.mismatchKeys,
    });
    const clean = { missing: [], extra: [], mismatch: [] };

    it("reports zero missing, extra and mismatch for every imported row", async () => {
      const imported = await applyImport();
      expect(imported.map((r) => [r.inserted, r.skipped_old, r.skipped_missing_timestamp])).toEqual(
        [
          [2, 0, 0],
          [3, 1, 1],
          [3, 1, 0],
        ],
      );
      const report = await check();
      for (const name of funnelTables) {
        expect(report[name]!.keyColumns, name).toEqual(["legacy_id"]);
        expect(outcome(report[name]!), name).toEqual(clean);
        expect(report[name]!.mappingGaps, name).toEqual([]);
      }
      // Featured is compared in full (the 2025 row is not pruned). Join/search
      // select the cutoff-exact row and drop the old row; join also drops the
      // NULL-clock row the importer reports as skipped_missing_timestamp.
      expect(
        funnelTables.map((name) => [report[name]!.legacyCount, report[name]!.nextCount]),
      ).toEqual([
        [2, 2],
        [3, 3],
        [3, 3],
      ]);
      // The native rows exist on Next but are outside the imported set.
      const [native] = await fixture!.client`
        select (select count(*)::int from featured_contents where legacy_id is null) as featured,
          (select count(*)::int from join_attempts where legacy_id is null) as joins,
          (select count(*)::int from event_search_logs where legacy_id is null) as searches`;
      expect(native).toEqual({ featured: 1, joins: 1, searches: 1 });
    });

    it("does not report rows created natively after cutover as extras on a later re-run", async () => {
      await applyImport();
      await fixture!.client`insert into featured_contents (title) values ('Created after cutover')`;
      await fixture!.client`insert into join_attempts (outcome) values ('denied')`;
      await fixture!
        .client`insert into event_search_logs (normalized_query, result_count) values ('after cutover', 0)`;
      const rerun = await applyImport();
      expect(rerun.map((r) => [r.inserted, r.updated, r.unchanged])).toEqual([
        [0, 0, 2],
        [0, 0, 3],
        [0, 0, 3],
      ]);
      const report = await check();
      for (const name of funnelTables) expect(outcome(report[name]!), name).toEqual(clean);
      expect(report.join_attempts!.nextCount).toBe(3);
    });

    it("reports a changed imported row on its own table only, and the importer repairs it", async () => {
      await applyImport();
      await fixture!.client`update featured_contents set title = 'Edited' where legacy_id = '1'`;
      await fixture!.client`update join_attempts set outcome = 'expired' where legacy_id = '3'`;
      await fixture!.client`update event_search_logs set result_count = 9 where legacy_id = '4'`;
      let report = await check();
      expect(outcome(report.featured_contents!)).toEqual({ ...clean, mismatch: [["1"]] });
      expect(outcome(report.join_attempts!)).toEqual({ ...clean, mismatch: [["3"]] });
      expect(outcome(report.event_search_logs!)).toEqual({ ...clean, mismatch: [["4"]] });
      expect((await applyImport()).map((r) => r.updated)).toEqual([1, 1, 1]);
      report = await check();
      for (const name of funnelTables) expect(outcome(report[name]!), name).toEqual(clean);
    });

    it("reports a missing imported row (including the cutoff-exact row) and the importer restores it", async () => {
      await applyImport();
      for (const name of funnelTables)
        await fixture!.client.unsafe(`delete from "${name}" where legacy_id = '2'`);
      let report = await check();
      for (const name of funnelTables)
        expect(outcome(report[name]!), name).toEqual({ ...clean, missing: [["2"]] });
      expect((await applyImport()).map((r) => r.inserted)).toEqual([1, 1, 1]);
      report = await check();
      for (const name of funnelTables) expect(outcome(report[name]!), name).toEqual(clean);
    });

    it("reports an imported-looking next row absent from the source as an extra", async () => {
      await applyImport();
      await fixture!
        .client`insert into featured_contents (legacy_id, title) values ('999', 'Ghost')`;
      await fixture!
        .client`insert into join_attempts (legacy_id, outcome) values ('999', 'denied')`;
      await fixture!
        .client`insert into event_search_logs (legacy_id, normalized_query, result_count) values ('999', 'ghost', 0)`;
      const report = await check();
      for (const name of funnelTables)
        expect(outcome(report[name]!), name).toEqual({ ...clean, extra: [["999"]] });
    });

    it("ignores rows outside the importer's retention window and unknown-age source rows", async () => {
      await applyImport();
      // Legacy id 1 is older than the cutoff on both tables: never imported, not missing.
      // A copy left on Next by an earlier, wider import is also outside the window.
      await fixture!.client`insert into join_attempts (legacy_id, outcome, created_at)
        values ('1', 'denied', '2026-07-02 11:59:59.999999+00')`;
      await fixture!
        .client`insert into event_search_logs (legacy_id, normalized_query, result_count, occurred_at)
        values ('1', 'old game', 0, '2026-07-02 11:59:59.999999+00')`;
      const report = await check();
      for (const name of funnelTables) expect(outcome(report[name]!), name).toEqual(clean);
      // Legacy join id 5 has no created_at: the importer skips it (counted), so it is not missing.
      expect(report.join_attempts!.legacyCount).toBe(3);
      // The cutoff-exact row is inside the window and compared: tampering shows.
      await fixture!.client`update join_attempts set outcome = 'denied' where legacy_id = '2'`;
      expect(outcome((await check()).join_attempts!)).toEqual({ ...clean, mismatch: [["2"]] });
    });
  },
);
