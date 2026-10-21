// Acceptance fixtures: verify/import CLI safety and verdicts.
//
// Owned by the F5 acceptance card; the Builder builds on this branch and never
// edits this file — corrections return to the acceptance card.
//
// Contract (mirrors the erase-member exit norms and the json-smoke ledger):
// - `--help` as the sole argument: usage to stdout, exit 0, empty stderr,
//   zero side effects (a temp cwd stays empty, scrubbed or garbage env
//   suffices, no GITHUB_OUTPUT write for the gate).
// - Usage errors: exit 2 with a usage line on stderr (never failure prose),
//   empty stdout. Exit 2 means "invoked wrong"; exit 1 means "ran and failed".
// - smoke machine verdict: `--json` and/or `--ledger <path>`; exit codes
//   unchanged (0 pass / 1 probe failure / 2 usage).
// - Pins: the deploy gate's bare invocation still enters the gate, and bare
//   importer invocations still mean dry-run (the staging importer dry-run
//   workflow relies on the default).
//
// Offline only: refused loopback (127.0.0.1:9, nothing listens there) and
// temp dirs. Every spawn terminates fast by construction: usage paths exit
// before any probe or connect, and refused loopback connections fail at once.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs as parseEventsRsvpsArgs } from "../bin/import/events-rsvps.mjs";
import { parseOptions as parseAuditOptions } from "../bin/import/audit.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE = join(repoRoot, "bin/smoke.mjs");
const EVENTS_RSVPS = join(repoRoot, "bin/import/events-rsvps.mjs");
const AUDIT = join(repoRoot, "bin/import/audit.mjs");
const GATE = join(repoRoot, "ci/production-deploy-gate.mjs");
// Nothing listens on loopback discard-port 9, so probes against it fail fast
// without leaving loopback.
const REFUSED_BASE = "http://127.0.0.1:9/";
const GARBAGE_URLS = {
  LEGACY_DATABASE_URL: "postgres://garbage.invalid/source_db",
  DATABASE_URL: "postgres://garbage.invalid/target_db",
};

function run(script, args, { env = {}, cwd } = {}) {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), "cli-safety-"));
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  return { ...result, cwd: dir };
}

function expectHelp(result) {
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/usage/i);
  expect(result.stderr).toBe("");
  expect(readdirSync(result.cwd)).toEqual([]);
}

function expectUsageError(result, { not = [] } = {}) {
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/usage/i);
  expect(result.stdout).toBe("");
  for (const prose of not) expect(result.stderr).not.toContain(prose);
}

describe("bin/smoke.mjs", () => {
  it("--help exits 0 with usage on stdout and zero side effects", () => {
    expectHelp(run(SMOKE, ["--help"]));
  });

  it("unknown flag exits 2 with usage (pin)", () => {
    expectUsageError(run(SMOKE, [REFUSED_BASE, "--bogus"]));
  });

  it("missing base url exits 2 with usage (pin)", () => {
    expectUsageError(run(SMOKE, []));
  });

  it("bare --ledger without a path exits 2", () => {
    // Unknown today, missing-value after the verdict lands (the json-smoke
    // mirror); either way it is a usage error, never a probe run.
    expectUsageError(run(SMOKE, [REFUSED_BASE, "--ledger"]));
  });
});

describe("bin/import/events-rsvps.mjs", () => {
  it("--help exits 0 with usage and zero side effects", () => {
    // Garbage URLs prove --help short-circuits before any env validation or
    // connection attempt.
    expectHelp(run(EVENTS_RSVPS, ["--help"], { env: GARBAGE_URLS }));
  });

  it("unknown flag exits 2 with usage, not failure prose", () => {
    expectUsageError(run(EVENTS_RSVPS, ["--bogus"]), { not: ["import failed"] });
  });

  it("flag typo exits 2 with usage, not failure prose", () => {
    expectUsageError(run(EVENTS_RSVPS, ["--appl"]), { not: ["import failed"] });
  });

  it("bare invocation is not a usage error (dry-run default pin)", () => {
    // The staging importer dry-run workflow invokes this slice bare; with no
    // URLs configured that is a config failure (1), never "invoked wrong" (2).
    const result = run(EVENTS_RSVPS, []);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toMatch(/usage/i);
  });

  it("bare means dry-run (unit pin)", () => {
    expect(parseEventsRsvpsArgs([])).toEqual({ dryRun: true });
    expect(parseEventsRsvpsArgs(["--dry-run"])).toEqual({ dryRun: true });
    expect(parseEventsRsvpsArgs(["--apply"])).toEqual({ dryRun: false });
  });
});

describe("bin/import/audit.mjs", () => {
  it("--help exits 0 with usage and zero side effects (pin)", () => {
    expectHelp(run(AUDIT, ["--help"], { env: GARBAGE_URLS }));
  });

  it("unknown flag exits 2 with usage, not safeFailure prose", () => {
    expectUsageError(run(AUDIT, ["--bogus"]), { not: ["Audit import failed"] });
  });

  it("conflicting --apply --dry-run exits 2 with usage", () => {
    expectUsageError(run(AUDIT, ["--apply", "--dry-run"]), {
      not: ["Audit import failed"],
    });
  });

  it("bare invocation is not a usage error (dry-run default pin)", () => {
    const result = run(AUDIT, []);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toMatch(/usage/i);
  });

  it("bare means dry-run (unit pin)", () => {
    expect(parseAuditOptions([])).toEqual({ dryRun: true, enableGrants: false, help: false });
    expect(parseAuditOptions(["--apply"])).toEqual({
      dryRun: false,
      enableGrants: false,
      help: false,
    });
  });
});

describe("ci/production-deploy-gate.mjs", () => {
  it("--help exits 0 with usage and zero side effects", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cli-safety-"));
    const output = join(cwd, "github-output");
    const result = run(GATE, ["--help"], { cwd, env: { GITHUB_OUTPUT: output } });
    expectHelp(result);
    expect(existsSync(output)).toBe(false);
  });

  it("unknown --flag exits 2 with usage instead of running the gate", () => {
    const result = run(GATE, ["--bogus"]);
    expectUsageError(result, { not: ["::error::"] });
    expect(result.stderr).not.toMatch(/deployment disabled/);
  });

  it("near-miss flag typo exits 2 with usage", () => {
    const result = run(GATE, ["--check-migration"]);
    expectUsageError(result, { not: ["::error::"] });
    expect(result.stderr).not.toMatch(/deployment disabled/);
  });

  it("bare invocation still enters the gate (pin)", () => {
    const result = run(GATE, [], {
      env: {
        PRODUCTION_DEPLOY_ENABLED: "",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/deployment disabled/);
  });
});

let cachedVerdictModes;
function supportedVerdictModes() {
  cachedVerdictModes ??= (() => {
    const modes = [];
    if (run(SMOKE, [REFUSED_BASE, "--json"]).status !== 2) modes.push("json");
    const dir = mkdtempSync(join(tmpdir(), "cli-safety-"));
    if (run(SMOKE, [REFUSED_BASE, "--ledger", join(dir, "smoke-ledger.json")]).status !== 2) {
      modes.push("ledger");
    }
    return modes;
  })();
  return cachedVerdictModes;
}

function verdictLines(stdout) {
  const verdicts = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.ok === "boolean") verdicts.push(parsed);
    } catch {
      // Not a verdict line; human output may contain other braces.
    }
  }
  return verdicts;
}

describe("smoke machine verdict", () => {
  it("smoke offers --json or --ledger", () => {
    expect(supportedVerdictModes().length).toBeGreaterThan(0);
  });

  it("--json verdict shape tracks the probe result", (ctx) => {
    if (!supportedVerdictModes().includes("json")) ctx.skip();
    const plain = run(SMOKE, [REFUSED_BASE]);
    const result = run(SMOKE, [REFUSED_BASE, "--json"]);
    expect(result.status).toBe(plain.status);
    expect(result.status).toBe(1);
    const [verdict] = verdictLines(result.stdout);
    expect(verdict?.ok).toBe(false);
    expect(verdict?.routes).toBeGreaterThan(0);
    expect(verdict?.failed).toBeGreaterThan(0);
  });

  it("--ledger verdict shape mirrors json-smoke", (ctx) => {
    if (!supportedVerdictModes().includes("ledger")) ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), "cli-safety-"));
    const ledgerPath = join(dir, "smoke-ledger.json");
    const plain = run(SMOKE, [REFUSED_BASE]);
    const result = run(SMOKE, [REFUSED_BASE, "--ledger", ledgerPath]);
    expect(result.status).toBe(plain.status);
    expect(result.status).toBe(1);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(ledger.ledger).toMatch(/^smoke\//);
    expect(typeof ledger.origin).toBe("string");
    expect(Array.isArray(ledger.checks)).toBe(true);
    expect(ledger.checks.length).toBeGreaterThan(0);
    expect(ledger.summary.total).toBe(ledger.checks.length);
    expect(ledger.summary.failed).toBeGreaterThan(0);
  });

  it("unwritable --ledger keeps the probe result", (ctx) => {
    if (!supportedVerdictModes().includes("ledger")) ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), "cli-safety-"));
    const result = run(SMOKE, [REFUSED_BASE, "--ledger", join(dir, "missing", "ledger.json")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ledger/i);
  });
});

describe("staging importer dry-run default", () => {
  it("workflow still invokes every importer slice bare", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github/workflows/staging-importer-dryrun.yml"),
      "utf8",
    );
    const invocations = workflow.split("\n").filter((line) => line.includes("run_slice "));
    for (const slice of ["users-profiles", "events-rsvps", "content-funnel", "audit"]) {
      const lines = invocations.filter((line) => line.includes(`node bin/import/${slice}.mjs`));
      expect(lines.length).toBe(1);
      expect(lines[0].trim()).toBe(`run_slice ${slice} node bin/import/${slice}.mjs`);
    }
    for (const line of invocations) expect(line).not.toContain("--apply");
  });
});
