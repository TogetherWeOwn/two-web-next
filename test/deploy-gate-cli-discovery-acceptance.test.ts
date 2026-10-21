// Offline acceptance fixtures for agent-discoverable deploy-gate CLIs.
//
// Four operator CLIs must answer the standard discovery gesture: --help exits 0
// with usage on stdout and zero side effects, --json/--dry-run where the family
// needs them, and exit codes that separate mis-invocation (2) from a failed
// verdict (1). Every case runs offline: loopback servers, temp receipt files,
// and scrubbed environments only. No staging, no database, and no filesystem
// effects outside temp dirs.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPROVED_MODERATOR_ROLE_IDS } from "../src/probes/check-moderators";

const BIN = fileURLToPath(new URL("../bin/", import.meta.url).href);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "81da0f67-1e2c-4b6e-9a53-0c7c1d2e3f40";
const FIXTURE_TOKEN = "fixture-only-qa-token";
const CODE_PATTERN = /(?:\bcode\b|\breason\b)\s*[=:]\s*["']?([A-Za-z0-9][A-Za-z0-9_.-]*)/i;

type RunResult = { status: number | null; stdout: string; stderr: string };

function runCli(
  script: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): RunResult {
  const nodeArgs =
    script === "check-moderators.mjs"
      ? ["--import", join(BIN, "ts-hook.mjs"), join(BIN, script), ...args]
      : [join(BIN, script), ...args];
  const result = spawnSync(process.execPath, nodeArgs, {
    encoding: "utf8",
    timeout: 20_000,
    cwd: opts.cwd,
    // PATH-only base: help, usage errors, and dry runs must not depend on
    // ambient credentials, and record/verify probes must not write step
    // summaries outside the test.
    env: { PATH: process.env.PATH ?? "", ...opts.env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Async spawn for tests that serve loopback fixtures: spawnSync blocks the
// event loop, so the fixture server could never answer the child.
function runCliAsync(
  script: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<RunResult> {
  const nodeArgs =
    script === "check-moderators.mjs"
      ? ["--import", join(BIN, "ts-hook.mjs"), join(BIN, script), ...args]
      : [join(BIN, script), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: opts.cwd,
      env: { PATH: process.env.PATH ?? "", ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function dirEntries(dir: string): string[] {
  return readdirSync(dir).sort();
}

function codeToken(output: string): string | null {
  return output.match(CODE_PATTERN)?.[1] ?? null;
}

async function withUpServer<T>(
  body: unknown,
  status: number,
  fn: (ctx: { origin: string; hits: () => number }) => T | Promise<T>,
): Promise<T> {
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    response.setHeader("content-type", "application/json");
    response.statusCode = status;
    response.end(request.url === "/up" ? JSON.stringify(body) : "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await fn({ origin, hits: () => hits });
  } finally {
    server.close();
  }
}

describe("revision-check discovery contract", () => {
  it("--help exits 0 with usage on stdout and no probe output", () => {
    withTempDir("revision-help-", (dir) => {
      const before = dirEntries(dir);
      const result = runCli("revision-check.mjs", ["--help"], { cwd: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Usage:/);
      expect(result.stdout).toContain("revision-check.mjs");
      expect(result.stdout).toContain("--json");
      expect(result.stdout).toContain("--help");
      expect(result.stdout).not.toMatch(/Live before deploy|unreadable|Deployed revision verified/);
      expect(result.stderr).toBe("");
      expect(dirEntries(dir)).toEqual(before);
    });
  });

  it("--help is never parsed as the origin positional or the commit value", async () => {
    await withUpServer({ revision: { version_id: VERSION, commit: COMMIT } }, 200, ({ origin }) =>
      withTempDirAsync("revision-help-arg-", async (dir) => {
        for (const args of [
          [origin, "--help"],
          ["--help", origin],
        ]) {
          const result = await runCliAsync("revision-check.mjs", args, { cwd: dir });
          expect(result.status, JSON.stringify(args)).toBe(0);
          expect(result.stdout).toMatch(/Usage:/);
          expect(result.stderr).toBe("");
        }
      }),
    );
    await withUpServer({ revision: { version_id: VERSION, commit: COMMIT } }, 200, (server) =>
      withTempDirAsync("revision-help-no-fetch-", async (dir) => {
        const result = await runCliAsync("revision-check.mjs", ["--help", server.origin], {
          cwd: dir,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Usage:/);
        // Help short-circuits before any probe: the origin is never fetched.
        expect(server.hits()).toBe(0);
      }),
    );
  });

  it("--json is a flag, never an origin: bare --json is a usage error", () => {
    withTempDir("revision-json-origin-", (dir) => {
      const result = runCli("revision-check.mjs", ["--json"], { cwd: dir });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/Usage:/);
      expect(result.stdout).toBe("");
    });
  });

  it("--json record mode emits a versioned verdict and never fails", async () => {
    await withUpServer(
      { revision: { version_id: VERSION, commit: COMMIT } },
      200,
      ({ origin, hits }) =>
        withTempDirAsync("revision-json-record-", async (dir) => {
          const before = dirEntries(dir);
          const result = await runCliAsync("revision-check.mjs", [origin, "--json"], { cwd: dir });
          expect(result.status).toBe(0);
          expect(result.stderr).toBe("");
          const verdict = JSON.parse(result.stdout);
          expect(verdict).toMatchObject({
            version: 1,
            mode: "record",
            commit: COMMIT,
            verified: true,
          });
          expect(typeof verdict.code).toBe("string");
          expect(verdict.code.length).toBeGreaterThan(0);
          expect(typeof verdict.next_action).toBe("string");
          expect(verdict.next_action.length).toBeGreaterThan(0);
          expect(hits()).toBeGreaterThan(0);
          expect(dirEntries(dir)).toEqual(before);
        }),
    );
    await withUpServer({ status: "healthy" }, 200, ({ origin }) =>
      withTempDirAsync("revision-json-nomarker-", async (dir) => {
        const result = await runCliAsync("revision-check.mjs", [origin, "--json"], { cwd: dir });
        expect(result.status).toBe(0);
        const verdict = JSON.parse(result.stdout);
        expect(verdict).toMatchObject({ version: 1, mode: "record", verified: false });
        expect(verdict.commit).toBeNull();
      }),
    );
  });

  it("--json verify mode exits 0 on the deployed commit with pure-JSON stdout", async () => {
    await withUpServer({ revision: { version_id: VERSION, commit: COMMIT } }, 200, ({ origin }) =>
      withTempDirAsync("revision-json-verify-", async (dir) => {
        const result = await runCliAsync("revision-check.mjs", [origin, COMMIT, "--json"], {
          cwd: dir,
        });
        expect(result.status).toBe(0);
        // The whole stdout parses: no attempt chatter mixed into the verdict.
        const verdict = JSON.parse(result.stdout);
        expect(verdict).toMatchObject({
          version: 1,
          mode: "verify",
          commit: COMMIT,
          verified: true,
        });
        expect(typeof verdict.code).toBe("string");
        expect(verdict.code.length).toBeGreaterThan(0);
        expect(typeof verdict.next_action).toBe("string");
        expect(verdict.next_action.length).toBeGreaterThan(0);
      }),
    );
  });

  it("--json verdict codes are stable for the same live state", async () => {
    await withUpServer({ revision: { version_id: VERSION, commit: COMMIT } }, 200, ({ origin }) =>
      withTempDirAsync("revision-json-stable-", async (dir) => {
        const first = await runCliAsync("revision-check.mjs", [origin, "--json"], { cwd: dir });
        const second = await runCliAsync("revision-check.mjs", [origin, "--json"], { cwd: dir });
        expect(first.status).toBe(0);
        expect(second.status).toBe(0);
        expect(JSON.parse(first.stdout).code).toBe(JSON.parse(second.stdout).code);
      }),
    );
  });

  it("human output is unchanged without --json", async () => {
    await withUpServer({ revision: { version_id: VERSION, commit: COMMIT } }, 200, ({ origin }) =>
      withTempDirAsync("revision-human-", async (dir) => {
        const record = await runCliAsync("revision-check.mjs", [origin], { cwd: dir });
        expect(record.status).toBe(0);
        expect(record.stdout).toMatch(/Live before deploy/);
        const verify = await runCliAsync("revision-check.mjs", [origin, COMMIT], { cwd: dir });
        expect(verify.status).toBe(0);
        expect(verify.stdout).toMatch(/Deployed revision verified/);
      }),
    );
    await withUpServer({ status: "healthy" }, 200, ({ origin }) =>
      withTempDirAsync("revision-human-nomarker-", async (dir) => {
        const record = await runCliAsync("revision-check.mjs", [origin], { cwd: dir });
        expect(record.status).toBe(0);
        expect(record.stdout).toMatch(/no revision marker/);
      }),
    );
  });

  it("mis-invocation still exits 2 with usage on stderr", () => {
    withTempDir("revision-misinv-", (dir) => {
      for (const args of [
        [],
        ["http://127.0.0.1:1", "main"],
        ["http://127.0.0.1:1", COMMIT, "x"],
      ]) {
        const result = runCli("revision-check.mjs", args, { cwd: dir });
        expect(result.status, JSON.stringify(args)).toBe(2);
        expect(result.stderr).toMatch(/Usage:/);
      }
    });
  });
});

describe("alert-probe discovery contract", () => {
  it("--help exits 0 with usage on stdout and zero effects", () => {
    withTempDir("alert-help-", (dir) => {
      const before = dirEntries(dir);
      // No token, no receipt file: help must not validate inputs or send.
      const result = runCli("alert-probe.mjs", ["--help"], { cwd: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Usage:/);
      expect(result.stdout).toContain("alert-probe.mjs");
      expect(result.stdout).toContain("--receipt-file");
      expect(result.stdout).toContain("--dry-run");
      expect(result.stdout).toContain("--help");
      expect(result.stderr).toBe("");
      expect(dirEntries(dir)).toEqual(before);
    });
  });

  it("--help wins in any argv position and is never a receipt path", () => {
    withTempDir("alert-help-arg-", (dir) => {
      const receipt = join(dir, "tail.json");
      writeFileSync(receipt, '{"logs":[]}\n');
      for (const args of [
        ["--help", "--receipt-file", receipt],
        ["--receipt-file", receipt, "--help"],
        ["--receipt-file", "--help"],
      ]) {
        const result = runCli("alert-probe.mjs", args, {
          cwd: dir,
          env: { QA_AUTH_TOKEN: FIXTURE_TOKEN },
        });
        expect(result.status, JSON.stringify(args)).toBe(0);
        expect(result.stdout).toMatch(/Usage:/);
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain(FIXTURE_TOKEN);
      }
      expect(readFileSync(receipt, "utf8")).toBe('{"logs":[]}\n');
      expect(dirEntries(dir)).toEqual(["tail.json"]);
    });
  });

  it("--dry-run validates the receipt file plus env presence without sending", () => {
    withTempDir("alert-dryrun-", (dir) => {
      const receipt = join(dir, "tail.json");
      writeFileSync(receipt, '{"logs":[]}\n');
      const result = runCli("alert-probe.mjs", ["--receipt-file", receipt, "--dry-run"], {
        cwd: dir,
        env: { QA_AUTH_TOKEN: FIXTURE_TOKEN },
      });
      // Offline exit 0 proves no delivery was attempted: a real send cannot
      // succeed with an unconnected receipt file and no network.
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const verdict = JSON.parse(result.stdout);
      expect(typeof verdict.code).toBe("string");
      expect(verdict.code.length).toBeGreaterThan(0);
      expect(verdict.dry_run === true || verdict.mode === "dry-run").toBe(true);
      expect(result.stdout).not.toContain(FIXTURE_TOKEN);
      expect(readFileSync(receipt, "utf8")).toBe('{"logs":[]}\n');
      expect(dirEntries(dir)).toEqual(["tail.json"]);
    });
  });

  it("--dry-run exits 2 with a structured reason when inputs are missing", () => {
    withTempDir("alert-dryrun-missing-", (dir) => {
      const receipt = join(dir, "tail.json");
      writeFileSync(receipt, '{"logs":[]}\n');
      const missingFile = runCli(
        "alert-probe.mjs",
        ["--receipt-file", join(dir, "absent.json"), "--dry-run"],
        { cwd: dir, env: { QA_AUTH_TOKEN: FIXTURE_TOKEN } },
      );
      expect(missingFile.status).toBe(2);
      expect(codeToken(`${missingFile.stdout}\n${missingFile.stderr}`)).not.toBeNull();
      expect(`${missingFile.stdout}\n${missingFile.stderr}`).not.toContain(FIXTURE_TOKEN);

      const missingToken = runCli("alert-probe.mjs", ["--receipt-file", receipt, "--dry-run"], {
        cwd: dir,
      });
      expect(missingToken.status).toBe(2);
      expect(codeToken(`${missingToken.stdout}\n${missingToken.stderr}`)).not.toBeNull();

      const missingReceipt = runCli("alert-probe.mjs", ["--dry-run"], {
        cwd: dir,
        env: { QA_AUTH_TOKEN: FIXTURE_TOKEN },
      });
      expect(missingReceipt.status).toBe(2);
      expect(missingReceipt.stderr).toMatch(/Usage:/);
    });
  });

  it("mis-invocation exits 2 with a stable reason code, never the token", () => {
    withTempDir("alert-misinv-", (dir) => {
      const receipt = join(dir, "tail.json");
      writeFileSync(receipt, '{"logs":[]}\n');
      const cases: string[][] = [
        [],
        ["--receipt-file"],
        ["--unknown"],
        ["--receipt-file", receipt, "extra"],
        // A flag-shaped value is rejected at argv level, never used as a path.
        ["--receipt-file", "--dry-run"],
      ];
      for (const args of cases) {
        const result = runCli("alert-probe.mjs", args, {
          cwd: dir,
          env: { QA_AUTH_TOKEN: FIXTURE_TOKEN },
        });
        expect(result.status, JSON.stringify(args)).toBe(2);
        expect(result.stderr).toMatch(/Usage:|--receipt-file/);
        expect(codeToken(result.stderr)).not.toBeNull();
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(FIXTURE_TOKEN);
      }
      const again = runCli("alert-probe.mjs", ["--unknown"], {
        cwd: dir,
        env: { QA_AUTH_TOKEN: FIXTURE_TOKEN },
      });
      const first = runCli("alert-probe.mjs", ["--unknown"], {
        cwd: dir,
        env: { QA_AUTH_TOKEN: FIXTURE_TOKEN },
      });
      expect(codeToken(again.stderr)).toBe(codeToken(first.stderr));
    });
  });

  it("real runs keep the no-credential failure line and add a reason code", () => {
    withTempDir("alert-failure-line-", (dir) => {
      const receipt = join(dir, "tail.json");
      writeFileSync(receipt, '{"logs":[]}\n');
      // Missing token fails before any read or send: offline-safe.
      const result = runCli("alert-probe.mjs", ["--receipt-file", receipt], { cwd: dir });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("no delivery claimed");
      expect(codeToken(result.stderr)).not.toBeNull();
      // Unreadable receipt also fails before any send.
      const unreadable = runCli("alert-probe.mjs", ["--receipt-file", join(dir, "absent.json")], {
        cwd: dir,
        env: { QA_AUTH_TOKEN: FIXTURE_TOKEN },
      });
      expect(unreadable.status).toBe(2);
      expect(unreadable.stderr).toContain("no delivery claimed");
      expect(`${unreadable.stdout}\n${unreadable.stderr}`).not.toContain(FIXTURE_TOKEN);
    });
  });
});

describe("seed-staging discovery contract", () => {
  const fixtureEnv = {
    APP_URL: "http://localhost:8787",
    SEED_CONFIRM: "staging",
    DATABASE_URL: "postgres://agent_test@agent-testdb:5432/two_web_next",
  };

  it("--help exits 0 with usage on stdout and zero effects", () => {
    withTempDir("seed-help-", (dir) => {
      const before = dirEntries(dir);
      // Empty environment: help must not validate env or touch the database.
      const result = runCli("seed-staging.mjs", ["--help"], { cwd: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Usage:/);
      expect(result.stdout).toContain("seed-staging.mjs");
      expect(result.stdout).toContain("--dry-run");
      expect(result.stdout).toContain("--apply");
      expect(result.stdout).toContain("--help");
      expect(result.stderr).toBe("");
      expect(dirEntries(dir)).toEqual(before);
    });
  });

  it("--help wins over mode flags in any position", () => {
    withTempDir("seed-help-arg-", (dir) => {
      for (const args of [
        ["--help", "--apply"],
        ["--apply", "--help"],
        ["--help", "--dry-run"],
      ]) {
        const result = runCli("seed-staging.mjs", args, { cwd: dir });
        expect(result.status, JSON.stringify(args)).toBe(0);
        expect(result.stdout).toMatch(/Usage:/);
        expect(result.stderr).toBe("");
      }
      expect(dirEntries(dir)).toEqual([]);
    });
  });

  it("mis-invocation fails with usage on stderr and no secret leak", () => {
    withTempDir("seed-misinv-", (dir) => {
      for (const args of [["--unknown"], ["--apply", "--dry-run"], ["postgres://secret@live/db"]]) {
        const result = runCli("seed-staging.mjs", args, { cwd: dir, env: fixtureEnv });
        expect([1, 2]).toContain(result.status);
        expect(result.stderr).toMatch(/Usage:/);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("secret@live");
        expect(result.stderr).not.toContain("postgres://");
      }
    });
  });

  it("default dry-run still plans without connecting", () => {
    withTempDir("seed-dryrun-", (dir) => {
      const result = runCli("seed-staging.mjs", [], { cwd: dir, env: fixtureEnv });
      expect(result.status).toBe(0);
      const plan = JSON.parse(result.stdout);
      expect(plan).toMatchObject({ mode: "dry-run" });
      expect(plan.planned).toMatchObject({ events: 50, users: 3, rsvps: 12, featured: 3 });
      expect(result.stdout).not.toContain("agent_test@");
    });
  });

  it("production refusals still fail closed without disclosing URLs", () => {
    withTempDir("seed-refusal-", (dir) => {
      const result = runCli("seed-staging.mjs", [], {
        cwd: dir,
        env: { ...fixtureEnv, APP_URL: "https://togetherweown.com" },
      });
      expect([1, 2]).toContain(result.status);
      expect(result.stderr).toMatch(/production APP_URL/);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("postgres://");
    });
  });
});

describe("check-moderators discovery contract", () => {
  it("--help exits 0 with usage on stdout and zero effects", () => {
    withTempDir("moderators-help-", (dir) => {
      const before = dirEntries(dir);
      // Empty environment: help must not read config or run the probe.
      const result = runCli("check-moderators.mjs", ["--help"], { cwd: dir });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Usage:/);
      expect(result.stdout).toContain("check-moderators");
      expect(result.stdout).toContain("--require-configured");
      expect(result.stdout).toContain("--json");
      expect(result.stdout).toContain("--config");
      expect(result.stdout).toContain("--env");
      expect(result.stdout).toContain("--help");
      expect(result.stderr).toBe("");
      expect(dirEntries(dir)).toEqual(before);
    });
  });

  it("--help wins over probe and config flags without reading anything", () => {
    withTempDir("moderators-help-arg-", (dir) => {
      for (const args of [
        ["--help", "--require-configured"],
        ["--require-configured", "--help"],
        ["--help", "--config=/nonexistent-wrangler.jsonc"],
      ]) {
        const result = runCli("check-moderators.mjs", args, { cwd: dir });
        expect(result.status, JSON.stringify(args)).toBe(0);
        expect(result.stdout).toMatch(/Usage:/);
        expect(result.stderr).toBe("");
      }
      expect(dirEntries(dir)).toEqual([]);
    });
  });

  it("mis-invocation still exits 2", () => {
    withTempDir("moderators-misinv-", (dir) => {
      for (const args of [["--bogus"], ["--env=staging"]]) {
        const result = runCli("check-moderators.mjs", args, { cwd: dir });
        expect(result.status, JSON.stringify(args)).toBe(2);
        expect(result.stderr.length).toBeGreaterThan(0);
      }
    });
  });

  it("probe behavior is unchanged: blank passes, approved pair passes, json shape holds", () => {
    withTempDir("moderators-probe-", (dir) => {
      const blank = runCli("check-moderators.mjs", [], {
        cwd: dir,
        env: { DISCORD_MODERATOR_ROLE_IDS: "" },
      });
      expect(blank.status).toBe(0);
      expect(blank.stdout).toMatch(/PASS/);

      const approved = APPROVED_MODERATOR_ROLE_IDS.join(",");
      const configured = runCli("check-moderators.mjs", ["--require-configured"], {
        cwd: dir,
        env: { DISCORD_MODERATOR_ROLE_IDS: approved },
      });
      expect(configured.status).toBe(0);

      const json = runCli("check-moderators.mjs", ["--require-configured", "--json"], {
        cwd: dir,
        env: { DISCORD_MODERATOR_ROLE_IDS: approved },
      });
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ failures: 0, unknowns: 0, ok: true });

      const doomed = runCli("check-moderators.mjs", ["--require-configured"], {
        cwd: dir,
        env: { DISCORD_MODERATOR_ROLE_IDS: "508654771276873729" },
      });
      expect(doomed.status).toBe(1);
    });
  });
});
