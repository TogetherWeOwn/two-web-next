/// <reference types="vite/client" />
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import app from "./app";
import type { Env } from "../src/env";
import { migrateRoster, upsertRosterUser } from "../src/db/roster";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  migrate,
  type Sql,
} from "../src/sessions";
import { QA_HEADER } from "../src/qa";
import usersMigration from "../drizzle/0000_init-users.sql?raw";

// N6 acceptance (TOG-9898): sign-in and join upsert the durable roster row
// (legacy DiscordLoginController/JoinController updateOrCreate on the Discord
// id). The roster payload carries username/avatar/member only — `users` has no
// moderator column, and the flag is recomputed from Discord role IDs into the
// session row at login.

const MOD_ROLE = "508654771276873729";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
};

const cookiesFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

// In-memory Sql double for the roster upsert. Understands exactly the
// statement upsertRosterUser emits; anything else is a test bug, surfaced loudly.
function fakeRoster() {
  const rows = new Map<string, { id: string; username: string; avatar: string | null; member: boolean }>();
  const statements: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    statements.push(strings.join("?"));
    if (head.includes("INSERT INTO users")) {
      const [id, username, avatar, member] = values as [string, string, string | null, boolean];
      rows.set(id, { id, username, avatar, member });
      return [];
    }
    throw new Error(`fakeRoster: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return { sql, rows, statements };
}

/** Fresh memory session store + env carrying the roster seam, per test. */
function isolated(extra: Record<string, unknown> = {}) {
  const store = createMemorySessionStore();
  const roster = fakeRoster();
  const e = { ...env, SESSION_STORE: store, ROSTER_STORE: roster.sql, ...extra } as unknown as Env;
  return { store, roster, env: e };
}

type Profile = { id: string; username: string; global_name: string | null; avatar: string | null };

function mockDiscord(
  profile: Profile = { id: "42", username: "rick", global_name: "Rick", avatar: "ava-1" },
  opts: { joinStatus?: number; memberRoles?: string[] } = {},
) {
  const { joinStatus = 201, memberRoles = [] } = opts;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token" });
      if (url.endsWith("/users/@me")) return Response.json(profile);
      if (url.includes(`/members/${profile.id}`) && (init as RequestInit)?.method === "PUT")
        return new Response(null, { status: joinStatus });
      if (url.includes(`/members/${profile.id}`))
        return Response.json({ roles: memberRoles, joined_at: "2024-01-01T00:00:00Z" });
      return new Response("unexpected", { status: 500 });
    }),
  );
}

async function startSignIn(e: Env) {
  const res = await app.request("/auth/discord", {}, e);
  const location = new URL(res.headers.get("location")!);
  return { state: location.searchParams.get("state")!, cookie: cookiesFrom(res) };
}

const signIn = (e: Env, state: string, cookie: string) =>
  app.request(`/auth/discord/callback?code=abc&state=${state}`, { headers: { cookie } }, e);

afterEach(() => vi.unstubAllGlobals());

describe("upsertRosterUser", () => {
  it("repeat logins update the row in place, never a duplicate", async () => {
    const { sql, rows } = fakeRoster();
    await upsertRosterUser(sql, { id: "42", username: "rick", avatar: "ava-1", member: false });
    await upsertRosterUser(sql, { id: "42", username: "Rick", avatar: "ava-2", member: true });
    expect(rows.size).toBe(1);
    expect(rows.get("42")).toEqual({ id: "42", username: "Rick", avatar: "ava-2", member: true });
  });

  it("a missing store degrades to a no-op, like recordAttempt", async () => {
    await expect(
      upsertRosterUser(null, { id: "42", username: "rick", avatar: null, member: true }),
    ).resolves.toBeUndefined();
  });

  it("the emitted write never carries a moderator field", async () => {
    const { sql, statements } = fakeRoster();
    await upsertRosterUser(sql, { id: "42", username: "rick", avatar: null, member: true });
    expect(statements).toHaveLength(1);
    expect(statements.join(" ")).not.toMatch(/moderator/i);
    expect(statements[0]).toContain("ON CONFLICT (id) DO UPDATE");
  });
});

describe("sign-in writes the roster", () => {
  it("the callback upserts username/avatar/member; the session flag still comes from recompute", async () => {
    const { store, roster, env: e } = isolated();
    mockDiscord(
      { id: "42", username: "rick", global_name: "Rick", avatar: "ava-1" },
      { memberRoles: [MOD_ROLE] },
    );
    const { state, cookie } = await startSignIn(e);
    const res = await signIn(e, state, cookie);
    expect(res.headers.get("location")).toBe("/?n=joined");

    expect(roster.rows.get("42")).toEqual({ id: "42", username: "Rick", avatar: "ava-1", member: true });

    // Moderator ownership: the flag lands in the session row from the role
    // recompute, while the roster row carries no such field.
    const signed = decodeURIComponent(
      res.headers.getSetCookie().find((c) => c.startsWith("__Host-two_session="))!.split(";")[0]!.split("=")[1]!,
    );
    const row = await store.get(await hashToken(signed.split(".")[0]!));
    expect(row?.moderator).toBe(true);
    expect(roster.statements.join(" ")).not.toMatch(/moderator/i);
  });

  it("a second login with a new profile refreshes the same row", async () => {
    const { roster, env: e } = isolated();
    mockDiscord({ id: "42", username: "rick", global_name: "Rick", avatar: "ava-1" });
    const first = await startSignIn(e);
    await signIn(e, first.state, first.cookie);

    mockDiscord({ id: "42", username: "rick", global_name: "Rick Updated", avatar: "ava-2" });
    const second = await startSignIn(e);
    await signIn(e, second.state, second.cookie);

    expect(roster.rows.size).toBe(1);
    expect(roster.rows.get("42")).toEqual({
      id: "42",
      username: "Rick Updated",
      avatar: "ava-2",
      member: true,
    });
  });

  it("a roster failure warns but never blocks sign-in", async () => {
    const store = createMemorySessionStore();
    const failing = (async () => {
      throw new Error("db down");
    }) as unknown as Sql;
    const e = { ...env, SESSION_STORE: store, ROSTER_STORE: failing } as unknown as Env;
    mockDiscord();
    const { state, cookie } = await startSignIn(e);
    const res = await signIn(e, state, cookie);
    expect(res.headers.get("location")).toBe("/?n=joined");
    const home = await app.request("/", { headers: { cookie: cookiesFrom(res) } }, e);
    expect(await home.text()).toContain("Rick");
  });
});

describe("join callback writes the roster", () => {
  it("a successful join upserts the row with member true", async () => {
    const { roster, env: e } = isolated({ JOIN_DEPS: { store: async () => null } });
    mockDiscord({ id: "42", username: "rick", global_name: "Rick", avatar: "ava-9" });
    const start = await app.request("/join/discord", {}, e);
    const location = new URL(start.headers.get("location")!);
    const res = await app.request(
      `/join/callback?code=abc&state=${location.searchParams.get("state")}`,
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    expect(res.status).toBe(302);
    expect(roster.rows.get("42")).toEqual({ id: "42", username: "Rick", avatar: "ava-9", member: true });
  });
});

describe("staging QA seam writes the roster", () => {
  it("the fixture login upserts the roster row for W7 reads", async () => {
    const { roster, env: e } = isolated({
      APP_URL: "https://next.togetherweown.com",
      QA_AUTH_TOKEN: "qa-secret",
    });
    const res = await app.request("/auth/qa/qa-member", { method: "POST", headers: { origin: e.APP_URL, [QA_HEADER]: "qa-secret" } }, e);
    expect(res.status).toBe(204);
    expect(roster.rows.get("900000000000001396")).toEqual({
      id: "900000000000001396",
      username: "QA Member",
      avatar: null,
      member: true,
    });
  });
});

// Live against agent-testdb in a throwaway schema. Skipped when DATABASE_URL is
// unset (CI has no test-DB access). Never point this at anything but agent-testdb.
describe.skipIf(!process.env.DATABASE_URL)("roster upsert (agent-testdb)", () => {
  const schemaName = `n6_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sql: postgres.Sql;
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${schemaName}`);
    sql = postgres(process.env.DATABASE_URL!, { max: 4, connection: { search_path: schemaName } });
    // Canonical migration SQL is the source of truth, not the runtime DDL.
    for (const stmt of usersMigration.split("--> statement-breakpoint")) {
      if (stmt.trim()) await sql.unsafe(stmt);
    }
    await migrate(sql as unknown as Sql);
  });
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin?.end();
  });

  it("migrateRoster is a no-op on a migrated database", async () => {
    await migrateRoster(sql as unknown as Sql);
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = ${schemaName} AND tablename = 'users'`;
    expect(tables.map((t) => t.tablename)).toEqual(["users"]);
  });

  it("same id twice yields one refreshed row, and users has no moderator column", async () => {
    const db = sql as unknown as Sql;
    await upsertRosterUser(db, { id: "42", username: "rick", avatar: "ava-1", member: false });
    await upsertRosterUser(db, { id: "42", username: "Rick", avatar: "ava-2", member: true });

    const rows = await sql<Record<string, unknown>[]>`SELECT * FROM users WHERE id = ${"42"}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "42", username: "Rick", avatar: "ava-2", member: true });
    expect("moderator" in rows[0]!).toBe(false);

    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schemaName} AND table_name = 'users'`;
    expect(cols.map((c) => c.column_name)).not.toContain("moderator");
  });

  it("a full sign-in writes the roster row; moderator lives only in the session", async () => {
    const store = createPostgresSessionStore(sql as unknown as Sql);
    const e = {
      ...env,
      SESSION_STORE: store,
      ROSTER_STORE: sql as unknown as Sql,
    } as unknown as Env;
    mockDiscord(
      { id: "7", username: "morty", global_name: "Morty", avatar: "ava-m" },
      { memberRoles: [MOD_ROLE] },
    );

    const start = await app.request("/auth/discord", {}, e);
    const location = new URL(start.headers.get("location")!);
    const cb = await app.request(
      `/auth/discord/callback?code=abc&state=${location.searchParams.get("state")}`,
      { headers: { cookie: cookiesFrom(start) } },
      e,
    );
    expect(cb.headers.get("location")).toBe("/?n=joined");

    const users = await sql<Record<string, unknown>[]>`SELECT * FROM users WHERE id = ${"7"}`;
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ username: "Morty", avatar: "ava-m", member: true });

    const sessions = await sql<{ moderator: boolean }[]>`SELECT moderator FROM web_sessions`;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.moderator).toBe(true);
  });
});
