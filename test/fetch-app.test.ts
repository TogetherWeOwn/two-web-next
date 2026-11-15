import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fetchApp } from "./helpers/fetch-app";

const env: Env = {
  APP_URL: "https://example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_BOT_TOKEN: "fixture",
  DISCORD_GUILD_ID: "fixture",
  DISCORD_INVITE_URL: "/discord",
  SESSION_SECRET: "fixture-session-secret-at-least-32-bytes",
};
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

describe("fetchApp", () => {
  it("passes the original request, bindings and context to an explicit worker handler", async () => {
    const request = new Request("https://example.test/fixture?x=1", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-fixture": "present" },
      body: "request body",
    });
    const response = new Response("candidate response", { status: 202 });
    const handler = vi.fn(async (received: Request, bindings: Env, context: ExecutionContext) => {
      expect(received).toBe(request);
      expect(bindings).toBe(env);
      expect(context).toBe(ctx);
      expect(received.method).toBe("POST");
      expect(received.url).toBe("https://example.test/fixture?x=1");
      expect(received.headers.get("x-fixture")).toBe("present");
      expect(await received.text()).toBe("request body");
      return response;
    });
    expect(await fetchApp(request, env, ctx, handler)).toBe(response);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("propagates handler failures without falling back to the app", async () => {
    const error = new Error("candidate failed");
    const handler = vi.fn(() => {
      throw error;
    });
    await expect(fetchApp(new Request("https://example.test/"), env, ctx, handler)).rejects.toBe(
      error,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
