// Acceptance contract for SessionStore.renew, the expiry-only store write,
// plus the gate re-stamp decisions: profile and admin reads rotate through
// store.rotate (fresh bearer + fresh window), never renew. The memory store,
// a recording tagged-SQL double and the real gates run hermetically: no
// database, Discord or network transport.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminGuard, type AccessDecl, type Actor } from "../src/admin/guard";
import type { Env } from "../src/env";
import { bufferedMemberHtml } from "../src/member-reads";
import { memberGate } from "../src/profiles/routes-gate";
import type { ProfileApp } from "../src/profiles/routes-shared";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
  type DbSessionRow,
  type SessionStore,
  type Sql,
} from "../src/sessions";

// Typed locally so this file compiles before the member lands on SessionStore.
type Renew = (tokenHash: string, expiresAt: Date) => Promise<boolean>;
type RenewableStore = SessionStore & { renew: Renew };

const COOKIE_NAME = "__Host-two_session";
const LOGIN_AT = Date.parse("2026-10-19T10:00:00.000Z");
const TTL_MS = SESSION_TTL_SECONDS * 1000;
const EXPIRES_AT = LOGIN_AT + TTL_MS;
const REQUEST_AT = Date.parse("2026-10-19T11:15:30.125Z");
const env: Env = {
  APP_URL: "https://app.example.test",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
};
const MEMBER: DbSessionRow = {
  userId: "100000000000000011",
  username: "renew-member",
  avatar: null,
  member: true,
  moderator: false,
};
const MODERATOR: DbSessionRow = {
  userId: "100000000000000012",
  username: "renew-moderator",
  avatar: "a_0123456789abcdef",
  member: true,
  moderator: true,
};

describe("memory SessionStore.renew", () => {
  let now = LOGIN_AT;
  let store: RenewableStore;

  async function issue(viewer: DbSessionRow, expiresAt = EXPIRES_AT) {
    const tokenHash = await hashToken(newSessionToken());
    await store.create({ ...viewer, tokenHash, expiresAt: new Date(expiresAt) });
    return tokenHash;
  }

  beforeEach(() => {
    now = LOGIN_AT;
    store = createMemorySessionStore(() => now) as RenewableStore;
  });

  it("extends a live row to the supplied expiry and keeps its bearer, identity and status key", async () => {
    const login = await issue(MODERATOR);
    // A rotated bearer carries its login's status key: renewal must keep it.
    const current = await hashToken(newSessionToken());
    expect(
      await store.rotate(login, {
        ...MODERATOR,
        tokenHash: current,
        expiresAt: new Date(EXPIRES_AT),
      }),
    ).toBe(true);
    const create = vi.spyOn(store, "create");
    const replace = vi.spyOn(store, "replace");
    const rotate = vi.spyOn(store, "rotate");

    now = REQUEST_AT;
    expect(await store.renew(current, new Date(REQUEST_AT + TTL_MS))).toBe(true);

    now = EXPIRES_AT;
    expect(await store.get(current), "renewed row outlives its old expiry").toEqual(MODERATOR);
    expect(await store.statusHash(current)).toBe(login);
    now = REQUEST_AT + TTL_MS - 1;
    expect(await store.get(current)).toEqual(MODERATOR);
    expect(await store.isActive(login)).toBe(true);
    now = REQUEST_AT + TTL_MS;
    expect(await store.get(current), "renewed row expires at the supplied instant").toBeNull();
    expect(await store.isActive(login)).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("never shortens a live row: the later of the stored and supplied expiry wins", async () => {
    const tokenHash = await issue(MEMBER);
    now = REQUEST_AT;
    expect(await store.renew(tokenHash, new Date(REQUEST_AT + 60_000))).toBe(true);
    now = EXPIRES_AT - 1;
    expect(await store.get(tokenHash), "an earlier supplied expiry must not cut the row").toEqual(
      MEMBER,
    );
    now = EXPIRES_AT;
    expect(await store.get(tokenHash)).toBeNull();
  });

  it.each([
    { when: "one millisecond before expiry", at: EXPIRES_AT - 1, renewed: true },
    { when: "at the exact expiry instant", at: EXPIRES_AT, renewed: false },
    { when: "after expiry", at: EXPIRES_AT + 1, renewed: false },
  ])("renews only a still-live row: $when", async ({ at, renewed }) => {
    const tokenHash = await issue(MEMBER);
    now = at;
    expect(await store.renew(tokenHash, new Date(at + TTL_MS))).toBe(renewed);
    expect(await store.get(tokenHash)).toEqual(renewed ? MEMBER : null);
    now = at + TTL_MS - 1;
    expect(await store.get(tokenHash), "a refused renewal must not revive the row").toEqual(
      renewed ? MEMBER : null,
    );
  });

  it("refuses a revoked token and does not revive it", async () => {
    const tokenHash = await issue(MEMBER);
    await store.revoke(tokenHash);
    now = REQUEST_AT;
    expect(await store.renew(tokenHash, new Date(REQUEST_AT + TTL_MS))).toBe(false);
    expect(await store.get(tokenHash)).toBeNull();
    expect(await store.statusHash(tokenHash)).toBeNull();
  });

  it("refuses a token rotated away and leaves its replacement's expiry alone", async () => {
    const old = await issue(MEMBER);
    const replacement = await hashToken(newSessionToken());
    await store.rotate(old, { ...MEMBER, tokenHash: replacement, expiresAt: new Date(EXPIRES_AT) });
    now = REQUEST_AT;
    expect(await store.renew(old, new Date(REQUEST_AT + TTL_MS))).toBe(false);
    expect(await store.get(old)).toBeNull();
    now = EXPIRES_AT - 1;
    expect(await store.get(replacement)).toEqual(MEMBER);
    now = EXPIRES_AT;
    expect(
      await store.get(replacement),
      "renewing the old bearer must not extend its lineage",
    ).toBeNull();
  });

  it("never mints a row for an unknown token", async () => {
    const unknown = await hashToken(newSessionToken());
    expect(await store.renew(unknown, new Date(LOGIN_AT + TTL_MS))).toBe(false);
    expect(await store.get(unknown)).toBeNull();
    expect(await store.statusHash(unknown)).toBeNull();
    expect(await store.isActive(unknown)).toBe(false);
  });
});

type Statement = { strings: readonly string[]; values: unknown[]; text: string };

/** Records each tagged-template call and answers every one with `result`. */
function recordingSql(result: Record<string, unknown>[]) {
  const statements: Statement[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    // Numbered placeholders, lower case, collapsed whitespace.
    const text = strings
      .reduce((query, part, i) => `${query}$${i}${part}`)
      .replace(/\s+/g, " ")
      .replace(/\( /g, "(")
      .replace(/ \)/g, ")")
      .replace(/ ?, ?/g, ", ")
      .trim()
      .toLowerCase();
    statements.push({ strings: [...strings], values, text });
    return result;
  }) as unknown as Sql;
  sql.unsafe = async () => {
    throw new Error("renewal must not issue unparameterized SQL");
  };
  return { sql, statements };
}

describe("postgres SessionStore.renew (recording SQL double)", () => {
  it("issues one parameterized, expiry-only UPDATE behind a materialized row lock", async () => {
    const tokenHash = await hashToken(newSessionToken());
    const expiresAt = new Date(REQUEST_AT + TTL_MS);
    const { sql, statements } = recordingSql([{ "?column?": 1 }]);
    const store = createPostgresSessionStore(sql) as RenewableStore;
    await store.renew(tokenHash, expiresAt);

    expect(statements).toHaveLength(1);
    const { strings, values, text } = statements[0]!;
    // Both inputs travel as bind parameters, never as SQL text.
    const tokenAt = values.indexOf(tokenHash);
    const expiryAt = values.findIndex((v) =>
      v instanceof Date ? v.getTime() === expiresAt.getTime() : v === expiresAt.toISOString(),
    );
    expect(tokenAt, "token hash must be a bind parameter").toBeGreaterThanOrEqual(0);
    expect(expiryAt, "supplied expiry must be a bind parameter").toBeGreaterThanOrEqual(0);
    expect(strings.join("")).not.toContain(tokenHash);
    expect(strings.join("")).not.toContain(expiresAt.toISOString());
    const tokenParam = `$${tokenAt + 1}`;
    const expiryParam = `$${expiryAt + 1}`;

    // Lock the source row first, in a materialized CTE.
    const lock = text.match(
      /\bwith (\w+) as materialized \(select [^()]*?\bfrom web_sessions\b[^()]*?\btoken_hash = (\$\d+)[^()]*?\bfor (?:no key )?update\)/,
    );
    expect(lock, `row lock CTE missing from: ${text}`).not.toBeNull();
    const [lockSql, cte, lockedParam] = lock!;
    expect(lockedParam).toBe(tokenParam);
    const afterLock = text.slice(lock!.index! + lockSql.length);

    // Eligibility reads the wall clock only after the lock is held: now() is
    // pinned to transaction start and could renew an expired row.
    expect(text).not.toMatch(/\bnow\(\)|\bcurrent_timestamp\b|\btransaction_timestamp\(/);
    expect(text.indexOf("clock_timestamp()")).toBeGreaterThan(text.indexOf(lockSql));
    expect(afterLock).toMatch(/\b(?:\w+\.)?revoked_at is null\b/);
    expect(afterLock).toMatch(/\b(?:\w+\.)?expires_at > clock_timestamp\(\)/);

    // Exactly one write: expires_at only, raised to the later of the two.
    expect(text.match(/\bupdate web_sessions\b/g)).toHaveLength(1);
    expect(text).not.toMatch(/\binsert\b|\bdelete\b|\bon conflict\b|\bmerge into\b/);
    const update = afterLock.match(
      /\bupdate web_sessions(?: (?:as )?\w+)? set (.+?) (?:from|where|returning)\b(.*)$/,
    );
    expect(update, `expiry UPDATE missing after the lock: ${afterLock}`).not.toBeNull();
    const [, assignments, rest] = update!;
    const greatest = assignments!.match(/^expires_at = greatest\((.+)\)$/);
    expect(greatest, `only expires_at may change, got: ${assignments}`).not.toBeNull();
    expect(greatest![1]).toMatch(/\b(?:\w+\.)?expires_at\b/);
    expect(greatest![1]).toContain(expiryParam);
    // The UPDATE touches only the locked row, never the whole table.
    expect(rest).toMatch(new RegExp(`\\b${cte}\\b`));
    expect(rest).toMatch(/\btoken_hash (?:= (?:\w+\.)?token_hash\b|= \$\d+|in \(select\b)/);
  });

  it.each([
    { rows: [], renewed: false, when: "no row matched" },
    { rows: [{ "?column?": 1 }], renewed: true, when: "the locked row was renewed" },
  ])("returns $renewed when $when", async ({ rows, renewed }) => {
    const { sql, statements } = recordingSql(rows);
    const store = createPostgresSessionStore(sql) as RenewableStore;
    const tokenHash = await hashToken(newSessionToken());
    expect(await store.renew(tokenHash, new Date(REQUEST_AT + TTL_MS))).toBe(renewed);
    expect(statements).toHaveLength(1);
  });
});

// The terminal handlers return only the authenticated viewer's identity, so
// the real admin read boundary needs no audit database.
function memberApp(store: SessionStore) {
  const app: ProfileApp = new Hono();
  app.use("/*", memberGate({ sessionStore: store }));
  app.get("/profile", (c) => c.html(`<p>${c.get("viewer").id}</p>`));
  app.post("/profile", (c) => c.text(`posted ${c.get("viewer").id}`));
  return app;
}

function moderatorApp(store: SessionStore) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminActor: Actor; access: AccessDecl };
  }>();
  app.use("/*", adminGuard({ sessionStore: store }));
  app.get("/admin", (c) => {
    c.set("access", { resource: "events", action: "view", route: "test.session-renew" });
    return bufferedMemberHtml(c, `<p>${c.get("adminActor").id}</p>`);
  });
  app.post("/admin", (c) => c.text(`posted ${c.get("adminActor").id}`));
  return app;
}

async function sessionFor(store: SessionStore, viewer: DbSessionRow) {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await store.create({ ...viewer, tokenHash, expiresAt: new Date(EXPIRES_AT) });
  const signed = await serializeSigned(COOKIE_NAME, token, env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  return { tokenHash, cookie: signed.split(";")[0]! };
}

function sessionCookies(response: Response) {
  return response.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
}

type Rotate = SessionStore["rotate"];

/** A memory store whose rotation is replaced by `rotate`; reads stay real. */
function storeWithRotate(rotate: Rotate) {
  const store = createMemorySessionStore(() => Date.now());
  store.rotate = rotate;
  return store;
}

const gates = [
  {
    name: "memberGate",
    viewer: MEMBER,
    refused: { ...MEMBER, member: false },
    path: "/profile",
    app: memberApp,
  },
  {
    name: "adminGuard",
    viewer: MODERATOR,
    refused: { ...MODERATOR, moderator: false },
    path: "/admin",
    app: moderatorApp,
  },
] as const;

describe.each(gates)("$name rotation decisions (hermetic)", (gate) => {
  beforeEach(() => {
    // Only Date is fake: cryptography and the read boundary's deadlines stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LOGIN_AT);
    vi.stubGlobal("fetch", () => {
      throw new Error("The renewal suite must not use network transport");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("rotates an authenticated GET once, from request time", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const rotate = vi.spyOn(store, "rotate");
    const renew = vi.spyOn(store, "renew");
    const { cookie, tokenHash } = await sessionFor(store, gate.viewer);
    vi.setSystemTime(REQUEST_AT);
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(200);
    expect(renew, "the re-stamp must rotate, not renew").not.toHaveBeenCalled();
    expect(rotate, "an authenticated view must rotate exactly once").toHaveBeenCalledTimes(1);
    const [source, replacement] = rotate.mock.calls[0]!;
    expect(source).toBe(tokenHash);
    expect(replacement.tokenHash, "the replacement must be a fresh hash").not.toBe(tokenHash);
    expect(replacement.expiresAt).toEqual(new Date(REQUEST_AT + TTL_MS));
    expect({ ...replacement, tokenHash: "", expiresAt: new Date(0) }).toMatchObject({
      userId: gate.viewer.userId,
      username: gate.viewer.username,
      avatar: gate.viewer.avatar,
      member: gate.viewer.member,
      moderator: gate.viewer.moderator,
    });
  });

  it("redirects as expired when the rotation loses a race, with no bearer or contents", async () => {
    // get() saw a live row; by the rotation it was revoked, rotated or expired.
    // Model real revocation before the losing rotation so the rotation
    // fallback re-read finds no row and the 302 stays valid after grace
    // preservation.
    let store!: SessionStore;
    const rotate = vi.fn<Rotate>(async (hash) => {
      await store.revoke(hash);
      return false;
    });
    store = storeWithRotate(rotate);
    const { cookie, tokenHash } = await sessionFor(store, gate.viewer);
    vi.setSystemTime(REQUEST_AT);
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(rotate).toHaveBeenCalledTimes(1);
    const [source, replacement] = rotate.mock.calls[0]!;
    expect(source).toBe(tokenHash);
    expect(replacement.expiresAt).toEqual(new Date(REQUEST_AT + TTL_MS));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/discord");
    expect(sessionCookies(response)).toHaveLength(0);
    expect(await response.text()).not.toContain(gate.viewer.userId);
  });

  it.each(["HEAD", "POST"])("does not rotate on %s", async (method) => {
    const store = createMemorySessionStore(() => Date.now());
    const rotate = vi.spyOn(store, "rotate");
    const renew = vi.spyOn(store, "renew");
    const { cookie } = await sessionFor(store, gate.viewer);
    vi.setSystemTime(REQUEST_AT);
    const response = await gate.app(store).request(gate.path, { method, headers: { cookie } }, env);
    expect(response.status).toBe(200);
    expect(rotate).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(sessionCookies(response)).toHaveLength(0);
  });

  it("does not rotate a signed-in viewer the gate refuses", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const rotate = vi.spyOn(store, "rotate");
    const renew = vi.spyOn(store, "renew");
    const { cookie } = await sessionFor(store, gate.refused);
    vi.setSystemTime(REQUEST_AT);
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(403);
    expect(rotate).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(sessionCookies(response)).toHaveLength(0);
  });
});
