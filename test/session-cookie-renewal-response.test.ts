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

function profileApp(store: SessionStore, oldHash: string) {
  const app: ProfileApp = new Hono();
  const deps = { sessionStore: store, accessLog: async () => true };
  registerGate(app, deps, profileStores(deps));
  app.get("/profile", async (c) => {
    await rotateDuringHandler(store, oldHash, MEMBER);
    return bufferedMemberHtml(c, `<p>${c.get("viewer").id}</p>`);
  });
  return app;
}

function adminApp(store: SessionStore, oldHash?: string) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminActor: Actor; access: AccessDecl };
  }>();
  app.use("/*", adminGuard({ sessionStore: store }));
  app.get("/admin", async (c) => {
    c.set("access", { resource: "events", action: "view", route: "test.session-cookie" });
    if (oldHash) await rotateDuringHandler(store, oldHash, MODERATOR);
    return bufferedMemberHtml(c, `<p>${c.get("adminActor").id}</p>`);
  });
  app.get("/admin/missing", (c) => {
    c.set("access", { resource: "events", action: "view", route: "test.session-cookie-missing" });
    return bufferedMemberHtml(c, "Not found", 404);
  });
  return app;
}

describe("renewed session cookies follow the live bearer", () => {
  it("does not send a profile cookie after another request rotates its bearer", async () => {
    const store = createMemorySessionStore();
    const { cookie, tokenHash } = await sessionFor(store, MEMBER);

    const response = await profileApp(store, tokenHash).request(
      "/profile",
      { headers: { cookie } },
      env,
    );

    expect(response.status).toBe(200);
    expect(await store.statusHash(tokenHash)).toBeNull();
    expect(await store.get(tokenHash)).toEqual(MEMBER);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it("does not send an admin cookie after another request rotates its bearer", async () => {
    const store = createMemorySessionStore();
    const { cookie, tokenHash } = await sessionFor(store, MODERATOR);

    const response = await adminApp(store, tokenHash).request(
      "/admin",
      { headers: { cookie } },
      env,
    );

    expect(response.status).toBe(200);
    expect(await store.statusHash(tokenHash)).toBeNull();
    expect(await store.get(tokenHash)).toEqual(MODERATOR);
    expect(sessionCookies(response)).toHaveLength(0);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  it("refreshes the moderator cookie on an authorized rendered 404", async () => {
    const store = createMemorySessionStore();
    const { cookie } = await sessionFor(store, MODERATOR);

    const response = await adminApp(store).request("/admin/missing", { headers: { cookie } }, env);

    expect(response.status).toBe(404);
    expect(sessionCookies(response)).toHaveLength(1);
    expect(sessionCookies(response)[0]?.split(";")[0]).toBe(cookie);
  });
});
