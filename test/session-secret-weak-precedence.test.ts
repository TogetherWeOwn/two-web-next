// route-inventory: GET /up
// Precedence pin for the SESSION_SECRET strength gate.
//
// A weak SESSION_SECRET takes precedence over a missing Discord secret:
// weak plus missing must still refuse with `config: "weak"`, never
// `config: "missing"`, and neither the response body nor the server-side
// log may carry the planted value. Fixing the weak secret can then surface
// `config: "missing"` for the still-absent secret (see docs/runbook.md).
//
// All fixtures are synthetic and patterned; no real secret is read.
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { configReadiness } from "../src/up";
import app from "./app";
import { healthSql } from "./helpers/up";

// Short planted sentinel: weak by length, and distinctive so any leak is
// caught by the not-to-contain assertions below.
const PLANTED_WEAK = "PREC9x-WEAK";

const healthyQueueRow = {
  pending: 3,
  delayed: 1,
  reserved: 0,
  total: 4,
  failed: 2,
  oldest_pending_age_seconds: 42,
  oldest_ready_wait_age_seconds: 12.5,
};

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  // Deliberately short: the strength gate must not reach this secret.
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

function envWeakPlusMissing(botToken: unknown): Env {
  const env = {
    ...baseEnv,
    SESSION_SECRET: PLANTED_WEAK,
    QUEUE_DEPTH_STORE: healthSql({ queue: [healthyQueueRow] }),
  } as Record<string, unknown>;
  if (botToken === undefined) delete env.DISCORD_BOT_TOKEN;
  else env.DISCORD_BOT_TOKEN = botToken;
  return env as Env;
}

function captureLogs() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    text: () => JSON.stringify([...warn.mock.calls, ...error.mock.calls]),
    restore: () => {
      warn.mockRestore();
      error.mockRestore();
    },
  };
}

const REQUIREMENT_WORDS = /32|length|weak|strength|short|whitespace|padded|minimum|at least/i;

describe("SESSION_SECRET precedence: weak beats missing", () => {
  it.each([
    ["an absent DISCORD_BOT_TOKEN", undefined],
    ["an empty DISCORD_BOT_TOKEN", ""],
  ])("configReadiness reports weak with %s", (_label, botToken) => {
    const logs = captureLogs();
    try {
      const readiness = configReadiness({
        SESSION_SECRET: PLANTED_WEAK,
        DISCORD_CLIENT_SECRET: "client-secret",
        DISCORD_BOT_TOKEN: botToken as string,
      });
      expect(readiness).toEqual({ config: "weak" });
      expect(JSON.stringify(readiness)).not.toContain(PLANTED_WEAK);
      expect(logs.text()).toContain("SESSION_SECRET");
      expect(logs.text()).toMatch(REQUIREMENT_WORDS);
      expect(logs.text()).not.toContain(PLANTED_WEAK);
    } finally {
      logs.restore();
    }
  });

  it.each([
    ["an absent DISCORD_BOT_TOKEN", undefined],
    ["an empty DISCORD_BOT_TOKEN", ""],
  ])("GET /up answers 503 config:weak with %s, disclosing nothing", async (_label, botToken) => {
    const logs = captureLogs();
    try {
      const res = await app.request("/up", {}, envWeakPlusMissing(botToken));
      const text = await res.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(body.status).toBe("degraded");
      expect(body.db).toBe("ok");
      expect(body.pending_migrations).toBe(0);
      expect(body.config).toBe("weak");
      expect(body.queue).toMatchObject({ status: "healthy", pending: 3, failed: 2 });
      expect(text).not.toContain(PLANTED_WEAK);
      expect(text).not.toContain("SESSION_SECRET");
      expect(text).not.toContain("DISCORD_BOT_TOKEN");
      expect(logs.text()).toContain("SESSION_SECRET");
      expect(logs.text()).toMatch(REQUIREMENT_WORDS);
      expect(logs.text()).not.toContain(PLANTED_WEAK);
    } finally {
      logs.restore();
    }
  });
});
