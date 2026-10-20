// route-inventory: POST /admin/events
// route-inventory: POST /admin/events/:key/publish
// Admin write admission (nightly mutation A1): pins src/admin/guard.ts's
// moderator gate on the write path through the documented override seams.
//
// A weakened gate (e.g. `if (row?.moderator)` mutated to `if (row)`) must be
// killed here: a signed-in non-moderator POST must stay 403 and never reach
// the store. A moderator POST without a database proves the gate passed by
// failing closed to 503 at the store seam, not at the gate.
//
// Hermetic and DB-free: memory session store only, no DATABASE_URL, no
// Discord, no ADMIN_DB. Matches the sessions-join nightly contract exactly.
//
// Scope guard: must not import `src/admin/guard.ts` directly; drive only
// through the mounted admin app with memory store and minimal env.
import { describe, expect, it } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import { adminApp } from "../src/admin/routes";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

async function cookieFor(
  store: SessionStore,
  row: { userId: string; username: string; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: true,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

const MOD = { userId: "100000000000000111", username: "mod", moderator: true };
const PLEB = { userId: "100000000000000222", username: "pleb", moderator: false };

function form(body: Record<string, string>) {
  return {
    method: "POST" as const,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  };
}

describe("admin write admission (guard bypass kill)", () => {
  it("non-moderator POST stays 403 on the write path, never reaching the store", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    const cookie = await cookieFor(store, PLEB);
    const headers = { cookie };

    for (const [path, body] of [
      ["/events", { title: "x" }],
      ["/events/abc", { title: "x" }],
      ["/events/abc/publish", {}],
      ["/events/abc/cancel", {}],
    ] as const) {
      const res = await app.request(path, { ...form(body), headers }, baseEnv);
      expect(res.status, `POST ${path}`).toBe(403);
      const text = await res.text();
      // Harness paths that match the shared 403 helper's machine-only
      // event-write shapes keep the JSON envelope; the rest negotiate to
      // the branded page (production admin paths always negotiate).
      if (path === "/events" || path.endsWith("/publish") || path.endsWith("/cancel")) {
        expect(JSON.parse(text), `POST ${path}`).toMatchObject({ error: "forbidden" });
      } else {
        expect(text, `POST ${path}`).toContain("You do not have access to this");
      }
    }
  });

  it("moderator POST without a database fails closed to 503 past the gate", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    const cookie = await cookieFor(store, MOD);

    const res = await app.request(
      "/events",
      { ...form({ title: "x" }), headers: { cookie } },
      baseEnv,
    );
    // 503 proves the gate admitted a moderator and the store seam refused
    // without a database; a bypassed gate turns the 403 above into this 503.
    expect(res.status).toBe(503);
  });
});
