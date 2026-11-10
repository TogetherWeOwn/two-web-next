// Acceptance contract: exercise the real parsers, main functions and member
// operations. Only the postgres.js boundary is replaced; no sockets or DBs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as erase, parseEraseArgs } from "../bin/erase-member.mjs";
import { main as revoke, parseRevokeArgs } from "../bin/revoke-sessions.mjs";
import { SESSION_ABSOLUTE_MAX_AGE_SECONDS } from "../src/sessions";

const driver = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("postgres", () => ({ default: driver.factory }));

const ID = "100000000000000201";
const OTHER_ID = "100000000000000202";
const SECRET = "synthetic-password";
const HOST = "db.fixture.invalid";
const ROW = "private-fixture-row";
const RAW_URL = `postgres://fixture:${SECRET}@${HOST}/fixture?sslmode=verify-full`;
const LOCAL_ENV = { DATABASE_URL: "postgres://fixture@localhost/fixture" };
const COUNTS = {
  users: 1,
  profiles: 2,
  rsvps: 3,
  web_sessions: 4,
  web_session_grace: 5,
  join_attempts: 6,
};
const CODES = [
  "E_MODE_CONFLICT",
  "E_TARGET",
  "E_DUPLICATE_FLAG",
  "E_UNKNOWN_FLAG",
  "E_URL_ARG",
  "E_DISCORD_ID",
  "LOCK_TIMEOUT",
  "TX_FAILED",
];

const invalidArgs = [
  {
    name: "mixed modes",
    tail: ["--apply", "--dry-run"],
    code: "E_MODE_CONFLICT",
    reason: /conflict|both|together|exclusive/i,
    next: /mode|--apply|--dry-run/i,
  },
  {
    name: "reversed mixed modes",
    tail: ["--dry-run", "--apply"],
    code: "E_MODE_CONFLICT",
    reason: /conflict|both|together|exclusive/i,
    next: /mode|--apply|--dry-run/i,
  },
  {
    name: "repeated apply",
    tail: ["--apply", "--apply"],
    code: "E_DUPLICATE_FLAG",
    reason: /duplicat|repeat|once|multiple|already/i,
    next: /flag|--apply|duplicat|repeat|once/i,
  },
  {
    name: "repeated dry-run",
    tail: ["--dry-run", "--dry-run"],
    code: "E_DUPLICATE_FLAG",
    reason: /duplicat|repeat|once|multiple|already/i,
    next: /flag|--dry-run|duplicat|repeat|once/i,
  },
  {
    name: "repeated id",
    tail: [`--discord-id=${OTHER_ID}`],
    code: "E_DUPLICATE_FLAG",
    reason: /duplicat|repeat|once|multiple|already/i,
    next: /flag|discord|duplicat|repeat|once/i,
  },
  {
    name: "empty first id still counts as present",
    args: ["--discord-id=", `--discord-id=${ID}`],
    code: "E_DUPLICATE_FLAG",
    reason: /duplicat|repeat|once|multiple|already/i,
    next: /flag|discord|duplicat|repeat|once/i,
  },
  {
    name: "repeated target forms",
    tail: ["--target", "staging", "--target=production"],
    code: "E_DUPLICATE_FLAG",
    reason: /duplicat|repeat|once|multiple|already/i,
    next: /flag|target|duplicat|repeat|once/i,
  },
  {
    name: "missing target",
    tail: ["--target"],
    code: "E_TARGET",
    reason: /target/i,
    next: /target|staging|production/i,
  },
  {
    name: "empty target",
    tail: ["--target="],
    code: "E_TARGET",
    reason: /target/i,
    next: /target|staging|production/i,
  },
  {
    name: "unknown target",
    tail: ["--target=sideways"],
    code: "E_TARGET",
    reason: /target/i,
    next: /target|staging|production/i,
  },
  {
    name: "target is case-sensitive",
    tail: ["--target=STAGING"],
    code: "E_TARGET",
    reason: /target/i,
    next: /target|staging|production/i,
  },
  {
    name: "mode cannot be consumed as target",
    tail: ["--target", "--apply"],
    code: "E_TARGET",
    reason: /target/i,
    next: /target|staging|production/i,
  },
  {
    name: "wrong flag with apply",
    tail: ["--apply", "--apppy"],
    code: "E_UNKNOWN_FLAG",
    reason: /unknown|unrecogni|unsupported|unexpected/i,
    next: /flag|option|help|remove/i,
  },
  {
    name: "unknown value flag",
    tail: ["--apply=true"],
    code: "E_UNKNOWN_FLAG",
    reason: /unknown|unrecogni|unsupported|unexpected/i,
    next: /flag|option|help|remove/i,
  },
  {
    name: "URL instead of id",
    args: [RAW_URL],
    code: "E_URL_ARG",
    reason: /url|connection/i,
    next: /env|DATABASE_URL/i,
  },
  {
    name: "URL after apply",
    tail: ["--apply", RAW_URL],
    code: "E_URL_ARG",
    reason: /url|connection/i,
    next: /env|DATABASE_URL/i,
  },
  {
    name: "missing id",
    args: [],
    code: "E_DISCORD_ID",
    reason: /discord.*id|snowflake/i,
    next: /discord|snowflake/i,
  },
  {
    name: "empty id",
    args: ["--discord-id="],
    code: "E_DISCORD_ID",
    reason: /discord.*id|snowflake/i,
    next: /discord|snowflake/i,
  },
  {
    name: "malformed id",
    args: [`--discord-id=${ROW}\n${SECRET}`],
    code: "E_DISCORD_ID",
    reason: /discord.*id|snowflake/i,
    next: /discord|snowflake/i,
  },
  {
    name: "noncanonical id with apply",
    args: ["--discord-id=007", "--apply"],
    code: "E_DISCORD_ID",
    reason: /discord.*id|snowflake/i,
    next: /discord|snowflake/i,
  },
].map((row) => ({ ...row, args: row.args ?? [`--discord-id=${ID}`, ...row.tail] }));

// A tiny SQL boundary fixture supplies distinct hand-checked counts and records
// writes. The real erase/revoke functions still choose dry-run or transaction.
function fakeClient(failure) {
  const remaining = { ...COUNTS };
  const queries = [];
  const writes = [];
  const sql = async (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (failure) throw failure;
    // The fixture holds no RSVP rows, so the event lock finds no events.
    if (/^select id from events /i.test(text)) return [];
    const table = text.match(/(?:from|update) (\w+)/i)?.[1];
    if (!(table in remaining)) throw new Error(`Unexpected fixture SQL: ${text}`);
    if (/^select count\(/i.test(text)) return [{ n: remaining[table] }];
    if (/^(delete|update) /i.test(text)) {
      writes.push({ text, values });
      const count = remaining[table];
      remaining[table] = 0;
      return Array.from({ length: count }, () => ({ "?column?": 1 }));
    }
    throw new Error(`Unexpected fixture SQL: ${text}`);
  };
  sql.begin = vi.fn(async (fn) => fn(sql));
  sql.end = vi.fn(async () => {});
  return { sql, queries, writes, remaining };
}

// Both CLIs deliberately suppress ambient PG settings and driver console noise.
// Restore those process globals after each call, including when assertions fail.
async function invoke(main, args, env = LOCAL_ENV) {
  let stdout = "";
  let stderr = "";
  const methods = ["log", "info", "warn", "error", "debug", "trace"];
  const originalConsole = Object.fromEntries(methods.map((key) => [key, console[key]]));
  const pgEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("PG")),
  );
  const tls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  for (const key of methods) {
    console[key] = (...values) => {
      const line = `${values.join(" ")}\n`;
      if (key === "log" || key === "info") stdout += line;
      else stderr += line;
    };
  }
  try {
    return {
      status: await main(args, env),
      get stdout() {
        return stdout;
      },
      get stderr() {
        return stderr;
      },
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
    Object.assign(console, originalConsole);
    for (const key of Object.keys(process.env)) if (key.startsWith("PG")) delete process.env[key];
    Object.assign(process.env, pgEnv);
    if (tls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tls;
  }
}

function assertRedacted(text) {
  for (const value of [RAW_URL, SECRET, HOST, ROW, ID, OTHER_ID, "postgres://", "localhost"])
    expect(text).not.toContain(value);
}

function failureJson(result, status, code) {
  expect(result.status).toBe(status);
  expect(result.stdout).toBe("");
  assertRedacted(result.stderr);
  expect(result.stderr).toMatch(/^\{[^\r\n]*\}\n$/);
  const body = JSON.parse(result.stderr);
  expect(Object.keys(body).sort()).toEqual(["code", "message", "next", "ok"]);
  expect(body.ok).toBe(false);
  expect(body.code).toMatch(/^[A-Z][A-Z_0-9]+$/);
  if (code) expect(body.code).toBe(code);
  for (const field of ["message", "next"]) {
    expect(typeof body[field]).toBe("string");
    expect(body[field].trim().length).toBeGreaterThan(0);
    expect(body[field]).not.toMatch(/[\r\n]/);
  }
  return body;
}

afterEach(() => driver.factory.mockReset());

for (const cli of [
  {
    name: "erase-member",
    main: erase,
    parse: parseEraseArgs,
    counts: COUNTS,
    passesKey: "deletesPerPass",
  },
  {
    name: "revoke-sessions",
    main: revoke,
    parse: parseRevokeArgs,
    counts: { web_sessions: 4 },
    passesKey: "stampsPerPass",
  },
]) {
  describe(`${cli.name} coded errors (offline acceptance)`, () => {
    for (const row of invalidArgs) {
      it(`parser throws a typed ${row.code}: ${row.name}`, () => {
        let thrown;
        try {
          cli.parse(row.args);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.code).toBe(row.code);
        expect(thrown.constructor).not.toBe(Error);
        expect(thrown.message).toMatch(row.reason);
        assertRedacted(thrown.message);
      });

      it(`main emits only JSON exit 2 before any client: ${row.name}`, async () => {
        const result = await invoke(cli.main, row.args);
        expect(driver.factory).not.toHaveBeenCalled();
        const body = failureJson(result, 2, row.code);
        expect(body.message).toMatch(row.reason);
        expect(body.next).toMatch(row.next);
      });
    }

    for (const env of [
      {},
      { DATABASE_URL: `https://${HOST}/${ROW}` },
      { DATABASE_URL: RAW_URL },
      { ...LOCAL_ENV, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    ]) {
      it(`configuration refusal is one redacted JSON exit 2: ${Object.keys(env).join(",") || "unset"} ${env.DATABASE_URL === RAW_URL ? "remote" : ""}`, async () => {
        const result = await invoke(cli.main, [`--discord-id=${ID}`, "--apply"], env);
        expect(driver.factory).not.toHaveBeenCalled();
        failureJson(result, 2);
      });
    }

    for (const mode of [undefined, "--dry-run", "--apply"]) {
      const expectedMode = mode === "--apply" ? "apply" : "dry-run";
      const args = [`--discord-id=${ID}`, ...(mode ? [mode] : [])];
      it(`preserves counts, chase fields and ${mode ?? "default dry-run"} without row output`, async () => {
        const fixture = fakeClient();
        driver.factory.mockReturnValue(fixture.sql);
        const result = await invoke(cli.main, args);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toMatch(/^\{[^\r\n]*\}\n$/);
        const body = JSON.parse(result.stdout);
        expect(body).toMatchObject({
          mode: expectedMode,
          counts: cli.counts,
          passes: expectedMode === "apply" ? 1 : 0,
          [cli.passesKey]: expectedMode === "apply" ? [4] : [],
        });
        expect(fixture.queries.length).toBeGreaterThan(0);
        const expectedValues =
          cli.name === "revoke-sessions" ? [ID, SESSION_ABSOLUTE_MAX_AGE_SECONDS] : [ID];
        for (const query of fixture.queries) expect(query.values).toEqual(expectedValues);
        expect(fixture.sql.begin).toHaveBeenCalledTimes(expectedMode === "apply" ? 1 : 0);
        if (expectedMode === "dry-run") {
          expect(fixture.writes).toEqual([]);
          expect(fixture.remaining).toEqual(COUNTS);
        } else {
          expect(fixture.writes.length).toBeGreaterThan(0);
        }
        expect(fixture.sql.end).toHaveBeenCalledTimes(1);
        assertRedacted(result.stdout);
      });

      it(`adds ok:true to ${mode ?? "default dry-run"} success JSON`, async () => {
        driver.factory.mockReturnValue(fakeClient().sql);
        const result = await invoke(cli.main, args);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout).ok).toBe(true);
      });
    }

    for (const sqlstate of ["55P03", "23514", "57014", "ECONNREFUSED"]) {
      for (const mode of ["--dry-run", "--apply"]) {
        it(`${sqlstate} during ${mode} has a distinct redacted runtime code`, async () => {
          const error = Object.assign(new Error(`lock timeout ${RAW_URL}\n${ROW}`), {
            code: sqlstate,
            detail: ROW,
            hint: SECRET,
            where: HOST,
          });
          const fixture = fakeClient(error);
          driver.factory.mockReturnValue(fixture.sql);
          const result = await invoke(cli.main, [`--discord-id=${ID}`, mode]);
          expect(fixture.queries.length).toBeGreaterThan(0);
          expect(fixture.sql.end).toHaveBeenCalledTimes(1);
          const body = failureJson(result, 1, sqlstate === "55P03" ? "LOCK_TIMEOUT" : "TX_FAILED");
          if (sqlstate === "55P03") {
            expect(body.message).toMatch(/lock|timeout/i);
            expect(body.next).toMatch(/retry|re-run/i);
            expect(body.next).toMatch(/lock|clear|dry.run/i);
          } else {
            expect(body.next).toMatch(/check|inspect|dry.run|connect|migration/i);
          }
        });
      }
    }

    it("client construction failure is JSON exit 1, not an escaped exception", async () => {
      driver.factory.mockImplementation(() => {
        throw new Error(`${RAW_URL}\n${ROW}`);
      });
      failureJson(await invoke(cli.main, [`--discord-id=${ID}`, "--apply"]), 1, "TX_FAILED");
    });

    it("driver console noise cannot leak secrets beside the result", async () => {
      driver.factory.mockImplementation(() => {
        console.error(RAW_URL, ROW);
        console.warn(SECRET, HOST);
        return fakeClient(Object.assign(new Error(ROW), { code: "55P03" })).sql;
      });
      failureJson(await invoke(cli.main, [`--discord-id=${ID}`, "--apply"]), 1, "LOCK_TIMEOUT");
    });

    it("help lists every stable error code without requiring configuration", async () => {
      const result = await invoke(cli.main, ["--help"], {});
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(driver.factory).not.toHaveBeenCalled();
      expect(result.stdout).toContain("Usage:");
      for (const code of CODES) expect(result.stdout).toContain(code);
    });
  });
}
