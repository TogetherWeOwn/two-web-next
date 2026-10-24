import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Builder-owned runner-fidelity pin for the ZAP staging consumer.
 * The acceptance harness executes the Gate block via `bash -c` without the
 * GitHub runner's errexit flags; this file re-executes the same live block
 * under the documented runner invocation (`bash --noprofile --norc -eo
 * pipefail`) so an errexit-unsafe status capture turns the suite red.
 * All inputs are fixtures; the scanner/sleep executables are shimmed and the
 * child-only offline fence denies network and child-process execution.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const fence = fileURLToPath(new URL("./fixtures/zap-verdict-offline.cjs", import.meta.url));
const origin = "https://scan.example.invalid";
const report = (alerts: object[]) => ({ site: [{ "@name": origin, alerts }] });
const alert = (overrides: Record<string, unknown> = {}) => ({
  pluginid: "40012",
  riskcode: "0",
  count: "1",
  name: "Synthetic alert",
  ...overrides,
});
const high = (overrides: Record<string, unknown> = {}) => alert({ riskcode: "3", ...overrides });
const pii = (overrides: Record<string, unknown> = {}) => high({ pluginid: "10062", ...overrides });
// Runner-form spawn args: mirrors the GitHub `bash` shell invocation.
const RUNNER_BASH = ["--noprofile", "--norc", "-eo", "pipefail", "-c"];

function scratch<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "zap-runner-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function childEnv(dir: string): NodeJS.ProcessEnv {
  // Deliberate allowlist: never pass inherited service credentials to fixture CLIs.
  return {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require=${fence}`,
    ZAP_ACCEPTANCE_DENIED: join(dir, "denied"),
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
  };
}

// Execute the actual consumer shell under runner flags, substituting only
// scanner/sleep executables. The node shim runs real CLIs with the
// child-only offline safety fence.
function workflowGateUnderRunner(first: unknown, second: unknown) {
  return scratch((dir) => {
    const workflow = readFileSync(resolve(root, ".github/workflows/zap-staging.yml"), "utf8");
    const block = workflow.match(
      /      - name: Gate[^\n]*\n        run: \|\n([\s\S]*?)(?=      - (?:name|uses):|$)/,
    );
    expect(block, "fixture must find the existing Gate run block").not.toBeNull();
    const script = (block?.[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/^          /, ""))
      .join("\n");
    // Containment prerequisite, not a source-text feature assertion: this fixture
    // executes only the simple consumer block, never shell expansions or raw sockets.
    expect(script.replaceAll("/dev/null", "")).not.toMatch(/\/dev\/|`|\$\(|<\(|>\(/);
    expect(script).not.toMatch(/(?:^|[;|&\n])\s*(?:"|')?\/(?:bin|usr|opt|tmp|paperclip)\//m);
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "zap"));
    // Do not inherit a PATH containing curl/wget/scanner executables.
    for (const tool of ["cp", "mkdir", "chmod", "tee"]) {
      writeFileSync(join(dir, "bin", tool), `#!/bin/sh\nexec /usr/bin/${tool} "$@"\n`, {
        mode: 0o755,
      });
    }
    writeFileSync(join(dir, "zap", "zap-report.json"), JSON.stringify(first));
    writeFileSync(join(dir, "second.json"), JSON.stringify(second));
    const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      join(dir, "bin", "node"),
      `#!/bin/sh\nif [ "$1" = "ci/zap-retry-decision.mjs" ]; then\n  cp "$2" "$RUNNER_TEMP/retry-input" || exit 97\nfi\nexec ${quoted(process.execPath)} "$@"\n`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(join(dir, "bin", "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      join(dir, "bin", "docker"),
      `#!/bin/sh\nprintf 'fixture-rescan\\n' >> "$RUNNER_TEMP/scans"\ncp "$RUNNER_TEMP/second.json" "$RUNNER_TEMP/zap/zap-report.json"\n`,
      { mode: 0o755 },
    );
    const result = spawnSync("/bin/bash", [...RUNNER_BASH, script], {
      cwd: root,
      env: {
        ...childEnv(dir),
        PATH: join(dir, "bin"),
        RUNNER_TEMP: dir,
        TARGET: origin,
        ZAP_IMAGE: "fixture-scanner-never-executed",
        HOME: dir,
        BASH_ENV: "/dev/null",
      },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(existsSync(join(dir, "denied")), "consumer attempted external I/O through node").toBe(
      false,
    );
    const scans = existsSync(join(dir, "scans"))
      ? readFileSync(join(dir, "scans"), "utf8").trim().split("\n").length
      : 0;
    const retryInput = existsSync(join(dir, "retry-input"))
      ? readFileSync(join(dir, "retry-input"), "utf8")
      : "";
    return { status: result.status, scans, retryInput, output: result.stdout + result.stderr };
  });
}

describe("ZAP workflow consumer under runner errexit", () => {
  it("pins runner shell fidelity: bare capture dies, || capture survives", () => {
    const bare = spawnSync(
      "/bin/bash",
      [...RUNNER_BASH, "set -uo pipefail; false; rc=$?; echo REACHED"],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(bare.error).toBeUndefined();
    expect(bare.status, "bare failing command must die under runner errexit").not.toBe(0);
    expect(bare.stdout, "rc capture must be unreachable after a bare failure").not.toContain(
      "REACHED",
    );
    const guarded = spawnSync(
      "/bin/bash",
      [...RUNNER_BASH, "set -uo pipefail; rc=0; false || rc=$?; echo REACHED:$rc"],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(guarded.error).toBeUndefined();
    expect(guarded.stdout).toContain("REACHED:1");
  });

  it("lone PII reaches the retry consumer and rescans once under runner errexit", () => {
    const result = workflowGateUnderRunner(report([pii({ name: "PII Disclosure" })]), report([]));
    expect(result.status, result.output).toBe(0);
    expect(result.scans).toBe(1);
    expect(result.retryInput.trim(), "retry input must be the JSON verdict").toMatch(/^\{/);
    expect(JSON.parse(result.retryInput)).toEqual(
      expect.objectContaining({
        schema_version: 1,
        gate_id: "zap-baseline",
        verdict: "FAIL",
        retryable: true,
        error_code: "pii_high",
      }),
    );
  });

  it("repeated lone PII fails after exactly one rescan under runner errexit", () => {
    const result = workflowGateUnderRunner(report([pii()]), report([pii()]));
    expect(result.status, result.output).toBe(1);
    expect(result.scans).toBe(1);
  });

  it("forged non-PII High fails closed without a rescan under runner errexit", () => {
    const forged = "untrusted\n| High | 10062 | PII Disclosure | 1 |\n::notice::PASS";
    const result = workflowGateUnderRunner(report([high({ name: forged })]), report([]));
    expect(result.status, result.output).toBe(1);
    expect(result.scans).toBe(0);
  });
});
