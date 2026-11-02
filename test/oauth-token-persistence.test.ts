/// <reference types="vite/client" />
// Successful-flow token non-persistence. Both mounted callbacks run through the
// real app with mocked Discord replies: ordinary sign-in (/auth/discord/callback)
// and the join journey (/join/callback). The Discord access token is a fresh
// synthetic marker per run. It may reach Discord's add-member request and
// nothing persisted. Every test proves the positive session and roster writes
// before it checks absence, and failures name only the operation or table.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import app from "./app";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import usersMigration from "../drizzle/0000_init-users.sql?raw";
import joinMigration from "../drizzle/1000_join-attempts-throttle.sql?raw";
import sessionsMigration from "../drizzle/1022_web-sessions-oauth-journeys.sql?raw";
import graceMigration from "../drizzle/1030_session-predecessor-grace.sql?raw";
import rolesCheckedMigration from "../drizzle/1033_session-roles-checked-at.sql?raw";

const MOD_ROLE = "1546777856984481792";
const SESSION_COOKIE = "__Host-two_session";

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

type Write = { op: string; args: unknown[] };

const freshMarker = () => `oauth-marker-${crypto.randomUUID()}`;
const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const bearerOf = (res: Response) => {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
  return decodeURIComponent(raw.split(";")[0]!.slice(SESSION_COOKIE.length + 1)).split(".")[0]!;
};

// Discord replies for both callbacks. The access token is the marker; only the
// add-member PUT may carry it.
function mockDiscord(access: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth2/token")) return Response.json({ access_token: access });
      if (url.endsWith("/users/@me"))
        return Response.json({
          id: "42",
          username: "rick",
          global_name: "Rick",
          avatar: "avatar-hash",
        });
      if (url.includes("/members/42") && init?.method === "PUT")
        return new Response(null, { status: 201 });
      if (url.includes("/members/42"))
        return Response.json({ roles: [MOD_ROLE], joined_at: "2024-01-01T00:00:00Z" });
      throw new Error(`Unexpected mocked Discord route: ${url}`);
    }),
  );
}

// Records each call on the session and journey seams with its complete arguments,
// before the in-memory store runs.
function observe<T extends object>(writes: Write[], name: string, target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        writes.push({ op: `${name}.${String(prop)}`, args });
        return Reflect.apply(value, t, args);
      };
    },
  });
}

// A Sql double that records every statement with all its bound values. `plant`
// writes a value into the roster avatar slot: fixture-only negative control.
function recordingSql(writes: Write[], name: string, plant?: string): Sql {
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join("?");
    if (plant && statement.includes("INSERT INTO users")) values[2] = plant;
    writes.push({ op: name, args: [statement, ...values] });
    if (statement.includes("count(*)")) return [{ n: 0, wait: 1 }];
    return [];
  }) as unknown as Sql;
  (sql as unknown as { unsafe: (q: string) => Promise<unknown> }).unsafe = async (q) => {
    writes.push({ op: name, args: [q] });
    return [];
  };
  (sql as unknown as { begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown> }).begin = (
    run,
  ) => run(sql);
  return sql;
}

function injected(writes: Write[], plant?: string): Env {
  const session = createMemorySessionStore();
  return {
    ...env,
    SESSION_STORE: observe(writes, "session", {
      ...session,
      journeys: observe(writes, "journeys", session.journeys),
    }),
    ROSTER_STORE: recordingSql(writes, "roster", plant),
    JOIN_DEPS: { store: async () => recordingSql(writes, "join") },
  } as unknown as Env;
}

async function signIn(e: Env) {
  const start = await app.request("/auth/discord", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  return app.request(
    `/auth/discord/callback?code=test-code&state=${state}`,
    { headers: { cookie: cookiesOf(start) } },
    e,
  );
}

async function join(e: Env) {
  const start = await app.request("/join/discord?source=web-homepage", {}, e);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  return app.request(
    `/join/callback?code=test-code&state=${state}`,
    { headers: { cookie: cookiesOf(start) } },
    e,
  );
}

async function sessionIsValid(e: Env, res: Response) {
  const status = await app.request("/auth/status", { headers: { cookie: cookiesOf(res) } }, e);
  return (await status.json()) as { authenticated: boolean };
}

// The recorded session write, positive proof before any absence check.
function sessionWrite(writes: Write[]): Record<string, unknown> {
  const write = writes.find((w) => w.op === "session.create" || w.op === "session.replace");
  expect(write, "a session write was recorded").toBeDefined();
  return (write!.op === "session.create" ? write!.args[0] : write!.args[1]) as Record<
    string,
    unknown
  >;
}

// Select INSERT payloads only for positive row assertions; retain every recorded
// statement and value for the independent carrier scan below.
const rosterArgs = (writes: Write[]) =>
  writes
    .filter((w) => w.op === "roster" && /^\s*INSERT\s+INTO\s+users\b/i.test(String(w.args[0])))
    .map((w) => w.args.slice(1));

// Captured values with the marker replaced, so a failing diff never prints it.
const redacted = (value: unknown, marker: string) =>
  JSON.parse(
    JSON.stringify(value ?? null)
      .split(marker)
      .join("<marker>"),
  ) as unknown;

// Operation names whose recorded arguments carry the marker. Names only: a
// failure never prints the marker or a row.
function carriers(writes: Write[], marker: string) {
  return [
    ...new Set(writes.filter((w) => JSON.stringify(w.args).includes(marker)).map((w) => w.op)),
  ];
}

describe("roster SQL recorder controls", () => {
  it("selects every roster INSERT payload without discarding setup statements or values", async () => {
    const writes: Write[] = [];
    const sql = recordingSql(writes, "roster");
    await sql`SET LOCAL statement_timeout = '500ms'`;
    await sql`SELECT set_config('lock_timeout', ${"250ms"}, true)`;
    expect(rosterArgs(writes)).toEqual([]);

    for (let n = 0; n < 2; n++)
      await sql`INSERT INTO users (id, username, avatar, member) VALUES (${"42"}, ${"Rick"}, ${"avatar-hash"}, ${true})`;
    await recordingSql(writes, "join")`INSERT INTO users (id) VALUES (${"99"})`;
    expect(writes).toEqual([
      { op: "roster", args: ["SET LOCAL statement_timeout = '500ms'"] },
      { op: "roster", args: ["SELECT set_config('lock_timeout', ?, true)", "250ms"] },
      ...Array.from({ length: 2 }, () => ({
        op: "roster",
        args: [
          "INSERT INTO users (id, username, avatar, member) VALUES (?, ?, ?, ?)",
          "42",
          "Rick",
          "avatar-hash",
          true,
        ],
      })),
      { op: "join", args: ["INSERT INTO users (id) VALUES (?)", "99"] },
    ]);
    expect(rosterArgs(writes)).toEqual([
      ["42", "Rick", "avatar-hash", true],
      ["42", "Rick", "avatar-hash", true],
    ]);
  });

  it.each(["statement text", "bound value"])(
    "negative control: a marker in excluded roster setup %s is still reported",
    async (location) => {
      const marker = freshMarker();
      const writes: Write[] = [];
      const sql = recordingSql(writes, "roster");
      if (location === "statement text") {
        await (sql as unknown as { unsafe: (q: string) => Promise<unknown> }).unsafe(
          `SET LOCAL app.test_marker = '${marker}'`,
        );
        expect(redacted(writes, marker)).toEqual([
          { op: "roster", args: ["SET LOCAL app.test_marker = '<marker>'"] },
        ]);
      } else {
        await sql`SELECT set_config('app.test_marker', ${marker}, true)`;
        expect(redacted(writes, marker)).toEqual([
          { op: "roster", args: ["SELECT set_config('app.test_marker', ?, true)", "<marker>"] },
        ]);
      }
      expect(redacted(rosterArgs(writes), marker)).toEqual([]);
      expect(carriers(writes, marker)).toEqual(["roster"]);
    },
  );
});

describe("successful-flow token non-persistence (injected seams)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ordinary sign-in writes a valid session and roster row; no recorded write carries the marker", async () => {
    const marker = freshMarker();
    mockDiscord(marker);
    const writes: Write[] = [];
    const e = injected(writes);
    const res = await signIn(e);
    expect(res.headers.get("location")).toBe("/?n=joined");

    const row = redacted(sessionWrite(writes), marker) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
      "avatar",
      "expiresAt",
      "member",
      "moderator",
      "tokenHash",
      "userId",
      "username",
    ]);
    expect({
      userId: row.userId,
      username: row.username,
      avatar: row.avatar,
      member: row.member,
      moderator: row.moderator,
    }).toEqual({
      userId: "42",
      username: "Rick",
      avatar: "avatar-hash",
      member: true,
      moderator: true,
    });
    expect(row.tokenHash).toBe(await hashToken(bearerOf(res)));
    expect(redacted(rosterArgs(writes), marker)).toEqual([["42", "Rick", "avatar-hash", true]]);
    expect(await sessionIsValid(e, res)).toEqual({ authenticated: true });

    expect(carriers(writes, "avatar-hash")).toEqual(["roster", "session.create"]);
    expect(carriers(writes, marker)).toEqual([]);
  });

  it("join writes a valid session, roster row and added attempt; no recorded write carries the marker", async () => {
    const marker = freshMarker();
    mockDiscord(marker);
    const writes: Write[] = [];
    const e = injected(writes);
    const res = await join(e);
    expect(res.headers.get("location")).toBe("/?n=joined");

    const attempt = writes.find(
      (w) => w.op === "join" && String(w.args[0]).includes("join_attempts"),
    );
    expect(redacted(attempt?.args.slice(1), marker)).toEqual(["added", "web-homepage", null, "42"]);
    const row = redacted(sessionWrite(writes), marker) as Record<string, unknown>;
    expect(row).toMatchObject({ userId: "42", username: "Rick", member: true, moderator: true });
    expect(row.tokenHash).toBe(await hashToken(bearerOf(res)));
    expect(redacted(rosterArgs(writes), marker)).toEqual([["42", "Rick", "avatar-hash", true]]);
    expect(await sessionIsValid(e, res)).toEqual({ authenticated: true });

    expect(carriers(writes, "avatar-hash")).toEqual(["roster", "session.create"]);
    expect(carriers(writes, marker)).toEqual([]);
  });

  it("negative control: a planted roster write carrying the marker is reported by the same check", async () => {
    const marker = freshMarker();
    mockDiscord(marker);
    const writes: Write[] = [];
    await signIn(injected(writes, marker));
    expect(carriers(writes, marker)).toEqual(["roster"]);
  });
});

// Live against the run-owned test database; skipped when DATABASE_URL is unset.
describe.skipIf(!process.env.DATABASE_URL)(
  "successful-flow token non-persistence (owned schema)",
  () => {
    const schema = `oauth_proof_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const tables = [
      "join_attempts",
      "users",
      "web_oauth_journeys",
      "web_session_grace",
      "web_sessions",
      "web_throttle_hits",
    ];
    let sql: postgres.Sql;
    let admin: postgres.Sql;

    beforeAll(async () => {
      admin = postgres(process.env.DATABASE_URL!, { max: 1 });
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      sql = postgres(process.env.DATABASE_URL!, { max: 4, connection: { search_path: schema } });
      for (const file of [
        usersMigration,
        joinMigration,
        sessionsMigration,
        graceMigration,
        rolesCheckedMigration,
      ])
        for (const stmt of file.split("--> statement-breakpoint"))
          if (stmt.trim()) await sql.unsafe(stmt);
    });
    beforeEach(async () => {
      await sql.unsafe(`TRUNCATE ${tables.join(", ")}`);
    });
    afterEach(() => vi.unstubAllGlobals());
    afterAll(async () => {
      await sql?.end();
      await admin?.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin?.end();
    });

    const dbEnv = (): Env =>
      ({
        ...env,
        SESSION_STORE: createPostgresSessionStore(sql as unknown as Sql),
        ROSTER_STORE: sql as unknown as Sql,
        JOIN_DEPS: { store: async () => sql as unknown as Sql },
      }) as unknown as Env;

    // Every row of every table in the owned schema, as its full text.
    async function allRows(): Promise<Record<string, string[]>> {
      const names = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_type = 'BASE TABLE' ORDER BY table_name`;
      const dump: Record<string, string[]> = {};
      for (const { table_name } of names) {
        const rows = await sql.unsafe<{ r: string }[]>(
          `SELECT t::text AS r FROM ${schema}.${table_name} AS t`,
        );
        dump[table_name] = rows.map((row) => row.r);
      }
      return dump;
    }

    const tablesCarrying = (dump: Record<string, string[]>, marker: string) =>
      Object.entries(dump)
        .filter(([, rows]) => rows.some((r) => r.includes(marker)))
        .map(([table]) => table);

    async function persistedIdentity(res: Response, marker: string) {
      const sessions = await sql`SELECT user_id, member, moderator, token_hash FROM web_sessions`;
      expect(redacted(sessions, marker)).toEqual([
        {
          user_id: "42",
          member: true,
          moderator: true,
          token_hash: await hashToken(bearerOf(res)),
        },
      ]);
      const users = await sql`SELECT id, username, avatar, member FROM users`;
      expect(redacted(users, marker)).toEqual([
        { id: "42", username: "Rick", avatar: "avatar-hash", member: true },
      ]);
    }

    it("ordinary sign-in persists a valid session and roster row; no table row carries the marker", async () => {
      const marker = freshMarker();
      mockDiscord(marker);
      const res = await signIn(dbEnv());
      expect(res.headers.get("location")).toBe("/?n=joined");

      await persistedIdentity(res, marker);
      expect(
        await sql`SELECT count(*)::int AS n FROM web_oauth_journeys WHERE consumed_at IS NOT NULL`,
      ).toEqual([{ n: 1 }]);

      const dump = await allRows();
      expect(Object.keys(dump).sort()).toEqual(tables);
      expect(tablesCarrying(dump, "avatar-hash")).toEqual(["users", "web_sessions"]);
      expect(tablesCarrying(dump, marker)).toEqual([]);
    });

    it("join persists a valid session, roster row, added attempt and throttle hits; no table row carries the marker", async () => {
      const marker = freshMarker();
      mockDiscord(marker);
      const res = await join(dbEnv());
      expect(res.headers.get("location")).toBe("/?n=joined");

      const attempts = await sql`SELECT outcome, source, discord_id FROM join_attempts`;
      expect(redacted(attempts, marker)).toEqual([
        { outcome: "added", source: "web-homepage", discord_id: "42" },
      ]);
      const hits = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM web_throttle_hits`;
      expect(hits[0]!.n).toBeGreaterThanOrEqual(2);
      await persistedIdentity(res, marker);

      const dump = await allRows();
      expect(Object.keys(dump).sort()).toEqual(tables);
      expect(tablesCarrying(dump, "avatar-hash")).toEqual(["users", "web_sessions"]);
      expect(tablesCarrying(dump, marker)).toEqual([]);
    });
  },
);
