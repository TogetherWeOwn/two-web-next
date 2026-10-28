import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import { adminGuard, type AccessDecl, type Actor } from "../src/admin/guard";
import type { Env } from "../src/env";
import { bufferedMemberHtml } from "../src/member-reads";
import { profileStores } from "../src/profiles/routes-stores";
import { registerGate } from "../src/profiles/routes-gate";
import type { ProfileApp } from "../src/profiles/routes-shared";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
  type DbSessionRow,
  type SessionStore,
} from "../src/sessions";

const COOKIE_NAME = "__Host-two_session";
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
  username: "window-member",
  avatar: null,
  member: true,
  moderator: false,
};
const MODERATOR: DbSessionRow = { ...MEMBER, userId: "100000000000000002", moderator: true };

async function sessionFor(store: SessionStore, viewer: DbSessionRow) {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await store.create({
    ...viewer,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  });
  const signed = await serializeSigned(COOKIE_NAME, token, env.SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
  });
  return { tokenHash, cookie: signed.split(";")[0]! };
}

async function rotateDuringHandler(store: SessionStore, oldHash: string, viewer: DbSessionRow) {
  const replacement = newSessionToken();
  await store.rotate(oldHash, {
    ...viewer,
    tokenHash: await hashToken(replacement),
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  });
}

function sessionCookies(response: Response) {
  return response.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
}

/** The bearer inside a `name=signed` cookie pair (unsigned half). */
function bearerOf(pair: string): string {
  const signed = decodeURIComponent(pair.slice(pair.indexOf("=") + 1).split(";")[0]!);
  return signed.slice(0, signed.lastIndexOf("."));
}

/** A store that records every rotation's replacement hash, reads stay real. */
function storeWithRotationLog(real: SessionStore, rotations: string[]): SessionStore {
  const rawRotate = real.rotate.bind(real);
  return {
    ...real,
    rotate: async (oldHash, replacement) => {
      rotations.push(replacement.tokenHash);
      return rawRotate(oldHash, replacement);
    },
  };
}

function profileApp(store: SessionStore, rotations?: string[]) {
  const app: ProfileApp = new Hono();
  const deps = { sessionStore: store, accessLog: async () => true };
  registerGate(app, deps, profileStores(deps));
  app.get("/profile", async (c) => {
    // Another tab wins while this response renders: rotate the bearer this
    // view just minted, so the post-handler revalidation must drop the stale
    // cookie instead of restoring a superseded bearer.
    if (rotations) await rotateDuringHandler(store, rotations.at(-1)!, MEMBER);
    return bufferedMemberHtml(c, `<p>${c.get("viewer").id}</p>`);
  });
  return app;
}

function adminApp(store: SessionStore, rotations?: string[]) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminActor: Actor; access: AccessDecl };
  }>();
  app.use("/*", adminGuard({ sessionStore: store }));
  app.get("/admin", async (c) => {
    c.set("access", { resource: "events", action: "view", route: "test.session-cookie" });
    if (rotations) await rotateDuringHandler(store, rotations.at(-1)!, MODERATOR);
    return bufferedMemberHtml(c, `<p>${c.get("adminActor").id}</p>`);
  });
  app.get("/admin/missing", (c) => {
    c.set("access", { resource: "events", action: "view", route: "test.session-cookie-missing" });
    return bufferedMemberHtml(c, "Not found", 404);
  });
  app.get("/admin/redirect", (c) => {
    c.set("access", { resource: "events", action: "view", route: "test.session-cookie-redirect" });
    // A buffered redirect (a bare one never classifies through the boundary).
    c.header("location", "/admin");
    return bufferedMemberHtml(c, "Redirecting", 302);
  });
  return app;
}

describe("renewed session cookies follow the live bearer", () => {
  it("does not send a profile cookie after another request rotates its bearer", async () => {
    const real = createMemorySessionStore();
    const { cookie, tokenHash } = await sessionFor(real, MEMBER);
    const rotations: string[] = [];
    const store = storeWithRotationLog(real, rotations);

    const response = await profileApp(store, rotations).request(
      "/profile",
      { headers: { cookie } },
      env,
    );

    expect(response.status).toBe(200);
    expect(rotations, "the view and the other tab each rotate once").toHaveLength(2);
    const successorHash = rotations[0]!;
    expect(await real.statusHash(successorHash)).toBeNull();
    expect(await real.get(successorHash)).toEqual(MEMBER);
    expect(await real.get(tokenHash), "the grandparent is pruned on the next win").toBeNull();
    expect(sessionCookies(response)).toHaveLength(0);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it("does not send an admin cookie after another request rotates its bearer", async () => {
    const real = createMemorySessionStore();
    const { cookie, tokenHash } = await sessionFor(real, MODERATOR);
    const rotations: string[] = [];
    const store = storeWithRotationLog(real, rotations);

    const response = await adminApp(store, rotations).request(
      "/admin",
      { headers: { cookie } },
      env,
    );

    expect(response.status).toBe(200);
    expect(rotations, "the view and the other tab each rotate once").toHaveLength(2);
    const successorHash = rotations[0]!;
    expect(await real.statusHash(successorHash)).toBeNull();
    expect(await real.get(successorHash)).toEqual(MODERATOR);
    expect(await real.get(tokenHash), "the grandparent is pruned on the next win").toBeNull();
    expect(sessionCookies(response)).toHaveLength(0);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it("refreshes the moderator cookie on an authorized rendered 404", async () => {
    const store = createMemorySessionStore();
    const { cookie, tokenHash } = await sessionFor(store, MODERATOR);

    const response = await adminApp(store).request("/admin/missing", { headers: { cookie } }, env);

    expect(response.status).toBe(404);
    const refreshed = sessionCookies(response);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.split(";")[0], "the 404 must carry a fresh bearer").not.toBe(cookie);
    // The fresh bearer authenticates; the presented bearer is grace only.
    expect(await store.get(await hashToken(bearerOf(refreshed[0]!)))).toEqual(MODERATOR);
    expect(await store.statusHash(tokenHash)).toBeNull();
  });

  it("delivers the fresh bearer on a downstream redirect instead of stranding the moderator", async () => {
    const store = createMemorySessionStore();
    const { cookie, tokenHash } = await sessionFor(store, MODERATOR);

    const response = await adminApp(store).request("/admin/redirect", { headers: { cookie } }, env);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin");
    // The view already rotated: the browser's bearer is grace-only, so the
    // replacement must ride along or the redirect strands the session.
    const refreshed = sessionCookies(response);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.split(";")[0], "the redirect must carry a fresh bearer").not.toBe(cookie);
    expect(await store.get(await hashToken(bearerOf(refreshed[0]!)))).toEqual(MODERATOR);
    expect(await store.statusHash(tokenHash)).toBeNull();
  });
});
