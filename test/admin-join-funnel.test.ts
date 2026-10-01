// TOG-11226: connection-scoped 60 s cache + bounded optional read for the
// dashboard's join-funnel widget. Deterministic fake-clock/stub tests; the
// route-level check injects a failing ADMIN_DB stub — no live Postgres needed
// (the real-aggregate path is covered by test/admin-reads.test.ts).

import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FUNNEL_CACHE_TTL_MS,
  dashboardJoinFunnel,
} from "../src/admin/join-funnel";
import { adminApp } from "../src/admin/routes";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

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

// The injected `read` seam means the Db itself is never queried in unit tests.
const stubDb = {} as Db;
const read = (value: Record<string, number>) => vi.fn(async () => value);

async function cookieFor(store: ReturnType<typeof createMemorySessionStore>) {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "mod-funnel",
    username: "mod",
    avatar: null,
    member: true,
    moderator: true,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const s = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return s.split(";")[0]!;
}

describe("dashboardJoinFunnel cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("reuses the aggregate for one DB identity through 59,999 ms and refreshes at 60,000", async () => {
    const fill = read({ added: 1 });
    const id = "conn-ttl";
    expect(await dashboardJoinFunnel(stubDb, id, 500, fill)).toEqual({ added: 1 });

    vi.setSystemTime(Date.now() + FUNNEL_CACHE_TTL_MS - 1);
    expect(await dashboardJoinFunnel(stubDb, id, 500, fill)).toEqual({ added: 1 });
    expect(fill).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1); // exactly 60,000 ms after the fill
    fill.mockResolvedValue({ added: 2 });
    expect(await dashboardJoinFunnel(stubDb, id, 500, fill)).toEqual({ added: 2 });
    expect(fill).toHaveBeenCalledTimes(2);
  });

  it("never shares results across DB identities", async () => {
    const a = read({ added: 1 });
    const b = read({ denied: 9 });
    expect(await dashboardJoinFunnel(stubDb, "conn-iso-a", 500, a)).toEqual({ added: 1 });
    expect(await dashboardJoinFunnel(stubDb, "conn-iso-b", 500, b)).toEqual({ denied: 9 });
    // The single settled slot was replaced by conn-iso-b: conn-iso-a misses and
    // re-reads rather than ever returning conn-iso-b's aggregate.
    expect(await dashboardJoinFunnel(stubDb, "conn-iso-a", 500, a)).toEqual({ added: 1 });
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("resolves undefined on failure and does not cache it", async () => {
    const fill = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({ added: 3 });
    const id = "conn-fail";
    expect(await dashboardJoinFunnel(stubDb, id, 500, fill)).toBeUndefined();
    expect(await dashboardJoinFunnel(stubDb, id, 500, fill)).toEqual({ added: 3 });
    expect(fill).toHaveBeenCalledTimes(2);
  });

  it("bounds an indefinitely pending read to the deadline", async () => {
    const hanging = vi.fn(() => new Promise<Record<string, number>>(() => {}));
    const pending = dashboardJoinFunnel(stubDb, "conn-hang", 250, hanging);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBeUndefined();
    expect(hanging).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejection that lands after the deadline (no unhandled rejection)", async () => {
    let reject!: (err: Error) => void;
    const late = vi.fn(
      () =>
        new Promise<Record<string, number>>((_, r) => {
          reject = r;
        }),
    );
    const pending = dashboardJoinFunnel(stubDb, "conn-late", 100, late);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBeUndefined();
    // The underlying read rejects after the caller already resolved undefined;
    // vitest fails the run on an unhandled rejection, so unwinding cleanly is
    // the assertion.
    reject(new Error("late boom"));
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("dashboard route with a failing aggregate (stub ADMIN_DB)", () => {
  it("omits the funnel widget and still answers 200", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store);
    const brokenDb = {
      transaction: () => Promise.reject(new Error("aggregate unavailable")),
    } as unknown as Db;
    const res = await adminApp({ sessionStore: store }).request("/", { headers: { cookie } }, {
      ...env,
      ADMIN_DB: brokenDb,
    } as Env);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('data-testid="join-funnel"');
  });
});
