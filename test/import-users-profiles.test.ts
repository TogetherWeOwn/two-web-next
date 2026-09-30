import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUsersProfilesFixture, type UsersProfilesFixture } from "./helpers/import-users-profiles-db";

const script = fileURLToPath(new URL("../bin/import/users-profiles.mjs", import.meta.url).href);
function run(args: string[] = [], env: Record<string, string> = {}) {
  // Do not inherit DB URLs, PG credentials or application secrets from the runner.
  return spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 20_000 });
}
function counts(output: string) {
  return output.trim().split("\n").map((line) => JSON.parse(line));
}
function withDateStyle(url: string, style: string) {
  const scoped = new URL(url);
  scoped.searchParams.set("datestyle", style);
  return scoped.toString();
}

describe("users/profiles import CLI safety (no database)", () => {
  it("requires both env-only URLs and rejects URL arguments without echoing them", () => {
    const missing = run();
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("must be set");
    const rejected = run(["postgres://synthetic:synthetic-password@example.test/db"]);
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).not.toContain("synthetic-password");
    expect(rejected.stderr).not.toContain("example.test");
    expect(run(["--apply", "--dry-run"]).status).toBe(2);
  });

  it("has help, refuses identical endpoints and redacts malformed-URL errors", () => {
    expect(run(["--help"]).status).toBe(0);
    const same = run([], { LEGACY_DATABASE_URL: "same", DATABASE_URL: "same" });
    expect(same.status).toBe(2);
    const malformed = run([], {
      LEGACY_DATABASE_URL: "http://[synthetic-credential-secret",
      DATABASE_URL: "http://[synthetic-target-secret",
    });
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("import failed");
    expect(malformed.stdout + malformed.stderr).not.toContain("synthetic-");
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("users/profiles import against disposable Postgres", () => {
  let fixture: UsersProfilesFixture;
  let legacy: UsersProfilesFixture["legacy"];
  let next: UsersProfilesFixture["next"];
  let env: Record<string, string>;

  beforeAll(async () => {
    fixture = await createUsersProfilesFixture(url!);
    ({ legacy, next, env } = fixture);
  });
  beforeEach(async () => { await fixture.reset(); });
  afterAll(async () => { await fixture?.dispose(); });

  it("defaults to a read-only dry run; apply preserves natural keys and times; re-run writes nothing", async () => {
    const before = await legacy`select * from users order by id`;
    const beforeProfiles = await legacy`select * from profiles order by id`;
    const preview = run([], env);
    expect(preview.status, preview.stderr).toBe(0);
    expect(counts(preview.stdout)).toEqual([
      { table: "users", dryRun: true, read: 3, changed: 3, unchanged: 0, written: 0 },
      { table: "profiles", dryRun: true, read: 2, changed: 2, unchanged: 0, written: 0 },
    ]);
    expect(await next`select * from users`).toHaveLength(0);
    expect(await next`select * from profiles`).toHaveLength(0);

    const applied = run(["--apply"], env);
    expect(applied.status, applied.stderr).toBe(0);
    expect(counts(applied.stdout)).toEqual([
      { table: "users", dryRun: false, read: 3, changed: 3, unchanged: 0, written: 3 },
      { table: "profiles", dryRun: false, read: 2, changed: 2, unchanged: 0, written: 2 },
    ]);
    const users = await next`select *, xmin::text as version from users order by id`;
    const profiles = await next`select *, xmin::text as version from profiles order by user_id`;
    expect(users.map((row) => row.id)).toEqual(before.map((row) => row.discord_id));
    expect(users[0]).toMatchObject({ username: "synthetic-member", member: true, avatar: "https://example.test/avatar.png" });
    expect(users[1]).toMatchObject({ username: "synthetic-member", member: false, avatar: null });
    expect(users[0]!.created_at.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    expect(users[2]!.updated_at.toISOString()).toBe("2026-08-03T12:00:00.000Z");
    expect(profiles[0]).toMatchObject({ user_id: users[0]!.id, bio: "Synthetic bio with unicode: café 🎮", games: ["Synthetic Game", "Another Game"], timezone: "Europe/London" });
    expect(profiles[0]!.created_at.toISOString()).toBe("2026-08-04T14:00:00.000Z");
    expect(profiles[1]).toMatchObject({ user_id: users[1]!.id, games: [], bio: null, timezone: null });
    expect(profiles[1]!.updated_at.toISOString()).toBe("2026-08-05T16:00:00.000Z");
    for (const row of [...users, ...profiles]) {
      expect(row).not.toHaveProperty("is_moderator");
      expect(row).not.toHaveProperty("moderator");
      expect(row).not.toHaveProperty("remember_token");
      expect(row).not.toHaveProperty("password");
    }
    expect(JSON.stringify({ users, profiles }) + applied.stdout + applied.stderr).not.toContain("synthetic-remember");

    const repeat = run(["--apply"], env);
    expect(repeat.status, repeat.stderr).toBe(0);
    expect(counts(repeat.stdout)).toEqual([
      { table: "users", dryRun: false, read: 3, changed: 0, unchanged: 3, written: 0 },
      { table: "profiles", dryRun: false, read: 2, changed: 0, unchanged: 2, written: 0 },
    ]);
    expect(await next`select *, xmin::text as version from users order by id`).toEqual(users);
    expect(await next`select *, xmin::text as version from profiles order by user_id`).toEqual(profiles);
    expect(counts(run(["--dry-run"], env).stdout).map((row) => row.changed)).toEqual([0, 0]);
    expect(await legacy`select * from users order by id`).toEqual(before);
    expect(await legacy`select * from profiles order by id`).toEqual(beforeProfiles);
  });

  it.each([
    ["SQL, DMY", "ISO, MDY"],
    ["ISO, DMY", "SQL, MDY"],
    ["German, DMY", "Postgres, MDY"],
  ])("preserves UTC timestamps from %s into %s, including unchanged previews", async (sourceStyle, targetStyle) => {
    // Keep every date ambiguous so SQL/DMY -> MDY would silently swap month/day, not just throw.
    await legacy`update users set updated_at = '2026-08-02 11:00:00' where id in (11, 22)`;
    await legacy`update profiles set updated_at = '2026-08-05 15:00:00' where user_id = 11`;
    const styledEnv = {
      LEGACY_DATABASE_URL: withDateStyle(env.LEGACY_DATABASE_URL!, sourceStyle),
      DATABASE_URL: withDateStyle(env.DATABASE_URL!, targetStyle),
    };
    const applied = run(["--apply"], styledEnv);
    expect(applied.status, applied.stderr).toBe(0);
    const users = await next`select created_at, updated_at, xmin::text as version from users order by id`;
    const profiles = await next`select created_at, updated_at, xmin::text as version from profiles order by user_id`;
    expect(users.map((row) => [row.created_at.toISOString(), row.updated_at.toISOString()])).toEqual([
      ["2026-08-01T10:00:00.000Z", "2026-08-02T11:00:00.000Z"],
      ["2026-08-02T11:00:00.000Z", "2026-08-02T11:00:00.000Z"],
      ["2026-08-03T12:00:00.000Z", "2026-08-03T12:00:00.000Z"],
    ]);
    expect(profiles.map((row) => [row.created_at.toISOString(), row.updated_at.toISOString()])).toEqual([
      ["2026-08-04T14:00:00.000Z", "2026-08-05T15:00:00.000Z"],
      ["2026-08-05T16:00:00.000Z", "2026-08-05T16:00:00.000Z"],
    ]);
    for (const args of [[], ["--apply"]]) {
      const repeat = run(args, styledEnv);
      expect(repeat.status, repeat.stderr).toBe(0);
      expect(counts(repeat.stdout).map((row) => [row.changed, row.written])).toEqual([[0, 0], [0, 0]]);
    }
    expect(await next`select created_at, updated_at, xmin::text as version from users order by id`).toEqual(users);
    expect(await next`select created_at, updated_at, xmin::text as version from profiles order by user_id`).toEqual(profiles);
  });

  it("updates conflicts and only dirty rows, including nulls and membership changes", async () => {
    expect(run(["--apply"], env).status).toBe(0);
    const unchanged = await next`select xmin::text as version from users where id = '900000000000000022'`;
    await legacy`update users set username = 'synthetic-updated', avatar = null, discord_joined_at = null,
      is_moderator = false, updated_at = '2026-09-30 17:00:00' where id = 11`;
    await legacy`update profiles set bio = null, games = '["Changed Game"]', timezone = null,
      updated_at = '2026-09-30 17:00:00' where user_id = 11`;
    const preview = run([], env);
    expect(preview.status, preview.stderr).toBe(0);
    expect(counts(preview.stdout).map((row) => [row.changed, row.written])).toEqual([[1, 0], [1, 0]]);
    const applied = run(["--apply"], env);
    expect(applied.status, applied.stderr).toBe(0);
    expect(counts(applied.stdout).map((row) => row.written)).toEqual([1, 1]);
    expect((await next`select * from users where id = '900000000000000011'`)[0]).toMatchObject({ username: "synthetic-updated", avatar: null, member: false });
    expect((await next`select * from profiles where user_id = '900000000000000011'`)[0]).toMatchObject({ bio: null, games: ["Changed Game"], timezone: null });
    expect(await next`select xmin::text as version from users where id = '900000000000000022'`).toEqual(unchanged);
  });

  it("fails before writing on invalid games or missing creation timestamps", async () => {
    await legacy`update profiles set games = '{"bad":"synthetic-profile-secret"}' where user_id = 11`;
    const invalid = run(["--apply"], env);
    expect(invalid.status).toBe(1);
    expect(invalid.stdout + invalid.stderr).not.toContain("synthetic-profile-secret");
    expect(await next`select * from users`).toHaveLength(0);
    expect(await next`select * from profiles`).toHaveLength(0);
    await legacy`update profiles set games = '[]', created_at = null where user_id = 11`;
    expect(run(["--apply"], env).status).toBe(1);
    expect(await next`select * from users`).toHaveLength(0);
  });

  it("rolls back user writes if the profile destination fails and prints no row details", async () => {
    await next`alter table profiles add constraint synthetic_rejection check (bio is null)`;
    try {
      const failed = run(["--apply"], env);
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).not.toContain("Synthetic bio");
      expect(failed.stderr).not.toContain("synthetic_rejection");
      expect(await next`select * from users`).toHaveLength(0);
      expect(await next`select * from profiles`).toHaveLength(0);
    } finally {
      await next`alter table profiles drop constraint synthetic_rejection`;
    }
  });
});
