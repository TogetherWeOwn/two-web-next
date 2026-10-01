import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { QUEUE_READ_TIMEOUT_MS } from "../src/up";
import { healthSql } from "./helpers/up";

const factory = vi.hoisted(() => vi.fn());
vi.mock("postgres", () => ({ default: factory }));
import app from "./app";

const env: Env = {
  APP_URL: "https://next.example.test", DISCORD_CLIENT_ID: "test", DISCORD_GUILD_ID: "test",
  DISCORD_INVITE_URL: "https://discord.gg/test", DISCORD_CLIENT_SECRET: "test",
  DISCORD_BOT_TOKEN: "test", SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DB: { connectionString: "postgres://fixture.invalid/never-connected" },
};

describe("/up request-owned client lifecycle (offline)", () => {
  it.each(["ping", "queue"] as const)("a hung %s cannot extend the deadline through client cleanup", async (stage) => {
    vi.useFakeTimers();
    const end = vi.fn(() => new Promise<void>(() => {}));
    const waitUntil = vi.fn();
    const client = Object.assign(healthSql({ [stage]: () => new Promise(() => {}) }), { end });
    factory.mockReturnValue(client);
    try {
      const response = app.request("/up", {}, env, { waitUntil, passThroughOnException() {}, props: {} });
      await vi.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS);
      const res = await response;
      expect(res.status).toBe(stage === "ping" ? 503 : 200);
      expect(await res.json()).toMatchObject({ db: stage === "ping" ? "error" : "ok", queue: { status: "unknown" } });
      expect(factory).toHaveBeenCalledWith(env.DB!.connectionString, {
        max: 2, idle_timeout: 10, connect_timeout: 3, fetch_types: false,
      });
      expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
      expect(waitUntil).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      factory.mockReset();
    }
  });
});
