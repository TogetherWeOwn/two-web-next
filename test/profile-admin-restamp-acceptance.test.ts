// Test-Author-owned acceptance contract: profile/admin session re-stamp.
//
// A1/M267: authenticated profile and admin Hono page views re-stamp the
// sliding window exactly like rotating readSession views (fresh token, fresh
// window, Set-Cookie), bounded by the predecessor's original expiry and the
// 24-hour absolute cap. The Builder changes production code, not these
// expectations. Failing-first: on the pre-change head the gates renew the
// same bearer (expiry-only, no rotation), so every test marked RED below
// fails because no successor is minted; the fix makes them green. Tests
// marked CONTROL pass before and after: they pin the behavior the re-stamp
// must preserve (anonymous/failed reads never rotate, cap still binds,
// logout ends acceptance, POST never rotates, Kit bridge stays read-only).
//
// Disposable postgres only: the session store is a real Postgres store on a
// w15_ schema (createJobsFixture), skipped without DATABASE_URL. Real DB
// clocks are used throughout (no fake timers): expiry assertions carry an
// explicit skew tolerance instead of exact instants.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminGuard, type AccessDecl, type Actor } from "../src/admin/guard";
import type { Env } from "../src/env";
import { resolveRequestSession } from "../src/kit-session";
import { bufferedMemberHtml } from "../src/member-reads";
import { memberGate } from "../src/profiles/routes-gate";
import type { ProfileApp } from "../src/profiles/routes-shared";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createPostgresSessionStore,
  hashToken,
  migrate,
  newSessionToken,
  SESSION_ABSOLUTE_MAX_AGE_SECONDS,
  SESSION_TTL_SECONDS,
  type DbSessionRow,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import app from "./app";
import { mergeCookies } from "./fixtures/session-recovery";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://app.example.test";
const TTL_MS = SESSION_TTL_SECONDS * 1000;
const CAP_MS = SESSION_ABSOLUTE_MAX_AGE_SECONDS * 1000;
/** DB clock vs test clock standoff for cap seeds. */
const PG_MARGIN_MS = 60_000;
/** Tolerance for request-time + TTL expiry assertions on a real clock. */
const SKEW_MS = 120_000;

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
  userId: "100000000000000051",
  username: "restamp-member",
  avatar: null,
  member: true,
  moderator: false,
};
const MODERATOR: DbSessionRow = {
  ...MEMBER,
  userId: "100000000000000052",
  username: "restamp-moderator",
  moderator: true,
};

// Identity-only handlers do no member-data reads, so the real admin read
// boundary releases without an audit DB (zero subjects, no sink call).
function memberApp(store: SessionStore) {
  const gated: ProfileApp = new Hono();
  gated.use("/*", memberGate({ sessionStore: store }));
  gated.get("/profile", (c) => c.html(`<p>${c.get("viewer").id}</p>`));
  gated.post("/profile", (c) => c.text(`posted ${c.get("viewer").id}`));
  return gated;
}

function moderatorApp(store: SessionStore) {
  const gated = new Hono<{
    Bindings: Env;
    Variables: { adminActor: Actor; access: AccessDecl };
  }>();
  gated.use("/*", adminGuard({ sessionStore: store }));
  gated.get("/admin", (c) => {
    c.set("access", { resource: "events", action: "view", route: "test.session-restamp" });
    return bufferedMemberHtml(c, `<p>${c.get("adminActor").id}</p>`);
  });
  gated.post("/admin", (c) => c.text(`posted ${c.get("adminActor").id}`));
  return gated;
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

function envWith(store: SessionStore): Env {
  return { ...env, SESSION_STORE: store } as Env;
}

async function sessionFor(store: SessionStore, viewer: DbSessionRow, expiresAt: Date) {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await store.create({ ...viewer, tokenHash, expiresAt });
  const signed = await serializeSigned(SESSION_COOKIE, token, SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  return { token, tokenHash, cookie: signed.split(";")[0]! };
}

function sessionCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .filter((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
}

/** The minted bearer inside a `name=signed` cookie pair (unsigned half). */
function bearerOf(pair: string): string {
  const signed = decodeURIComponent(pair.slice(pair.indexOf("=") + 1).split(";")[0]!);
  return signed.slice(0, signed.lastIndexOf("."));
}

type Client = JobsFixture["client"];

async function sessionRow(client: Client, tokenHash: string) {
  const rows = await client<
    { expires_at: Date; created_at: Date; status_hash: string | null }[]
  >`select expires_at, created_at, status_hash from web_sessions where token_hash = ${tokenHash}`;
  return rows[0] ?? null;
}

async function graceRow(client: Client, predecessorHash: string) {
  const rows = await client<
    { successor_hash: string; expires_at: Date; grace_expires_at: Date }[]
  >`select successor_hash, expires_at, grace_expires_at from web_session_grace
    where predecessor_hash = ${predecessorHash}`;
  return rows[0] ?? null;
}

async function rowCounts(client: Client) {
  const [sessions] = await client<{ n: number }[]>`select count(*)::int as n from web_sessions`;
  const [grace] = await client<{ n: number }[]>`select count(*)::int as n from web_session_grace`;
  return { sessions: sessions!.n, grace: grace!.n };
}

const pgUrl = process.env.DATABASE_URL;

describe.skipIf(!pgUrl)("profile/admin session re-stamp (disposable postgres)", () => {
  let fixture: JobsFixture;
  let store: SessionStore;

  beforeAll(async () => {
    fixture = await createJobsFixture(pgUrl!, { max: 4 });
    await migrate(fixture.client as unknown as Sql);
    store = createPostgresSessionStore(fixture.client as unknown as Sql);
  });

  afterAll(async () => fixture?.dispose());

  beforeEach(async () => {
    await fixture.client`delete from web_session_grace`;
    await fixture.client`delete from web_sessions`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.client`delete from web_session_grace`;
    await fixture.client`delete from web_sessions`;
  });

  describe.each(gates)("$name", (gate) => {
    it("RED: rotates the bearer on an authenticated GET (fresh token, Set-Cookie, grace planted)", async () => {
      const before = await sessionFor(store, gate.viewer, new Date(Date.now() + TTL_MS));
      const lineage = await store.statusHash(before.tokenHash);
      expect(lineage, "control: the seeded login owns its lineage").toBe(before.tokenHash);

      const response = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: before.cookie } }, env);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(gate.viewer.userId);

      const renewed = sessionCookies(response);
      expect(renewed, "an authenticated view must re-stamp with a session cookie").toHaveLength(1);
      const bearer = bearerOf(renewed[0]!);
      expect(
        bearer,
        "RED: the view must mint a fresh bearer, not re-sign the presented one",
      ).not.toBe(before.token);
      const successorHash = await hashToken(bearer);

      // The old row is deleted; the predecessor authenticates only via grace.
      expect(
        await sessionRow(fixture.client, before.tokenHash),
        "RED: rotation deletes the source row",
      ).toBeNull();
      expect(await store.get(before.tokenHash)).toEqual(gate.viewer);
      expect(await store.statusHash(before.tokenHash)).toBeNull();
      const planted = await graceRow(fixture.client, before.tokenHash);
      expect(planted, "RED: rotation plants an immediate-predecessor grace row").not.toBeNull();
      expect(planted!.successor_hash).toBe(successorHash);

      // The successor is live and keeps the lineage key: no fork, no new clock.
      expect(await store.get(successorHash)).toEqual(gate.viewer);
      expect(await store.statusHash(successorHash)).toBe(before.tokenHash);
      expect(await rowCounts(fixture.client)).toEqual({ sessions: 1, grace: 1 });
    });

    it("RED: advances the stored expiry to request time + TTL on the successor", async () => {
      const originalExpiry = new Date(Date.now() + 600_000);
      const before = await sessionFor(store, gate.viewer, originalExpiry);
      const requestedAt = Date.now();
      const response = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: before.cookie } }, env);
      expect(response.status).toBe(200);

      const renewed = sessionCookies(response);
      expect(renewed).toHaveLength(1);
      const bearer = bearerOf(renewed[0]!);
      expect(bearer, "RED: the view must mint a fresh bearer").not.toBe(before.token);
      const successor = await sessionRow(fixture.client, await hashToken(bearer));
      expect(successor, "RED: the successor row must exist").not.toBeNull();
      expect(
        successor!.expires_at.getTime(),
        "the fresh window must advance past the original expiry",
      ).toBeGreaterThan(originalExpiry.getTime());
      expect(
        Math.abs(successor!.expires_at.getTime() - (requestedAt + TTL_MS)),
        "the fresh window must span request time + TTL",
      ).toBeLessThan(SKEW_MS);
    });

    it("RED: a view sequence re-stamps every hop and extends past the original expiry", async () => {
      const originalExpiry = new Date(Date.now() + 120_000);
      const first = await sessionFor(store, gate.viewer, originalExpiry);
      const seen = [first.tokenHash];

      const hop1 = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: first.cookie } }, env);
      expect(hop1.status).toBe(200);
      const jar1 = mergeCookies(first.cookie, hop1);
      const second = bearerOf(jar1);
      expect(second, "RED: hop one must mint a fresh bearer").not.toBe(first.token);
      seen.push(await hashToken(second));

      const hop2 = await gate.app(store).request(gate.path, { headers: { cookie: jar1 } }, env);
      expect(hop2.status).toBe(200);
      const jar2 = mergeCookies(jar1, hop2);
      const third = bearerOf(jar2);
      expect(third, "RED: hop two must mint a fresh bearer").not.toBe(second);
      expect(third).not.toBe(first.token);
      seen.push(await hashToken(third));

      const latest = await sessionRow(fixture.client, seen[2]!);
      expect(latest, "RED: the latest successor must exist").not.toBeNull();
      expect(
        latest!.expires_at.getTime() - originalExpiry.getTime(),
        "the sequence must extend the window by about a full TTL past the original expiry",
      ).toBeGreaterThan(TTL_MS - 300_000);

      // One live row, one immediate grace: hop two pruned the grandparent.
      expect(await rowCounts(fixture.client)).toEqual({ sessions: 1, grace: 1 });
      expect(await store.get(seen[2]!)).toEqual(gate.viewer);
      expect(await store.get(seen[1]!), "the immediate predecessor stays grace-valid").toEqual(
        gate.viewer,
      );
      expect(await store.get(seen[0]!), "the grandparent is pruned on the next win").toBeNull();
      expect(await store.statusHash(seen[2]!)).toBe(seen[0]!);
    });

    it("RED: rotates through store.rotate, never store.renew, on the happy path", async () => {
      const rotate = vi.spyOn(store, "rotate");
      const renew = vi.spyOn(store, "renew");
      const before = await sessionFor(store, gate.viewer, new Date(Date.now() + TTL_MS));
      const requestedAt = Date.now();
      const response = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: before.cookie } }, env);
      expect(response.status).toBe(200);

      expect(renew, "RED: the re-stamp must rotate, not renew").not.toHaveBeenCalled();
      expect(rotate, "RED: the gate must call store.rotate once").toHaveBeenCalledTimes(1);
      const [source, replacement] = rotate.mock.calls[0]!;
      expect(source).toBe(before.tokenHash);
      expect(replacement.tokenHash).not.toBe(before.tokenHash);
      expect({ ...replacement, tokenHash: "", expiresAt: new Date(0) }).toMatchObject({
        userId: gate.viewer.userId,
        username: gate.viewer.username,
        avatar: gate.viewer.avatar,
        member: gate.viewer.member,
        moderator: gate.viewer.moderator,
      });
      expect(
        Math.abs(replacement.expiresAt.getTime() - (requestedAt + TTL_MS)),
        "the replacement must carry a fresh request-time + TTL window",
      ).toBeLessThan(SKEW_MS);
    });

    it("RED: a near-cap rotation preserves the lineage start (the successor dies with the lineage)", async () => {
      const before = await sessionFor(store, gate.viewer, new Date(Date.now() + TTL_MS));
      await fixture.client`update web_sessions
        set created_at = ${new Date(Date.now() - CAP_MS + 600_000)}
        where token_hash = ${before.tokenHash}`;
      const source = await sessionRow(fixture.client, before.tokenHash);
      expect(source).not.toBeNull();

      const response = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: before.cookie } }, env);
      expect(response.status).toBe(200);
      const renewed = sessionCookies(response);
      expect(renewed).toHaveLength(1);
      const bearer = bearerOf(renewed[0]!);
      expect(bearer, "RED: a young lineage must still rotate").not.toBe(before.token);
      const successor = await sessionRow(fixture.client, await hashToken(bearer));
      expect(successor, "RED: the successor row must exist").not.toBeNull();
      expect(
        successor!.created_at.getTime(),
        "rotation must inherit the lineage start, never restart the absolute clock",
      ).toBe(source!.created_at.getTime());
      expect(await store.get(await hashToken(bearer))).toEqual(gate.viewer);
    });

    it("RED: predecessor grace reads authenticate without Set-Cookie and without extension", async () => {
      const before = await sessionFor(store, gate.viewer, new Date(Date.now() + TTL_MS));
      const rotated = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: before.cookie } }, env);
      expect(rotated.status).toBe(200);
      const fresh = sessionCookies(rotated);
      expect(fresh).toHaveLength(1);
      expect(bearerOf(fresh[0]!), "RED: the view must rotate before grace exists").not.toBe(
        before.token,
      );
      const successorHash = await hashToken(bearerOf(fresh[0]!));
      const graceBefore = await graceRow(fixture.client, before.tokenHash);
      const successorBefore = await sessionRow(fixture.client, successorHash);
      expect(graceBefore).not.toBeNull();
      expect(successorBefore).not.toBeNull();

      for (const n of [1, 2]) {
        const graceRead = await gate
          .app(store)
          .request(gate.path, { headers: { cookie: before.cookie } }, env);
        expect(graceRead.status, `grace read ${n} serves`).toBe(200);
        expect(await graceRead.text()).toContain(gate.viewer.userId);
        expect(sessionCookies(graceRead), `grace read ${n} sets no cookie`).toHaveLength(0);
      }

      const graceAfter = await graceRow(fixture.client, before.tokenHash);
      const successorAfter = await sessionRow(fixture.client, successorHash);
      expect(
        graceAfter!.grace_expires_at.getTime(),
        "grace reads must not slide the fixed deadline",
      ).toBe(graceBefore!.grace_expires_at.getTime());
      expect(
        successorAfter!.expires_at.getTime(),
        "grace reads must not renew the live successor",
      ).toBe(successorBefore!.expires_at.getTime());
      expect(await rowCounts(fixture.client), "grace reads mint no siblings").toEqual({
        sessions: 1,
        grace: 1,
      });

      // Past the fixed deadline the predecessor bounces while the successor lives.
      await fixture.client`update web_session_grace
        set grace_expires_at = clock_timestamp() - interval '1 second'
        where predecessor_hash = ${before.tokenHash}`;
      const refused = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: before.cookie } }, env);
      expect(refused.status).toBe(302);
      expect(refused.headers.get("location")).toBe("/auth/discord");
      expect(sessionCookies(refused)).toHaveLength(0);
      const live = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: mergeCookies(before.cookie, rotated) } }, env);
      expect(live.status).toBe(200);
    });

    it("RED: the planted grace row is bounded by the predecessor's original expiry", async () => {
      const originalExpiry = new Date(Date.now() + 600_000);
      const before = await sessionFor(store, gate.viewer, originalExpiry);
      const response = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: before.cookie } }, env);
      expect(response.status).toBe(200);
      expect(sessionCookies(response)).toHaveLength(1);
      const planted = await graceRow(fixture.client, before.tokenHash);
      expect(planted, "RED: rotation must plant a grace row").not.toBeNull();
      expect(
        planted!.expires_at.getTime(),
        "grace must carry the predecessor's original expiry as its bound",
      ).toBe(originalExpiry.getTime());
    });

    it("CONTROL: a past-cap lineage bounces without cookies or writes", async () => {
      const before = await sessionFor(store, gate.viewer, new Date(Date.now() + TTL_MS));
      await fixture.client`update web_sessions
        set created_at = ${new Date(Date.now() - CAP_MS - PG_MARGIN_MS)}
        where token_hash = ${before.tokenHash}`;
      expect(await store.get(before.tokenHash), "control: the seed reads dead").toBeNull();

      const response = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: before.cookie } }, env);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/auth/discord");
      expect(await response.text()).not.toContain(gate.viewer.userId);
      expect(sessionCookies(response)).toHaveLength(0);
      expect(await rowCounts(fixture.client), "no rotation, no revival, no grace").toEqual({
        sessions: 1,
        grace: 0,
      });
    });

    it("CONTROL: an anonymous read bounces without cookies or writes", async () => {
      const response = await gate.app(store).request(gate.path, {}, env);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/auth/discord");
      expect(sessionCookies(response)).toHaveLength(0);
      expect(await rowCounts(fixture.client)).toEqual({ sessions: 0, grace: 0 });
    });

    it("CONTROL: malformed and tampered bearers bounce without cookies or writes", async () => {
      const malformed = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: `${SESSION_COOKIE}=not-a-valid-token` } }, env);
      expect(malformed.status).toBe(302);
      expect(sessionCookies(malformed)).toHaveLength(0);

      const forged = await serializeSigned(SESSION_COOKIE, newSessionToken(), "wrong-secret", {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });
      const tampered = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: forged.split(";")[0]! } }, env);
      expect(tampered.status).toBe(302);
      expect(sessionCookies(tampered)).toHaveLength(0);
      expect(await rowCounts(fixture.client)).toEqual({ sessions: 0, grace: 0 });
    });

    it("CONTROL: a signed-in viewer the gate refuses gets 403 without cookies, writes or expiry change", async () => {
      const originalExpiry = new Date(Date.now() + TTL_MS);
      const refused = await sessionFor(store, gate.refused, originalExpiry);
      const response = await gate
        .app(store)
        .request(gate.path, { headers: { cookie: refused.cookie } }, env);
      expect(response.status).toBe(403);
      expect(sessionCookies(response)).toHaveLength(0);
      expect(await rowCounts(fixture.client)).toEqual({ sessions: 1, grace: 0 });
      const row = await sessionRow(fixture.client, refused.tokenHash);
      expect(row!.expires_at.getTime(), "a refused read must not touch the window").toBe(
        originalExpiry.getTime(),
      );
    });

    it("CONTROL: POST never rotates (writes keep current semantics)", async () => {
      const originalExpiry = new Date(Date.now() + TTL_MS);
      const before = await sessionFor(store, gate.viewer, originalExpiry);
      const response = await gate
        .app(store)
        .request(gate.path, { method: "POST", headers: { cookie: before.cookie } }, env);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(gate.viewer.userId);
      expect(sessionCookies(response)).toHaveLength(0);
      expect(await rowCounts(fixture.client)).toEqual({ sessions: 1, grace: 0 });
      const row = await sessionRow(fixture.client, before.tokenHash);
      expect(row!.expires_at.getTime(), "a write must not touch the window").toBe(
        originalExpiry.getTime(),
      );
    });

    it("CONTROL: logout mid-sequence ends acceptance for every bearer immediately", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const first = await sessionFor(store, gate.viewer, new Date(Date.now() + TTL_MS));
      const seen = new Set([first.tokenHash]);
      let jar = first.cookie;
      for (let hop = 0; hop < 2; hop++) {
        const view = await gate.app(store).request(gate.path, { headers: { cookie: jar } }, env);
        expect(view.status).toBe(200);
        jar = mergeCookies(jar, view);
        seen.add(await hashToken(bearerOf(jar)));
      }

      const logout = await app.request(
        "/logout",
        { method: "POST", headers: { cookie: jar, origin: APP_URL } },
        envWith(store),
      );
      expect(logout.status).toBe(303);
      expect(logout.headers.get("location")).toBe("/");
      const cleared = logout.headers
        .getSetCookie()
        .filter((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
      expect(cleared, "logout must clear the session cookie").toHaveLength(1);
      expect(cleared[0]).toMatch(/Max-Age=0/i);

      for (const hash of seen) {
        expect(await store.get(hash), "every sequence bearer must read dead").toBeNull();
        expect(await store.statusHash(hash)).toBeNull();
      }
      // Revocation is a soft delete: the row remains with revoked_at set, but
      // no live row and no grace row may survive.
      const [live] = await fixture.client<
        { n: number }[]
      >`select count(*)::int as n from web_sessions where revoked_at is null`;
      expect(live!.n, "no live session row may survive logout").toBe(0);
      expect((await rowCounts(fixture.client)).grace, "no grace row may survive logout").toBe(0);
      const after = await gate.app(store).request(gate.path, { headers: { cookie: jar } }, env);
      expect(after.status).toBe(302);
      expect(after.headers.get("location")).toBe("/auth/discord");
      expect(sessionCookies(after)).toHaveLength(0);
    });
  });

  describe("Kit bridge stays non-rotating", () => {
    const requestWith = (cookie: string) =>
      new Request("https://app.example.test/events/past", { headers: { cookie } });

    it("CONTROL: the bridge authenticates a live bearer with zero session writes", async () => {
      const live = await sessionFor(store, MEMBER, new Date(Date.now() + TTL_MS));
      const renew = vi.spyOn(store, "renew");
      const rotate = vi.spyOn(store, "rotate");
      const replace = vi.spyOn(store, "replace");
      const create = vi.spyOn(store, "create");

      const decision = await resolveRequestSession(requestWith(live.cookie), {
        sessionSecret: SECRET,
        store,
      });
      expect(decision.status).toBe("authenticated");
      expect(decision.session).toMatchObject({ userId: MEMBER.userId });
      expect(renew).not.toHaveBeenCalled();
      expect(rotate).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(await rowCounts(fixture.client)).toEqual({ sessions: 1, grace: 0 });
    });

    it("CONTROL: the bridge authenticates both rotated tabs with zero session writes", async () => {
      const before = await sessionFor(store, MEMBER, new Date(Date.now() + TTL_MS));
      const replacement = newSessionToken();
      const successorHash = await hashToken(replacement);
      expect(
        await store.rotate(before.tokenHash, {
          ...MEMBER,
          tokenHash: successorHash,
          expiresAt: new Date(Date.now() + TTL_MS),
        }),
        "control: the store plants predecessor grace",
      ).toBe(true);
      const successorCookie = (
        await serializeSigned(SESSION_COOKIE, replacement, SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      const renew = vi.spyOn(store, "renew");
      const rotate = vi.spyOn(store, "rotate");
      const replace = vi.spyOn(store, "replace");
      const create = vi.spyOn(store, "create");

      // Either tab's read is pure: no rotation, no renewal, no Set-Cookie by
      // construction (the bridge returns a decision, never a cookie).
      for (const cookie of [before.cookie, successorCookie]) {
        const decision = await resolveRequestSession(requestWith(cookie), {
          sessionSecret: SECRET,
          store,
        });
        expect(decision.status).toBe("authenticated");
        expect(decision.session).toMatchObject({ userId: MEMBER.userId });
      }
      expect(renew).not.toHaveBeenCalled();
      expect(rotate).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(await rowCounts(fixture.client)).toEqual({ sessions: 1, grace: 1 });
    });
  });
});
