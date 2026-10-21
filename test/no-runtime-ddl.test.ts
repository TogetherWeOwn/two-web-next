// The runtime database role holds read/write only: no schema CREATE, so no
// production code path may run DDL. The helpers below exist as fixture-only
// bootstrap for disposable test schemas; the canonical DDL lives in
// drizzle/ and is applied by the migrate workflow. This scan keeps it that
// way: after removing comments, no src/ module outside the definition sites
// may name a bootstrap helper or carry a DDL statement. Verbs are paired
// with their object noun (create/alter/drop table, truncate to a target,
// grant/revoke … on), so prose identifiers such as a `truncate()` helper or
// `grant` records cannot trip it; a statement split across lines is caught
// by the whitespace-folded check.
//
// Scope is src/ because that is what ships in the Worker bundle: every .ts
// and .tsx module, the same set vitest coverage measures. Test, fixture,
// e2e and ci code may call the helpers against disposable schemas.
// Only full-line `//` comments and `/* */` blocks are removed: an inline
// trailing comment that names a helper fails the scan on purpose, so the
// author rewords it instead of the scan learning to skip code.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const SRC = "src";

// Module that defines each bootstrap helper, plus the one barrel that
// re-exports a helper. Every other src/ module must not name them.
const DEFINITION_SITES: Record<string, string[]> = {
  "src/sessions.ts": ["migrate", "migrateOAuthJourneys"],
  "src/oauth-journeys.ts": ["migrateOAuthJourneys"],
  "src/join/service.ts": ["migrateJoin"],
  "src/db/roster.ts": ["migrateRoster"],
  "src/admin/store-access.ts": ["ensureAccessLogGin"],
  "src/admin/store.ts": ["ensureAccessLogGin"],
};

// Files allowed to carry DDL text: the fixture-only bootstrap definitions.
const DDL_SITES = new Set([
  "src/sessions.ts",
  "src/oauth-journeys.ts",
  "src/join/service.ts",
  "src/db/roster.ts",
  "src/admin/store-access.ts",
]);

const HELPER_PATTERN =
  /\b(migrate|migrateJoin|migrateRoster|migrateOAuthJourneys|ensureAccessLogGin)\b/;
// DDL verbs paired with the object nouns this repo writes (see drizzle/):
// modifiers (or replace, temp/temporary, unlogged, unique, materialized)
// may sit between verb and noun, and grant/revoke span a comma-separated
// privilege list or ALL [PRIVILEGES] before ON.
const DDL_PATTERN =
  /\b(create\s+(or\s+replace\s+)?(temp\s+|temporary\s+|unlogged\s+|unique\s+|materialized\s+)*(table|index|sequence|extension|type|schema|view|function|trigger|policy|database)\b|alter\s+(table|index|sequence|type|schema|view|function|trigger|policy|database)\b|drop\s+(table|index|sequence|type|schema|view|function|trigger|policy|database)\b|truncate\s+(table\s+)?\w|grant\s+(all(\s+privileges)?|[a-z]+(\s*,\s*[a-z]+)*)\s+on\b|revoke\s+(all(\s+privileges)?|[a-z]+(\s*,\s*[a-z]+)*)\s+on\b)/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(`${rel}/`));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

function codeOnly(text: string): string {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlocks
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

// Positive controls: one sample per pattern branch, so narrowing or
// deleting any branch turns the suite red. Kept as plain strings in this
// test file, which lives outside the scanned src/ tree.
const DDL_SAMPLES = [
  "create table probe_ddl (id integer)",
  "create index probe_ddl_idx on probe_ddl (id)",
  "create sequence probe_ddl_seq",
  "create extension if not exists probe_ddl",
  "create type probe_ddl as enum ('a')",
  "create schema probe_ddl",
  "create view probe_ddl as select 1",
  "create function probe_ddl() returns void",
  "create trigger probe_ddl after insert on t execute function f()",
  "create policy probe_ddl on t for select using (true)",
  "create database probe_ddl",
  "create or replace function probe_ddl() returns void",
  "create temp table probe_ddl (id integer)",
  "create temporary table probe_ddl (id integer)",
  "create unlogged table probe_ddl (id integer)",
  "create unique index probe_ddl_idx on probe_ddl (id)",
  "create materialized view probe_ddl as select 1",
  "alter table probe_ddl add column c integer",
  "alter index probe_ddl rename to probe_ddl_2",
  "alter sequence probe_ddl restart",
  "alter type probe_ddl add value 'b'",
  "alter schema probe_ddl rename to probe_ddl_2",
  "alter view probe_ddl rename to probe_ddl_2",
  "alter function probe_ddl() rename to probe_ddl_2",
  "alter trigger probe_ddl on t rename to probe_ddl_2",
  "alter policy probe_ddl on t rename to probe_ddl_2",
  "alter database probe_ddl rename to probe_ddl_2",
  "drop table probe_ddl",
  "drop index probe_ddl",
  "drop sequence probe_ddl",
  "drop type probe_ddl",
  "drop schema probe_ddl",
  "drop view probe_ddl",
  "drop function probe_ddl",
  "drop trigger probe_ddl on t",
  "drop policy probe_ddl on t",
  "drop database probe_ddl",
  "truncate probe_ddl",
  "truncate table probe_ddl",
  "grant usage on schema s to r",
  "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA s TO r",
  "grant usage, select on all sequences in schema s to r",
  "grant all privileges on all tables in schema s to r",
  "grant all on schema s to r",
  "revoke usage on schema s from r",
  "revoke select, insert on probe_ddl from r",
  "revoke all privileges on schema s from r",
];

const HELPER_SAMPLES = [
  "await migrate(sql)",
  "await migrateJoin(sql)",
  "await migrateRoster(sql)",
  "await migrateOAuthJourneys(sql)",
  "await ensureAccessLogGin(db)",
];

// Comment-only text must not trip either pattern: full-line `//` lines and
// a `/* */` block carrying DDL statements and helper names.
const COMMENT_ONLY_SAMPLE = `// create table probe_ddl (id integer)
// await migrateJoin(sql)
/*
create or replace function probe_ddl() returns void as $$ begin end $$;
drop schema probe_ddl;
GRANT SELECT, INSERT ON probe_ddl TO r;
await migrateRoster(sql);
*/
`;

describe("no runtime DDL in the Worker bundle", () => {
  it("no src/ module outside the definition sites names a bootstrap helper", () => {
    const violations: string[] = [];
    for (const file of walk(`${SRC}/`)) {
      const expected = DEFINITION_SITES[file] ?? [];
      const lines = codeOnly(readFileSync(new URL(file, root), "utf8")).split("\n");
      lines.forEach((line, index) => {
        const match = HELPER_PATTERN.exec(line);
        const name = match?.[1];
        if (name && !expected.includes(name)) {
          violations.push(`${file}:${index + 1}: ${name} (${line.trim().slice(0, 100)})`);
        }
      });
    }
    expect(violations, "production modules must not call DDL bootstrap helpers").toEqual([]);
  });

  it("no src/ module outside the bootstrap definitions carries DDL text", () => {
    const violations: string[] = [];
    for (const file of walk(`${SRC}/`)) {
      if (DDL_SITES.has(file)) continue;
      const code = codeOnly(readFileSync(new URL(file, root), "utf8"));
      code.split("\n").forEach((line, index) => {
        if (DDL_PATTERN.test(line)) {
          violations.push(`${file}:${index + 1} (${line.trim().slice(0, 100)})`);
        }
      });
      // A statement split across lines evades the per-line check; folding
      // whitespace catches `create\ntable …` at file granularity.
      if (
        violations.every((v) => !v.startsWith(`${file}:`)) &&
        DDL_PATTERN.test(code.replace(/\s+/g, " "))
      ) {
        violations.push(`${file} (DDL statement split across lines)`);
      }
    }
    expect(violations, "DDL statements live in drizzle/ migrations, not in src/").toEqual([]);
  });

  it("each allowlist entry is still referenced (no stale exemptions)", () => {
    for (const [file, helpers] of Object.entries(DEFINITION_SITES)) {
      const code = codeOnly(readFileSync(new URL(file, root), "utf8"));
      for (const helper of helpers) {
        // Presence, not a definition assertion: sessions.ts imports and calls
        // migrateOAuthJourneys without defining it, and store.ts only
        // re-exports. If a helper leaves its file entirely, the exemption
        // must leave with it.
        const referenced = new RegExp(`\\b${helper}\\b`).test(code);
        expect(referenced, `${file} no longer references ${helper}: drop its exemption`).toBe(true);
      }
    }
    // A DDL exemption must leave with the DDL that justified it: every
    // DDL_SITES file must still carry a DDL statement after comment
    // stripping (folded, so split-line statements count).
    for (const file of DDL_SITES) {
      const folded = codeOnly(readFileSync(new URL(file, root), "utf8")).replace(/\s+/g, " ");
      expect(DDL_PATTERN.test(folded), `${file} no longer carries DDL: drop its exemption`).toBe(
        true,
      );
    }
  });

  it("positive controls pin every scanner branch", () => {
    // Walk filter: the scan must cover the shipped .ts/.tsx set, so a
    // future extension rename that shrinks the scan fails here instead of
    // passing vacuously.
    const files = walk(`${SRC}/`);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.endsWith(".tsx"))).toBe(true);
    for (const sample of DDL_SAMPLES) {
      expect(DDL_PATTERN.test(sample), `DDL sample not flagged: ${sample}`).toBe(true);
    }
    for (const sample of HELPER_SAMPLES) {
      expect(HELPER_PATTERN.test(sample), `helper sample not flagged: ${sample}`).toBe(true);
    }
    // A statement split across lines evades the per-line check; folding
    // whitespace must still catch it.
    const split = "create\ntable probe_ddl (id integer)";
    expect(split.split("\n").some((line) => DDL_PATTERN.test(line))).toBe(false);
    expect(DDL_PATTERN.test(split.replace(/\s+/g, " "))).toBe(true);
    // Comment-only text must not trip either pattern.
    const stripped = codeOnly(COMMENT_ONLY_SAMPLE);
    expect(DDL_PATTERN.test(stripped)).toBe(false);
    expect(DDL_PATTERN.test(stripped.replace(/\s+/g, " "))).toBe(false);
    expect(HELPER_PATTERN.test(stripped)).toBe(false);
  });
});
