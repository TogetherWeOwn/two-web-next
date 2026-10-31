// Admin guard lost-rotation re-read (src/admin/guard.ts): when rotate() loses
// a race, the guard re-reads the bearer once and decides from that row. A
// moderator demoted between the two reads must get 403, never the panel; a
// still-moderator grace read serves without minting a replacement cookie.
// Memory store only, no DB.
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const MOD = { userId: "100000000000000111", username: "mod" };

/**
 * A moderator bearer whose rotation loses to a competing tab: the competitor
 * rotates first, so the guard's own rotate() really fails and its re-read
 * resolves through predecessor grace. The test chooses the re-read's role.
 */
async function racedStore(reread: { moderator: boolean }) {
  const inner = createMemorySessionStore();
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  await inner.create({
    tokenHash,
    userId: MOD.userId,
    username: MOD.username,
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  let reads = 0;
  let rotations = 0;
  const store: SessionStore = {
    ...inner,
    get: async (hash) => {
      const row = await inner.get(hash);
      reads++;
      return row && reads > 1 ? { ...row, moderator: reread.moderator } : row;
    },
    rotate: async (oldHash, replacement) => {
      rotations++;
      const competitor = await hashToken(newSessionToken());
      if (!(await inner.rotate(oldHash, { ...replacement, tokenHash: competitor }))) {
        throw new Error("competing rotation should win");
      }
      return inner.rotate(oldHash, replacement);
    },
  };
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return {
    store,
    cookie: serialized.split(";")[0]!,
    counts: () => ({ reads, rotations }),
    // Grace-only: the bearer still reads, but has no status key of its own.
    graceOnly: async () =>
      (await inner.get(tokenHash)) !== null && (await inner.statusHash(tokenHash)) === null,
  };
}

describe("admin guard: rotation lost a race", () => {
  it("refuses a moderator demoted between the read and the re-read", async () => {
    const { store, cookie, counts, graceOnly } = await racedStore({ moderator: false });
    const res = await adminApp(store).request("/", { headers: { cookie } }, env);
    expect(counts()).toEqual({ reads: 2, rotations: 1 });
    expect(await graceOnly()).toBe(true);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("You do not have access to this");
    expect(body).not.toContain(MOD.username);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-two_session="))).toBe(false);
  });

  it("serves a still-moderator grace re-read without minting a cookie", async () => {
    const { store, cookie, counts, graceOnly } = await racedStore({ moderator: true });
    const res = await adminApp(store).request("/", { headers: { cookie } }, env);
    expect(counts()).toEqual({ reads: 2, rotations: 1 });
    expect(await graceOnly()).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(MOD.username);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-two_session="))).toBe(false);
  });
});
