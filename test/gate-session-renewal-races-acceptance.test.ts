import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminGuard, type AccessDecl, type Actor } from "../src/admin/guard";
import type { Env } from "../src/env";
import { bufferedMemberHtml } from "../src/member-reads";
import { registerGate } from "../src/profiles/routes-gate";
import type { ProfileApp } from "../src/profiles/routes-shared";
import { profileStores } from "../src/profiles/routes-stores";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type DbSessionRow,
  type SessionStore,
} from "../src/sessions";

// Acceptance-owned: exercise the real gates, signed cookies and memory store.
const COOKIE_NAME = "__Host-two_session";
const TTL_MS = 7_200_000;
const env: Env = {
  APP_URL: "https://app.example.test",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  // No bot token: renewal races exercise the gates hermetically, and the
  // mid-session role recheck treats a missing token as incomplete config
  // (no Discord lookup, stored bits stand).
  DISCORD_BOT_TOKEN: "",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
};
const MEMBER: DbSessionRow = {
  userId: "100000000000000001",
  username: "renewal-race-member",
  avatar: null,
  member: true,
  moderator: false,
};
const MODERATOR: DbSessionRow = { ...MEMBER, userId: "100000000000000002", moderator: true };
const GATES = [
  { name: "profile", path: "/profile", viewer: MEMBER },
  { name: "admin", path: "/admin", viewer: MODERATOR },
] as const;
type Gate = (typeof GATES)[number];

async function sessionFor(store: SessionStore, viewer: DbSessionRow) {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await store.create({ ...viewer, tokenHash, expiresAt: new Date(Date.now() + TTL_MS) });
  const signed = await serializeSigned(COOKIE_NAME, token, env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 7200,
  });
  return { tokenHash, cookie: signed.split(";")[0]! };
}

function sessionCookies(response: Response) {
  return response.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
}

// Identity-only handlers mirror session-cookie-renewal-response: no member-data query or audit DB.
function protectedApp(
  gate: Gate,
  store: SessionStore,
  render: (viewerId: string) => Promise<string>,
) {
  if (gate.name === "profile") {
    const app: ProfileApp = new Hono();
    const deps = { sessionStore: store, accessLog: async () => true };
    registerGate(app, deps, profileStores(deps));
    app.get("/profile", async (c) => bufferedMemberHtml(c, await render(c.get("viewer").id)));
    return app;
  }
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminActor: Actor; access: AccessDecl };
  }>();
  app.use("/*", adminGuard({ sessionStore: store }));
  app.get("/admin", async (c) => {
    c.set("access", { resource: "events", action: "view", route: "test.session-renewal-races" });
    return bufferedMemberHtml(c, await render(c.get("adminActor").id));
  });
  return app;
}

const START = Date.parse("2026-10-20T12:00:00.000Z");
const GRACE_MS = 10_000;

async function rotatedSession(viewer: DbSessionRow, rotateAfter = 60_000) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  const store = createMemorySessionStore(() => Date.now());
  const predecessor = await sessionFor(store, viewer);
  const token = newSessionToken();
  const successorHash = await hashToken(token);
  const rotationTime = START + rotateAfter;
  const successorExpiry = rotationTime + TTL_MS;
  vi.setSystemTime(rotationTime);
  expect(
    await store.rotate(predecessor.tokenHash, {
      ...viewer,
      tokenHash: successorHash,
      expiresAt: new Date(successorExpiry),
    }),
  ).toBe(true);
  const signed = await serializeSigned(COOKIE_NAME, token, env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 7200,
  });
  expect(await store.statusHash(predecessor.tokenHash)).toBeNull();
  expect(await store.get(predecessor.tokenHash)).toEqual(viewer);
  expect(await store.statusHash(successorHash)).toBe(predecessor.tokenHash);
  return {
    store,
    predecessor,
    successor: { tokenHash: successorHash, cookie: signed.split(";")[0]! },
    rotationTime,
    successorExpiry,
  };
}

const externalFetch = vi.fn(async () => {
  throw new Error("Unexpected external fetch in hermetic session acceptance");
});
beforeEach(() => {
  externalFetch.mockClear();
  vi.stubGlobal("fetch", externalFetch);
});
afterEach(() => {
  try {
    expect(externalFetch).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe.each(GATES)("$name gate session renewal races", (gate) => {
  it.each([
    { bound: "fixed grace deadline", rotateAfter: 60_000, window: GRACE_MS },
    { bound: "predecessor original expiry", rotateAfter: TTL_MS - 5000, window: 5000 },
  ])(
    "admits an entry-time predecessor without writes or extending its $bound",
    async ({ rotateAfter, window }) => {
      const { store, predecessor, successor, rotationTime, successorExpiry } = await rotatedSession(
        gate.viewer,
        rotateAfter,
      );
      const writes = ["renew", "rotate", "replace", "create"] as const;
      const spies = writes.map((method) => vi.spyOn(store, method));
      const renders: string[] = [];
      const marker = `protected-${gate.name}-entry-grace`;
      const app = protectedApp(gate, store, async (id) => {
        renders.push(id);
        return `<p>${marker}:${id}</p>`;
      });

      // A second read just before the ORIGINAL bound detects sliding grace.
      for (const elapsed of [1000, window - 1]) {
        vi.setSystemTime(rotationTime + elapsed);
        expect(await store.statusHash(predecessor.tokenHash)).toBeNull();
        expect(await store.get(predecessor.tokenHash)).toEqual(gate.viewer);
        const response = await app.request(
          gate.path,
          { headers: { cookie: predecessor.cookie } },
          env,
        );
        const body = await response.text();
        expect.soft(response.status).toBe(200);
        expect.soft(body).toContain(`${marker}:${gate.viewer.userId}`);
        expect.soft(response.headers.get("location")).toBeNull();
        expect.soft(response.headers.getSetCookie()).toHaveLength(0);
        expect
          .soft(response.headers.get("cache-control") ?? "")
          .toMatch(/(?:^|,\s*)no-store(?:,|$)/);
      }
      expect.soft(renders).toEqual([gate.viewer.userId, gate.viewer.userId]);
      for (const spy of spies) expect.soft(spy).not.toHaveBeenCalled();

      vi.setSystemTime(rotationTime + window);
      expect.soft(await store.get(predecessor.tokenHash), "original bound is exclusive").toBeNull();
      const refused = await app.request(
        gate.path,
        { headers: { cookie: predecessor.cookie } },
        env,
      );
      expect.soft(refused.status).toBe(302);
      expect.soft(refused.headers.get("location")).toBe("/auth/discord");
      expect.soft(await refused.text()).not.toContain(marker);
      expect.soft(sessionCookies(refused)).toHaveLength(0);
      expect.soft(renders).toEqual([gate.viewer.userId, gate.viewer.userId]);
      // A grace request must not renew the live successor on the old tab's behalf.
      vi.setSystemTime(successorExpiry - 1);
      expect.soft(await store.get(successor.tokenHash)).toEqual(gate.viewer);
      vi.setSystemTime(successorExpiry);
      expect(await store.get(successor.tokenHash)).toBeNull();
    },
  );

  it.each([
    { bound: "grace deadline", rotateAfter: 60_000, window: GRACE_MS },
    { bound: "original expiry", rotateAfter: TTL_MS - 5000, window: 5000 },
  ])(
    "refuses at the exact predecessor $bound without rendering",
    async ({ rotateAfter, window }) => {
      const { store, predecessor, successor, rotationTime } = await rotatedSession(
        gate.viewer,
        rotateAfter,
      );
      vi.setSystemTime(rotationTime + window - 1);
      expect(await store.get(predecessor.tokenHash)).toEqual(gate.viewer);
      vi.setSystemTime(rotationTime + window);
      const renew = vi.spyOn(store, "renew");
      const renders: string[] = [];
      const marker = `protected-${gate.name}-exact-bound`;
      const app = protectedApp(gate, store, async (id) => {
        renders.push(id);
        return `<p>${marker}:${id}</p>`;
      });

      const response = await app.request(
        gate.path,
        { headers: { cookie: predecessor.cookie } },
        env,
      );
      const body = await response.text();

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/auth/discord");
      expect(body).not.toContain(marker);
      expect(body).not.toContain(gate.viewer.userId);
      expect(renders).toEqual([]);
      expect(renew).not.toHaveBeenCalled();
      expect(sessionCookies(response)).toHaveLength(0);
      expect(await store.get(predecessor.tokenHash)).toBeNull();
      expect(await store.get(successor.tokenHash)).toEqual(gate.viewer);
    },
  );

  it("refuses entry-time grace immediately after successor revocation without rendering", async () => {
    const { store, predecessor, successor, rotationTime } = await rotatedSession(gate.viewer);
    vi.setSystemTime(rotationTime + 1000);
    await store.revoke(successor.tokenHash);
    const renew = vi.spyOn(store, "renew");
    const renders: string[] = [];
    const marker = `protected-${gate.name}-revoked-successor`;
    const app = protectedApp(gate, store, async (id) => {
      renders.push(id);
      return `<p>${marker}:${id}</p>`;
    });

    const response = await app.request(gate.path, { headers: { cookie: predecessor.cookie } }, env);
    const body = await response.text();

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/discord");
    expect(body).not.toContain(marker);
    expect(body).not.toContain(gate.viewer.userId);
    expect(renders).toEqual([]);
    expect(renew).not.toHaveBeenCalled();
    expect(sessionCookies(response)).toHaveLength(0);
    expect(await store.get(predecessor.tokenHash)).toBeNull();
    expect(await store.get(successor.tokenHash)).toBeNull();
  });

  it("rotates a current successor normally, keeping its lineage", async () => {
    const { store, predecessor, successor, rotationTime, successorExpiry } = await rotatedSession(
      gate.viewer,
    );
    const requestTime = rotationTime + 1000;
    vi.setSystemTime(requestTime);
    const renew = vi.spyOn(store, "renew");
    const rotate = vi.spyOn(store, "rotate");
    const marker = `protected-${gate.name}-current-successor`;
    const app = protectedApp(gate, store, async (id) => `<p>${marker}:${id}</p>`);

    const response = await app.request(gate.path, { headers: { cookie: successor.cookie } }, env);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`${marker}:${gate.viewer.userId}`);
    expect(renew, "the re-stamp must rotate, not renew").not.toHaveBeenCalled();
    expect(rotate, "the view must rotate exactly once").toHaveBeenCalledTimes(1);
    const [source, replacement] = rotate.mock.calls[0]!;
    expect(source).toBe(successor.tokenHash);
    expect(replacement.tokenHash, "the replacement must be a fresh hash").not.toBe(
      successor.tokenHash,
    );
    expect(replacement.expiresAt).toEqual(new Date(requestTime + TTL_MS));
    const refreshed = sessionCookies(response);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.split(";")[0], "the view must mint a fresh bearer").not.toBe(
      successor.cookie,
    );
    expect(refreshed[0]).toMatch(/(?:^|;\s*)Max-Age=7200(?:;|$)/);
    expect(refreshed[0]).toContain("HttpOnly");
    expect(refreshed[0]).toContain("Secure");
    expect(refreshed[0]).toContain("SameSite=Lax");
    // The lineage key survives the second rotation; the first successor is
    // now grace, and the grandparent is pruned.
    expect(await store.statusHash(replacement.tokenHash)).toBe(predecessor.tokenHash);
    expect(await store.get(successor.tokenHash), "the rotated bearer stays grace-valid").toEqual(
      gate.viewer,
    );
    expect(await store.get(predecessor.tokenHash), "the grandparent is pruned").toBeNull();
    vi.setSystemTime(successorExpiry);
    expect(
      await store.get(replacement.tokenHash),
      "the fresh window outlives the old expiry",
    ).toEqual(gate.viewer);
    vi.setSystemTime(requestTime + TTL_MS - 1);
    expect(await store.get(replacement.tokenHash)).toEqual(gate.viewer);
    vi.setSystemTime(requestTime + TTL_MS);
    expect(await store.get(replacement.tokenHash)).toBeNull();
  });

  it("still refuses a current bearer whose rotation loses a revocation race", async () => {
    const realStore = createMemorySessionStore();
    const { cookie, tokenHash } = await sessionFor(realStore, gate.viewer);
    expect(await realStore.statusHash(tokenHash)).not.toBeNull();
    const rotate = vi.fn<SessionStore["rotate"]>(async (hash, replacement) => {
      await realStore.revoke(hash);
      return realStore.rotate(hash, replacement);
    });
    const store: SessionStore = { ...realStore, rotate };
    const renew = vi.spyOn(store, "renew");
    const renders: string[] = [];
    const marker = `protected-${gate.name}-false-rotate`;
    const app = protectedApp(gate, store, async (id) => {
      renders.push(id);
      return `<p>${marker}:${id}</p>`;
    });

    const response = await app.request(gate.path, { headers: { cookie } }, env);
    const body = await response.text();

    expect(rotate).toHaveBeenCalledTimes(1);
    expect(await rotate.mock.results[0]!.value).toBe(false);
    expect(renew, "a lost rotation must not fall back to renewal").not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/discord");
    expect(renders).toEqual([]);
    expect(body).not.toContain(marker);
    expect(body).not.toContain(gate.viewer.userId);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(await realStore.get(tokenHash)).toBeNull();
    expect(await realStore.statusHash(tokenHash)).toBeNull();
  });

  it.each([
    { bound: "fixed grace deadline", requestAfter: 60_000, window: GRACE_MS },
    { bound: "original expiry", requestAfter: TTL_MS - 5000, window: 5000 },
  ])(
    "preserves grace when a concurrent rotation wins before the view without extending its $bound",
    async ({ requestAfter, window }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START);
      const realStore = createMemorySessionStore(() => Date.now());
      const { cookie, tokenHash: oldHash } = await sessionFor(realStore, gate.viewer);
      const originalExpiry = START + TTL_MS;
      expect(await realStore.statusHash(oldHash)).toBe(oldHash);
      expect(await realStore.get(oldHash)).toEqual(gate.viewer);

      const requestTime = START + requestAfter;
      vi.setSystemTime(requestTime);
      const concurrentHash = await hashToken(newSessionToken());
      const concurrentExpiry = requestTime + TTL_MS;
      let concurrentWon = false;
      let rotateResult: boolean | null = null;
      const rotate = vi.fn<SessionStore["rotate"]>(async (hash, replacement) => {
        // Another tab wins first; the view's own rotation then loses.
        concurrentWon = await realStore.rotate(oldHash, {
          ...gate.viewer,
          tokenHash: concurrentHash,
          expiresAt: new Date(concurrentExpiry),
        });
        rotateResult = await realStore.rotate(hash, replacement);
        return rotateResult;
      });
      const store: SessionStore = { ...realStore, rotate };
      const renew = vi.spyOn(store, "renew");
      const replaceSpy = vi.spyOn(store, "replace");
      const createSpy = vi.spyOn(store, "create");

      const renders: string[] = [];
      const marker = `protected-${gate.name}-rotation-before-rotate`;
      const app = protectedApp(gate, store, async (id) => {
        renders.push(id);
        return `<p>${marker}:${id}</p>`;
      });

      const response = await app.request(gate.path, { headers: { cookie } }, env);
      const body = await response.text();

      expect(rotate).toHaveBeenCalledTimes(1);
      const [source, replacement] = rotate.mock.calls[0]!;
      expect(source).toBe(oldHash);
      expect(replacement.expiresAt).toEqual(new Date(requestTime + TTL_MS));
      expect(concurrentWon).toBe(true);
      expect(rotateResult).toBe(false);
      expect(await rotate.mock.results[0]!.value).toBe(false);

      expect(response.status).toBe(200);
      expect(body).toContain(`${marker}:${gate.viewer.userId}`);
      expect(renders).toEqual([gate.viewer.userId]);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.getSetCookie()).toHaveLength(0);
      expect(sessionCookies(response)).toHaveLength(0);
      expect(response.headers.get("cache-control") ?? "").toMatch(/private/);
      expect(response.headers.get("cache-control") ?? "").toMatch(/(?:^|,\s*)no-store(?:,|$)/);

      expect(renew, "a lost rotation must not fall back to renewal").not.toHaveBeenCalled();
      expect(replaceSpy).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();

      expect(await realStore.statusHash(oldHash)).toBeNull();
      expect(await realStore.get(oldHash)).toEqual(gate.viewer);
      expect(await realStore.statusHash(concurrentHash)).toBe(oldHash);
      expect(await realStore.get(concurrentHash)).toEqual(gate.viewer);

      // A second grace read just before the ORIGINAL bound detects sliding grace.
      vi.setSystemTime(requestTime + window - 1);
      expect(await realStore.get(oldHash)).toEqual(gate.viewer);
      const second = await app.request(gate.path, { headers: { cookie } }, env);
      const secondBody = await second.text();
      expect(second.status).toBe(200);
      expect(secondBody).toContain(`${marker}:${gate.viewer.userId}`);
      expect(renders).toEqual([gate.viewer.userId, gate.viewer.userId]);
      expect(second.headers.get("location")).toBeNull();
      expect(second.headers.getSetCookie()).toHaveLength(0);
      expect(rotate).toHaveBeenCalledTimes(1);

      vi.setSystemTime(requestTime + window);
      expect(await realStore.get(oldHash), "original bound is exclusive").toBeNull();
      const refused = await app.request(gate.path, { headers: { cookie } }, env);
      expect(refused.status).toBe(302);
      expect(refused.headers.get("location")).toBe("/auth/discord");
      expect(await refused.text()).not.toContain(marker);
      expect(sessionCookies(refused)).toHaveLength(0);
      expect(renders).toEqual([gate.viewer.userId, gate.viewer.userId]);
      expect(rotate).toHaveBeenCalledTimes(1);

      // The losing view must not extend the winner's lineage.
      expect(originalExpiry).toBe(START + TTL_MS);
      vi.setSystemTime(concurrentExpiry - 1);
      expect(await realStore.get(concurrentHash)).toEqual(gate.viewer);
      vi.setSystemTime(concurrentExpiry);
      expect(await realStore.get(concurrentHash)).toBeNull();
    },
  );

  it("returns 503 without contents when the rotation fallback re-read fails", async () => {
    const realStore = createMemorySessionStore();
    const { cookie, tokenHash: oldHash } = await sessionFor(realStore, gate.viewer);
    expect(await realStore.statusHash(oldHash)).not.toBeNull();
    const concurrentHash = await hashToken(newSessionToken());
    const detail = `private-${gate.name}-rotation-fallback-error`;
    let getCalls = 0;
    let rotateCalls = 0;
    let concurrentWon = false;
    const store: SessionStore = {
      ...realStore,
      get: async (hash) => {
        getCalls++;
        if (getCalls === 1) return realStore.get(hash);
        throw new Error(detail);
      },
      rotate: async (hash, replacement) => {
        rotateCalls++;
        concurrentWon = await realStore.rotate(oldHash, {
          ...gate.viewer,
          tokenHash: concurrentHash,
          expiresAt: replacement.expiresAt,
        });
        return realStore.rotate(hash, replacement);
      },
    };
    const renders: string[] = [];
    const marker = `protected-${gate.name}-rotation-fallback-error`;
    const app = protectedApp(gate, store, async (id) => {
      renders.push(id);
      return `<p>${marker}:${id}</p>`;
    });

    const response = await app.request(gate.path, { headers: { cookie } }, env);
    const body = await response.text();

    expect(rotateCalls).toBe(1);
    expect(concurrentWon).toBe(true);
    expect(getCalls).toBe(2);
    expect(renders).toEqual([]);
    expect(response.status).toBe(503);
    expect(body).not.toContain(marker);
    expect(body).not.toContain(gate.viewer.userId);
    expect(body).not.toContain(detail);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(response.headers.get("cache-control") ?? "").toMatch(/private/);
    expect(response.headers.get("cache-control") ?? "").toMatch(/(?:^|,\s*)no-store(?:,|$)/);
  });

  it("discards private HTML when strict post-handler status fails despite permissive get succeeding", async () => {
    const realStore = createMemorySessionStore();
    const { cookie, tokenHash } = await sessionFor(realStore, gate.viewer);
    let renderedHtml = "";
    let strictPostReads = 0;
    const marker = `protected-${gate.name}-strict-revalidation`;
    const detail = `private-${gate.name}-strict-status-error`;
    const store: SessionStore = {
      ...realStore,
      statusHash: async (hash) => {
        if (renderedHtml) {
          strictPostReads++;
          throw new Error(detail);
        }
        return realStore.statusHash(hash);
      },
    };
    const app = protectedApp(gate, store, async (id) => {
      renderedHtml = `<p>${marker}:${id}</p>`;
      return renderedHtml;
    });

    const response = await app.request(gate.path, { headers: { cookie } }, env);
    const body = await response.text();

    expect(renderedHtml).toContain(`${marker}:${gate.viewer.userId}`);
    expect(await store.get(tokenHash), "get remains permissive and healthy").toEqual(gate.viewer);
    expect.soft(strictPostReads).toBe(1);
    expect.soft(response.status).toBe(503);
    expect.soft(body).not.toContain(marker);
    expect.soft(body).not.toContain(gate.viewer.userId);
    expect.soft(body).not.toContain(detail);
    expect.soft(response.headers.getSetCookie()).toHaveLength(0);
    expect.soft(response.headers.get("location")).toBeNull();
    expect.soft(response.headers.get("cache-control") ?? "").toMatch(/(?:^|,\s*)no-store(?:,|$)/);
  });

  it("keeps a request admitted before expiry alive while rendering crosses the original expiry", async () => {
    // Only Date moves: the member-read boundary keeps its real deadline timers.
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
    const store = createMemorySessionStore(() => Date.now());
    const renew = vi.spyOn(store, "renew");
    const rotate = vi.spyOn(store, "rotate");
    const { cookie, tokenHash } = await sessionFor(store, gate.viewer);
    const originalExpiry = Date.now() + TTL_MS;
    const requestTime = originalExpiry - 1000;
    vi.setSystemTime(requestTime);
    const renders: string[] = [];
    const marker = `protected-${gate.name}-expiry-crossing`;
    const app = protectedApp(gate, store, async (viewerId) => {
      renders.push(viewerId);
      vi.setSystemTime(requestTime + 2000);
      return `<p>${marker}:${viewerId}</p>`;
    });

    const response = await app.request(gate.path, { headers: { cookie } }, env);

    expect(renders).toEqual([gate.viewer.userId]);
    expect(globalThis.setTimeout).toBe(realSetTimeout);
    expect(Date.now()).toBe(originalExpiry + 1000);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`${marker}:${gate.viewer.userId}`);
    expect(response.headers.get("location")).toBeNull();
    expect(renew, "the re-stamp must rotate, not renew").not.toHaveBeenCalled();
    expect(rotate, "the view must rotate exactly once").toHaveBeenCalledTimes(1);
    const [, replacement] = rotate.mock.calls[0]!;
    expect.soft(sessionCookies(response)).toHaveLength(1);
    expect.soft(sessionCookies(response)[0]?.split(";")[0] === cookie).toBe(false);
    expect.soft(sessionCookies(response)[0] ?? "").toMatch(/(?:^|;\s*)Max-Age=7200(?:;|$)/);
    expect
      .soft(await store.get(tokenHash), "the predecessor reads dead past its original expiry")
      .toBeNull();
    expect(await store.statusHash(tokenHash), "the predecessor keeps no status key").toBeNull();
    vi.setSystemTime(requestTime + TTL_MS - 1);
    expect
      .soft(await store.get(replacement.tokenHash), "fresh row lives until request-time + TTL")
      .not.toBeNull();
    vi.setSystemTime(requestTime + TTL_MS);
    expect(await store.get(replacement.tokenHash)).toBeNull();
  });

  it("discards rendered protected contents when post-handler session revalidation throws", async () => {
    const realStore = createMemorySessionStore();
    const { cookie } = await sessionFor(realStore, gate.viewer);
    const marker = `protected-${gate.name}-revalidation-contents`;
    const detail = `private-${gate.name}-revalidation-store-error`;
    const events: string[] = [];
    let renderedHtml = "";
    let getCalls = 0;
    const store: SessionStore = {
      ...realStore,
      get: async (hash) => {
        getCalls++;
        if (getCalls === 1) {
          const viewer = await realStore.get(hash);
          events.push(viewer ? "authenticated" : "not-authenticated");
          return viewer;
        }
        events.push("post-handler-get-threw");
        throw new Error(detail);
      },
    };
    const app = protectedApp(gate, store, async (viewerId) => {
      events.push("rendered");
      renderedHtml = `<p>${marker}:${viewerId}</p>`;
      return renderedHtml;
    });

    const response = await app.request(gate.path, { headers: { cookie } }, env);
    const body = await response.text();

    expect(events).toEqual(["authenticated", "rendered", "post-handler-get-threw"]);
    expect(getCalls).toBe(2);
    expect(renderedHtml).toContain(`${marker}:${gate.viewer.userId}`);
    expect.soft(response.status).toBe(503);
    expect.soft(body).not.toContain(marker);
    expect.soft(body).not.toContain(gate.viewer.userId);
    expect.soft(body).not.toContain(detail);
    expect.soft(sessionCookies(response)).toHaveLength(0);
    expect.soft(response.headers.get("location")).toBeNull();
    expect.soft(response.headers.get("cache-control") ?? "").toMatch(/(?:^|,\s*)no-store(?:,|$)/);
  });

  it("does not attach the fresh bearer after another tab rotates it mid-render", async () => {
    const realStore = createMemorySessionStore();
    const { cookie, tokenHash } = await sessionFor(realStore, gate.viewer);
    const rotations: string[] = [];
    const rawRotate = realStore.rotate.bind(realStore);
    const store: SessionStore = {
      ...realStore,
      rotate: async (oldHash, replacement) => {
        rotations.push(replacement.tokenHash);
        return rawRotate(oldHash, replacement);
      },
    };
    const renders: string[] = [];
    const marker = `protected-${gate.name}-rotate-then-rotate`;
    const app = protectedApp(gate, store, async (viewerId) => {
      renders.push(viewerId);
      // Another tab wins while this response renders: the post-handler
      // revalidation must drop the stale cookie instead of restoring a
      // superseded bearer.
      await store.rotate(rotations[0]!, {
        ...gate.viewer,
        tokenHash: await hashToken(newSessionToken()),
        expiresAt: new Date(Date.now() + TTL_MS),
      });
      return `<p>${marker}:${viewerId}</p>`;
    });

    const response = await app.request(gate.path, { headers: { cookie } }, env);

    expect(rotations, "the view and the other tab each rotate once").toHaveLength(2);
    const successorHash = rotations[0]!;
    expect(renders).toEqual([gate.viewer.userId]);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`${marker}:${gate.viewer.userId}`);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(response.headers.get("location")).toBeNull();
    expect(await realStore.statusHash(successorHash)).toBeNull();
    expect(await realStore.get(successorHash)).toMatchObject(gate.viewer);
    expect(await realStore.get(tokenHash), "the grandparent is pruned on the next win").toBeNull();
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(await realStore.get(rotations[1]!)).toMatchObject(gate.viewer);
  });

  it("does not execute protected reads for a refused viewer", async () => {
    const store = createMemorySessionStore();
    const refusedViewer = gate.name === "admin" ? MEMBER : { ...MEMBER, member: false };
    const { cookie } = await sessionFor(store, refusedViewer);
    let protectedReads = 0;
    const marker = `protected-${gate.name}-refused-read`;
    const app = protectedApp(gate, store, async (viewerId) => {
      protectedReads++;
      return `<p>${marker}:${viewerId}</p>`;
    });

    const response = await app.request(gate.path, { headers: { cookie } }, env);
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(protectedReads).toBe(0);
    expect(body).not.toContain(marker);
    expect(body).not.toContain(refusedViewer.userId);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(response.headers.get("cache-control")).toMatch(/(?:^|,\s*)no-store(?:,|$)/);
  });
});
