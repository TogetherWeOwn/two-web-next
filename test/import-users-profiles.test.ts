import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { profileAvatarSrcset } from "../src/islands/contracts";
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
const { importUsersProfiles } = await import(pathToFileURL(script).href);
function withoutSessionOverrides(url: string) {
  const scoped = new URL(url);
  // The shared fixture deliberately adds a hostile timezone. The CLI now
  // refuses session overrides; direct-client tests below exercise those defaults.
  scoped.searchParams.delete("timezone");
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

  it.each([
    ["", "", 5432, 5432],
    [":5434", "", 5434, 5432],
    ["", ":5435", 5432, 5435],
    [":5434", ":5435", 5434, 5435],
  ])("pins both client ports for source %s and target %s without connecting", (sourcePort, targetPort, expectedSource, expectedTarget) => {
    const constructed = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { createImportClient } = await import(${JSON.stringify(pathToFileURL(script).href)});
      const clients = [process.env.LEGACY_DATABASE_URL, process.env.DATABASE_URL].map(createImportClient);
      console.log(JSON.stringify(clients.map(sql => sql.options.port)));
      await Promise.all(clients.map(sql => sql.end()));
    `], {
      env: {
        PGPORT: "5433",
        LEGACY_DATABASE_URL: `postgres://agent_test@agent-testdb${sourcePort}/two_web_next`,
        DATABASE_URL: `postgres://agent_test@agent-testdb${targetPort}/two_web_next`,
      },
      encoding: "utf8", timeout: 20_000,
    });
    expect(constructed.status, constructed.stderr).toBe(0);
    expect(JSON.parse(constructed.stdout)).toEqual([[expectedSource], [expectedTarget]]);
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
    ({ legacy, next } = fixture);
    env = Object.fromEntries(Object.entries(fixture.env).map(([key, value]) => [key, withoutSessionOverrides(value)]));
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
    expect(users[0]).toMatchObject({ username: "Synthetic Display", member: true, avatar: "abc123" });
    expect(profileAvatarSrcset(users[0]!.id, users[0]!.avatar)).toEqual({
      src: "https://cdn.discordapp.com/avatars/900000000000000011/abc123.png?size=128",
      srcset: "https://cdn.discordapp.com/avatars/900000000000000011/abc123.png?size=64 1x, https://cdn.discordapp.com/avatars/900000000000000011/abc123.png?size=128 2x, https://cdn.discordapp.com/avatars/900000000000000011/abc123.png?size=256 3x",
    });
    expect(users[1]).toMatchObject({ username: "synthetic-member", member: false, avatar: null });
    expect(users[2]).toMatchObject({ username: "synthetic-no-profile", member: true, avatar: null });
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
    ["https://cdn.discordapp.com/avatars/900000000000000011/a_abc123.gif?size=512", "a_abc123"],
    ["https://cdn.discordapp.com/avatars/900000000000000011/abc123.webp?size=64", "abc123"],
    ["https://cdn.discordapp.com/avatars/900000000000000011/abc123.jpeg", "abc123"],
    ["abc123", "abc123"],
    ["https://cdn.discordapp.com/embed/avatars/0.png", null],
    ["https://cdn.discordapp.com/embed/avatars/5.png?size=128", null],
    [null, null],
    ["", null],
  ])("normalizes avatar %s for the actual renderer and unchanged preview/apply", async (avatar, expectedHash) => {
    await legacy`update users set avatar = ${avatar} where id = 11`;
    const applied = run(["--apply"], env);
    expect(applied.status, applied.stderr).toBe(0);
    const users = await next`select id, avatar, xmin::text as version from users order by id`;
    expect(users[0]!.avatar).toBe(expectedHash);
    const rendered = profileAvatarSrcset(users[0]!.id, users[0]!.avatar);
    if (expectedHash === null) expect(rendered).toBeNull();
    else expect(rendered!.src).toBe(`https://cdn.discordapp.com/avatars/900000000000000011/${expectedHash}.png?size=128`);
    for (const args of [[], ["--apply"]]) {
      const repeat = run(args, env);
      expect(repeat.status, repeat.stderr).toBe(0);
      expect(counts(repeat.stdout).map((row) => [row.changed, row.written])).toEqual([[0, 0], [0, 0]]);
    }
    expect(await next`select id, avatar, xmin::text as version from users order by id`).toEqual(users);
  });

  it.each([
    "https://cdn.discordapp.com.evil.test/avatars/900000000000000011/abc123.png",
    "http://cdn.discordapp.com/avatars/900000000000000011/abc123.png",
    "https://cdn.discordapp.com/avatars/900000000000000022/abc123.png",
    "https://synthetic-secret@cdn.discordapp.com/avatars/900000000000000011/abc123.png",
    "https://cdn.discordapp.com:444/avatars/900000000000000011/abc123.png",
    "https://cdn.discordapp.com/avatars/900000000000000011/abc123.png#synthetic-secret",
    "https://cdn.discordapp.com/avatars/900000000000000011/%61bc123.png",
    "https://cdn.discordapp.com/avatars/900000000000000011/abc123.svg",
    "https://cdn.discordapp.com/embed/avatars/6.png",
    "synthetic-invalid-avatar/secret",
  ])("refuses unsupported or mismatched avatar %s before writing without logging it", async (avatar) => {
    await legacy`update users set avatar = ${avatar} where id = 11`;
    for (const args of [[], ["--apply"]]) {
      const refused = run(args, env);
      expect(refused.status).toBe(1);
      expect(refused.stdout + refused.stderr).not.toContain(avatar);
      expect(refused.stdout + refused.stderr).not.toContain("synthetic-secret");
    }
    expect(await next`select * from users`).toHaveLength(0);
    expect(await next`select * from profiles`).toHaveLength(0);
  });

  it.each([
    ["SQL, DMY", "ISO, MDY"],
    ["ISO, DMY", "SQL, MDY"],
    ["German, DMY", "Postgres, MDY"],
  ])("preserves UTC timestamps from %s into %s, including unchanged previews", async (sourceStyle, targetStyle) => {
    // Keep every date ambiguous so SQL/DMY -> MDY would silently swap month/day, not just throw.
    await legacy`update users set updated_at = '2026-08-02 11:00:00' where id in (11, 22)`;
    await legacy`update profiles set updated_at = '2026-08-05 15:00:00' where user_id = 11`;
    await legacy`select set_config('datestyle', ${sourceStyle}, false)`;
    await next`select set_config('datestyle', ${targetStyle}, false)`;
    await legacy`set time zone 'Pacific/Honolulu'`;
    await next`set time zone 'Pacific/Honolulu'`;
    const applied = await importUsersProfiles(legacy, next, { dryRun: false });
    expect(applied.users.written).toBe(3);
    expect(applied.profiles.written).toBe(2);
    // SET LOCAL restores hostile defaults after commit; read assertions under ISO.
    await next`set datestyle = 'ISO, YMD'`;
    await next`set time zone 'UTC'`;
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
    for (const dryRun of [true, false]) {
      await next`select set_config('datestyle', ${targetStyle}, false)`;
      await next`set time zone 'Pacific/Honolulu'`;
      const repeat = await importUsersProfiles(legacy, next, { dryRun });
      expect([repeat.users, repeat.profiles].map((row) => [row.changed, row.written])).toEqual([[0, 0], [0, 0]]);
    }
    await legacy`set datestyle = 'ISO, YMD'`;
    await next`set datestyle = 'ISO, YMD'`;
    await legacy`set time zone 'UTC'`;
    await next`set time zone 'UTC'`;
    expect(await next`select created_at, updated_at, xmin::text as version from users order by id`).toEqual(users);
    expect(await next`select created_at, updated_at, xmin::text as version from profiles order by user_id`).toEqual(profiles);
  });

  it("updates conflicts and only dirty rows, including nulls and membership changes", async () => {
    expect(run(["--apply"], env).status).toBe(0);
    const unchanged = await next`select xmin::text as version from users where id = '900000000000000022'`;
    await legacy`update users set username = 'synthetic-updated', display_name = null, avatar = null, discord_joined_at = null,
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

  it.each([null, "", "Changed Display 🎮", "   "])("updates an equal-timestamp display name %s with the same preview/apply counts", async (displayName) => {
    expect(run(["--apply"], env).status).toBe(0);
    await legacy`update users set display_name = ${displayName} where id = 11`;
    const expectedName = displayName === null || displayName === "" ? "synthetic-member" : displayName;
    const before = await next`select *, xmin::text as version from users order by id`;
    const preview = run([], env);
    expect(preview.status, preview.stderr).toBe(0);
    expect(counts(preview.stdout).map((row) => [row.changed, row.written])).toEqual([[1, 0], [0, 0]]);
    expect(await next`select *, xmin::text as version from users order by id`).toEqual(before);
    const applied = run(["--apply"], env);
    expect(applied.status, applied.stderr).toBe(0);
    expect(counts(applied.stdout).map((row) => [row.changed, row.written])).toEqual([[1, 1], [0, 0]]);
    expect((await next`select username from users where id = '900000000000000011'`)[0]!.username).toBe(expectedName);
    const after = await next`select *, xmin::text as version from users order by id`;
    const repeat = run(["--apply"], env);
    expect(repeat.status, repeat.stderr).toBe(0);
    expect(counts(repeat.stdout).map((row) => row.written)).toEqual([0, 0]);
    expect(await next`select *, xmin::text as version from users order by id`).toEqual(after);
  });

  it("does not overwrite newer Next users, including their row versions, on preview or repeated apply", async () => {
    expect(run(["--apply"], env).status).toBe(0);
    await next`update users set username = 'Current Discord Name', avatar = 'newhash', member = false,
      updated_at = '2026-10-01T00:00:00Z' where id = '900000000000000011'`;
    const before = await next`select *, xmin::text as version from users order by id`;
    for (const args of [[], ["--apply"], ["--apply"]]) {
      const result = run(args, env);
      expect(result.status, result.stderr).toBe(0);
      expect(counts(result.stdout).map((row) => [row.changed, row.unchanged, row.written])).toEqual([[0, 3, 0], [0, 2, 0]]);
      expect(await next`select *, xmin::text as version from users order by id`).toEqual(before);
    }
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
