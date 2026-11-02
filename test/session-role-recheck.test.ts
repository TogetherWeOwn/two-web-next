// route-inventory: GET /profile
// route-inventory: GET /admin
//
// Mid-session role recheck: a privileged session whose member/moderator
// bits are at least SESSION_ROLE_RECHECK_SECONDS old re-derives them from
// Discord before they authorize another request (src/session-role-refresh.ts,
// src/roles.ts, src/sessions.ts). Only a definitive Discord answer replaces
// the bits; an inconclusive lookup keeps them and only restamps the
// cadence. Hermetic: memory stores, manual clocks, stubbed Discord fetch.
// The Postgres store's due/apply/rotate behavior is pinned beside the other
// session-clock cases in test/session-absolute-age-operations.test.ts.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminGuard, type AccessDecl, type Actor } from "../src/admin/guard";
import type { Env } from "../src/env";
import { bufferedMemberHtml } from "../src/member-reads";
import { memberGate } from "../src/profiles/routes-gate";
import type { ProfileApp } from "../src/profiles/routes-shared";
import { recheckGuildRoles } from "../src/roles";
import { SESSION_COOKIE } from "../src/session-cookie";
import { refreshSessionRoles, type RoleRecheckConfig } from "../src/session-role-refresh";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  SESSION_ROLE_RECHECK_SECONDS,
  SESSION_TTL_SECONDS,
  type DbSessionRow,
  type SessionStore,
} from "../src/sessions";

const SECRET = "test-session-secret-at-least-32-bytes-long";
const GUILD = "326474832151838730";
const MOD_ROLE = "555000111222333444";
const LOGIN_AT = Date.parse("2026-10-19T10:00:00.000Z");
const CADENCE_MS = SESSION_ROLE_RECHECK_SECONDS * 1000;
const TTL_MS = SESSION_TTL_SECONDS * 1000;

const MODERATOR: DbSessionRow = {
  userId: "100000000000000401",
  username: "recheck-moderator",
  avatar: null,
  member: true,
  moderator: true,
};
const MEMBER: DbSessionRow = { ...MODERATOR, userId: "100000000000000402", moderator: false };

const CONFIG: RoleRecheckConfig = {
  guildId: GUILD,
  botToken: "bot-token",
  moderatorRoleIds: [MOD_ROLE],
};

const env: Env = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: SECRET,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_GUILD_ID: GUILD,
  DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
  DISCORD_INVITE_URL: "https://discord.gg/invite",
};

type FetchCall = { url: string; authorization: string | null };

function stubDiscord(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function memberBody(roles: string[]): Response {
  return new Response(JSON.stringify({ roles, joined_at: "2020-01-01T00:00:00.000Z" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("recheckGuildRoles verdicts", () => {
  const opts = () => ({
    guildId: GUILD,
    userId: MODERATOR.userId,
    botToken: "bot-token",
    moderatorRoleIds: [MOD_ROLE],
  });

  it("re-derives member and moderator from the live guild member", async () => {
    const calls = stubDiscord(() => memberBody([MOD_ROLE, "123"]));
    await expect(recheckGuildRoles(opts())).resolves.toEqual({ member: true, moderator: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://discord.com/api/v10/guilds/${GUILD}/members/${MODERATOR.userId}`,
    );
    expect(calls[0]!.authorization).toBe("Bot bot-token");
  });

  it("reports a demoted moderator as member without the moderator bit", async () => {
    stubDiscord(() => memberBody(["123"]));
    await expect(recheckGuildRoles(opts())).resolves.toEqual({ member: true, moderator: false });
  });

  it("reports a user who left the guild (404) with both bits cleared", async () => {
    stubDiscord(() => new Response("Unknown Member", { status: 404 }));
    await expect(recheckGuildRoles(opts())).resolves.toEqual({ member: false, moderator: false });
  });

  it("keeps the verdict inconclusive on HTTP failure, transport failure and shape misses", async () => {
    stubDiscord(() => new Response("upstream", { status: 502 }));
    await expect(recheckGuildRoles(opts())).resolves.toBeNull();

    stubDiscord(() => {
      throw new Error("socket reset");
    });
    await expect(recheckGuildRoles(opts())).resolves.toBeNull();

    stubDiscord(
      () =>
        new Response(JSON.stringify({ joined_at: "2020-01-01T00:00:00.000Z" }), { status: 200 }),
    );
    await expect(recheckGuildRoles(opts())).resolves.toBeNull();

    stubDiscord(() => new Response("not json", { status: 200 }));
    await expect(recheckGuildRoles(opts())).resolves.toBeNull();
  });

  it("treats a roles array with any malformed entry as a shape miss, not a demotion", async () => {
    for (const roles of [[null], [[MOD_ROLE]], ["not-a-snowflake"], [MOD_ROLE, 42]]) {
      stubDiscord(
        () =>
          new Response(JSON.stringify({ roles, joined_at: "2020-01-01T00:00:00.000Z" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      await expect(recheckGuildRoles(opts())).resolves.toBeNull();
    }
  });

  it("emits no request and stays inconclusive without a bot token", async () => {
    const calls = stubDiscord(() => memberBody([MOD_ROLE]));
    await expect(recheckGuildRoles({ ...opts(), botToken: "  " })).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("memory store recheck stamping (manual clock, no timers)", () => {
  let now = LOGIN_AT;
  let store: SessionStore;
  beforeEach(() => {
    now = LOGIN_AT;
    store = createMemorySessionStore(() => now);
  });

  async function seed(viewer: DbSessionRow = MODERATOR) {
    const tokenHash = await hashToken(newSessionToken());
    await store.create({ ...viewer, tokenHash, expiresAt: new Date(LOGIN_AT + TTL_MS) });
    return tokenHash;
  }

  it("pins the cadence at five minutes", () => {
    expect(SESSION_ROLE_RECHECK_SECONDS).toBe(5 * 60);
  });

  it("is due at the cadence boundary and not before", async () => {
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS - 1;
    expect(await store.roleRecheckDue!(tokenHash)).toBe(false);
    now = LOGIN_AT + CADENCE_MS;
    expect(await store.roleRecheckDue!(tokenHash)).toBe(true);
  });

  it("never marks an unprivileged row due", async () => {
    const tokenHash = await seed({ ...MEMBER, member: false });
    now = LOGIN_AT + CADENCE_MS * 4;
    expect(await store.roleRecheckDue!(tokenHash)).toBe(false);
  });

  it("apply with bits replaces them and restamps; apply with null only restamps", async () => {
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    expect(await store.applyRoleRecheck!(tokenHash, null)).toBe(true);
    expect(await store.get(tokenHash)).toEqual(MODERATOR);
    expect(await store.roleRecheckDue!(tokenHash)).toBe(false);

    now += CADENCE_MS;
    expect(await store.roleRecheckDue!(tokenHash)).toBe(true);
    expect(await store.applyRoleRecheck!(tokenHash, { member: true, moderator: false })).toBe(true);
    expect(await store.get(tokenHash)).toEqual({ ...MODERATOR, moderator: false });
    expect(await store.roleRecheckDue!(tokenHash)).toBe(false);
  });

  it("a second apply after a landed recheck is discarded", async () => {
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    expect(await store.applyRoleRecheck!(tokenHash, { member: true, moderator: false })).toBe(true);
    // The stamp is fresh: a verdict read before the landed demotion (or a
    // late restamp) must not overwrite it.
    expect(await store.applyRoleRecheck!(tokenHash, { member: true, moderator: true })).toBe(false);
    expect(await store.applyRoleRecheck!(tokenHash, null)).toBe(false);
    expect(await store.get(tokenHash)).toEqual({ ...MODERATOR, moderator: false });
  });

  it("apply rewrites the live predecessor grace with the same bits", async () => {
    const oldHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    const newHash = await hashToken(newSessionToken());
    expect(
      await store.rotate(oldHash, {
        ...MODERATOR,
        tokenHash: newHash,
        expiresAt: new Date(now + TTL_MS),
      }),
    ).toBe(true);
    expect(await store.applyRoleRecheck!(newHash, { member: false, moderator: false })).toBe(true);
    expect(await store.get(oldHash)).toEqual({ ...MODERATOR, member: false, moderator: false });
    expect(await store.get(newHash)).toEqual({ ...MODERATOR, member: false, moderator: false });
  });

  it("rotation with bits a recheck already changed resets the stamp to lineage start", async () => {
    // A request read the privileged row, a concurrent recheck demoted it
    // (fresh stamp), then the first request rotates with its stale snapshot.
    // The successor carries the caller's bits (store contract) but must not
    // inherit the demotion's fresh stamp: it is immediately due again.
    const oldHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    expect(await store.applyRoleRecheck!(oldHash, { member: true, moderator: false })).toBe(true);
    expect(await store.roleRecheckDue!(oldHash)).toBe(false);
    const newHash = await hashToken(newSessionToken());
    expect(
      await store.rotate(oldHash, {
        ...MODERATOR,
        tokenHash: newHash,
        expiresAt: new Date(now + TTL_MS),
      }),
    ).toBe(true);
    expect(await store.get(newHash)).toEqual(MODERATOR);
    expect(await store.roleRecheckDue!(newHash)).toBe(true);
  });

  it("rotation preserves the recheck stamp instead of freshening it", async () => {
    const oldHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    const newHash = await hashToken(newSessionToken());
    expect(
      await store.rotate(oldHash, {
        ...MODERATOR,
        tokenHash: newHash,
        expiresAt: new Date(now + TTL_MS),
      }),
    ).toBe(true);
    expect(await store.roleRecheckDue!(newHash)).toBe(true);
  });

  it("apply on an unknown or dead bearer resolves false", async () => {
    expect(await store.applyRoleRecheck!("missing", { member: false, moderator: false })).toBe(
      false,
    );
    expect(await store.applyRoleRecheck!("missing", null)).toBe(false);
  });
});

describe("refreshSessionRoles", () => {
  let now = LOGIN_AT;
  let store: SessionStore;
  beforeEach(() => {
    now = LOGIN_AT;
    store = createMemorySessionStore(() => now);
  });

  async function seed(viewer: DbSessionRow = MODERATOR) {
    const tokenHash = await hashToken(newSessionToken());
    await store.create({ ...viewer, tokenHash, expiresAt: new Date(LOGIN_AT + TTL_MS) });
    return tokenHash;
  }

  it("strips the moderator bit within the cadence after a Discord demotion", async () => {
    const calls = stubDiscord(() => memberBody(["123"]));
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    const row = await store.get(tokenHash);
    const refreshed = await refreshSessionRoles(store, tokenHash, row!, CONFIG);
    expect(refreshed).toEqual({ ...MODERATOR, moderator: false });
    expect(await store.get(tokenHash)).toEqual({ ...MODERATOR, moderator: false });
    expect(calls).toHaveLength(1);

    // The attempt restamped the cadence: the next read serves stored bits.
    const again = await refreshSessionRoles(store, tokenHash, refreshed!, CONFIG);
    expect(again).toEqual({ ...MODERATOR, moderator: false });
    expect(calls).toHaveLength(1);
  });

  it("clears both bits when the member left the guild", async () => {
    stubDiscord(() => new Response("Unknown Member", { status: 404 }));
    const tokenHash = await seed(MEMBER);
    now = LOGIN_AT + CADENCE_MS;
    const refreshed = await refreshSessionRoles(
      store,
      tokenHash,
      (await store.get(tokenHash))!,
      CONFIG,
    );
    expect(refreshed).toEqual({ ...MEMBER, member: false, moderator: false });
    expect(await store.get(tokenHash)).toEqual({ ...MEMBER, member: false, moderator: false });
  });

  it("keeps the stored bits through a Discord outage and restamps the attempt", async () => {
    const calls = stubDiscord(() => new Response("upstream", { status: 502 }));
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    const refreshed = await refreshSessionRoles(
      store,
      tokenHash,
      (await store.get(tokenHash))!,
      CONFIG,
    );
    expect(refreshed).toEqual(MODERATOR);
    expect(await store.get(tokenHash)).toEqual(MODERATOR);
    await refreshSessionRoles(store, tokenHash, refreshed!, CONFIG);
    expect(calls).toHaveLength(1);
  });

  it("makes no Discord call before the cadence or for unprivileged rows", async () => {
    const calls = stubDiscord(() => memberBody([]));
    const fresh = await seed();
    const freshRow = await refreshSessionRoles(store, fresh, (await store.get(fresh))!, CONFIG);
    expect(freshRow).toEqual(MODERATOR);

    const plain = await seed({ ...MEMBER, userId: "100000000000000403", member: false });
    now = LOGIN_AT + CADENCE_MS * 3;
    const plainRow = await refreshSessionRoles(store, plain, (await store.get(plain))!, CONFIG);
    expect(plainRow?.member).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("makes no Discord call when the derivation config is incomplete", async () => {
    const calls = stubDiscord(() => memberBody([]));
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    const row = (await store.get(tokenHash))!;
    expect(await refreshSessionRoles(store, tokenHash, row, { ...CONFIG, guildId: " " })).toEqual(
      MODERATOR,
    );
    expect(await refreshSessionRoles(store, tokenHash, row, { ...CONFIG, botToken: " " })).toEqual(
      MODERATOR,
    );
    // Absent bindings read as undefined at runtime: stored bits, never a throw.
    const absent = {
      guildId: undefined,
      botToken: undefined,
      moderatorRoleIds: undefined,
    } as unknown as RoleRecheckConfig;
    expect(await refreshSessionRoles(store, tokenHash, row, absent)).toEqual(MODERATOR);
    expect(calls).toHaveLength(0);
  });

  it("makes no Discord call for a predecessor grace bearer", async () => {
    const calls = stubDiscord(() => memberBody([]));
    const oldHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    const newHash = await hashToken(newSessionToken());
    await store.rotate(oldHash, {
      ...MODERATOR,
      tokenHash: newHash,
      expiresAt: new Date(now + TTL_MS),
    });
    const graceRow = await store.get(oldHash);
    expect(graceRow).toEqual(MODERATOR);
    const refreshed = await refreshSessionRoles(store, oldHash, graceRow!, CONFIG);
    expect(refreshed).toEqual(MODERATOR);
    expect(calls).toHaveLength(0);
  });

  it("keeps the login-only behavior for stores without the recheck methods", async () => {
    const calls = stubDiscord(() => memberBody([]));
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    const { roleRecheckDue: _due, applyRoleRecheck: _apply, ...legacy } = store;
    const refreshed = await refreshSessionRoles(
      legacy as SessionStore,
      tokenHash,
      (await store.get(tokenHash))!,
      CONFIG,
    );
    expect(refreshed).toEqual(MODERATOR);
    expect(calls).toHaveLength(0);
  });

  it("never re-derives QA fixture sessions (staging synthetic identities)", async () => {
    const calls = stubDiscord(() => new Response("Unknown Member", { status: 404 }));
    const qaModerator: DbSessionRow = { ...MODERATOR, userId: "900000000000001397" };
    const tokenHash = await seed(qaModerator);
    now = LOGIN_AT + CADENCE_MS * 3;
    const refreshed = await refreshSessionRoles(
      store,
      tokenHash,
      (await store.get(tokenHash))!,
      CONFIG,
    );
    expect(refreshed).toEqual(qaModerator);
    expect(calls).toHaveLength(0);
  });

  it("serves stored bits without a Discord call when only grace remains (no status key)", async () => {
    const calls = stubDiscord(() => memberBody([]));
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    const graceOnly: SessionStore = { ...store, statusHash: async () => null };
    const refreshed = await refreshSessionRoles(
      graceOnly,
      tokenHash,
      (await store.get(tokenHash))!,
      CONFIG,
    );
    expect(refreshed).toEqual(MODERATOR);
    expect(calls).toHaveLength(0);
  });

  it("degrades to the stored bits when the recheck machinery itself fails", async () => {
    const calls = stubDiscord(() => memberBody([]));
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    const broken: SessionStore = {
      ...store,
      roleRecheckDue: async () => {
        throw new Error("column does not exist");
      },
    };
    const refreshed = await refreshSessionRoles(
      broken,
      tokenHash,
      (await store.get(tokenHash))!,
      CONFIG,
    );
    expect(refreshed).toEqual(MODERATOR);
    expect(calls).toHaveLength(0);
  });

  it("a blank moderator allowlist re-derives to non-moderator, matching login", async () => {
    const calls = stubDiscord(() => memberBody([MOD_ROLE]));
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    const refreshed = await refreshSessionRoles(store, tokenHash, (await store.get(tokenHash))!, {
      ...CONFIG,
      moderatorRoleIds: [],
    });
    expect(refreshed).toEqual({ ...MODERATOR, moderator: false });
    expect(await store.get(tokenHash)).toEqual({ ...MODERATOR, moderator: false });
    expect(calls).toHaveLength(1);
  });

  it("a verdict read before a parallel demotion cannot overwrite it", async () => {
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    // This request's Discord read still sees the moderator role, but a
    // parallel recheck lands its demotion first; the stale verdict is
    // discarded and the landed bits authorize.
    stubDiscord(async () => {
      await store.applyRoleRecheck!(tokenHash, { member: true, moderator: false });
      return memberBody([MOD_ROLE]);
    });
    const refreshed = await refreshSessionRoles(
      store,
      tokenHash,
      (await store.get(tokenHash))!,
      CONFIG,
    );
    expect(refreshed).toEqual({ ...MODERATOR, moderator: false });
    expect(await store.get(tokenHash)).toEqual({ ...MODERATOR, moderator: false });
  });

  it("reads as no session when the re-read after a failed apply also fails", async () => {
    stubDiscord(() => memberBody([MOD_ROLE]));
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    const row = (await store.get(tokenHash))!;
    const dying: SessionStore = {
      ...store,
      applyRoleRecheck: async () => false,
      get: async () => {
        throw new Error("store unavailable");
      },
    };
    // The pre-lookup row is known not to be live in that form; it must
    // never be the fallback when the authoritative re-read cannot answer.
    await expect(refreshSessionRoles(dying, tokenHash, row, CONFIG)).resolves.toBeNull();
  });

  it("reads as no session when the row is revoked during the lookup", async () => {
    const tokenHash = await seed();
    now = LOGIN_AT + CADENCE_MS;
    stubDiscord(async () => {
      await store.revoke(tokenHash);
      return memberBody([MOD_ROLE]);
    });
    const refreshed = await refreshSessionRoles(
      store,
      tokenHash,
      (await store.get(tokenHash))!,
      CONFIG,
    );
    expect(refreshed).toBeNull();
  });
});

describe("gates enforce the refreshed bits", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LOGIN_AT);
  });

  async function sessionFor(store: SessionStore, viewer: DbSessionRow) {
    const token = newSessionToken();
    await store.create({
      ...viewer,
      tokenHash: await hashToken(token),
      expiresAt: new Date(LOGIN_AT + TTL_MS),
    });
    const signed = await serializeSigned(SESSION_COOKIE, token, SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
    });
    return signed.split(";")[0]!;
  }

  function moderatorApp(store: SessionStore) {
    const gated = new Hono<{
      Bindings: Env;
      Variables: { adminActor: Actor; access: AccessDecl };
    }>();
    gated.use("/*", adminGuard({ sessionStore: store }));
    gated.get("/admin", (c) => {
      c.set("access", { resource: "events", action: "view", route: "test.session-role-recheck" });
      return bufferedMemberHtml(c, `<p>${c.get("adminActor").id}</p>`);
    });
    return gated;
  }

  function memberApp(store: SessionStore) {
    const gated: ProfileApp = new Hono();
    gated.use("/*", memberGate({ sessionStore: store }));
    gated.get("/profile", (c) => c.html(`<p>${c.get("viewer").id}</p>`));
    return gated;
  }

  it("admin guard 403s a moderator demoted since login once the cadence passes", async () => {
    const calls = stubDiscord(() => memberBody(["123"]));
    const store = createMemorySessionStore(() => Date.now());
    const cookie = await sessionFor(store, MODERATOR);
    vi.setSystemTime(LOGIN_AT + CADENCE_MS);
    const response = await moderatorApp(store).request("/admin", { headers: { cookie } }, env);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("admin guard still admits a moderator whose role is intact after the cadence", async () => {
    const calls = stubDiscord(() => memberBody([MOD_ROLE]));
    const store = createMemorySessionStore(() => Date.now());
    const cookie = await sessionFor(store, MODERATOR);
    vi.setSystemTime(LOGIN_AT + CADENCE_MS);
    const response = await moderatorApp(store).request("/admin", { headers: { cookie } }, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(MODERATOR.userId);
    expect(calls).toHaveLength(1);
  });

  it("member gate 403s a member who left the guild once the cadence passes", async () => {
    stubDiscord(() => new Response("Unknown Member", { status: 404 }));
    const store = createMemorySessionStore(() => Date.now());
    const cookie = await sessionFor(store, MEMBER);
    vi.setSystemTime(LOGIN_AT + CADENCE_MS);
    const response = await memberApp(store).request("/profile", { headers: { cookie } }, env);
    expect(response.status).toBe(403);
  });

  it("member gate serves a fresh member session without a Discord call", async () => {
    const calls = stubDiscord(() => {
      throw new Error("fresh sessions must not call Discord");
    });
    const store = createMemorySessionStore(() => Date.now());
    const cookie = await sessionFor(store, MEMBER);
    vi.setSystemTime(LOGIN_AT + 60_000);
    const response = await memberApp(store).request("/profile", { headers: { cookie } }, env);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
