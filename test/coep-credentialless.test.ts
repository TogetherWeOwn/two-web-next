// ZAP 90004: every response carries COEP credentialless, never require-corp.
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { securityHeadersFor } from "../src/headers";
import type { Env } from "../src/env";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const routes: Array<[string, string]> = [
  ["GET", "/"],
  ["GET", "/join"],
  ["POST", "/join"],
  ["GET", "/events"],
  ["GET", "/rules"],
  ["GET", "/no-such-page"],
  ["POST", "/api/agent-events"],
];

describe("Cross-Origin-Embedder-Policy: credentialless (ZAP 90004)", () => {
  for (const [method, path] of routes) {
    it(`${method} ${path} emits COEP credentialless`, async () => {
      const res = await app.request(path, { method, headers: { host: "next.example.test" } }, env);
      expect(res.headers.get("Cross-Origin-Embedder-Policy"), `${method} ${path}`).toBe(
        "credentialless",
      );
    });
  }

  it("securityHeadersFor pins COEP credentialless, never require-corp", () => {
    for (const [method, path] of routes) {
      const headers = new Map(securityHeadersFor({ path, method }));
      expect(headers.get("Cross-Origin-Embedder-Policy"), `${method} ${path}`).toBe(
        "credentialless",
      );
    }
  });
});
