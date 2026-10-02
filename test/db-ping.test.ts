import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db/index";

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

describe.each(["https://togetherweown.com", "https://next.togetherweown.com"])(
  "removed diagnostics on %s",
  (host) => {
    it.each(["absent", "available", "unavailable"] as const)(
      "matches unknown paths with optional 404 DB lookup: %s",
      async (state) => {
        const dbRead = vi.fn(() => {
          throw new Error("fixture DB binding unavailable");
        });
        const urlRead = vi.fn(() => {
          throw new Error("fixture DATABASE_URL unavailable");
        });
        const query = vi.fn(async (sql: string) => ({
          rows: sql.includes('from "events"')
            ? [["fixture-event", "Fixture event", "2026-10-01T18:00:00Z", null]]
            : [],
        }));
        const db = drizzle(query);
        const transaction = vi.fn(async (fn: (tx: Db) => Promise<unknown>) =>
          fn(db as unknown as Db),
        );
        Object.assign(db, { transaction });
        const bindings: EnvWithAdminDb = { ...env, APP_URL: host };
        if (state !== "absent") {
          Object.defineProperties(bindings, {
            DB: { get: dbRead },
            DATABASE_URL: { get: urlRead },
          });
        }
        if (state === "available") bindings.ADMIN_DB = db as unknown as Db;
        const reads = () =>
          [dbRead, urlRead, transaction, query].map((mock) => mock.mock.calls.length);
        const clearReads = () => {
          for (const mock of [dbRead, urlRead, transaction, query]) mock.mockClear();
        };
        const headerCases = [
          { name: "no origin evidence", headers: new Headers(), unsafeStatus: 403 },
          {
            name: "bearer without origin evidence",
            headers: new Headers({
              accept: "application/json",
              authorization: "Bearer fixture-probe",
            }),
            unsafeStatus: 403,
          },
          { name: "same-origin Origin", headers: new Headers({ origin: host }), unsafeStatus: 404 },
          {
            name: "cross-origin Origin",
            headers: new Headers({ origin: "https://other.example" }),
            unsafeStatus: 403,
          },
          {
            name: "same-origin fetch metadata",
            headers: new Headers({ "sec-fetch-site": "same-origin" }),
            unsafeStatus: 404,
          },
          {
            name: "cross-site fetch metadata",
            headers: new Headers({ "sec-fetch-site": "cross-site" }),
            unsafeStatus: 403,
          },
        ];
        for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
          for (const { name, headers, unsafeStatus } of headerCases) {
            const expectedStatus = ["GET", "HEAD", "OPTIONS"].includes(method) ? 404 : unsafeStatus;
            clearReads();
            const unknown = await app.request(`${host}/not-a-route`, { method, headers }, bindings);
            const body = await unknown.text();
            const unknownReads = reads();
            expect(unknown.status, `${method} unknown route: ${name}`).toBe(expectedStatus);
            if (expectedStatus === 403 || state === "absent") {
              expect(unknownReads).toEqual([0, 0, 0, 0]);
            } else if (state === "available") {
              expect(transaction).toHaveBeenCalledOnce();
              expect(query).toHaveBeenCalledTimes(2);
              expect(dbRead).not.toHaveBeenCalled();
              expect(urlRead).not.toHaveBeenCalled();
            } else {
              // Binding failure is swallowed by the generic 404's optional lookup.
              expect(urlRead).toHaveBeenCalled();
              expect(dbRead).not.toHaveBeenCalled();
              expect(transaction).not.toHaveBeenCalled();
              expect(body).not.toContain("fixture DATABASE_URL unavailable");
            }
            if (expectedStatus === 404) {
              expect(unknown.headers.get("cache-control")).toBe("no-store, private");
              expect(unknown.headers.get("set-cookie")).toBeNull();
              if (method !== "HEAD") {
                expect(body).toContain('content="noindex, nofollow"');
                expect(body).toContain('action="/events" method="get"');
                if (state === "available") expect(body).toContain('href="/e/fixture-event"');
                else expect(body).not.toContain('data-testid="error-event-suggestion"');
              }
            }
            for (const path of removed) {
              clearReads();
              const response = await app.request(`${host}${path}`, { method, headers }, bindings);
              expect(response.status, `${method} ${path}: ${name}`).toBe(expectedStatus);
              expect(await response.text(), path).toBe(body);
              expect([...response.headers], path).toEqual([...unknown.headers]);
              expect(reads(), `${method} ${path}: ${name}`).toEqual(unknownReads);
            }
          }
        }
      },
    );

    it.each([undefined, "https://cross-origin.example.test", "null"])(
      "keeps unsafe requests with untrusted Origin %s behind the global guard",
      async (origin) => {
        const dbRead = vi.fn(() => {
          throw new Error("refused requests must not read the DB binding");
        });
        const urlRead = vi.fn(() => {
          throw new Error("refused requests must not read DATABASE_URL");
        });
        const bindings: Env = { ...env, APP_URL: host };
        Object.defineProperties(bindings, {
          DB: { get: dbRead },
          DATABASE_URL: { get: urlRead },
        });
        const headers = new Headers({
          accept: "application/json",
          authorization: "Bearer fixture-probe",
        });
        if (origin !== undefined) headers.set("origin", origin);
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          const unknown = await app.request(`${host}/not-a-route`, { method, headers }, bindings);
          const body = await unknown.text();
          expect(unknown.status).toBe(403);
          expect(JSON.parse(body)).toEqual({ error: "cross_origin" });
          for (const path of removed) {
            const response = await app.request(`${host}${path}`, { method, headers }, bindings);
            expect(response.status, `${method} ${path}`).toBe(403);
            expect(await response.text(), path).toBe(body);
            expect([...response.headers], path).toEqual([...unknown.headers]);
          }
        }
        expect(dbRead).not.toHaveBeenCalled();
        expect(urlRead).not.toHaveBeenCalled();
      },
    );

    it("rejects missing or foreign Origin on removed-path POSTs before routing or DB access", async () => {
      const dbRead = vi.fn(() => {
        throw new Error("origin rejection must not read the DB binding");
      });
      const bindings: Env = { ...env, APP_URL: host };
      Object.defineProperty(bindings, "DB", { get: dbRead });
      for (const origin of [undefined, "https://foreign.example"]) {
        const headers = origin ? { origin } : undefined;
        for (const path of ["/not-a-route", ...removed]) {
          const response = await app.request(
            `${host}${path}`,
            { method: "POST", headers },
            bindings,
          );
          expect(response.status, path).toBe(403);
          expect(await response.json(), path).toEqual({ error: "cross_origin" });
          expect(response.headers.get("cache-control"), path).toBe("no-store, private");
        }
      }
      expect(dbRead).not.toHaveBeenCalled();
    });

    it("does not register diagnostic routes for any method", () => {
      expect(app.routes.filter((route) => removed.includes(route.path))).toEqual([]);
    });
  },
);
