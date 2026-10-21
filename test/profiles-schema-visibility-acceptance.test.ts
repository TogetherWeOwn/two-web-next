// Profiles schema acceptance: per-field visibility, handles, customization,
// linked accounts, backfill, erasure, and the pure visibility function.
//
// Spec interface the implementation must provide (additive only):
// - drizzle migration(s) after the known journal adding profiles columns
//   (handle citext unique, handle_changed_at, index_opt_in default false,
//   accent, banner_key, links <= 5, featured_games <= 6, plus a visibility
//   map as profiles.visibility JSONB or a profile_field_visibility table)
//   and a generic linked_accounts table with both uniques;
// - src/db/schema.ts exports linkedAccounts and the new profiles columns;
// - src/profiles/visibility.ts exports DEFAULT_VISIBILITY plus the pure
//   filterVisibleProfile(profile, viewerClass) for guest|member|owner|moderator;
// - src/member-erasure.ts deletes linked_accounts rows; docs/member-erasure.md
//   and docs/retention-ledger.md publish the new rows.
//
// Every test below fails until the builder lands that interface. The builder
// continues this branch history and never edits this file.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schemaModule from "../src/db/schema";
import { ERASURE_TABLES } from "../src/member-erasure";
import { createMemberDataFixture, testDatabaseUrl } from "./helpers/member-data-db";

const root = fileURLToPath(new URL("..", import.meta.url).href);
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const drizzleDir = join(root, "drizzle");

// Migrations known at the time these tests were written. Anything else in
// drizzle/*.sql is the schema slice under test.
const KNOWN_MIGRATIONS = new Set([
  "0000_init-users.sql",
  "0001_agent-events.sql",
  "1000_join-attempts-throttle.sql",
  "1001_admin-slice.sql",
  "1002_rsvps.sql",
  "1003_profiles.sql",
  "1004_job-unique-locks.sql",
  "1005_event-search-logs.sql",
  "1006_rsvp-synced-at.sql",
  "1007_queue-ledger.sql",
  "1008_agent-event-idempotency-prune-idx.sql",
  "1009_event-sync-failure.sql",
  "1010_rsvp-legacy-order.sql",
  "1011_legacy-audit-evidence.sql",
  "1012_content-funnel-import-keys.sql",
  "1013_hot-path-indexes.sql",
  "1014_event-ics-sequence.sql",
  "1016_job-lock-ownership.sql",
  "1017_queue_failed_job_identity.sql",
  "1018_audit-immutability.sql",
  "1019_shared-agent-events.sql",
  "1020_event-sync-revisions.sql",
  "1021_discord-event-snapshots.sql",
  "1022_web-sessions-oauth-journeys.sql",
  "1023_agent-event-audits-prune-idx.sql",
  "1024_board-view-logs.sql",
  "1025_leaderboard-opt-out.sql",
  "1027_join-attempts-discord-id-index.sql",
  "1028_join-attempts-request-id-index.sql",
  "1029_event-sync-terminal-intent.sql",
  "1030_session-predecessor-grace.sql",
  "1031_event-accessibility-notes.sql",
  "1032_event-public-join-details.sql",
]);

function newMigrationFiles(): string[] {
  return readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => !KNOWN_MIGRATIONS.has(f))
    .sort();
}

function newMigrationSql(): string {
  return newMigrationFiles()
    .map((f) => readFileSync(join(drizzleDir, f), "utf8"))
    .join("\n");
}

// Spec defaults: public display identity, members-only personal + Steam.
const PUBLIC_FIELDS = ["name", "avatar", "rank", "memberSince"] as const;
const MEMBERS_FIELDS = ["bio", "games", "timezone", "steam"] as const;
const ALL_FIELDS = [...PUBLIC_FIELDS, ...MEMBERS_FIELDS] as const;
type ViewerClass = "guest" | "member" | "owner" | "moderator";

type VisibilityModule = {
  DEFAULT_VISIBILITY: Record<string, string>;
  filterVisibleProfile: (
    profile: Record<string, unknown>,
    viewer: string,
  ) => Record<string, unknown>;
};

async function loadVisibilityModule(): Promise<VisibilityModule> {
  // Variable path on purpose: a static import would fail typecheck before the
  // builder lands the module. The tests pin the runtime contract instead.
  const parts = ["../src/profiles", "visibility.js"];
  const specifier = parts.join("/");
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch (error) {
    throw new Error(
      `SPEC INTERFACE MISSING: src/profiles/visibility.ts must export ` +
        `DEFAULT_VISIBILITY and filterVisibleProfile: ${(error as Error).message}`,
    );
  }
  const typed = mod as Partial<VisibilityModule>;
  if (!typed.DEFAULT_VISIBILITY || typeof typed.filterVisibleProfile !== "function") {
    throw new Error(
      "SPEC INTERFACE MISSING: src/profiles/visibility.ts must export " +
        "DEFAULT_VISIBILITY (object) and filterVisibleProfile (function)",
    );
  }
  return typed as VisibilityModule;
}

function fullProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Ada",
    avatar: "https://cdn.example.test/ada.png",
    rank: 7,
    memberSince: "2024-03-01",
    bio: "Loves chess",
    games: ["Chess", "Go"],
    timezone: "Europe/London",
    steam: { persona: "ada", steamId: "76561198000000001" },
    ...overrides,
  };
}

describe("profiles schema migrations are additive", () => {
  it("ships at least one new migration beyond the known journal", () => {
    const files = newMigrationFiles();
    expect(
      files,
      `expected a new drizzle migration adding profiles columns + linked_accounts; found only: ${files.join(", ") || "(none)"}`,
    ).not.toHaveLength(0);
  });

  it("adds the profiles handle, opt-in, and customization columns", () => {
    const sql = newMigrationSql().toLowerCase();
    for (const column of [
      "handle",
      "handle_changed_at",
      "index_opt_in",
      "accent",
      "banner_key",
      "links",
      "featured_games",
    ]) {
      expect(sql, `new migration must add profiles.${column}`).toContain(column);
    }
  });

  it("adds a per-field visibility store with the spec defaults", () => {
    const sql = newMigrationSql().toLowerCase();
    const hasJsonMap = sql.includes("visibility") && sql.includes("profiles");
    const hasTable = sql.includes("profile_field_visibility");
    expect(
      hasJsonMap || hasTable,
      "new migration must add a visibility map (profiles.visibility JSONB or profile_field_visibility table)",
    ).toBe(true);
    // Defaults must appear in the migration: public identity, members personal.
    for (const field of ["name", "avatar", "rank", "member"]) {
      expect(sql, `visibility defaults must name public field ${field}`).toContain(field);
    }
    for (const field of ["bio", "games", "timezone", "steam"]) {
      expect(sql, `visibility defaults must name members field ${field}`).toContain(field);
    }
  });

  it("creates the generic linked_accounts table with both uniques", () => {
    const sql = newMigrationSql().toLowerCase();
    expect(sql).toContain("linked_accounts");
    for (const column of ["user_id", "provider", "provider_user_id", "linked_at", "synced_at"]) {
      expect(sql, `linked_accounts must have ${column}`).toContain(column);
    }
    expect(sql).toContain("jsonb");
    // Both uniqueness scopes: one account per provider identity, one row per member+provider.
    expect(sql).toContain("provider");
    expect(sql).toContain("unique");
  });

  it("never drops, truncates, or rewrites existing tables", () => {
    const sql = newMigrationSql();
    for (const banned of [
      /drop\s+table/i,
      /drop\s+column/i,
      /truncate/i,
      /alter\s+table\s+"?users"?\s+drop/i,
      /alter\s+table\s+"?profiles"?\s+drop/i,
      /delete\s+from\s+"?(users|profiles|rsvps)"?/i,
    ]) {
      expect(sql, `additive migration must not match ${banned}`).not.toMatch(banned);
    }
  });

  it("registers the new migration in the drizzle journal", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json")) as {
      entries: { tag: string }[];
    };
    const tags = journal.entries.map((e) => e.tag);
    const files = newMigrationFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const tag = file.replace(/\.sql$/, "");
      expect(tags, `journal must register ${tag}`).toContain(tag);
    }
  });
});

describe("profiles Drizzle schema exports", () => {
  it("exports linkedAccounts with the generic columns", async () => {
    const table = (schemaModule as Record<string, unknown>).linkedAccounts;
    expect(table, "src/db/schema.ts must export linkedAccounts").toBeDefined();
    if (!table) return;
    const { getTableColumns } = await import("drizzle-orm");
    const columns = Object.values(
      getTableColumns(table as unknown as Parameters<typeof getTableColumns>[0]),
    ).map((c) => c.name);
    for (const column of [
      "user_id",
      "provider",
      "provider_user_id",
      "data",
      "linked_at",
      "synced_at",
    ]) {
      expect(columns, `linkedAccounts must map ${column}`).toContain(column);
    }
  });

  it("maps the new profiles columns", async () => {
    const { getTableColumns } = await import("drizzle-orm");
    const columns = Object.values(getTableColumns(schemaModule.profiles)).map((c) => c.name);
    for (const column of [
      "handle",
      "handle_changed_at",
      "index_opt_in",
      "accent",
      "banner_key",
      "links",
      "featured_games",
    ]) {
      expect(columns, `profiles must map ${column}`).toContain(column);
    }
    const hasVisibilityColumn = columns.includes("visibility");
    const hasVisibilityTable =
      (schemaModule as Record<string, unknown>).profileFieldVisibility !== undefined;
    expect(
      hasVisibilityColumn || hasVisibilityTable,
      "schema must map visibility (profiles.visibility or profileFieldVisibility)",
    ).toBe(true);
  });
});

describe("profile visibility spec interface", () => {
  it("ships the visibility module", () => {
    expect(
      existsSync(join(root, "src/profiles/visibility.ts")),
      "src/profiles/visibility.ts must exist",
    ).toBe(true);
  });

  it("pins the default map: public identity, members personal", async () => {
    const mod = await loadVisibilityModule();
    expect(mod.DEFAULT_VISIBILITY).toMatchObject({
      name: "public",
      avatar: "public",
      rank: "public",
      memberSince: "public",
      bio: "members",
      games: "members",
      timezone: "members",
      steam: "members",
    });
  });

  it("guest sees only public fields under defaults; member/owner/moderator see all", async () => {
    const mod = await loadVisibilityModule();
    const profile = fullProfile();
    const guest = mod.filterVisibleProfile(profile, "guest");
    expect(Object.keys(guest).sort()).toEqual([...PUBLIC_FIELDS].sort());
    for (const viewer of ["member", "owner", "moderator"] as const) {
      const visible = mod.filterVisibleProfile(profile, viewer);
      expect(Object.keys(visible).sort(), `${viewer} must see every field`).toEqual(
        [...ALL_FIELDS].sort(),
      );
    }
  });

  it.each(ALL_FIELDS)("field %s flips for guests when its toggle flips", async (field) => {
    const mod = await loadVisibilityModule();
    const isPublicDefault = (PUBLIC_FIELDS as readonly string[]).includes(field);
    const flipped = isPublicDefault ? "members" : "public";
    const profile = fullProfile({ visibility: { [field]: flipped } });
    const guest = mod.filterVisibleProfile(profile, "guest");
    if (isPublicDefault) {
      expect(guest, `guest must lose ${field} once set to members`).not.toHaveProperty(field);
    } else {
      expect(guest, `guest must gain ${field} once set to public`).toHaveProperty(field);
    }
    for (const viewer of ["member", "owner", "moderator"] as const) {
      const visible = mod.filterVisibleProfile(profile, viewer);
      expect(visible, `${viewer} must keep ${field} after the flip`).toHaveProperty(field);
    }
  });

  it.each(["guest", "member", "owner", "moderator"] as const)(
    "viewer %s never receives a field outside its class",
    async (viewer: ViewerClass) => {
      const mod = await loadVisibilityModule();
      // Adversarial map: every members-default field stays members, every
      // public-default field is forced to members except name.
      const profile = fullProfile({
        visibility: {
          avatar: "members",
          rank: "members",
          memberSince: "members",
          bio: "members",
          games: "members",
          timezone: "members",
          steam: "members",
        },
      });
      const visible = mod.filterVisibleProfile(profile, viewer);
      if (viewer === "guest") {
        expect(Object.keys(visible).sort()).toEqual(["name"]);
      } else {
        expect(Object.keys(visible).sort()).toEqual([...ALL_FIELDS].sort());
      }
    },
  );

  it("is pure: no input mutation, deterministic output", async () => {
    const mod = await loadVisibilityModule();
    const profile = fullProfile({ visibility: { bio: "public" } });
    const before = JSON.parse(JSON.stringify(profile)) as Record<string, unknown>;
    const first = mod.filterVisibleProfile(profile, "guest");
    const second = mod.filterVisibleProfile(profile, "guest");
    expect(profile).toEqual(before);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("rejects unknown viewer classes instead of leaking", async () => {
    const mod = await loadVisibilityModule();
    expect(() => mod.filterVisibleProfile(fullProfile(), "staff")).toThrow();
    expect(() => mod.filterVisibleProfile(fullProfile(), "")).toThrow();
  });
});

describe("member erasure covers the new rows", () => {
  it("lists linked_accounts as an erasure table", () => {
    expect([...ERASURE_TABLES]).toContain("linked_accounts");
  });

  it("deletes linked_accounts rows by member id in code", () => {
    const erasure = read("src/member-erasure.ts");
    expect(erasure).toContain("linked_accounts");
    expect(erasure).toMatch(/delete\s+from\s+linked_accounts\s+where\s+user_id\s*=/i);
  });

  it("publishes linked_accounts in the erasure doc's deleted table", () => {
    const doc = read("docs/member-erasure.md");
    const deletedStart = doc.indexOf("## What is deleted");
    const retainedStart = doc.indexOf("## What is retained");
    expect(deletedStart).toBeGreaterThanOrEqual(0);
    expect(retainedStart).toBeGreaterThan(deletedStart);
    const deleted = doc.slice(deletedStart, retainedStart);
    expect(deleted).toContain("linked_accounts");
    expect(deleted).toContain("user_id");
  });
});

describe("retention ledger covers the new rows", () => {
  it("publishes a linked_accounts row with window, mechanism, and proof", () => {
    const doc = read("docs/retention-ledger.md");
    const rows = doc.split("\n").filter((line) => line.startsWith("| `linked_accounts`"));
    expect(rows, "ledger must carry one dedicated linked_accounts row").toHaveLength(1);
    const row = rows[0] as string;
    for (const claim of [
      "linked_accounts",
      "eraseMember",
      "member-erasure.md#what-is-deleted",
      "src/member-erasure.ts",
    ]) {
      expect(row, `linked_accounts row must pin: ${claim}`).toContain(claim);
    }
  });

  it("publishes the profiles customization retention next to the profiles row", () => {
    const doc = read("docs/retention-ledger.md");
    const rows = doc.split("\n").filter((line) => /^\| `profiles`(?:\s|\|)/.test(line));
    expect(rows, "ledger must keep its dedicated profiles row").toHaveLength(1);
    const row = rows[0] as string;
    for (const claim of ["handle", "linked_accounts", "eraseMember"]) {
      expect(row, `profiles row must pin: ${claim}`).toContain(claim);
    }
  });
});

// Live round-trips use a guarded disposable schema on the approved test host.
describe.skipIf(!process.env.DATABASE_URL)("profiles schema on scratch Postgres", () => {
  let fixture: Awaited<ReturnType<typeof createMemberDataFixture>> | undefined;
  let sql: postgres.Sql;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL as string);
    sql = fixture.client;
  }, 60_000);

  afterAll(async () => {
    await fixture?.dispose();
  });

  it("exposes the new profiles columns with the spec defaults", async () => {
    const cols = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
      where table_schema = current_schema() and table_name = 'profiles'`;
    const names = cols.map((c) => c.column_name);
    for (const column of [
      "handle",
      "handle_changed_at",
      "index_opt_in",
      "accent",
      "banner_key",
      "links",
      "featured_games",
    ]) {
      expect(names, `profiles must expose ${column}`).toContain(column);
    }
    // index_opt_in defaults to false (search noindex until opt-in).
    await sql`insert into users (id, username) values ('900000000000000001', 'schema-defaults')`;
    await sql`insert into profiles (user_id) values ('900000000000000001')`;
    const [row] = await sql<{ index_opt_in: boolean }[]>`
      select index_opt_in from profiles where user_id = '900000000000000001'`;
    expect(row?.index_opt_in).toBe(false);
  });

  it("exposes the visibility store with the spec defaults", async () => {
    const profileCols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'profiles'`;
    const names = profileCols.map((c) => c.column_name);
    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = current_schema()`;
    const tableNames = tables.map((t) => t.table_name);
    if (names.includes("visibility")) {
      await sql`insert into users (id, username) values ('900000000000000002', 'vis-defaults')`;
      await sql`insert into profiles (user_id) values ('900000000000000002')`;
      const [row] = await sql<{ visibility: Record<string, string> }[]>`
        select visibility from profiles where user_id = '900000000000000002'`;
      expect(row?.visibility).toMatchObject({
        name: "public",
        avatar: "public",
        rank: "public",
        bio: "members",
        games: "members",
        timezone: "members",
        steam: "members",
      });
    } else {
      expect(
        tableNames,
        "visibility needs profiles.visibility or a profile_field_visibility table",
      ).toContain("profile_field_visibility");
      const visCols = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'profile_field_visibility'`;
      expect(visCols.map((c) => c.column_name)).toContain("user_id");
    }
  });

  it("enforces case-insensitive handle uniqueness", async () => {
    await sql`insert into users (id, username) values ('900000000000000003', 'CaseOne')`;
    await sql`insert into users (id, username) values ('900000000000000004', 'casetwo')`;
    await sql`insert into profiles (user_id, handle) values ('900000000000000003', 'UniqueHandle')`;
    await expect(
      sql`insert into profiles (user_id, handle) values ('900000000000000004', 'uniquehandle')`,
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      sql`insert into profiles (user_id, handle) values ('900000000000000004', 'UNIQUEHANDLE')`,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("creates linked_accounts with both uniques", async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'linked_accounts'`;
    const names = cols.map((c) => c.column_name);
    for (const column of [
      "user_id",
      "provider",
      "provider_user_id",
      "data",
      "linked_at",
      "synced_at",
    ]) {
      expect(names, `linked_accounts must expose ${column}`).toContain(column);
    }
    await sql`insert into users (id, username) values ('900000000000000005', 'link-one')`;
    await sql`insert into users (id, username) values ('900000000000000006', 'link-two')`;
    await sql`insert into linked_accounts (user_id, provider, provider_user_id, data)
      values ('900000000000000005', 'steam', '76561198000000001', '{"persona":"one"}')`;
    // Same provider identity cannot link to a second member.
    await expect(
      sql`insert into linked_accounts (user_id, provider, provider_user_id, data)
        values ('900000000000000006', 'steam', '76561198000000001', '{"persona":"two"}')`,
    ).rejects.toMatchObject({ code: "23505" });
    // Same member cannot link a second account on one provider.
    await expect(
      sql`insert into linked_accounts (user_id, provider, provider_user_id, data)
        values ('900000000000000005', 'steam', '76561198000000002', '{"persona":"dup"}')`,
    ).rejects.toMatchObject({ code: "23505" });
    // A different provider on the same identity stays allowed (generic model).
    await sql`insert into linked_accounts (user_id, provider, provider_user_id, data)
      values ('900000000000000006', 'twitch', '76561198000000001', '{"login":"two"}')`;
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from linked_accounts where provider_user_id = '76561198000000001'`;
    expect(rows[0]?.n).toBe(2);
  });

  it("caps links at 5 and featured games at 6", async () => {
    await sql`insert into users (id, username) values ('900000000000000007', 'caps-one')`;
    const five = JSON.stringify(["a", "b", "c", "d", "e"]);
    const six = JSON.stringify(["a", "b", "c", "d", "e", "f"]);
    await sql`insert into profiles (user_id, links) values ('900000000000000007', ${five}::jsonb)`;
    await expect(
      sql`update profiles set links = ${six}::jsonb where user_id = '900000000000000007'`,
    ).rejects.toThrow();
    const sixGames = JSON.stringify(["1", "2", "3", "4", "5", "6"]);
    const sevenGames = JSON.stringify(["1", "2", "3", "4", "5", "6", "7"]);
    await sql`update profiles set featured_games = ${sixGames}::jsonb where user_id = '900000000000000007'`;
    await expect(
      sql`update profiles set featured_games = ${sevenGames}::jsonb where user_id = '900000000000000007'`,
    ).rejects.toThrow();
  });

  it("erases linked_accounts rows with the member, keeping neighbors", async () => {
    const { eraseMember } = await import("../src/member-erasure");
    await sql`insert into users (id, username) values ('900000000000000008', 'erase-one')`;
    await sql`insert into users (id, username) values ('900000000000000009', 'erase-two')`;
    await sql`insert into profiles (user_id) values ('900000000000000008'), ('900000000000000009')`;
    await sql`insert into linked_accounts (user_id, provider, provider_user_id, data)
      values ('900000000000000008', 'steam', '76561198000000008', '{}'),
             ('900000000000000009', 'steam', '76561198000000009', '{}')`;
    const result = await eraseMember(
      sql as unknown as Parameters<typeof eraseMember>[0],
      "900000000000000008",
      { dryRun: false },
    );
    expect(result.users).toBe(1);
    const remaining = await sql<{ user_id: string }[]>`select user_id from linked_accounts`;
    expect(remaining.map((r) => r.user_id)).toEqual(["900000000000000009"]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("handle backfill is deterministic", () => {
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url).href);

  async function backfilledHandles(seed: { id: string; username: string }[]): Promise<string[]> {
    const url = testDatabaseUrl(process.env.DATABASE_URL as string);
    const schemaName = `handle_backfill_${randomUUID().replaceAll("-", "")}`;
    const options = {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      onnotice: () => {},
    };
    const admin = postgres(url.href, options);
    const client = postgres(url.href, { ...options, connection: { search_path: schemaName } });
    try {
      await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
      const all = readMigrationFiles({ migrationsFolder });
      const knownCount = KNOWN_MIGRATIONS.size;
      const before = all.slice(0, knownCount);
      const after = all.slice(knownCount);
      expect(
        after.length,
        "backfill needs the new migration after the known journal",
      ).toBeGreaterThan(0);
      await client.begin(async (tx) => {
        for (const migration of before) {
          for (const statement of migration.sql) {
            if (statement.trim()) {
              await tx.unsafe(statement.replaceAll('"public".', `"${schemaName}".`));
            }
          }
        }
      });
      for (const row of seed) {
        await client`insert into users (id, username) values (${row.id}, ${row.username})`;
      }
      await client.begin(async (tx) => {
        for (const migration of after) {
          for (const statement of migration.sql) {
            if (statement.trim()) {
              await tx.unsafe(statement.replaceAll('"public".', `"${schemaName}".`));
            }
          }
        }
      });
      const rows = await client<{ user_id: string; handle: string }[]>`
        select user_id, handle from profiles order by user_id`;
      expect(rows.length, "every seeded member must get a backfilled handle").toBe(seed.length);
      return rows.map((r) => `${r.user_id}=${r.handle}`);
    } finally {
      try {
        await client.end({ timeout: 1 });
      } finally {
        try {
          await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
        } finally {
          await admin.end({ timeout: 1 });
        }
      }
    }
  }

  it("backfills every member from the Discord username, unique case-insensitively", async () => {
    const seed = [
      { id: "910000000000000001", username: "Alice" },
      { id: "910000000000000002", username: "alice" },
      { id: "910000000000000003", username: "ALICE" },
      { id: "910000000000000004", username: "bob" },
    ];
    const handles = await backfilledHandles(seed);
    expect(handles).toHaveLength(4);
    const values = handles.map((h) => h.split("=")[1] as string);
    expect(new Set(values.map((v) => v.toLowerCase())).size).toBe(4);
    // First writer keeps the clean lowercased username; collisions stay derived.
    const first = values[0] as string;
    expect(first).toBe("alice");
    for (const value of values.slice(1, 3)) {
      expect(value?.toLowerCase()).toContain("alice");
    }
    expect(values[3]?.toLowerCase()).toContain("bob");
  });

  it("resolves the same collisions identically on every run", async () => {
    const seed = [
      { id: "920000000000000001", username: "Sam" },
      { id: "920000000000000002", username: "sam" },
      { id: "920000000000000003", username: "SAM" },
    ];
    const first = await backfilledHandles(seed);
    const second = await backfilledHandles(seed);
    expect(second).toEqual(first);
  });

  it("keeps pre-existing handles instead of overwriting them", async () => {
    const url = testDatabaseUrl(process.env.DATABASE_URL as string);
    const schemaName = `handle_keep_${randomUUID().replaceAll("-", "")}`;
    const options = {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      onnotice: () => {},
    };
    const admin = postgres(url.href, options);
    const client = postgres(url.href, { ...options, connection: { search_path: schemaName } });
    try {
      await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
      const all = readMigrationFiles({ migrationsFolder });
      const before = all.slice(0, KNOWN_MIGRATIONS.size);
      const after = all.slice(KNOWN_MIGRATIONS.size);
      await client.begin(async (tx) => {
        for (const migration of before) {
          for (const statement of migration.sql) {
            if (statement.trim()) {
              await tx.unsafe(statement.replaceAll('"public".', `"${schemaName}".`));
            }
          }
        }
      });
      await client`insert into users (id, username) values ('930000000000000001', 'carol')`;
      // Pre-migration profile row without a handle column yet.
      await client`insert into profiles (user_id, bio) values ('930000000000000001', 'hi')`;
      await client.begin(async (tx) => {
        for (const migration of after) {
          for (const statement of migration.sql) {
            if (statement.trim()) {
              await tx.unsafe(statement.replaceAll('"public".', `"${schemaName}".`));
            }
          }
        }
      });
      // Builder may seed handle_changed_at on backfill; the handle itself must
      // derive from the Discord username.
      const [row] = await client<{ handle: string }[]>`
        select handle from profiles where user_id = '930000000000000001'`;
      expect(row?.handle.toLowerCase()).toContain("carol");
      // A second migration pass must not rewrite the backfilled value.
      await client.begin(async (tx) => {
        for (const migration of after) {
          for (const statement of migration.sql) {
            if (statement.trim()) {
              // Re-running additive DDL is idempotent; backfill must be guarded.
              if (/create\s+table|add\s+column|create\s+(unique\s+)?index/i.test(statement))
                continue;
              await tx.unsafe(statement.replaceAll('"public".', `"${schemaName}".`));
            }
          }
        }
      });
      const [again] = await client<{ handle: string }[]>`
        select handle from profiles where user_id = '930000000000000001'`;
      expect(again?.handle).toBe(row?.handle);
    } finally {
      try {
        await client.end({ timeout: 1 });
      } finally {
        try {
          await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
        } finally {
          await admin.end({ timeout: 1 });
        }
      }
    }
  });
});
