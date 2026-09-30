import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";

const env: Env = {
  APP_URL: "https://togetherweown.com",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

// In-process requests only: production host/config, but no live database or network.
const removed = ["/db-ping", "/health", "/healthz"];

describe.each(["https://togetherweown.com", "https://next.togetherweown.com"])("removed diagnostics on %s", (host) => {
  it.each([false, true])("matches unknown paths with a configured DB: %s", async (configured) => {
    const dbRead = vi.fn(() => { throw new Error("removed diagnostics must not read the DB binding"); });
    const urlRead = vi.fn(() => { throw new Error("removed diagnostics must not read DATABASE_URL"); });
    const bindings: Env = { ...env, APP_URL: host };
    if (configured) {
      Object.defineProperties(bindings, {
        DB: { get: dbRead },
        DATABASE_URL: { get: urlRead },
      });
    }
    for (const method of ["GET", "HEAD", "POST"]) {
      for (const headers of [new Headers(), new Headers({ accept: "application/json", authorization: "Bearer fixture-probe" })]) {
        for (const origin of [undefined, host, "https://cross-origin.example.test"]) {
          const requestHeaders = new Headers(headers);
          if (origin !== undefined) requestHeaders.set("origin", origin);
          // Unsafe requests hit the global same-origin guard before the 404 handler.
          const status = method === "POST" && origin !== host ? 403 : 404;
          const unknown = await app.request(`${host}/not-a-route`, { method, headers: requestHeaders }, bindings);
          const body = await unknown.text();
          expect(unknown.status).toBe(status);
          for (const path of removed) {
            const response = await app.request(`${host}${path}`, { method, headers: requestHeaders }, bindings);
            expect(response.status, `${method} ${path}`).toBe(status);
            expect(await response.text(), path).toBe(body);
            expect([...response.headers], path).toEqual([...unknown.headers]);
          }
        }
      }
    }
    expect(dbRead).not.toHaveBeenCalled();
    expect(urlRead).not.toHaveBeenCalled();
  });

  it("does not register diagnostic routes for any method", () => {
    expect(app.routes.filter((route) => removed.includes(route.path))).toEqual([]);
  });
});
