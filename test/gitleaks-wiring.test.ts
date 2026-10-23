import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The required `gitleaks` check must not be silenceable by the pull request it
// gates. These pins keep the wiring in .github/workflows/pr-gates.yml in place:
// the scanner archive is verified against a pinned SHA-256 before it is
// extracted, and a PR is scanned through .github/scripts/gitleaks-scan.sh, which
// applies the base branch's .gitleaks.toml / .gitleaksignore, after the offline
// self-test .github/scripts/test-gitleaks-scan.sh has run. The behaviour itself
// is exercised by that self-test inside the job, where the verified binary
// exists; this file pins that nothing is rewired around it and that the
// session-renewal fixture exception cannot silently widen.
const policy = readFileSync(".gitleaks.toml", "utf8");
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

describe("gitleaks fixture policy", () => {
  it("keeps the session-renewal exception limited to the exact rule, path and three secrets", () => {
    // Pin the whole table: extra fields, OR (including its implicit default),
    // unanchored patterns or additional alternatives must require a test change.
    const entries = policy
      .split(/\r?\n\[\[allowlists\]\]\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.includes("Three synthetic ULID event keys in the Kit event-detail"));
    expect(entries).toEqual([
      String.raw`description = "Three synthetic ULID event keys in the Kit event-detail session-renewal fixture, used only by in-memory event lookup and request paths, not credentials"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "secret"
paths = ['''^test/kit-event-detail-session-renewal\.test\.ts$''']
regexes = [
  '''^01ARZ3NDEKTSV4RRFFQ69G5FBV$''',
  '''^01ARZ3NDEKTSV4RRFFQ69G5FCV$''',
  '''^01ARZ3NDEKTSV4RRFFQ69G5FZV$''',
]`,
    ]);
  });

  it("keeps the Kit-error fixture exception limited to the exact rule, path and secret", () => {
    // Pin the whole table: extra fields, OR (including its implicit default),
    // unanchored patterns or additional alternatives must require a test change.
    const entries = policy
      .split(/\r?\n\[\[allowlists\]\]\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.includes("Synthetic hostile request-id fixture in the Kit error"));
    expect(entries).toEqual([
      String.raw`description = "Synthetic hostile request-id fixture in the Kit error correlation tests, not a credential"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "secret"
regexes = ['''^0123456789abcdef-IP-secret$''']
paths = ['''^test/kit-error-request-correlation\.test\.ts$''']`,
    ]);
  });

  it("keeps the Discord-marker fixture exception limited to the exact rule, path and secret", () => {
    // Pin the whole table: extra fields, OR (including its implicit default),
    // unanchored patterns or additional alternatives must require a test change.
    const entries = policy
      .split(/\r?\n\[\[allowlists\]\]\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.includes("Synthetic Discord snowflake leak-marker"));
    expect(entries).toEqual([
      String.raw`description = "Synthetic Discord snowflake leak-marker in the queue/agent structured-fields acceptance test; patterned digits, not a real client or credential"
targetRules = ["discord-client-id"]
condition = "AND"
regexTarget = "secret"
paths = ['''^test/queue-agent-structured-fields-acceptance\.test\.ts$''']
regexes = ['''^777666555444333222$''']`,
    ]);
  });

  it("keeps the unknown-event fixture exception limited to the exact rule, path and secret", () => {
    // Pin the whole table: extra fields, OR (including its implicit default),
    // unanchored patterns or additional alternatives must require a test change.
    const entries = policy
      .split(/\r?\n\[\[allowlists\]\]\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) =>
        entry.includes("Synthetic unknown-event ULID in the cancelled-event alternatives"),
      );
    expect(entries).toEqual([
      String.raw`description = "Synthetic unknown-event ULID in the cancelled-event alternatives acceptance fixture, used only for an in-memory 404 lookup, not a credential"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "secret"
paths = ['''^test/event-gone-alternatives-acceptance\.test\.ts$''']
regexes = ['''^01ARZ3NDEKTSV4RRFFQ69G5FA9$''']`,
    ]);
  });

  it("keeps the bot-settings fixture exception limited to the exact rule, path and secret", () => {
    // Pin the whole table: extra fields, OR (including its implicit default),
    // unanchored patterns or additional alternatives must require a test change.
    const entries = policy
      .split(/\r?\n\[\[allowlists\]\]\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) =>
        entry.includes("Deterministic RFC example-UUID idempotency fixture in the bot settings"),
      );
    expect(entries).toEqual([
      String.raw`description = "Deterministic RFC example-UUID idempotency fixture in the bot settings tests, asserted literally in expected headers and bodies, not a credential (including its committed history)"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "secret"
paths = ['''^test/bot-settings\.test\.ts$''']
regexes = ['''^123e4567-e89b-12d3-a456-426614174000$''']`,
    ]);
  });

  it("keeps the operator fixture exception limited to the exact rule, path and secret", () => {
    // Pin the whole table: extra fields, OR (including its implicit default),
    // unanchored patterns or additional alternatives must require a test change.
    const entries = policy
      .split(/\r?\n\[\[allowlists\]\]\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) =>
        entry.includes("Synthetic operator bearer fixture in the local accessibility harness"),
      );
    expect(entries).toEqual([
      String.raw`description = "Synthetic operator bearer fixture in the local accessibility harness, including its committed history; never provisioned as a live credential"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "secret"
paths = ['''^ci/a11y-cases\.mjs$''']
regexes = ['''^a11y-operator-fixture-$''']`,
    ]);
  });
});

describe("gitleaks public-event fixture policy", () => {
  const entries = policy
    .split(/\r?\n\[\[allowlists\]\]\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("Two synthetic offline PUBLIC Discord event fixtures"));

  it("pins the entire rule/path/value conjunction, including explicit AND and secret matching", () => {
    expect(entries).toEqual([
      String.raw`description = "Two synthetic offline PUBLIC Discord event fixtures in the Kit public-payload contract tests, not credentials or member identities"
targetRules = ["discord-client-id"]
condition = "AND"
regexTarget = "secret"
paths = ['''^test/kit-no-member-data-contract\.test\.ts$''']
regexes = ['''^111222333444555667$''', '''^222333444555666778$''']`,
    ]);
  });

  // Probe the configured regexes, not a second set of copied patterns. This is
  // structural coverage, not scanner integration: the whole-table pin above
  // also rejects implicit OR, other rules/targets and additional fields.
  it.each([
    ["discord-client-id", "test/kit-no-member-data-contract.test.ts", "111222333444555667", true],
    ["discord-client-id", "test/kit-no-member-data-contract.test.ts", "222333444555666778", true],
    ["discord-client-id", "src/control.ts", "111222333444555667", false],
    ["discord-client-id", "src/control.ts", "222333444555666778", false],
    [
      "discord-client-id",
      "prefix/test/kit-no-member-data-contract.test.ts",
      "111222333444555667",
      false,
    ],
    [
      "discord-client-id",
      "test/kit-no-member-data-contract.test.ts.bak",
      "111222333444555667",
      false,
    ],
    ["discord-client-id", "test/kit-no-member-data-contractXtest.ts", "111222333444555667", false],
    ["discord-client-id", "test/kit-no-member-data-contract.testXts", "222333444555666778", false],
    ["discord-client-id", "test/kit-no-member-data-contract.test.ts", "333444555666777889", false],
    ["discord-client-id", "test/kit-no-member-data-contract.test.ts", "111222333444555668", false],
    ["discord-client-id", "test/kit-no-member-data-contract.test.ts", "0111222333444555667", false],
    ["discord-client-id", "test/kit-no-member-data-contract.test.ts", "2223334445556667780", false],
    ["generic-api-key", "test/kit-no-member-data-contract.test.ts", "111222333444555667", false],
    ["generic-api-key", "test/kit-no-member-data-contract.test.ts", "222333444555666778", false],
  ])("matches rule=%s path=%s secret=%s only when approved=%s", (rule, path, secret, approved) => {
    const entry = entries[0] ?? "";
    const targetRule = entry.match(/^targetRules = \["([^"]+)"\]$/m)?.[1];
    const patterns = [...entry.matchAll(/'''([^']+)'''/g)].map(
      (match) => new RegExp(match[0].slice(3, -3)),
    );
    expect(patterns).toHaveLength(3);
    const [pathPattern, ...secretPatterns] = patterns;
    expect(
      targetRule === rule &&
        pathPattern?.test(path) &&
        secretPatterns.some((pattern) => pattern.test(secret)),
    ).toBe(approved);
  });
});

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
    expect(scan).toContain("BASE_REF: ${{ github.base_ref || github.event.merge_group.base_ref }}");
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

  it("applies the base branch's policy files on pull requests and merge groups", () => {
    expect(scanScript).toContain('"${EVENT_NAME:-}" == "pull_request"');
    expect(scanScript).toContain('"${EVENT_NAME:-}" == "merge_group"');
    // merge_group.base_ref arrives as refs/heads/<branch>; strip it before
    // resolving the fetched base.
    expect(scanScript).toContain('base_ref="${BASE_REF#refs/heads/}"');
    expect(scanScript).toContain('base="refs/remotes/origin/${base_ref}"');
    expect(scanScript).toContain('"${base}:.gitleaks.toml"');
    expect(scanScript).toContain('"${base}:.gitleaksignore"');
    expect(scanScript).toContain("--config");
    expect(scanScript).toContain("--gitleaks-ignore-path");
    // An unfetched base branch fails the scan instead of falling back to the PR's files.
    expect(scanScript).toMatch(/base branch \$\{base_ref\} is not fetched[\s\S]*exit 2/);
  });

  it("unlinks the PR's ignore file before copying the base policy over it", () => {
    // cp follows a destination symlink, which could point at the running wrapper.
    expect(scanScript).toMatch(/rm -f \.gitleaksignore\n\s+cp "\$\{ignore\}" \.gitleaksignore/);
  });
});

describe("test-gitleaks-scan.sh", () => {
  it("covers every bypass a pull request could add itself", () => {
    for (const name of [
      "allowlist added in .gitleaks.toml",
      "fingerprint added in .gitleaksignore",
      "fingerprint appended to an existing .gitleaksignore",
      ".gitleaksignore symlink cannot overwrite the running wrapper",
      "inline gitleaks:allow",
      "allowlist already on the base branch is honoured",
      ".gitleaksignore already on the base branch is honoured",
      "base without policy files, PR-added allowlist is ignored",
      "unfetched base branch fails",
      "push: merged allowlist is honoured",
      "merge_group: allowlist added in .gitleaks.toml does not silence the scan",
      "merge_group: fingerprint added in .gitleaksignore does not silence the scan",
      "merge_group: unfetched base branch fails",
    ]) {
      expect(selfTestScript, name).toContain(name);
    }
  });

  it("derives the planted token at run time instead of writing a literal", () => {
    expect(selfTestScript).toMatch(/token="ghp_\$\(printf [^\n]*sha256sum/);
    expect(selfTestScript).not.toMatch(/ghp_[0-9A-Za-z]{36}/);
  });
});
