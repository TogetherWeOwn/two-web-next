import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The required `gitleaks` check must not be silenceable by the pull request it
// gates. These pins keep the wiring in .github/workflows/pr-gates.yml in place:
// the scanner archive is verified against a pinned SHA-256 before it is
// extracted, and a PR is scanned through .github/scripts/gitleaks-scan.sh, which
// applies the base branch's .gitleaks.toml / .gitleaksignore, after the offline
// self-test .github/scripts/test-gitleaks-scan.sh has run. The behaviour itself
// is exercised by that self-test inside the job, where the verified binary
// exists; this file only pins that nothing is rewired around it.
const workflow = readFileSync(".github/workflows/pr-gates.yml", "utf8");
const scanScript = readFileSync(".github/scripts/gitleaks-scan.sh", "utf8");
const selfTestScript = readFileSync(".github/scripts/test-gitleaks-scan.sh", "utf8");

const jobBlock = workflow.split(/\n  gitleaks:\n/)[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";
// Every step of the job, header line first. Comment lines between steps fall at
// the tail of the step above them, which no assertion below reads.
const steps = jobBlock.split("\n    steps:\n")[1]?.split(/\n {6}- /) ?? [];
const step = (name: string): string => {
  const found = steps.find((text) => text.split("\n")[0] === `name: ${name}`);
  expect(found, `gitleaks job has no step named ${name}`).toBeDefined();
  return found ?? "";
};

describe("gitleaks job wiring", () => {
  it("verifies the pinned archive before it is extracted or run", () => {
    const install = step("Install gitleaks");
    expect(install).toMatch(/\n {10}GITLEAKS_SHA256: [0-9a-f]{64}\n/);
    const check = install.indexOf("sha256sum --check");
    expect(check).toBeGreaterThan(-1);
    expect(install.slice(check - 80, check)).toContain("${GITLEAKS_SHA256}");
    expect(check).toBeLessThan(install.indexOf("tar -xzf"));
    expect(check).toBeLessThan(install.indexOf('"$RUNNER_TEMP/gitleaks" version'));
    // The checked file is the downloaded one, not a stale name.
    expect(install).toContain(
      'archive="$RUNNER_TEMP/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"',
    );
    expect(install).toContain('tar -xzf "$archive"');
  });

  it("scans only through the wrapper, after the self-test", () => {
    expect(jobBlock).not.toMatch(/gitleaks"? git /);
    const scan = step("Scan the full history");
    expect(scan).toContain("run: bash .github/scripts/gitleaks-scan.sh");
    // Context values reach the shell as env vars, never interpolated into `run:`.
    expect(scan).toContain("GITLEAKS_BIN: ${{ runner.temp }}/gitleaks");
    expect(scan).toContain("EVENT_NAME: ${{ github.event_name }}");
    expect(scan).toContain("BASE_REF: ${{ github.base_ref }}");
    const runLines = scan.split("\n").filter((line) => line.trim().startsWith("run:"));
    expect(runLines.filter((line) => line.includes("${{"))).toEqual([]);

    const selfTest = step("Self-test the PR scan policy");
    expect(selfTest).toContain("run: bash .github/scripts/test-gitleaks-scan.sh");
    expect(selfTest).toContain("GITLEAKS_BIN: ${{ runner.temp }}/gitleaks");
    expect(jobBlock.indexOf(selfTest)).toBeLessThan(jobBlock.indexOf(scan));
    expect(jobBlock.indexOf(step("Install gitleaks"))).toBeLessThan(jobBlock.indexOf(selfTest));
  });

  it("keeps the full-history checkout and never softens the job", () => {
    expect(jobBlock).toMatch(/\n {10}fetch-depth: 0\n/);
    expect(jobBlock).not.toContain("continue-on-error");
  });
});

describe("gitleaks-scan.sh", () => {
  it("keeps the history scan and its flags", () => {
    for (const flag of [
      "--redact",
      "--verbose",
      "--exit-code 1",
      "--log-opts=HEAD",
      "--ignore-gitleaks-allow",
    ]) {
      expect(scanScript, flag).toContain(flag);
    }
    expect(scanScript).not.toContain("--no-git");
    expect(scanScript).not.toContain("continue-on-error");
    // The scanner's exit status is the script's: nothing masks a finding.
    expect(scanScript.trimEnd().split("\n").pop()).toBe('"${GITLEAKS_BIN}" "${args[@]}"');
  });

  it("applies the base branch's policy files on pull requests", () => {
    expect(scanScript).toContain('"${EVENT_NAME:-}" == "pull_request"');
    expect(scanScript).toContain('base="refs/remotes/origin/${BASE_REF}"');
    expect(scanScript).toContain('"${base}:.gitleaks.toml"');
    expect(scanScript).toContain('"${base}:.gitleaksignore"');
    expect(scanScript).toContain("--config");
    expect(scanScript).toContain("--gitleaks-ignore-path");
    // An unfetched base branch fails the scan instead of falling back to the PR's files.
    expect(scanScript).toMatch(/base branch \$\{BASE_REF\} is not fetched[\s\S]*exit 2/);
  });
});

describe("test-gitleaks-scan.sh", () => {
  it("covers every bypass a pull request could add itself", () => {
    for (const name of [
      "allowlist added in .gitleaks.toml",
      "fingerprint added in .gitleaksignore",
      "fingerprint appended to an existing .gitleaksignore",
      "inline gitleaks:allow",
      "allowlist already on the base branch is honoured",
      ".gitleaksignore already on the base branch is honoured",
      "base without policy files, PR-added allowlist is ignored",
      "unfetched base branch fails",
      "push: merged allowlist is honoured",
    ]) {
      expect(selfTestScript, name).toContain(name);
    }
  });

  it("derives the planted token at run time instead of writing a literal", () => {
    expect(selfTestScript).toMatch(/token="ghp_\$\(printf [^\n]*sha256sum/);
    expect(selfTestScript).not.toMatch(/ghp_[0-9A-Za-z]{36}/);
  });
});
