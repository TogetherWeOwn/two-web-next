import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { QUEUE_READ_TIMEOUT_MS, WEB_MIGRATIONS } from "../src/up";
import { healthSql } from "./helpers/up";

const factory = vi.hoisted(() => vi.fn());
vi.mock("postgres", () => ({ default: factory }));
import app from "./app";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "test",
  DISCORD_GUILD_ID: "test",
  DISCORD_INVITE_URL: "https://discord.gg/test",
  DISCORD_CLIENT_SECRET: "test",
  DISCORD_BOT_TOKEN: "test",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  DB: { connectionString: "postgres://fixture.invalid/never-connected" },
};

const webUrl = "postgres://web.fixture.invalid/never-connected";
const queueRow = {
  pending: 25,
  delayed: 1,
  reserved: 0,
  total: 26,
  failed: 2,
  oldest_pending_age_seconds: 42,
};
const clientWithEnd = (options: Parameters<typeof healthSql>[0] = {}) =>
  Object.assign(healthSql(options), { end: vi.fn(async () => {}) });

describe("/up database selection (offline)", () => {
  afterEach(() => factory.mockReset());

  it.each([true, false])(
    "readiness follows DATABASE_URL, not the opposite DB binding health (web down: %s)",
    async (webDown) => {
      const web = clientWithEnd({ ping: webDown ? new Error("web unavailable") : undefined });
      const binding = clientWithEnd({
        ping: webDown ? undefined : new Error("binding unavailable"),
        queue: webDown ? [queueRow] : new Error("binding unavailable"),
      });
      factory.mockImplementation((url) => (url === webUrl ? web : binding));
      const res = await app.request("/up", {}, { ...env, DATABASE_URL: webUrl });
      expect(res.status).toBe(webDown ? 503 : 200);
      expect(await res.json()).toMatchObject({
        db: webDown ? "error" : "ok",
        pending_migrations: webDown ? null : 0,
        queue: webDown
          ? { status: "degraded", ...queueRow, warn_at: 20, critical_at: 100, detail: null }
          : { status: "unknown", pending: null, total: null, detail: null },
      });
      expect(factory.mock.calls.map(([url]) => url)).toEqual([webUrl, env.DB!.connectionString]);
      expect(web.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
      expect(binding.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    },
  );

  it("counts the selected web ledger even when the binding ledger is fully migrated", async () => {
    const web = clientWithEnd({
      migrations: WEB_MIGRATIONS.slice(1).map(({ when }) => ({ created_at: String(when) })),
    });
    const binding = clientWithEnd({ queue: [queueRow] });
    factory.mockImplementation((url) => (url === webUrl ? web : binding));
    const res = await app.request("/up", {}, { ...env, DATABASE_URL: webUrl });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      db: "ok",
      pending_migrations: 1,
      queue: { pending: 25 },
    });
  });

  it("does not substitute the healthy binding after a malformed DATABASE_URL", async () => {
    const binding = clientWithEnd({ queue: [queueRow] });
    factory.mockImplementation((url) => {
      if (url === "not a url") throw new Error("malformed web URL");
      return binding;
    });
    const res = await app.request("/up", {}, { ...env, DATABASE_URL: "not a url" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      db: "error",
      pending_migrations: null,
      queue: { pending: 25 },
    });
    expect(factory.mock.calls.map(([url]) => url)).toEqual(["not a url", env.DB!.connectionString]);
    expect(binding.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
  });

  it("a malformed queue binding does not fail a ready selected web database", async () => {
    const web = clientWithEnd();
    factory.mockImplementation((url) => {
      if (url === webUrl) return web;
      throw new Error("malformed queue binding");
    });
    const res = await app.request("/up", {}, { ...env, DATABASE_URL: webUrl });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      db: "ok",
      pending_migrations: 0,
      queue: { status: "unknown", detail: "queue ledger is not configured." },
    });
    expect(web.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
  });

  it("separate hung DB and queue clients still answer at 3 s without waiting for either cleanup", async () => {
    vi.useFakeTimers();
    const never = () => new Promise<Record<string, unknown>[]>(() => {});
    const web = Object.assign(healthSql({ ping: never }), { end: vi.fn(never) });
    const binding = Object.assign(healthSql({ queue: never }), { end: vi.fn(never) });
    const waitUntil = vi.fn();
    factory.mockImplementation((url) => (url === webUrl ? web : binding));
    try {
      const response = app.request(
        "/up",
        {},
        { ...env, DATABASE_URL: webUrl },
        { waitUntil, passThroughOnException() {}, props: {} },
      );
      await vi.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS);
      const res = await response;
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        db: "error",
        pending_migrations: null,
        queue: { status: "unknown" },
      });
      expect(factory).toHaveBeenCalledTimes(2);
      for (const [, options] of factory.mock.calls)
        expect(options).toMatchObject({ max: 1, connect_timeout: 3 });
      expect(web.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
      expect(binding.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
      expect(waitUntil).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["", env.DB!.connectionString])(
    "shares one client when both reads select the binding (DATABASE_URL: %s)",
    async (url) => {
      const binding = clientWithEnd({ queue: [queueRow] });
      factory.mockReturnValue(binding);
      const res = await app.request("/up", {}, { ...env, DATABASE_URL: url });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        db: "ok",
        pending_migrations: 0,
        queue: { pending: 25 },
      });
      expect(factory).toHaveBeenCalledExactlyOnceWith(env.DB!.connectionString, {
        max: 2,
        idle_timeout: 10,
        connect_timeout: 3,
        fetch_types: false,
      });
      expect(binding.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    },
  );
});

describe("/up request-owned client lifecycle (offline)", () => {
  it.each(["ping", "queue"] as const)(
    "a hung %s cannot extend the deadline through client cleanup",
    async (stage) => {
      vi.useFakeTimers();
      const end = vi.fn(() => new Promise<void>(() => {}));
      const waitUntil = vi.fn();
      const client = Object.assign(healthSql({ [stage]: () => new Promise(() => {}) }), { end });
      factory.mockReturnValue(client);
      try {
        const response = app.request("/up", {}, env, {
          waitUntil,
          passThroughOnException() {},
          props: {},
        });
        await vi.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS);
        const res = await response;
        expect(res.status).toBe(stage === "ping" ? 503 : 200);
        expect(await res.json()).toMatchObject({
          db: stage === "ping" ? "error" : "ok",
          queue: { status: "unknown" },
        });
        expect(factory).toHaveBeenCalledWith(env.DB!.connectionString, {
          max: 2,
          idle_timeout: 10,
          connect_timeout: 3,
          fetch_types: false,
        });
        expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
        expect(waitUntil).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
        factory.mockReset();
      }
    },
  );
});
