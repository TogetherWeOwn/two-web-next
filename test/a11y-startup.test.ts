import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";

const env: Env = {
  APP_URL: "https://127.0.0.1:8787",
  DISCORD_CLIENT_ID: "local-fixture",
  DISCORD_CLIENT_SECRET: "local-fixture",
  DISCORD_BOT_TOKEN: "local-fixture",
  DISCORD_GUILD_ID: "local-fixture",
  DISCORD_INVITE_URL: "/discord",
  SESSION_SECRET: "local-fixture-session-secret-at-least-32-bytes",
};

// The audit worker has ADMIN_DB/SESSION_STORE seams, but no normal DB binding.
describe("local accessibility worker startup", () => {
  const runner = readFileSync(new URL("../ci/a11y.mjs", import.meta.url), "utf8");
  const path = runner.match(/readiness\.get\(`\$\{origin\}([^`]+)`/)?.[1];

  it("polls the existing DB-free route, not deployment readiness", async () => {
    expect(path).toBe("/robots.txt");
    const read = vi.fn(() => { throw new Error("Startup must not read DB/session bindings"); });
    const bindings = { ...env };
    for (const key of ["DB", "DATABASE_URL", "ADMIN_DB", "SESSION_STORE"]) {
      Object.defineProperty(bindings, key, { get: read });
    }
    const response = await app.request(`${env.APP_URL}${path}`, {}, bindings);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain("User-agent:");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps the missing-DB /up readiness gate closed on the same origin", async () => {
    const response = await app.request(`${env.APP_URL}/up`, {}, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ db: "error", pending_migrations: null });
  });
});
