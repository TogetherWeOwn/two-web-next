import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsersProfilesFixture, type UsersProfilesFixture } from "./helpers/import-users-profiles-db";

// Wrap the real driver for fixtures; constructor policy tests can replace it
// with an inert stub and prove refusal happens before even constructing a client.
vi.mock("postgres", async (original) => {
  const actual = await original<{ default: typeof postgres }>();
  return { ...actual, default: vi.fn(actual.default) };
});
const script = fileURLToPath(new URL("../bin/import/users-profiles.mjs", import.meta.url).href);
const { createImportClient, importUsersProfiles } = await import(pathToFileURL(script).href);
const baseUrl = "postgres://agent_test@agent-testdb:5432/two_web_next";
beforeEach(() => vi.clearAllMocks());

describe("users/profiles URL policy (inert constructors)", () => {
  it.each([
    "client_encoding=LATIN1", "client_encoding=UTF8", "options=-c%20client_encoding%3DLATIN1",
    "options=-c%20search_path%3Dpublic", "database=other", "db=other", "host=other.test",
    "hostname=other.test", "port=5433", "user=other", "role=other", "session_authorization=other",
    "default_transaction_read_only=off", "datestyle=SQL%2CDMY", "timezone=Pacific%2FHonolulu",
    "TimeZone=UTC", "CLIENT_ENCODING=LATIN1", "application_name=synthetic", "debug=true",
    "search_path=public%2Cother", "search_path=%22public%22", "search_path=%24user",
    "search_path=public%3BSET%20ROLE%20other", "search_path=", "search_path=public&search_path=other",
    "search_path=public%0A", "search_path=public%0D", "search_path=public%00",
    `search_path=${"a".repeat(64)}`, "sslmode=require&sslmode=disable", "sslmode=arbitrary",
    "search_path=public&options=-c%20role%3Dother",
  ])("refuses ?%s before driver construction", (query) => {
    expect(() => createImportClient(`${baseUrl}?${query}`)).toThrow("Invalid connection URL parameters");
    expect(postgres).not.toHaveBeenCalled();
  });

  it.each(["public", "legacy_up_012345", "next_up_abcdef", "a".repeat(63)])("allows only the literal fixture schema %s and pins startup UTF8", (schema) => {
    const sentinel = {} as ReturnType<typeof postgres>;
    vi.mocked(postgres).mockReturnValueOnce(sentinel);
    expect(createImportClient(`${baseUrl}?search_path=${schema}&sslmode=require`)).toBe(sentinel);
    expect(postgres).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(postgres).mock.calls[0]!;
    expect(new URL(url as string).searchParams.get("search_path")).toBe(schema);
    expect(options).toMatchObject({ port: 5432, connection: { timezone: "UTC", client_encoding: "UTF8" } });
    expect((options!.password as () => string)()).toBe("");
  });

  it("pins UTF8 on the real lazy driver without opening a connection", async () => {
    const sql = createImportClient(`${baseUrl}?search_path=legacy_up_constructor`);
    try {
      expect(sql.options.connection).toMatchObject({ client_encoding: "UTF8", timezone: "UTC", search_path: "legacy_up_constructor" });
    } finally { await sql.end(); }
  });

  it("redacts refused source and destination URL overrides in preview and apply", () => {
    for (const key of ["LEGACY_DATABASE_URL", "DATABASE_URL"]) {
      for (const args of [[], ["--apply"]]) {
        const env = {
          LEGACY_DATABASE_URL: `${baseUrl}?search_path=legacy_up_inert`,
          DATABASE_URL: `${baseUrl}?search_path=next_up_inert`,
          [key]: `${baseUrl}?role=synthetic-private-role&client_encoding=LATIN1`,
        };
        const result = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 20_000 });
        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("import failed");
        expect(result.stderr).not.toContain("synthetic-private-role");
        expect(result.stderr).not.toContain(baseUrl);
      }
    }
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("users/profiles encoding on synthetic disposable Postgres", () => {
  let fixture: UsersProfilesFixture;
  beforeAll(async () => { fixture = await createUsersProfilesFixture(url!); });
  beforeEach(async () => { await fixture.reset(); });
  afterAll(async () => { await fixture?.dispose(); });

  it.each(["LATIN1", "WIN1252"])("re-pins caller-supplied %s sessions before preview, apply and zero-write replay", async (encoding) => {
    const { legacy, next } = fixture;
    const name = "Café Münchner — 日本語 🎮";
    const handle = "Joueur é — Ελληνικά";
    const bio = "Crème brûlée / 日本語 / 🎮 / é";
    const games = ["Pokémon", "囲碁 ☕", "Игра 🎮", "é"];
    // The transcribed Laravel fixture has timestamp(0); widen this isolated
    // synthetic column to prove the importer does not truncate microseconds.
    await legacy`alter table users alter column updated_at type timestamp(6)`;
    await legacy`update users set display_name = ${name}, updated_at = '2026-08-02 11:00:00.123456' where id = 11`;
    await legacy`update users set username = ${handle}, display_name = '' where id = 22`;
    await legacy`update profiles set bio = ${bio}, games = ${legacy.json(games)} where user_id = 11`;
    const sourceUsers = await legacy`select *, xmin::text as version from users order by id`;
    const sourceProfiles = await legacy`select *, xmin::text as version from profiles order by id`;
    const poison = async () => {
      await legacy`select set_config('client_encoding', ${encoding}, false)`;
      await next`select set_config('client_encoding', ${encoding}, false)`;
      expect((await legacy`show client_encoding`)[0]!.client_encoding).toBe(encoding);
      expect((await next`show client_encoding`)[0]!.client_encoding).toBe(encoding);
    };
    const restore = async () => {
      await legacy`set client_encoding = 'UTF8'`;
      await next`set client_encoding = 'UTF8'`;
    };
    try {
      await poison();
      const preview = await importUsersProfiles(legacy, next);
      expect(preview.users).toMatchObject({ changed: 3, written: 0 });
      expect(preview.profiles).toMatchObject({ changed: 2, written: 0 });
      await restore();
      expect(await next`select * from users`).toHaveLength(0);
      expect(await next`select * from profiles`).toHaveLength(0);
      await poison();
      const applied = await importUsersProfiles(legacy, next, { dryRun: false });
      expect(applied.users.written).toBe(3);
      expect(applied.profiles.written).toBe(2);
      await restore();
      const users = await next`select *, xmin::text as version, updated_at::text as exact_updated_at from users order by id`;
      const profiles = await next`select *, xmin::text as version from profiles order by user_id`;
      expect(Buffer.from(users[0]!.username)).toEqual(Buffer.from(name));
      expect(Buffer.from(users[1]!.username)).toEqual(Buffer.from(handle));
      expect(Buffer.from(profiles[0]!.bio)).toEqual(Buffer.from(bio));
      expect(profiles[0]!.games.map((game: string) => Buffer.from(game))).toEqual(games.map((game) => Buffer.from(game)));
      expect(users[0]!.exact_updated_at).toContain("11:00:00.123456");
      for (const dryRun of [true, false]) {
        await poison();
        const replay = await importUsersProfiles(legacy, next, { dryRun });
        expect(replay.users).toMatchObject({ changed: 0, written: 0, unchanged: 3 });
        expect(replay.profiles).toMatchObject({ changed: 0, written: 0, unchanged: 2 });
        await restore();
        expect(await next`select *, xmin::text as version, updated_at::text as exact_updated_at from users order by id`).toEqual(users);
        expect(await next`select *, xmin::text as version from profiles order by user_id`).toEqual(profiles);
      }
      expect(await legacy`select *, xmin::text as version from users order by id`).toEqual(sourceUsers);
      expect(await legacy`select *, xmin::text as version from profiles order by id`).toEqual(sourceProfiles);
    } finally { await restore(); }
  });
});
