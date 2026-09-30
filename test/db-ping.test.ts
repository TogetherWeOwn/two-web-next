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
    const headerCases = [
      { name: "no origin evidence", headers: new Headers(), unsafeStatus: 403 },
      { name: "bearer without origin evidence", headers: new Headers({ accept: "application/json", authorization: "Bearer fixture-probe" }), unsafeStatus: 403 },
      { name: "same-origin Origin", headers: new Headers({ origin: host }), unsafeStatus: 404 },
      { name: "cross-origin Origin", headers: new Headers({ origin: "https://other.example" }), unsafeStatus: 403 },
      { name: "same-origin fetch metadata", headers: new Headers({ "sec-fetch-site": "same-origin" }), unsafeStatus: 404 },
      { name: "cross-site fetch metadata", headers: new Headers({ "sec-fetch-site": "cross-site" }), unsafeStatus: 403 },
    ];
    for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
      for (const { name, headers, unsafeStatus } of headerCases) {
        const expectedStatus = ["GET", "HEAD", "OPTIONS"].includes(method) ? 404 : unsafeStatus;
        const unknown = await app.request(`${host}/not-a-route`, { method, headers }, bindings);
        const body = await unknown.text();
        expect(unknown.status, `${method} unknown route: ${name}`).toBe(expectedStatus);
        for (const path of removed) {
          const response = await app.request(`${host}${path}`, { method, headers }, bindings);
          expect(response.status, `${method} ${path}: ${name}`).toBe(expectedStatus);
          expect(await response.text(), path).toBe(body);
          expect([...response.headers], path).toEqual([...unknown.headers]);
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
