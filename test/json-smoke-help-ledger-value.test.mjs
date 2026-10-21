import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Builder-owned supplement to the probe-cli --help acceptance suite: pins the
// json-smoke --ledger --help flag-value case, where --help arrives in the
// --ledger value slot. Help wins over ledger parsing (exit 0, usage on
// stdout, zero effects) instead of being consumed as a path. Kept in this
// file because the acceptance suite is Test-Author-owned and builders never
// edit it. Every case runs offline in a subprocess with a scrubbed
// environment: no inherited DATABASE_URL, QA_AUTH_TOKEN or PG* settings.

const syntheticToken = "fixture-qa-token";

function scratch() {
  return mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "probe-help-ledger-"));
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
  throw new Error("network disabled in help ledger-value fixture");
};
`,
  );
  return setup;
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

describe("json-smoke --help in the --ledger value slot", () => {
  it("--ledger --help exits 0 with usage and writes nothing", () => {
    const directory = scratch();
    try {
      const work = join(directory, "work");
      mkdirSync(work);
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const result = run("bin/json-smoke.mjs", ["--ledger", "--help"], {
        env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
        cwd: work,
        setup,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).not.toContain("checks,");
      expect(receiptOf(receipt)).toBe("");
      expect(readdirSync(work)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("--ledger --help with a URL appended still helps without probing", () => {
    const directory = scratch();
    try {
      const work = join(directory, "work");
      mkdirSync(work);
      const receipt = join(directory, "receipt");
      const setup = fetchTrap(directory, receipt);
      const result = run(
        "bin/json-smoke.mjs",
        ["--ledger", "--help", "https://staging.example.invalid"],
        {
          env: { QA_AUTH_TOKEN: syntheticToken, RECEIPT: receipt },
          cwd: work,
          setup,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).not.toContain("checks,");
      const calls = receiptOf(receipt);
      expect(calls).toBe("");
      expect(calls).not.toContain("--help");
      expect(readdirSync(work)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
