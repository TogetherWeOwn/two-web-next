// route-inventory: GET /db-ping
import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";
import { dbPing, hyperdriveQuery, type QueryRunner, type SqlFactory } from "../src/db/ping";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

// Stub the `postgres` module boundary: production calls makeSql(url, opts)
// per request (same shape as the W14 agent-events route), so the stub records
// the connection string and plays back rows/failure.
function stubMakeSql(rows: unknown[], opts?: { fail?: Error; seen?: string[]; ended?: { n: number } }): SqlFactory {
  const seen = opts?.seen ?? [];
  const ended = opts?.ended ?? { n: 0 };
  return ((url: string, _options?: Record<string, unknown>) => {
    seen.push(url);
    return {
      unsafe: async () => {
        if (opts?.fail) throw opts.fail;
        return rows;
      },
      end: async () => {
        ended.n += 1;
      },
    };
  }) as unknown as SqlFactory;
}

describe("dbPing", () => {
  it("returns version + now from one round-trip", async () => {
    const run: QueryRunner = async () => ({ rows: [{ version: "PostgreSQL 17", now: "2026-09-29" }] });
    await expect(dbPing(run)).resolves.toEqual({ ok: true, version: "PostgreSQL 17", now: "2026-09-29" });
  });

  it("rejects an unexpected row shape", async () => {
    const run: QueryRunner = async () => ({ rows: [{}] });
    await expect(dbPing(run)).rejects.toThrow("unexpected row shape");
  });

  it("propagates driver errors", async () => {
    const run: QueryRunner = async () => {
      throw new Error("connection refused");
    };
    await expect(dbPing(run)).rejects.toThrow("connection refused");
  });
});

describe("hyperdriveQuery", () => {
  it("hands the connection string to the driver and ends the client", async () => {
    const seen: string[] = [];
    const ended = { n: 0 };
    const run = hyperdriveQuery("postgres://hyperdrive-stub/db", stubMakeSql([{ one: 1 }], { seen, ended }));
    await expect(run("SELECT 1")).resolves.toEqual({ rows: [{ one: 1 }] });
    expect(seen).toEqual(["postgres://hyperdrive-stub/db"]);
    expect(ended.n).toBe(1);
  });

  it("ends the client after failure", async () => {
    const ended = { n: 0 };
    const run = hyperdriveQuery(
      "postgres://hyperdrive-stub/db",
      stubMakeSql([], { fail: new Error("timeout"), ended }),
    );
    await expect(run("SELECT 1")).rejects.toThrow("timeout");
    expect(ended.n).toBe(1);
  });
});

describe("GET /db-ping", () => {
  it("503s without a DB binding (prod-safe: no secrets in body)", async () => {
    const res = await app.request("/db-ping", {}, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "db_unavailable" });
  });
});
