// Offline regression coverage for the host operators copy from dry-run output.
// Keep the independent erase-confirm acceptance suite unchanged.
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as erase } from "../bin/erase-member.mjs";

const driver = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("postgres", () => ({ default: driver.factory }));

const ID = "100000000000000201";
const COUNTS = {
  users: 0,
  profiles: 0,
  rsvps: 0,
  web_sessions: 0,
  web_session_grace: 0,
  join_attempts: 0,
  overlay_configs: 0,
  overlay_tokens: 0,
};
const REMOTE_TARGETS = [
  { target: "staging", authority: "db.staging.invalid:5433", host: "db.staging.invalid" },
  { target: "production", authority: "db.production.test:5433", host: "db.production.test" },
  {
    target: "staging",
    authority: "[2001:0db8:0:0:0:0:0:1]:5433",
    host: "[2001:db8::1]",
    wrongForm: "2001:db8::1",
  },
  {
    target: "staging",
    authority: "db.staging.invalid.:5433",
    host: "db.staging.invalid.",
    wrongForm: "db.staging.invalid",
  },
  {
    target: "staging",
    authority: "DB.Staging.invalid:5433",
    host: "DB.Staging.invalid",
    wrongForm: "db.staging.invalid",
  },
];

function fakeClient() {
  const sql = vi.fn(async (strings) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text === "select pg_advisory_xact_lock(hashtextextended('two:overlay:' || ?, 0))")
      return [];
    if (/^select count\(/i.test(text)) return [{ n: 0 }];
    if (/^delete from /i.test(text)) return [];
    throw new Error(`Unexpected fixture SQL: ${text}`);
  });
  sql.begin = vi.fn(async (fn) => fn(sql));
  sql.end = vi.fn(async () => {});
  return sql;
}

async function invoke(args, databaseUrl) {
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
  try {
    const status = await erase([`--discord-id=${ID}`, ...args], { DATABASE_URL: databaseUrl });
    return { status, stdout, stderr };
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

afterEach(() => driver.factory.mockReset());

describe("erase-member exact dry-run host and copy-to-confirm flow", () => {
  for (const { target, authority, host, wrongForm } of REMOTE_TARGETS) {
    const databaseUrl = `postgres://fixture:synthetic-password@${authority}/neondb?sslmode=verify-full`;
    for (const mode of [[], ["--dry-run"]]) {
      it(`${target} ${host}: ${mode.length ? "explicit" : "default"} dry-run prints the exact URL hostname`, async () => {
        const sql = fakeClient();
        driver.factory.mockReturnValue(sql);
        const result = await invoke(["--target", target, ...mode], databaseUrl);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        const body = JSON.parse(result.stdout);
        expect(body).toMatchObject({
          ok: true,
          mode: "dry-run",
          counts: COUNTS,
          passes: 0,
          deletesPerPass: [],
          targetHost: host,
        });
        expect(body.confirmHint).toContain("--confirm");
        expect(driver.factory).toHaveBeenCalledTimes(1);
        expect(sql).toHaveBeenCalledTimes(8);
        expect(sql.begin).not.toHaveBeenCalled();
        expect(sql.end).toHaveBeenCalledTimes(1);
        for (const privateValue of [databaseUrl, "synthetic-password", ID, "postgres://"])
          expect(result.stdout).not.toContain(privateValue);
      });
    }

    it(`${target} ${host}: the reported host can be copied verbatim into --confirm`, async () => {
      driver.factory.mockReturnValue(fakeClient());
      const dryRun = await invoke(["--target", target], databaseUrl);
      expect(dryRun.status).toBe(0);
      const reportedHost = JSON.parse(dryRun.stdout).targetHost;
      expect(reportedHost).toBe(host);

      driver.factory.mockReset();
      const sql = fakeClient();
      driver.factory.mockReturnValue(sql);
      const result = await invoke(
        ["--target", target, "--apply", "--confirm", reportedHost],
        databaseUrl,
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout);
      expect(body).toMatchObject({ ok: true, mode: "apply", counts: COUNTS });
      expect(body).not.toHaveProperty("targetHost");
      expect(body).not.toHaveProperty("confirmHint");
      expect(driver.factory).toHaveBeenCalledTimes(1);
      expect(sql.begin).toHaveBeenCalledTimes(1);
      expect(sql.end).toHaveBeenCalledTimes(1);
    });

    if (wrongForm !== undefined) {
      it(`${host}: a non-identical host form refuses before driver construction`, async () => {
        const sql = fakeClient();
        driver.factory.mockReturnValue(sql);
        const result = await invoke(
          ["--target", target, "--apply", "--confirm", wrongForm],
          databaseUrl,
        );
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "E_CONFIRM" });
        expect(driver.factory).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
        expect(sql.begin).not.toHaveBeenCalled();
      });
    }
  }
});

describe("erase-member does not add remote host guidance to local output", () => {
  for (const host of ["agent-testdb", "localhost", "127.0.0.1", "[::1]"]) {
    for (const mode of ["dry-run", "apply"]) {
      it(`${host} ${mode}: omits targetHost and confirmHint`, async () => {
        const sql = fakeClient();
        driver.factory.mockReturnValue(sql);
        const result = await invoke([`--${mode}`], `postgres://fixture@${host}:5432/postgres`);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        const body = JSON.parse(result.stdout);
        expect(body).toMatchObject({ ok: true, mode, counts: COUNTS });
        expect(body).not.toHaveProperty("targetHost");
        expect(body).not.toHaveProperty("confirmHint");
        expect(driver.factory).toHaveBeenCalledTimes(1);
        expect(sql.begin).toHaveBeenCalledTimes(mode === "apply" ? 1 : 0);
        expect(sql.end).toHaveBeenCalledTimes(1);
      });
    }
  }
});
