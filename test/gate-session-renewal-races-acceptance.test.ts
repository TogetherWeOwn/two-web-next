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
  DISCORD_BOT_TOKEN: "bot-token",
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
  it("keeps a request admitted before expiry alive while rendering crosses the original expiry", async () => {
    // Only Date moves: the member-read boundary keeps its real deadline timers.
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
    const store = createMemorySessionStore(() => Date.now());
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
    expect.soft(sessionCookies(response)).toHaveLength(1);
    expect.soft(sessionCookies(response)[0]?.split(";")[0] === cookie).toBe(true);
    expect.soft(sessionCookies(response)[0] ?? "").toMatch(/(?:^|;\s*)Max-Age=7200(?:;|$)/);
    expect.soft(await store.get(tokenHash), "renewed row survives original expiry").not.toBeNull();
    vi.setSystemTime(requestTime + TTL_MS - 1);
    expect
      .soft(await store.get(tokenHash), "renewed row lives until request-time + TTL")
      .not.toBeNull();
    vi.setSystemTime(requestTime + TTL_MS);
    expect(await store.get(tokenHash)).toBeNull();
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
    expect.soft(response.headers.get("cache-control")).toMatch(/(?:^|,\s*)no-store(?:,|$)/);
  });

  it("does not attach the old bearer after renewal succeeds and rotates it before returning true", async () => {
    const realStore = createMemorySessionStore();
    const { cookie, tokenHash } = await sessionFor(realStore, gate.viewer);
    const replacementHash = await hashToken(newSessionToken());
    let renewed = false;
    let rotated = false;
    let renewCalls = 0;
    const store: SessionStore = {
      ...realStore,
      renew: async (hash, expiresAt) => {
        renewCalls++;
        renewed = await realStore.renew(hash, expiresAt);
        if (renewed) {
          rotated = await realStore.rotate(hash, {
            ...gate.viewer,
            tokenHash: replacementHash,
            expiresAt,
          });
        }
        return renewed;
      },
    };
    const renders: string[] = [];
    const marker = `protected-${gate.name}-renew-then-rotate`;
    const app = protectedApp(gate, store, async (viewerId) => {
      renders.push(viewerId);
      return `<p>${marker}:${viewerId}</p>`;
    });

    const response = await app.request(gate.path, { headers: { cookie } }, env);

    expect(renewCalls).toBe(1);
    expect(renewed).toBe(true);
    expect(rotated).toBe(true);
    expect(renders).toEqual([gate.viewer.userId]);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`${marker}:${gate.viewer.userId}`);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(response.headers.get("location")).toBeNull();
    expect(await realStore.get(tokenHash)).toBeNull();
    expect(await realStore.get(replacementHash)).toMatchObject(gate.viewer);
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
