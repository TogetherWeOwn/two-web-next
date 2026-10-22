// route-inventory: GET /
// route-inventory: GET /auth/status
// route-inventory: PUT /events/:key/rsvp
//
// Test-Author-owned acceptance contract: absolute session age cap (K2).
// The Builder changes production code, never this file. Failing-first: on a
// tree without the cap every "past the cap" test below fails because the
// sliding window is the only lifetime; the fix makes them green.
//
// The contract the Builder implements:
// - `SESSION_ABSOLUTE_MAX_AGE_SECONDS` exported from src/sessions.ts, 86400
//   (24 hours). The absolute age of a session is now minus its lineage start:
//   the login that minted the lineage. Rotation preserves the lineage start
//   (a rotated successor does NOT restart the clock); renewal never extends
//   past lineage start + cap.
// - Boundary is exclusive like expires_at: age == cap reads dead. A row is
//   live only while expires_at is future AND age < cap AND it is unrevoked.
// - Past the cap, get()/statusHash()/isActive() read null/null/false in both
//   stores, renew()/rotate() resolve false without writing, and sweepExpired
//   deletes absolutely-aged rows (the scheduled adapter stays batch-bounded).
// - Gates reuse the existing expired-session UX: page/profile/admin bounce to
//   login, JSON writes answer 401 with recovery, Kit reads guest, /auth/status
//   reports guest. Never a 500, never a resurrected session.
// - The privacy policy ships a new numbered version documenting the cap; the
//   120-minute idle window is unchanged.
//
// Hermetic except where marked: memory stores, fake clocks, signed cookies,
// stubbed Discord fetch. Postgres sections use a guarded disposable schema on
// agent-testdb or the CI Postgres service, and skip without DATABASE_URL.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { generateSignedCookie } from "hono/cookie";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminGuard, type AccessDecl, type Actor } from "../src/admin/guard";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import type { Env } from "../src/env";
import { __resetHomeGuestCacheForTests } from "../src/home-cache";
import { PRUNE_DELETE_BATCH_SIZE } from "../src/jobs/constants";
import { pgPruneStores } from "../src/jobs/postgres";
import { resolveRequestSession } from "../src/kit-session";
import { bufferedMemberHtml } from "../src/member-reads";
import { POLICY_FILE, POLICY_VERSION } from "../src/privacy";
import { POLICY_MARKDOWN } from "../src/privacy-content";
import { memberGate } from "../src/profiles/routes-gate";
import type { ProfileApp } from "../src/profiles/routes-shared";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  migrate,
  newSessionToken,
  SESSION_TTL_SECONDS,
  type DbSessionRow,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import app from "./app";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const LOGIN_AT = Date.parse("2026-10-19T10:00:00.000Z");
const TTL_MS = SESSION_TTL_SECONDS * 1000;
/** The absolute cap this suite pins: lineage start + 24h reads dead. */
const EXPECTED_ABSOLUTE_CAP_SECONDS = 24 * 3600;
const CAP_MS = EXPECTED_ABSOLUTE_CAP_SECONDS * 1000;
/** Postgres assertions use real clocks, so they stand off the boundary. */
const PG_MARGIN_MS = 60_000;
const RSVP_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RSVP_NEXT = `/e/${RSVP_KEY}?attendees=2`;
const RSVP_RECOVERY = "/auth/recover?next=" + encodeURIComponent(RSVP_NEXT);

const env: Env = {
  APP_URL,
  SESSION_SECRET: SECRET,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
};

const MEMBER: DbSessionRow = {
  userId: "100000000000000031",
  username: "absolute-cap-member",
  avatar: null,
  member: true,
  moderator: false,
};
const MODERATOR: DbSessionRow = {
  ...MEMBER,
  userId: "100000000000000032",
  username: "absolute-cap-moderator",
  moderator: true,
};

async function sessionsModule(): Promise<Record<string, unknown>> {
  return (await import("../src/sessions")) as unknown as Record<string, unknown>;
}

function envWith(store: SessionStore): Env {
  return { ...env, SESSION_STORE: store } as Env;
}

const COOKIE_NAME = SESSION_COOKIE;

async function sessionFor(store: SessionStore, viewer: DbSessionRow, expiresAt: Date) {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await store.create({ ...viewer, tokenHash, expiresAt });
  const signed = await serializeSigned(COOKIE_NAME, token, SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  return { token, tokenHash, cookie: signed.split(";")[0]! };
}

function sessionCookies(response: Response) {
  return response.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
}

function memberApp(store: SessionStore) {
  const gated: ProfileApp = new Hono();
  gated.use("/*", memberGate({ sessionStore: store }));
  gated.get("/profile", (c) => c.html(`<p>${c.get("viewer").id}</p>`));
  return gated;
}

function moderatorApp(store: SessionStore) {
  const gated = new Hono<{
    Bindings: Env;
    Variables: { adminActor: Actor; access: AccessDecl };
  }>();
  gated.use("/*", adminGuard({ sessionStore: store }));
  gated.get("/admin", (c) => {
    c.set("access", { resource: "events", action: "view", route: "test.session-absolute-cap" });
    return bufferedMemberHtml(c, `<p>${c.get("adminActor").id}</p>`);
  });
  return gated;
}

const gates = [
  { name: "memberGate", viewer: MEMBER, path: "/profile", app: memberApp },
  { name: "adminGuard", viewer: MODERATOR, path: "/admin", app: moderatorApp },
] as const;

describe("absolute cap contract pins", () => {
  it("exports SESSION_ABSOLUTE_MAX_AGE_SECONDS = 86400 from the session module", async () => {
    expect(await sessionsModule()).toHaveProperty(
      "SESSION_ABSOLUTE_MAX_AGE_SECONDS",
      EXPECTED_ABSOLUTE_CAP_SECONDS,
    );
  });

  it("leaves the 120-minute sliding window unchanged", () => {
    expect(SESSION_TTL_SECONDS).toBe(7200);
  });

  it("ships the cap in a new numbered privacy policy version", () => {
    expect(
      POLICY_VERSION,
      "the cap is a material change: ship a new numbered policy version",
    ).toBeGreaterThan(5);
    expect(POLICY_FILE).toBe(`content/privacy-policy-v${POLICY_VERSION}.md`);
    expect(existsSync(join(root, POLICY_FILE))).toBe(true);
  });

  it("documents the absolute cap in the session paragraph", () => {
    const paragraph = POLICY_MARKDOWN.split(/\n\s*\n/).find((block) =>
      block.includes("`__Host-two_session` keeps you signed in"),
    );
    expect(paragraph).toBeDefined();
    expect(paragraph!.toLowerCase()).toContain("absolute");
  });

  it("keeps the idle-window promise in the session paragraph", () => {
    const paragraph = POLICY_MARKDOWN.split(/\n\s*\n/).find((block) =>
      block.includes("`__Host-two_session` keeps you signed in"),
    );
    expect(paragraph).toBeDefined();
    expect(paragraph!).toContain("120 minutes");
    expect(paragraph!).toContain("two hours");
  });
});

describe("memory store absolute age (manual clock, no timers)", () => {
  let now = LOGIN_AT;
  let store: SessionStore;
  beforeEach(() => {
    now = LOGIN_AT;
    store = createMemorySessionStore(() => now);
  });

  async function agedSession(
    viewer: DbSessionRow = MEMBER,
    loginAt: number = LOGIN_AT,
    expiresAt: number = LOGIN_AT + CAP_MS + TTL_MS,
  ) {
    now = loginAt;
    const tokenHash = await hashToken(newSessionToken());
    await store.create({ ...viewer, tokenHash, expiresAt: new Date(expiresAt) });
    return tokenHash;
  }

  it("reads a young row with a future sliding expiry", async () => {
    const tokenHash = await agedSession();
    now = LOGIN_AT + CAP_MS - 1;
    expect(await store.get(tokenHash)).toEqual(MEMBER);
    expect(await store.statusHash(tokenHash)).toBe(tokenHash);
    expect(await store.isActive(tokenHash)).toBe(true);
  });

  it("reads null at the exact cap instant even with a future sliding expiry", async () => {
    const tokenHash = await agedSession();
    now = LOGIN_AT + CAP_MS - 1;
    expect(await store.get(tokenHash)).toEqual(MEMBER);
    now = LOGIN_AT + CAP_MS;
    expect(await store.get(tokenHash)).toBeNull();
    expect(await store.statusHash(tokenHash)).toBeNull();
    expect(await store.isActive(tokenHash)).toBe(false);
  });

  it("reads null past the cap and stays null (no resurrection on re-read)", async () => {
    const tokenHash = await agedSession();
    now = LOGIN_AT + CAP_MS + 1;
    expect(await store.get(tokenHash)).toBeNull();
    expect(await store.statusHash(tokenHash)).toBeNull();
    expect(await store.isActive(tokenHash)).toBe(false);
    expect(await store.get(tokenHash)).toBeNull();
  });

  it("refuses renewal past the cap without extending the row", async () => {
    const tokenHash = await agedSession();
    now = LOGIN_AT + CAP_MS - 1;
    expect(await store.renew(tokenHash, new Date(now + TTL_MS))).toBe(true);
    now = LOGIN_AT + CAP_MS;
    expect(await store.renew(tokenHash, new Date(now + TTL_MS))).toBe(false);
    now = LOGIN_AT + CAP_MS + TTL_MS - 1;
    expect(await store.get(tokenHash)).toBeNull();
  });

  it("refuses rotation past the cap without planting a successor", async () => {
    const oldHash = await agedSession();
    const replacement = await hashToken(newSessionToken());
    now = LOGIN_AT + CAP_MS;
    expect(
      await store.rotate(oldHash, {
        ...MEMBER,
        tokenHash: replacement,
        expiresAt: new Date(now + TTL_MS),
      }),
    ).toBe(false);
    expect(await store.get(replacement)).toBeNull();
    expect(await store.get(oldHash)).toBeNull();
  });

  it("keeps the lineage clock across rotation: the successor dies with the lineage", async () => {
    const oldHash = await agedSession(MEMBER, LOGIN_AT, LOGIN_AT + CAP_MS + TTL_MS);
    now = LOGIN_AT + 3_600_000;
    const successor = await hashToken(newSessionToken());
    expect(
      await store.rotate(oldHash, {
        ...MEMBER,
        tokenHash: successor,
        expiresAt: new Date(LOGIN_AT + CAP_MS + 2 * TTL_MS),
      }),
    ).toBe(true);
    now = LOGIN_AT + CAP_MS - 1;
    expect(await store.get(successor)).toEqual(MEMBER);
    now = LOGIN_AT + CAP_MS;
    expect(await store.get(successor)).toBeNull();
    expect(await store.statusHash(successor)).toBeNull();
  });

  it("kills predecessor grace once the successor passes the cap", async () => {
    const oldHash = await agedSession(MEMBER, LOGIN_AT, LOGIN_AT + CAP_MS + TTL_MS);
    now = LOGIN_AT + CAP_MS - 5_000;
    const successor = await hashToken(newSessionToken());
    expect(
      await store.rotate(oldHash, {
        ...MEMBER,
        tokenHash: successor,
        expiresAt: new Date(now + TTL_MS),
      }),
    ).toBe(true);
    expect(await store.get(oldHash)).toEqual(MEMBER);
    now = LOGIN_AT + CAP_MS + 5_000;
    expect(await store.get(successor)).toBeNull();
    expect(await store.get(oldHash)).toBeNull();
  });

  it("sweepExpired deletes absolutely-aged rows and keeps young rows", async () => {
    const young = await agedSession(MEMBER, LOGIN_AT + CAP_MS - TTL_MS, LOGIN_AT + 2 * CAP_MS);
    const aged = await agedSession(MEMBER, LOGIN_AT, LOGIN_AT + 2 * CAP_MS);
    now = LOGIN_AT + TTL_MS;
    const idleExpired = await hashToken(newSessionToken());
    await store.create({ ...MEMBER, tokenHash: idleExpired, expiresAt: new Date(now - 1) });
    now = LOGIN_AT + CAP_MS + 1;
    // One idle-expired row plus one absolutely-aged row with a future expiry.
    expect(await store.sweepExpired(new Date(now))).toBe(2);
    expect(await store.get(young)).toEqual(MEMBER);
    expect(await store.sweepExpired(new Date(now))).toBe(0);
    expect(aged).not.toBe(young);
  });
});

const pgUrl = process.env.DATABASE_URL;

describe.skipIf(!pgUrl)("postgres store absolute age (disposable schema)", () => {
  let fixture: JobsFixture;
  let store: ReturnType<typeof createPostgresSessionStore>;

  beforeAll(async () => {
    fixture = await createJobsFixture(pgUrl!, { max: 4 });
    await migrate(fixture.client as unknown as Sql);
    store = createPostgresSessionStore(fixture.client as unknown as Sql);
  });

  beforeEach(async () => {
    await fixture.client`delete from web_session_grace`;
    await fixture.client`delete from web_sessions`;
  });

  afterEach(async () => {
    await fixture.client`delete from web_session_grace`;
    await fixture.client`delete from web_sessions`;
  });

  async function seed(tokenHash: string, ageMs: number, expiresInMs = TTL_MS) {
    await store.create({
      ...MEMBER,
      tokenHash,
      expiresAt: new Date(Date.now() + expiresInMs),
    });
    await fixture.client`update web_sessions set created_at = ${new Date(Date.now() - ageMs)}
      where token_hash = ${tokenHash}`;
  }

  it("reads a young row and nulls a past-cap row with a future sliding expiry", async () => {
    await seed("abs-young", CAP_MS - PG_MARGIN_MS);
    await seed("abs-old", CAP_MS + PG_MARGIN_MS);
    expect(await store.get("abs-young")).toEqual(MEMBER);
    expect(await store.get("abs-old")).toBeNull();
  });

  it("agrees across statusHash/isActive past the cap", async () => {
    await seed("abs-probe-young", CAP_MS - PG_MARGIN_MS);
    await seed("abs-probe-old", CAP_MS + PG_MARGIN_MS);
    expect(await store.statusHash("abs-probe-old")).toBeNull();
    expect(await store.isActive("abs-probe-old")).toBe(false);
    const key = await store.statusHash("abs-probe-young");
    expect(key).toBe("abs-probe-young");
    expect(await store.isActive(key!)).toBe(true);
  });

  it("refuses renewal past the cap without extending the row", async () => {
    await seed("abs-renew", CAP_MS + PG_MARGIN_MS);
    expect(await store.renew("abs-renew", new Date(Date.now() + TTL_MS))).toBe(false);
    expect(await store.get("abs-renew")).toBeNull();
  });

  it("refuses rotation past the cap without planting a successor", async () => {
    await seed("abs-rotate-source", CAP_MS + PG_MARGIN_MS);
    expect(
      await store.rotate("abs-rotate-source", {
        ...MEMBER,
        tokenHash: "abs-rotate-new",
        expiresAt: new Date(Date.now() + TTL_MS),
      }),
    ).toBe(false);
    expect(await store.get("abs-rotate-new")).toBeNull();
    expect(await store.get("abs-rotate-source")).toBeNull();
  });

  it("carries the lineage created_at across rotation instead of restarting the clock", async () => {
    await seed("abs-lineage-source", 3_600_000);
    const [before] = await fixture.client<{ created_at: Date }[]>`
      select created_at from web_sessions where token_hash = 'abs-lineage-source'`;
    expect(
      await store.rotate("abs-lineage-source", {
        ...MEMBER,
        tokenHash: "abs-lineage-successor",
        expiresAt: new Date(Date.now() + TTL_MS),
      }),
    ).toBe(true);
    const [after] = await fixture.client<{ created_at: Date }[]>`
      select created_at from web_sessions where token_hash = 'abs-lineage-successor'`;
    expect(after!.created_at.getTime()).toBe(before!.created_at.getTime());
  });

  it("kills the rotated successor with the lineage once the lineage passes the cap", async () => {
    await seed("abs-aged-source", CAP_MS - PG_MARGIN_MS);
    expect(
      await store.rotate("abs-aged-source", {
        ...MEMBER,
        tokenHash: "abs-aged-successor",
        expiresAt: new Date(Date.now() + TTL_MS),
      }),
    ).toBe(true);
    await fixture.client`update web_sessions
      set created_at = ${new Date(Date.now() - CAP_MS - PG_MARGIN_MS)}
      where token_hash = 'abs-aged-successor'`;
    expect(await store.get("abs-aged-successor")).toBeNull();
    expect(await store.get("abs-aged-source")).toBeNull();
  });

  it("sweepExpired deletes absolutely-aged rows and keeps young rows", async () => {
    await seed("abs-sweep-young", CAP_MS - PG_MARGIN_MS);
    await seed("abs-sweep-old", CAP_MS + PG_MARGIN_MS);
    await store.create({
      ...MEMBER,
      tokenHash: "abs-sweep-idle",
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await store.sweepExpired(new Date())).toBe(2);
    expect(await store.get("abs-sweep-young")).toEqual(MEMBER);
    expect(await store.sweepExpired(new Date())).toBe(0);
  });
});

describe.skipIf(!pgUrl)("scheduled sweep stays batch-bounded for absolutely-aged rows", () => {
  it("drains aged rows one batch per statement with exact survivors", async () => {
    const iso = await createJobsFixture(pgUrl!, { max: 4 });
    try {
      await migrate(iso.client as unknown as Sql);
      const psql = iso.client;
      const stores = pgPruneStores(psql);
      const now = new Date();
      const aged = PRUNE_DELETE_BATCH_SIZE + 3;
      await psql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at, created_at)
        select 'abscap-old-' || g, '1', 'a', true, false,
          ${new Date(now.getTime() + TTL_MS)},
          ${new Date(now.getTime() - CAP_MS - PG_MARGIN_MS)}
        from generate_series(1, ${aged}) g`;
      await psql`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        values ('abscap-live','3','c',true,false,${new Date(now.getTime() + TTL_MS)})`;
      const survivors = async () =>
        (
          await psql<{ token_hash: string }[]>`select token_hash from web_sessions
            order by token_hash`
        ).map((r) => r.token_hash);

      expect(await stores.sessions.sweepExpired(now)).toBe(PRUNE_DELETE_BATCH_SIZE);
      expect(await survivors()).toContain("abscap-live");
      expect(await stores.sessions.sweepExpired(now)).toBe(3);
      expect(await stores.sessions.sweepExpired(now)).toBe(0);
      expect(await survivors()).toEqual(["abscap-live"]);
    } finally {
      await iso.dispose();
    }
  });
});

describe.each(gates)("$name past the absolute cap (hermetic)", (gate) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LOGIN_AT);
    vi.stubGlobal("fetch", () => {
      throw new Error("The absolute-cap suite must not use network transport");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function cappedSession(store: SessionStore) {
    const issued = await sessionFor(store, gate.viewer, new Date(LOGIN_AT + CAP_MS + TTL_MS));
    vi.setSystemTime(LOGIN_AT + CAP_MS);
    return issued;
  }

  it("serves a young bearer (control: the harness authenticates)", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie } = await sessionFor(store, gate.viewer, new Date(LOGIN_AT + TTL_MS));
    vi.setSystemTime(LOGIN_AT + 60_000);
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`<p>${gate.viewer.userId}</p>`);
  });

  it("bounces a past-cap bearer to login without cookies or contents, never 500", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash } = await cappedSession(store);
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/discord");
    expect(await response.text()).not.toContain(gate.viewer.userId);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(await store.get(tokenHash)).toBeNull();
    expect(await store.statusHash(tokenHash)).toBeNull();
  });

  it("never resurrects: a rotation attempted during a past-cap renewal plants nothing", async () => {
    const real = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash: oldHash } = await sessionFor(
      real,
      gate.viewer,
      new Date(LOGIN_AT + CAP_MS + TTL_MS),
    );
    vi.setSystemTime(LOGIN_AT + CAP_MS);
    const replacementHash = await hashToken(newSessionToken());
    const store: SessionStore = {
      ...real,
      renew: async (hash, expiresAt) => {
        await real.rotate(oldHash, {
          ...gate.viewer,
          tokenHash: replacementHash,
          expiresAt,
        });
        return real.renew(hash, expiresAt);
      },
    };
    const response = await gate.app(store).request(gate.path, { headers: { cookie } }, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/discord");
    expect(sessionCookies(response)).toHaveLength(0);
    expect(await real.get(oldHash)).toBeNull();
    expect(await real.get(replacementHash)).toBeNull();
    expect(await real.statusHash(replacementHash)).toBeNull();
  });

  it("resolves a render that crosses the cap to serve-without-renewal or bounce, never 500", async () => {
    const real = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash } = await sessionFor(
      real,
      gate.viewer,
      new Date(LOGIN_AT + CAP_MS + TTL_MS),
    );
    const requestTime = LOGIN_AT + CAP_MS - 1_000;
    vi.setSystemTime(requestTime);
    const gated =
      gate.name === "memberGate"
        ? (() => {
            const appFor: ProfileApp = new Hono();
            appFor.use("/*", memberGate({ sessionStore: real }));
            appFor.get("/profile", async (c) => {
              vi.setSystemTime(LOGIN_AT + CAP_MS + 1_000);
              return bufferedMemberHtml(c, `<p>${c.get("viewer").id}</p>`);
            });
            return appFor;
          })()
        : (() => {
            const appFor = new Hono<{
              Bindings: Env;
              Variables: { adminActor: Actor; access: AccessDecl };
            }>();
            appFor.use("/*", adminGuard({ sessionStore: real }));
            appFor.get("/admin", async (c) => {
              c.set("access", {
                resource: "events",
                action: "view",
                route: "test.session-absolute-cap",
              });
              vi.setSystemTime(LOGIN_AT + CAP_MS + 1_000);
              return bufferedMemberHtml(c, `<p>${c.get("adminActor").id}</p>`);
            });
            return appFor;
          })();
    const response = await gated.request(gate.path, { headers: { cookie } }, env);
    expect([200, 302]).toContain(response.status);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(await real.get(tokenHash)).toBeNull();
  });
});

describe("Hono homepage past the cap (hermetic full app)", () => {
  beforeEach(() => {
    __resetHomeGuestCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LOGIN_AT);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/scheduled-events")) return Response.json([]);
        throw new Error("Unexpected outbound request in absolute-cap homepage fixture");
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders a past-cap bearer as guest without minting a replacement cookie", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash } = await sessionFor(
      store,
      MEMBER,
      new Date(LOGIN_AT + CAP_MS + TTL_MS),
    );
    vi.setSystemTime(LOGIN_AT + CAP_MS);
    const response = await app.request("/", { headers: { cookie } }, envWith(store));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(MEMBER.username);
    expect(body).not.toContain(MEMBER.userId);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(await store.get(tokenHash)).toBeNull();
  });

  it("still rotates a young bearer (control: the page path renews)", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie } = await sessionFor(store, MEMBER, new Date(LOGIN_AT + TTL_MS));
    vi.setSystemTime(LOGIN_AT + 60_000);
    const response = await app.request("/", { headers: { cookie } }, envWith(store));
    expect(response.status).toBe(200);
    expect(sessionCookies(response)).toHaveLength(1);
  });
});

describe("Kit bridge past the cap (hermetic)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LOGIN_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const requestWith = (cookie: string) =>
    new Request("https://next.example.test/events/past", { headers: { cookie } });

  it("maps a past-cap bearer to guest without renewal writes", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash } = await sessionFor(
      store,
      MEMBER,
      new Date(LOGIN_AT + CAP_MS + TTL_MS),
    );
    const renew = vi.spyOn(store, "renew");
    const rotate = vi.spyOn(store, "rotate");
    const replace = vi.spyOn(store, "replace");
    const create = vi.spyOn(store, "create");
    vi.setSystemTime(LOGIN_AT + CAP_MS);
    const decision = await resolveRequestSession(requestWith(cookie), {
      sessionSecret: SECRET,
      store,
    });
    expect(decision).toEqual({ status: "guest", session: null });
    expect(renew).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await store.get(tokenHash)).toBeNull();
  });

  it("still authenticates a young bearer (control)", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie } = await sessionFor(store, MEMBER, new Date(LOGIN_AT + TTL_MS));
    vi.setSystemTime(LOGIN_AT + 60_000);
    const decision = await resolveRequestSession(requestWith(cookie), {
      sessionSecret: SECRET,
      store,
    });
    expect(decision.status).toBe("authenticated");
    expect(decision.session).toMatchObject({ userId: MEMBER.userId });
  });
});

describe("/auth/status past the cap (hermetic full app)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LOGIN_AT);
    vi.stubGlobal("fetch", () => {
      throw new Error("The absolute-cap suite must not use network transport");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function probeCookie(store: SessionStore, tokenHash: string) {
    const key = await store.statusHash(tokenHash);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    return (
      await generateSignedCookie(AUTH_STATUS_COOKIE, key!, SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        maxAge: SESSION_TTL_SECONDS,
      })
    ).split(";")[0]!;
  }

  it("reports guest for a past-cap session-cookie bearer, never 503", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie } = await sessionFor(store, MEMBER, new Date(LOGIN_AT + CAP_MS + TTL_MS));
    vi.setSystemTime(LOGIN_AT + CAP_MS);
    const response = await app.request("/auth/status", { headers: { cookie } }, envWith(store));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
  });

  it("reports guest for a pre-cap probe cookie once the lineage passes the cap", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash } = await sessionFor(
      store,
      MEMBER,
      new Date(LOGIN_AT + CAP_MS + TTL_MS),
    );
    const probe = await probeCookie(store, tokenHash);
    vi.setSystemTime(LOGIN_AT + CAP_MS);
    const response = await app.request(
      "/auth/status",
      { headers: { cookie: [cookie, probe].join("; ") } },
      envWith(store),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
  });

  it("still reports a young session live (control)", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie, tokenHash } = await sessionFor(store, MEMBER, new Date(LOGIN_AT + TTL_MS));
    const probe = await probeCookie(store, tokenHash);
    vi.setSystemTime(LOGIN_AT + 60_000);
    const response = await app.request(
      "/auth/status",
      { headers: { cookie: [cookie, probe].join("; ") } },
      envWith(store),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
  });
});

describe("JSON writes past the cap (hermetic full app)", () => {
  let effects = { database: 0, queue: 0, network: 0 };

  beforeEach(() => {
    effects = { database: 0, queue: 0, network: 0 };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LOGIN_AT);
    vi.stubGlobal("fetch", async () => {
      effects.network++;
      throw new Error("Unexpected outbound request in absolute-cap write fixture");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(effects).toEqual({ database: 0, queue: 0, network: 0 });
  });

  function writeEnv(store: SessionStore): Env {
    return {
      ...envWith(store),
      ADMIN_DB: new Proxy(
        {},
        {
          get() {
            effects.database++;
            throw new Error("A past-cap write must not reach a database");
          },
        },
      ),
      SYNC_EVENT_QUEUE: {
        send: async () => {
          effects.queue++;
          throw new Error("A past-cap write must not enqueue a write");
        },
      },
    } as unknown as Env;
  }

  it("PUT RSVP with a past-cap bearer stays a JSON 401 with recovery, not a redirect", async () => {
    const store = createMemorySessionStore(() => Date.now());
    const { cookie } = await sessionFor(store, MEMBER, new Date(LOGIN_AT + CAP_MS + TTL_MS));
    vi.setSystemTime(LOGIN_AT + CAP_MS);
    const response = await app.request(
      `/events/${RSVP_KEY}/rsvp`,
      {
        method: "PUT",
        headers: {
          cookie,
          origin: APP_URL,
          referer: APP_URL + RSVP_NEXT,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "going" }),
      },
      writeEnv(store),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Unauthorized", recovery: RSVP_RECOVERY });
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
