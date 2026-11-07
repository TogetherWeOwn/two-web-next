import { serializeSigned } from "hono/utils/cookie";
import { expect, vi } from "vitest";
import type { Env } from "../../src/env";
import { AUTH_STATUS_COOKIE } from "../../src/auth-status";
import { QA_HEADER } from "../../src/qa";
import { SESSION_COOKIE } from "../../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../../src/sessions";
import app from "../app";

export const CALLERS = ["oauth", "join", "qa"] as const;
export type SigninCaller = (typeof CALLERS)[number];
export const REQUEST_ID = "0123456789abcdef";
export const SECRET = "test-session-secret-at-least-32-bytes-long";
export const MOD_ROLE = "1546777856984481792";

export function identity(caller: SigninCaller) {
  return caller === "qa"
    ? {
        userId: "900000000000001397",
        username: "QA Moderator",
        avatar: null,
        member: true,
        moderator: true,
      }
    : {
        userId: "42",
        username: "Roster Member",
        avatar: "avatar-new",
        member: true,
        moderator: true,
      };
}

export function signinEnv(extra: Record<string, unknown> = {}): Env {
  return {
    APP_URL: "https://next.togetherweown.com",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: SECRET,
    DISCORD_MODERATOR_ROLE_IDS: MOD_ROLE,
    QA_AUTH_TOKEN: "qa-fixture-token-with-32-plus-characters",
    SESSION_STORE: createMemorySessionStore(),
    THROTTLE_STORE: async () => null,
    JOIN_DEPS: { store: async () => null },
    ...extra,
  } as unknown as Env;
}

export const cookieJar = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

export function bearer(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  expect(cookie, "successful issuance must deliver the normal signed bearer cookie").toBeDefined();
  return decodeURIComponent(cookie!.split(";")[0]!.slice(SESSION_COOKIE.length + 1)).split(".")[0]!;
}

export function stubSigninDiscord(joinStatus = 201, roles = [MOD_ROLE]) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (!url.startsWith("https://discord.com/api/"))
      throw new Error("Non-fixture transport refused");
    if (url.endsWith("/oauth2/token"))
      return Response.json({ access_token: "fixture-access-token" });
    if (url.endsWith("/users/@me"))
      return Response.json({
        id: "42",
        username: "provider-name",
        global_name: "Roster Member",
        avatar: "avatar-new",
      });
    if (url.endsWith("/members/42") && init?.method === "PUT")
      return new Response(null, { status: joinStatus });
    if (url.endsWith("/members/42"))
      return Response.json({ roles, joined_at: "2024-01-01T00:00:00Z" });
    throw new Error("Unexpected Discord fixture request");
  });
  return calls;
}

/** Admit through the real journey/token gates before starting the operation under test. */
export async function prepareSignin(caller: SigninCaller, env: Env, priorCookie = "") {
  if (caller === "qa")
    return async () =>
      app.request(
        "/auth/qa/qa-moderator",
        {
          method: "POST",
          headers: {
            origin: env.APP_URL,
            [QA_HEADER]: "qa-fixture-token-with-32-plus-characters",
            cookie: priorCookie,
            "X-Request-ID": REQUEST_ID,
          },
        },
        env,
      );
  const startPath = caller === "oauth" ? "/auth/discord" : "/join/discord";
  const start = await app.request(`${startPath}?next=%2Fprofile`, {}, env);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  expect(state).toBeTruthy();
  const callback = caller === "oauth" ? "/auth/discord/callback" : "/join/callback";
  return async () =>
    app.request(
      `${callback}?code=fixture-code&state=${state}`,
      {
        headers: {
          cookie: [cookieJar(start), priorCookie].filter(Boolean).join("; "),
          "X-Request-ID": REQUEST_ID,
        },
      },
      env,
    );
}

export async function expectIssued(response: Response, caller: SigninCaller, store: SessionStore) {
  expect(response.status).toBe(caller === "qa" ? 204 : 302);
  expect(response.headers.get("location")).toBe(caller === "qa" ? null : "/profile");
  if (caller === "qa") expect(await response.text()).toBe("");
  for (const name of [SESSION_COOKIE, AUTH_STATUS_COOKIE]) {
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; Max-Age=7200(?:;|$)/);
  }
  const hash = await hashToken(bearer(response));
  expect(await store.get(hash)).toEqual(identity(caller));
  const status = await store.statusHash(hash);
  expect(status).toBeTruthy();
  expect(await store.isActive(status!)).toBe(true);
  return hash;
}

export async function priorSession(store: SessionStore) {
  const token = newSessionToken();
  const hash = await hashToken(token);
  await store.create({
    tokenHash: hash,
    userId: "previous-user",
    username: "Previous member",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned(SESSION_COOKIE, token, SECRET, { path: "/", secure: true })
  ).split(";")[0]!;
  return { hash, cookie };
}

export function latch<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Observe completion while the peer is still parked; always clear the observer timer. */
export async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
