import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Acceptance fixtures: safe --help for the runtime probe CLIs
// (bin/db-ping.mjs, bin/admin-authwall-probe.mjs, bin/json-smoke.mjs).
// Owned by the Test Author: the Builder builds on this branch and never edits
// this file; corrections go back through the acceptance handoff, not a local fix.
// Every case runs offline in a subprocess with a scrubbed environment: no
// inherited DATABASE_URL, QA_AUTH_TOKEN or PG* settings. --help must exit 0
// with usage on stdout, empty stderr, and zero side effects; mis-invocation
// exit codes and existing behavior stay pinned below.

const syntheticUrl = "postgres://fixture:synthetic-password@agent-testdb/probe";
const syntheticToken = "fixture-qa-token";

function scratch() {
  return mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "probe-help-"));
}

// A --import setup module that turns any network attempt into a loud,
// recorded failure. A clean receipt proves the CLI never probed.
function fetchTrap(directory, receipt) {
  const setup = join(directory, "fetch-trap.mjs");
  writeFileSync(
    setup,
    `import { appendFileSync } from "node:fs";
globalThis.fetch = async (input) => {
  appendFileSync(${JSON.stringify(receipt)}, "fetch " + String(input?.url ?? input) + "\\n");
  throw new Error("network disabled in help acceptance fixture");
};
`,
  );
  return setup;
}

// A --import loader that redirects the "postgres" specifier to a fake driver
// recording import/construction. A clean receipt proves zero DB effects.
function dbTrap(directory, receipt) {
  const driver = join(directory, "driver.mjs");
  writeFileSync(
    driver,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(receipt)}, "imported\\n");
export default function postgres() {
  appendFileSync(${JSON.stringify(receipt)}, "constructed\\n");
  throw new Error("database disabled in help acceptance fixture");
}
`,
  );
  const hooks = join(directory, "hooks.mjs");
  writeFileSync(
    hooks,
    `export async function resolve(specifier, context, next) {
  if (specifier === "postgres")
    return { url: ${JSON.stringify(pathToFileURL(driver).href)}, shortCircuit: true };
  return next(specifier, context);
};`,
  );
  const register = join(directory, "register.mjs");
  writeFileSync(
    register,
    `import { register } from "node:module"; register(${JSON.stringify(pathToFileURL(hooks).href)});`,
  );
  return register;
}

const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));

function run(script, args, { env = {}, cwd = undefined, setup = null } = {}) {
  // Absolute script path: cases run with cwd set to a scratch directory so a
  // stray file write is observable, which breaks relative script paths.
  const entry = join(repoRoot, script);
  const nodeArgs = setup ? ["--import", setup, entry, ...args] : [entry, ...args];
  return spawnSync(process.execPath, nodeArgs, {
    // Never inherit a credential, target or libpq setting from the runner.
    env,
    cwd,
    encoding: "utf8",
    timeout: 15000,
  });
}

function receiptOf(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

describe("db-ping --help", () => {
  it("exits 0 with usage on stdout and no config read", () => {
    const directory = scratch();
    try {
      const result = run("bin/db-ping.mjs", ["--help"], { env: {}, cwd: directory });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never imports or constructs the driver, and documents env inputs and exit codes", () => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const register = dbTrap(directory, receipt);
      const result = run("bin/db-ping.mjs", ["--help"], {
        env: { DATABASE_URL: syntheticUrl, RECEIPT: receipt },
        cwd: directory,
        setup: register,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("DATABASE_URL");
      expect(result.stdout).toMatch(/exit 0/i);
      expect(result.stdout).toMatch(/exit 1/i);
      expect(result.stdout).toMatch(/exit 2/i);
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("unchanged: a positional argument is still a config refusal without driver use", () => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const register = dbTrap(directory, receipt);
      const result = run("bin/db-ping.mjs", [syntheticUrl], {
        env: { DATABASE_URL: syntheticUrl, RECEIPT: receipt },
        cwd: directory,
        setup: register,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe('{"ok":false,"code":"DB_PING_CONFIG"}');
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("admin-authwall-probe --help", () => {
  it("exits 0 with usage on stdout and no token read", () => {
    const directory = scratch();
    try {
      const result = run("bin/admin-authwall-probe.mjs", ["--help"], {
        env: {},
        cwd: directory,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never sends a request, and documents env inputs and exit codes", () => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const result = run("bin/admin-authwall-probe.mjs", ["--help"], {
        env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
        cwd: directory,
        setup,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("QA_AUTH_TOKEN");
      expect(result.stdout).toMatch(/exit 0/i);
      expect(result.stdout).toMatch(/exit 1/i);
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("unchanged: an extra argument still fails without probing", () => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const result = run("bin/admin-authwall-probe.mjs", ["extra-arg"], {
        env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
        cwd: directory,
        setup,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("probe failed");
      expect(receiptOf(receipt)).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("json-smoke --help", () => {
  it("exits 0 with usage on stdout and no token read", () => {
    const directory = scratch();
    try {
      const result = run("bin/json-smoke.mjs", ["--help"], { env: {}, cwd: directory });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is never probed as a URL, and documents env inputs and exit codes", () => {
    const directory = scratch();
    try {
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const result = run("bin/json-smoke.mjs", ["--help"], {
        env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
        cwd: directory,
        setup,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("QA_AUTH_TOKEN");
      expect(result.stdout).toMatch(/exit 0/i);
      expect(result.stdout).toMatch(/exit 1/i);
      expect(result.stdout).toMatch(/exit 2/i);
      expect(result.stdout).not.toContain("checks,");
      const calls = receiptOf(receipt);
      expect(calls).toBe("");
      expect(calls).not.toContain("--help");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes no ledger and no files even with --ledger", () => {
    const directory = scratch();
    try {
      const work = join(directory, "work");
      mkdirSync(work);
      const ledger = join(work, "ledger.jsonl");
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const result = run("bin/json-smoke.mjs", ["--ledger", ledger, "--help"], {
        env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
        cwd: work,
        setup,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:");
      expect(receiptOf(ledger)).toBe("");
      expect(receiptOf(receipt)).toBe("");
      expect(readdirSync(work)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("unchanged: missing base URL still exits 2 with usage on stderr", () => {
    const directory = scratch();
    try {
      const result = run("bin/json-smoke.mjs", [], { env: {}, cwd: directory });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage:");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("unchanged: --ledger without a value still exits 2", () => {
    const directory = scratch();
    try {
      const result = run("bin/json-smoke.mjs", ["--ledger"], { env: {}, cwd: directory });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage:");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("unchanged: --skip-ledger still replays skips offline without a token", () => {
    const directory = scratch();
    try {
      const result = run("bin/json-smoke.mjs", ["--skip-ledger", "fixture-freeze"], {
        env: {},
        cwd: directory,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SKIP ");
      expect(result.stdout).toContain("fixture-freeze");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("unchanged: --report-ledger on a missing file still exits 2", () => {
    const directory = scratch();
    try {
      const result = run(
        "bin/json-smoke.mjs",
        ["--report-ledger", join(directory, "missing.jsonl"), "heading", "context"],
        { env: {}, cwd: directory },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
