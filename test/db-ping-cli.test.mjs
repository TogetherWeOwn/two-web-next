import { expect, it } from "vitest";
import postgres from "postgres";
import { parseDatabaseUrl, runDbPing, PROBE_TIMEOUT_MS, CLEANUP_TIMEOUT_MS } from "../bin/db-ping-core.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const syntheticUrl = "postgres://fixture:synthetic-password@agent-testdb/probe";
const sentinel = "synthetic-driver-detail-row";

function cli(scenario, extraEnv = {}, args = []) {
  const directory = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "db-ping-test-"));
  try {
    const receipt = join(directory, "closed");
    const driver = join(directory, "driver.mjs");
    writeFileSync(driver, `
      import { appendFileSync } from 'node:fs';
      appendFileSync(process.env.RECEIPT, 'imported\\n');
      export default function postgres() {
        appendFileSync(process.env.RECEIPT, 'constructed\\n');
        if (Object.keys(process.env).some(key => key.startsWith('PG'))) throw new Error('${sentinel}');
        if (process.env.SCENARIO === 'construct') throw new Error(process.env.DATABASE_URL);
        // A live handle proves the CLI exits even if the driver never settles.
        const handle = setInterval(() => {}, 1000);
        return {
          unsafe: () => process.env.SCENARIO === 'hang' ? new Promise(() => {})
            : process.env.SCENARIO === 'success' ? Promise.resolve([{ version: '${sentinel}', now: '${sentinel}' }])
            : Promise.reject(new Error(process.env.DATABASE_URL + ' ${sentinel}')),
          end: () => {
            appendFileSync(process.env.RECEIPT, 'closed\\n');
            if (process.env.SCENARIO === 'cleanup-hang') return new Promise(() => {});
            clearInterval(handle);
            if (process.env.SCENARIO === 'cleanup-fail') throw new Error('${sentinel}');
            return Promise.resolve();
          }
        };
      }
    `);
    const driverUrl = pathToFileURL(driver).href;
    const hooks = join(directory, "hooks.mjs");
    writeFileSync(hooks, `export async function resolve(specifier, context, next) {
      if (specifier === 'postgres') return { url: ${JSON.stringify(driverUrl)}, shortCircuit: true };
      return next(specifier, context);
    }`);
    const register = join(directory, "register.mjs");
    writeFileSync(register, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)});`);
    const result = spawnSync(process.execPath, ["--import", register, "bin/db-ping.mjs", ...args], {
      // Never inherit a database credential or target from the test runner.
      env: { DATABASE_URL: syntheticUrl, SCENARIO: scenario, RECEIPT: receipt, ...extraEnv },
      encoding: "utf8", timeout: 8500,
    });
    let receiptText = "";
    try { receiptText = readFileSync(receipt, "utf8"); } catch {}
    return { ...result, closed: receiptText.includes("closed"), receipt: receiptText };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it("redacts injected URL/password/row failures and closes before CLI exit", () => {
  const result = cli("failure");
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim()).toBe('{"ok":false,"code":"DB_PING_FAILED"}');
  expect(result.stderr).not.toContain("synthetic-password");
  expect(result.stderr).not.toContain(sentinel);
  expect(result.closed).toBe(true);
});

for (const [scenario, code] of [["construct", "DB_PING_FAILED"],
  ["cleanup-fail", "DB_PING_CLEANUP_FAILED"], ["cleanup-hang", "DB_PING_CLEANUP_TIMEOUT"]]) {
  it(`bounds and redacts ${scenario} at the CLI boundary`, () => {
    const started = performance.now();
    const output = cli(scenario);
    expect(output.error).toBeUndefined();
    expect(output.status).toBe(1);
    expect(output.stderr.trim()).toBe(JSON.stringify({ ok: false, code }));
    expect(output.stdout).toBe("");
    expect(output.closed).toBe(scenario !== "construct");
    expect(performance.now() - started).toBeLessThan(2500);
  });
}

it("terminates a never-resolving driver with a live handle after attempting cleanup", () => {
  const started = performance.now();
  const output = cli("hang");
  expect(output.error).toBeUndefined();
  expect(output.status).toBe(1);
  expect(output.closed).toBe(true);
  expect(output.stderr.trim()).toBe('{"ok":false,"code":"DB_PING_TIMEOUT"}');
  expect(performance.now() - started).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS);
  expect(performance.now() - started).toBeLessThan(PROBE_TIMEOUT_MS + CLEANUP_TIMEOUT_MS + 2000);
}, 10000);

it("refuses argv credentials and missing config before even importing the driver", () => {
  for (const output of [cli("success", { DATABASE_URL: "" }), cli("success", {}, [syntheticUrl])]) {
    expect(output.status).toBe(2);
    expect(output.stderr.trim()).toBe('{"ok":false,"code":"DB_PING_CONFIG"}');
    expect(output.stdout).toBe("");
    expect(output.receipt).toBe("");
  }
});

it("discards all ambient libpq settings in the standalone process", () => {
  const output = cli("success", { PGHOST: "wrong-host", PGPORT: "1234", PGDATABASE: "wrong-db",
    PGUSER: "wrong-user", PGPASSWORD: "wrong-password", PGAPPNAME: sentinel,
    PGSSLMODE: "disable", PGTARGETSESSIONATTRS: "not-a-valid-value" });
  expect(output.status).toBe(0);
  expect(output.closed).toBe(true);
});

it("emits only stable success metadata, not driver rows", () => {
  const result = cli("success");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('{"ok":true,"code":"DB_PING_OK"}');
  expect(result.stderr).toBe("");
  expect(result.closed).toBe(true);
});

const invalidUrls = [undefined, "", "not-a-url", "https://fixture:password@agent-testdb/probe",
  "postgres:///probe", "postgres://fixture@/probe", "postgres://agent-testdb/probe",
  "postgres://fixture@agent-testdb", "postgres://fixture@agent-testdb/",
  "postgres://fixture@agent-testdb:0/probe", "postgres://fixture@agent-testdb:65536/probe",
  "postgres://fixture@agent-testdb:abc/probe", "postgres://fixture@agent-testdb/probe#secret",
  "postgres://fixture@agent-testdb/probe?host=other", "postgres://fixture@agent-testdb/probe?password=other",
  "postgres://fixture@agent-testdb/probe?port=2345", "postgres://fixture@agent-testdb/probe?sslmode=prefer",
  "postgres://fixture@agent-testdb/probe?sslmode=require&sslmode=disable",
  "postgres://fixture@agent-testdb/probe?sslrootcert=/secret",
  "postgres://fixture@agent-testdb/probe?options=-csearch_path=secret",
  "postgres://fixture@agent-testdb/probe?search_path=secret", " postgres://fixture@agent-testdb/probe",
  "postgres://fixture@agent-testdb/probe\n", "postgres://fixture@host,other/probe",
  "postgres://fixture@%2ftmp/probe", "postgres://fixture@agent-testdb/%2fother",
  "postgres://fixture@agent-testdb/%00", "postgres://fixture:%00@agent-testdb/probe",
  "postgres://fixture:%xx@agent-testdb/probe"];

it.each(invalidUrls)("refuses invalid configuration before constructing a client (%s)", async databaseUrl => {
  let constructed = false;
  const output = await runDbPing({ databaseUrl, createClient: () => { constructed = true; } });
  expect(output).toEqual({ ok: false, code: "DB_PING_CONFIG", exitCode: 2 });
  expect(constructed).toBe(false);
});

it("pins decoded fields, IPv6, TLS and defaults without consulting libpq", async () => {
  const options = parseDatabaseUrl("postgresql://user%40name:p%40ss@[::1]:6543/probe?sslmode=verify-full");
  expect(options.host).toEqual(["::1"]);
  expect(options.port).toEqual([6543]);
  expect(options.username).toBe("user@name");
  expect(options.password()).toBe("p@ss");
  expect(options.database).toBe("probe");
  expect(options.ssl).toBe("verify-full");
  expect(parseDatabaseUrl(`${syntheticUrl}?sslmode=require`).ssl).toBe("require");
  expect(parseDatabaseUrl(`${syntheticUrl}?sslmode=require&sslrootcert=system`).ssl).toBe("verify-full");

  const keys = { PGHOST: "wrong-host", PGPORT: "1234", PGDATABASE: "wrong-db",
    PGUSER: "wrong-user", PGUSERNAME: "wrong-username", PGPASSWORD: "wrong-password" };
  const previous = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
  let sql;
  try {
    Object.assign(process.env, keys);
    // Real driver's lazy option parsing only. No query => no socket opened.
    sql = postgres(parseDatabaseUrl("postgres://agent_test@agent-testdb/probe"));
    expect(sql.options.host).toEqual(["agent-testdb"]);
    expect(sql.options.port).toEqual([5432]);
    expect(sql.options.user).toBe("agent_test");
    expect(sql.options.database).toBe("probe");
    expect(sql.options.pass()).toBe("");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await sql?.end({ timeout: 0 });
  }
});

for (const phase of ["connect", "query"]) {
  it(`bounds never-resolving ${phase} fixtures and always attempts cleanup`, async () => {
    let connected = false;
    let closed = false;
    const started = performance.now();
    const output = await runDbPing({ databaseUrl: syntheticUrl, timeoutMs: 30, cleanupTimeoutMs: 20,
      createClient: options => {
        expect(options.connect_timeout).toBe(0.03);
        expect(options.connection.statement_timeout).toBe(30);
        return {
          unsafe: async statement => {
            expect(statement).toBe("SELECT 1 AS ok");
            if (phase === "connect") await new Promise(() => {});
            connected = true;
            await new Promise(() => {});
          },
          end: async options => { expect(options).toEqual({ timeout: 0 }); closed = true; },
        };
      } });
    expect(output.code).toBe("DB_PING_TIMEOUT");
    expect(output.exitCode).toBe(1);
    expect(connected).toBe(phase === "query");
    expect(closed).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });
}

it("bounds cleanup after success and absorbs late query rejection after timeout", async () => {
  let cleanup = false;
  const output = await runDbPing({ databaseUrl: syntheticUrl, timeoutMs: 30, cleanupTimeoutMs: 20,
    createClient: () => ({ unsafe: async () => [], end: () => { cleanup = true; return new Promise(() => {}); } }) });
  expect(cleanup).toBe(true);
  expect(output.code).toBe("DB_PING_CLEANUP_TIMEOUT");
  expect(output.exitCode).toBe(1);
  let reject;
  const late = await runDbPing({ databaseUrl: syntheticUrl, timeoutMs: 30, cleanupTimeoutMs: 20,
    createClient: () => ({ unsafe: () => new Promise((_, r) => { reject = r; }), end: async () => {} }) });
  expect(late.code).toBe("DB_PING_TIMEOUT");
  reject(new Error(sentinel));
  await new Promise(resolve => setImmediate(resolve));
});
