import { describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";

// Local outage fixture: never constructs a connection or reads any database.
vi.mock("postgres", () => ({
  default: vi.fn(() => {
    throw new Error("database unavailable");
  }),
}));

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

describe("homepage with unavailable Postgres", () => {
  it.each([
    { DATABASE_URL: "postgres://agent_test@agent-testdb:5432/two_web_next" },
    { DB: { connectionString: "postgres://agent_test@agent-testdb:5432/two_web_next" } },
  ])("returns guest 200 when both session and featured DB setup fail: %j", async (binding) => {
    const res = await app.request("/", {}, { ...env, ...binding });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="signin"');
    expect(html).toContain('data-testid="join"');
    expect(html).not.toContain('data-testid="featured-content"');
    expect(html).not.toContain("database unavailable");
    expect(res.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  });
});
