// Member-erasure coverage (DB-free). Proves the operator command covers every
// member-keyed table and column: it introspects the migrations
// (drizzle/*.sql plus the runtime DDL in src/sessions.ts and
// src/join/service.ts, which carry the same CREATE/ALTER statements) and the
// Drizzle table definitions (src/db/schema.ts, src/db/admin-schema.ts), then
// asserts each member-keyed (table, column) is either erased by eraseMember
// (its table is in ERASURE_TABLES) or retained with evidence (named in
// docs/member-erasure.md with its own deletion or retention proof). A second
// test pins the Discord-embedding throttle buckets (rsvp-write, profile-write)
// to their 5-minute prune proof. Adding a member-keyed column or a new
// *-write:${...} bucket without covering it fails this suite.
//
// Live database round-trips stay in test/member-erasure.test.ts; this file
// never connects.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERASURE_TABLES } from "../src/member-erasure";

const root = fileURLToPath(new URL("..", import.meta.url).href);
const drizzleDir = join(root, "drizzle");
const srcDir = join(root, "src");
const docsPath = join(root, "docs", "member-erasure.md");

type LocatedColumn = { table: string; column: string; source: string };

/** Column names that identify a member. `users.id` (the Discord snowflake PK)
 * is handled as a special case below; Discord *event* ids (discord_event_id,
 * discord_sync_*) and machine-ingress ids (agent_id, guild_id, grant_id) are
 * deliberately not member keys. */
const MEMBER_KEYED_COLUMNS = new Set([
  "user_id",
  "discord_id",
  "viewer_discord_id",
  "viewer_user_id",
  "subject_user_ids",
  // activity_log nullableMorphs/causer shape: subject_id may reference a
  // member, so it is treated as member-linkable; the type discriminators
  // (subject_type, causer_type) carry no id and stay out.
  "subject_id",
  "causer_id",
  "created_by",
]);

const isMemberKeyed = (table: string, column: string): boolean =>
  (table === "users" && column === "id") || MEMBER_KEYED_COLUMNS.has(column);

/** Retained (not erased) member-keyed columns, each named in
 * docs/member-erasure.md with its retention reason. */
const RETAINED = new Map<string, string>([
  ["events.created_by", "moderator authorship, not member data"],
  ["featured_contents.created_by", "moderator authorship, not member data"],
  ["member_data_access_logs.viewer_discord_id", "append-only access evidence, 90-day prune"],
  ["member_data_access_logs.viewer_user_id", "append-only access evidence, 90-day prune"],
  ["member_data_access_logs.subject_user_ids", "append-only access evidence, 90-day prune"],
  ["activity_log.causer_id", "append-only moderation evidence, pruned by age"],
  ["activity_log.subject_id", "append-only moderation evidence, pruned by age"],
]);

const COLUMN_TYPES =
  "bigserial|serial|text|varchar|boolean|smallint|integer|bigint|timestamp|timestamptz|jsonb|uuid|numeric|real|bytea|date|time|interval|char";
const CREATE_TABLE_OPEN_RE = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s*\(/gi;
const ADD_COLUMN_RE =
  /ALTER TABLE\s+"?([A-Za-z0-9_]+)"?\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi;
const COLUMN_DEF_RE = new RegExp(`^\\s*"?(\\w+)"?\\s+(?:${COLUMN_TYPES})\\b`, "i");

/** (table, column) pairs from a CREATE TABLE body: the paren-balanced
 * segment after the opening paren, split on top-level commas. Works whether
 * the statement spans many lines or sits on a single line. Table-level
 * constraints (PRIMARY KEY, FOREIGN KEY, CONSTRAINT, UNIQUE, CHECK) never
 * match because no column type follows their first word. */
function columnsFromCreateTable(text: string, source: string): LocatedColumn[] {
  const found: LocatedColumn[] = [];
  for (const match of text.matchAll(CREATE_TABLE_OPEN_RE)) {
    const table = match[1]!;
    let depth = 1;
    let i = match.index! + match[0].length;
    const bodyStart = i;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    const body = text.slice(bodyStart, i - 1);
    let seg = "";
    let segDepth = 0;
    const parts: string[] = [];
    for (const ch of body) {
      if (ch === "(") segDepth++;
      else if (ch === ")") segDepth--;
      if (ch === "," && segDepth === 0) {
        parts.push(seg);
        seg = "";
      } else {
        seg += ch;
      }
    }
    parts.push(seg);
    for (const part of parts) {
      const def = COLUMN_DEF_RE.exec(part);
      if (def) found.push({ table, column: def[1]!, source });
    }
  }
  return found;
}

/** (table, column) pairs from literal CREATE/ALTER SQL, whether in a
 * drizzle/*.sql migration or in the runtime DDL strings of src/sessions.ts
 * (web_sessions) and src/join/service.ts (join_attempts, web_throttle_hits). */
function columnsFromSqlText(text: string, source: string): LocatedColumn[] {
  const found: LocatedColumn[] = [];
  for (const match of text.matchAll(ADD_COLUMN_RE)) {
    found.push({ table: match[1]!, column: match[2]!, source });
  }
  found.push(...columnsFromCreateTable(text, source));
  return found;
}

/** Per-table member key erased by eraseMember, parsed from its
 * `delete from <table> where <column> =` statements so the proof follows the
 * code: a member-keyed column on an erased table is covered only when it IS
 * the table's delete key (a new key on the same table would survive). */
function erasureDeleteKeys(): Map<string, string> {
  const text = readFileSync(join(root, "src/member-erasure.ts"), "utf8");
  const keys = new Map<string, string>();
  for (const match of text.matchAll(
    /delete\s+from\s+"?([A-Za-z0-9_]+)"?\s+where\s+"?([A-Za-z0-9_]+)"?\s*=/gi,
  )) {
    keys.set(match[1]!, match[2]!);
  }
  return keys;
}

const DRIZZLE_TABLE_RE = /pgTable\(\s*"([A-Za-z0-9_]+)"/g;
const DRIZZLE_COLUMN_RE =
  /\b(text|varchar|boolean|smallint|integer|bigint|bigserial|serial|uuid|timestamp|jsonb)\(\s*"([A-Za-z0-9_]+)"/g;

/** (table, column) pairs from Drizzle pgTable definitions. The owning table is
 * the nearest preceding pgTable("..."): column helpers only occur inside
 * their table's object literal, while index/unique names use other helpers. */
function columnsFromDrizzleTables(text: string, source: string): LocatedColumn[] {
  const tables: { name: string; index: number }[] = [];
  for (const match of text.matchAll(DRIZZLE_TABLE_RE)) {
    tables.push({ name: match[1]!, index: match.index! });
  }
  const found: LocatedColumn[] = [];
  for (const match of text.matchAll(DRIZZLE_COLUMN_RE)) {
    let owner: string | null = null;
    for (const table of tables) {
      if (table.index < match.index!) owner = table.name;
      else break;
    }
    if (owner) found.push({ table: owner, column: match[2]!, source });
  }
  return found;
}

function collectMigrationColumns(): LocatedColumn[] {
  const found: LocatedColumn[] = [];
  for (const file of readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"))) {
    const text = readFileSync(join(drizzleDir, file), "utf8");
    found.push(...columnsFromSqlText(text, `drizzle/${file}`));
  }
  // Runtime DDL mirrors of the same shapes (sessions store, join backstop).
  for (const rel of ["src/sessions.ts", "src/join/service.ts"]) {
    found.push(...columnsFromSqlText(readFileSync(join(root, rel), "utf8"), rel));
  }
  for (const rel of ["src/db/schema.ts", "src/db/admin-schema.ts"]) {
    found.push(...columnsFromDrizzleTables(readFileSync(join(root, rel), "utf8"), rel));
  }
  const seen = new Set<string>();
  return found.filter((c) => {
    const key = `${c.table}.${c.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkSrc(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

/** Discord-embedding write buckets: every `<prefix>-write:${...}` constructor
 * in src. IP-keyed buckets (`join:<client>`, `<name>:<client ip>`) and machine
 * credential buckets (`shield:<hash>`) never match this shape. */
function collectWriteBuckets(): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  const re = /([A-Za-z0-9_.-]+-write):\$\{/g;
  for (const path of walkSrc(srcDir)) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const match of line.matchAll(re)) {
        const prefix = match[1]!;
        const loc = `${relative(root, path)}:${i + 1}`;
        buckets.set(prefix, [...(buckets.get(prefix) ?? []), loc]);
      }
    });
  }
  return buckets;
}

/** The known Discord-embedding write buckets and where each one's 5-minute
 * prune lives. */
const MEMBER_BUCKETS = [
  { prefix: "rsvp-write", constructedIn: "src/events/rsvp.ts", prunedIn: "src/events/rsvp.ts" },
  {
    prefix: "profile-write",
    constructedIn: "src/profiles/routes.tsx",
    prunedIn: "src/join/service.ts",
  },
] as const;

const hasThrottlePrune = (rel: string): boolean => {
  const text = readFileSync(join(root, rel), "utf8");
  if (!/delete\s+from\s+web_throttle_hits/i.test(text)) return false;
  if (/5\s*minutes/.test(text)) return true;
  // Shared retention constant: the prune bound must resolve to 5 minutes.
  if (!/THROTTLE_COUNTER_RETENTION_MINUTES/.test(text)) return false;
  const service = readFileSync(join(root, "src/join/service.ts"), "utf8");
  return /THROTTLE_COUNTER_RETENTION_MINUTES\s*=\s*5\b/.test(service);
};

describe("member-erasure coverage (DB-free migration introspection)", () => {
  it("erases or documents every member-keyed column in the migrated schema", () => {
    const deleteKeys = erasureDeleteKeys();
    for (const table of ERASURE_TABLES) {
      expect(deleteKeys.has(table), `eraseMember has no delete for "${table}"`).toBe(true);
    }
    const docs = readFileSync(docsPath, "utf8");
    const uncovered: string[] = [];
    const undocumentedRetained: string[] = [];
    for (const { table, column, source } of collectMigrationColumns()) {
      if (!isMemberKeyed(table, column)) continue;
      const key = `${table}.${column}`;
      if (deleteKeys.get(table) === column) continue;
      const why = RETAINED.get(key);
      if (!why) {
        uncovered.push(`${key} (first seen in ${source})`);
        continue;
      }
      if (!docs.includes(table)) undocumentedRetained.push(key);
    }
    expect(
      uncovered,
      `member-keyed columns with no erasure or documented exclusion: ${uncovered.join(", ")}. ` +
        "Delete them in eraseMember (src/member-erasure.ts) or document them in " +
        "docs/member-erasure.md with a deletion proof.",
    ).toEqual([]);
    expect(
      undocumentedRetained,
      `retained columns missing from docs/member-erasure.md: ${undocumentedRetained.join(", ")}.`,
    ).toEqual([]);
    // The erasure tables themselves must exist in the migrated schema.
    const tables = new Set(collectMigrationColumns().map((c) => c.table));
    for (const table of ERASURE_TABLES) {
      expect(tables.has(table), `erasure table "${table}" has no migrated definition`).toBe(true);
    }
  });

  it("proves each Discord-embedding write bucket is ephemeral with a prune", () => {
    const buckets = collectWriteBuckets();
    expect(
      [...buckets.keys()].sort(),
      `unexpected write-bucket set (each entry is prefix -> locations): ${JSON.stringify([
        ...buckets.entries(),
      ])}. A new *-write:\${...} bucket embeds a member id: erase it in ` +
        "eraseMember or document its ephemeral exclusion with a deletion proof.",
    ).toEqual(MEMBER_BUCKETS.map((b) => b.prefix).sort());
    const docs = readFileSync(docsPath, "utf8");
    for (const { prefix, constructedIn, prunedIn } of MEMBER_BUCKETS) {
      const locations = buckets.get(prefix) ?? [];
      expect(
        locations.some((loc) => loc.startsWith(constructedIn)),
        `${prefix} bucket must still be constructed in ${constructedIn} (seen: ${locations.join(", ")})`,
      ).toBe(true);
      expect(hasThrottlePrune(prunedIn), `${prefix} prune proof missing in ${prunedIn}`).toBe(true);
      for (const needle of [prefix, "web_throttle_hits"]) {
        expect(docs.includes(needle), `docs/member-erasure.md must name ${needle}`).toBe(true);
      }
    }
    expect(
      /five\s+minutes|5-minute/i.test(docs),
      "docs/member-erasure.md must record the 5-minute throttle-bucket retention",
    ).toBe(true);
    expect(/prune/i.test(docs), "docs/member-erasure.md must describe the prune proof").toBe(true);
    // The profile path shares the join admission prune rather than owning one.
    expect(readFileSync(join(root, "src/profiles/routes.tsx"), "utf8")).toContain(
      "checkJoinThrottle",
    );
  });
});
