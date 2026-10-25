// Failure arms of POST /logout/everywhere that the paired acceptance suite
// leaves unpinned (the acceptance file is owned elsewhere and never edited):
//
// - Member resolution (`store.get`) throwing is authoritative, like a failing
//   sweep: 503 in the negotiated representation, no cookie clears, every
//   session intact. A regression to `.catch(() => null)` would answer a false
//   303 "signed out everywhere" during an outage while every row stays live.
// - A dead bearer revokes nothing, even when it presents a signed status
//   cookie whose lineage has a live successor. POST /logout kills that lineage
//   on a dead bearer; this route must not, or a 303 claiming "everywhere"
//   would leave other lineages signed in while killing exactly one.
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  SESSION_PREDECESSOR_GRACE_SECONDS,
  type SessionStore,
} from "../src/sessions";
import app from "./app";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const SESSION_COOKIE = "__Host-two_session";
const STATUS_COOKIE = "__Host-two_session_status";
const ACTOR = {
  userId: "100000000000000221",
  username: "arms-actor",
  member: true,
  moderator: false,
} as const;

const cookieOpts = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" } as const;

async function signed(name: string, value: string): Promise<string> {
  return (await serializeSigned(name, value, SESSION_SECRET, cookieOpts)).split(";")[0]!;
}

async function mint(store: SessionStore, expiresAt: Date) {
  const token = newSessionToken();
  const hash = await hashToken(token);
  await store.create({
    tokenHash: hash,
    userId: ACTOR.userId,
    username: ACTOR.username,
    avatar: null,
    member: ACTOR.member,
    moderator: ACTOR.moderator,
    expiresAt,
  });
  return { token, hash, cookie: await signed(SESSION_COOKIE, token) };
}

function envFor(store: SessionStore): Env {
  return {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    SESSION_STORE: store,
  } as unknown as Env;
}

function post(path: string, store: SessionStore, cookie: string, accept?: string) {
  return app.request(
    path,
    { method: "POST", headers: { origin: APP_URL, cookie, ...(accept ? { accept } : {}) } },
    envFor(store),
  );
}

function cleared(res: Response, name: string): boolean {
  return res.headers
    .getSetCookie()
    .some((line) => line.startsWith(`${name}=`) && /Max-Age=0/i.test(line));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /logout/everywhere: no usable bearer needs no session storage", () => {
  const kinds = [
    "no cookies",
    "missing",
    "bad signature",
    "short",
    "long",
    "non-base64url",
    "missing prefix",
    "legacy hex",
    "bare prefix",
  ];
  const cases = kinds.flatMap((kind) =>
    [undefined, "text/html", "application/json", "*/*"].map((accept) => ({ kind, accept })),
  );

  it.each(cases)(
    "$kind bearer clears cookies without resolving storage (Accept $accept)",
    async ({ kind, accept }) => {
      const store = createMemorySessionStore();
      const current = await mint(store, new Date(Date.now() + 3_600_000));
      const sibling = await mint(store, new Date(Date.now() + 3_600_000));
      const currentRow = await store.get(current.hash);
      const siblingRow = await store.get(sibling.hash);
      const malformed: Record<string, string> = {
        short: current.token.slice(0, -1),
        long: `${current.token}A`,
        "non-base64url": `${current.token.slice(0, -1)}!`,
        "missing prefix": current.token.slice(4),
        "legacy hex": "a".repeat(64),
        "bare prefix": "two_",
      };
      const bearer =
        kind === "no cookies" || kind === "missing"
          ? ""
          : kind === "bad signature"
            ? (
                await serializeSigned(
                  SESSION_COOKIE,
                  current.token,
                  "wrong-signing-secret",
                  cookieOpts,
                )
              ).split(";")[0]!
            : await signed(SESSION_COOKIE, malformed[kind]!);
      const cookies =
        kind === "no cookies"
          ? []
          : [
              bearer,
              await signed(STATUS_COOKIE, current.hash),
              await signed("__Host-two_expired_write", "pending|/profile"),
            ].filter(Boolean);
      const unavailable = vi.fn(() => {
        throw new Error("store down");
      });
      const bindings = envFor(store);
      Object.defineProperty(bindings, "SESSION_STORE", { get: unavailable });

      const res = await app.request(
        "/logout/everywhere",
        {
          method: "POST",
          headers: {
            origin: APP_URL,
            ...(cookies.length ? { cookie: cookies.join("; ") } : {}),
            ...(accept ? { accept } : {}),
          },
        },
        bindings,
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.getSetCookie().sort()).toEqual(
        [
          "__Host-two_expired_write=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
          `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
          `${STATUS_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
        ].sort(),
      );
      expect(unavailable, "even resolving the session store is forbidden").not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
      expect(await store.get(current.hash)).toEqual(currentRow);
      expect(await store.get(sibling.hash)).toEqual(siblingRow);
    },
  );
});

describe("POST /logout/everywhere: a failing member resolution is authoritative", () => {
  const ACCEPTS: Array<[string, string | undefined, string]> = [
    ["html", "text/html", "text/html"],
    ["json", "application/json", "application/json"],
    ["absent", undefined, "text/plain"],
    ["wildcard", "*/*", "text/plain"],
  ];

  it.each(ACCEPTS)(
    "store.get throwing answers a negotiated 503 (%s) with no clears and sessions intact",
    async (_name, accept, contentType) => {
      const store = createMemorySessionStore();
      const current = await mint(store, new Date(Date.now() + 3_600_000));
      const sibling = await mint(store, new Date(Date.now() + 3_600_000));
      const live = vi.spyOn(store, "get").mockRejectedValue(new Error("store down"));
      const sweep = vi.spyOn(store, "revokeUserSessions");

      const res = await post("/logout/everywhere", store, current.cookie, accept);

      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toContain(contentType);
      expect(res.headers.getSetCookie(), "outage must not clear cookies").toEqual([]);
      expect(res.headers.get("location")).toBeNull();
      expect(sweep, "no sweep may run on a failed resolve").not.toHaveBeenCalled();
      live.mockRestore();
      expect(await store.get(current.hash)).not.toBeNull();
      expect(await store.get(sibling.hash)).not.toBeNull();
      expect(await res.text()).not.toContain(current.token);
    },
  );

  it.each(ACCEPTS)(
    "matches POST /logout's failure representation byte-class for byte-class (%s)",
    async (_name, accept) => {
      const single = createMemorySessionStore();
      const singleSession = await mint(single, new Date(Date.now() + 3_600_000));
      vi.spyOn(single, "revoke").mockRejectedValue(new Error("store down"));
      const everywhere = createMemorySessionStore();
      const everywhereSession = await mint(everywhere, new Date(Date.now() + 3_600_000));
      vi.spyOn(everywhere, "get").mockRejectedValue(new Error("store down"));

      const a = await post("/logout", single, singleSession.cookie, accept);
      const b = await post("/logout/everywhere", everywhere, everywhereSession.cookie, accept);

      expect(b.status).toBe(a.status);
      expect(b.headers.get("content-type")).toBe(a.headers.get("content-type"));
      expect(b.headers.get("vary")).toBe(a.headers.get("vary"));
      expect(b.headers.get("cache-control")).toBe(a.headers.get("cache-control"));
    },
  );
});

describe("POST /logout/everywhere: a dead bearer revokes nothing, not even its lineage", () => {
  it("a rotated-away predecessor past grace with a signed status cookie leaves the live successor and siblings untouched", async () => {
    let now = Date.now();
    const store = createMemorySessionStore(() => now);
    const farFuture = new Date(now + 3 * 3_600_000);
    const predecessor = await mint(store, farFuture);
    const lineage = predecessor.hash;
    const successor = await mint(store, farFuture);
    // Rotate the predecessor to a fresh token in the same lineage.
    const rotated = newSessionToken();
    const rotatedHash = await hashToken(rotated);
    expect(
      await store.rotate(predecessor.hash, {
        tokenHash: rotatedHash,
        userId: ACTOR.userId,
        username: ACTOR.username,
        avatar: null,
        member: ACTOR.member,
        moderator: ACTOR.moderator,
        expiresAt: farFuture,
      }),
    ).toBe(true);
    now += (SESSION_PREDECESSOR_GRACE_SECONDS + 1) * 1000;
    expect(await store.get(predecessor.hash), "fixture must present a dead bearer").toBeNull();
    expect(await store.get(rotatedHash), "lineage successor must be live").not.toBeNull();
    expect(await store.statusHash(rotatedHash)).toBe(lineage);

    const sweep = vi.spyOn(store, "revokeUserSessions");
    const revoke = vi.spyOn(store, "revoke");
    const lineageKill = vi.spyOn(store, "revokeLineage");
    const cookie = `${predecessor.cookie}; ${await signed(STATUS_COOKIE, lineage)}`;

    const res = await post("/logout/everywhere", store, cookie, "text/html");

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(cleared(res, SESSION_COOKIE)).toBe(true);
    expect(cleared(res, STATUS_COOKIE)).toBe(true);
    expect(sweep).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(lineageKill, "dead bearer must not kill the presented lineage").not.toHaveBeenCalled();
    expect(await store.get(rotatedHash), "lineage successor stays signed in").not.toBeNull();
    expect(await store.isActive(lineage)).toBe(true);
    expect(await store.get(successor.hash), "unrelated sibling stays signed in").not.toBeNull();
  });

  it("a revoked bearer with a signed status cookie leaves its lineage's other state untouched", async () => {
    const store = createMemorySessionStore();
    const expiresAt = new Date(Date.now() + 3_600_000);
    const revoked = await mint(store, expiresAt);
    const sibling = await mint(store, expiresAt);
    await store.revoke(revoked.hash);
    const lineageKill = vi.spyOn(store, "revokeLineage");
    const sweep = vi.spyOn(store, "revokeUserSessions");
    const cookie = `${revoked.cookie}; ${await signed(STATUS_COOKIE, revoked.hash)}`;

    const res = await post("/logout/everywhere", store, cookie, "text/html");

    expect(res.status).toBe(303);
    expect(lineageKill).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
    expect(await store.get(sibling.hash)).not.toBeNull();
  });
});
