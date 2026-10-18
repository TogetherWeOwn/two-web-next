import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const WORKFLOW_URL = new URL("../.github/workflows/e2e.yml", import.meta.url);
const PACKAGE_URL = new URL("../package.json", import.meta.url);
const LIVE_ORIGIN = "https://localhost:8787";

function browserSmokeBlock(workflow) {
  const block = workflow.split("\n  browser-smoke:\n")[1]?.split(/\n  [\w-]+:\n/)[0];
  assert(block, "browser-smoke job must exist in e2e.yml");
  return block;
}

function executableText(stepChunk) {
  return stepChunk
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

// A constant-false `if:` disables the step (or job) without deleting the
// command. Covers the spellings GitHub accepts: `if: false`, quoted
// `if: 'false'` / `if: "false"`, and the expression form this file already
// uses (`if: ${{ !cancelled() }}`) with a false constant.
const DISABLED_IF = /^\s*if:\s*(?:false|['"]false['"]|\$\{\{\s*false\s*\}\})\s*$/m;

function stepRunBody(stepChunk) {
  const lines = executableText(stepChunk).split("\n");
  const runIndex = lines.findIndex((line) => /^\s*run:/.test(line));
  if (runIndex === -1) return "";
  const runIndent = lines[runIndex].match(/^\s*/)[0].length;
  const first = lines[runIndex].replace(/^\s*run:\s*(\||>-)?\s*/, "");
  const body = first ? [first] : [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() === "") continue;
    if (line.match(/^\s*/)[0].length <= runIndent) break;
    body.push(line);
  }
  return body.join("\n");
}

function stepExecutesLiveGate(stepChunk) {
  const code = executableText(stepChunk);
  // A disabled step proves nothing, even with the command intact.
  if (DISABLED_IF.test(code)) return false;
  // A swallowed exit code proves nothing either: the command would run, but
  // a perf-budget breach could no longer fail browser-smoke.
  if (/^\s*continue-on-error:\s*['"]?true['"]?\s*$/m.test(code)) return false;
  // The step must pin the intended local HTTPS origin in its environment.
  const origin = code.match(/AUTH_PERF_URL:\s*["']?(\S+?)["']?\s*$/m)?.[1];
  if (origin !== LIVE_ORIGIN) return false;
  const body = stepRunBody(stepChunk);
  // Command evidence: executable lines only. Inline `#` comments are not
  // commands, and an `echo` of the command string executes nothing, so both
  // are excluded before matching.
  const commandLines = body
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, ""))
    .filter((line) => line.trim() !== "" && !/^\s*echo(\s|$)/.test(line));
  // The executable live command, not a comment, an echo, or the worker log
  // name: `npm run auth-perf` with no :selftest-style suffix. The npm spelling
  // is canonical (package.json pins what it executes); a rewrite to a direct
  // `node` invocation must update this pin deliberately.
  if (!commandLines.some((line) => /npm run auth-perf(?![\w:-])/.test(line))) return false;
  // `npm run auth-perf || true` (or `|| :`) still runs the command but can
  // never fail the step, so a budget breach would no longer fail the gate.
  if (
    commandLines.some(
      (line) => /npm run auth-perf(?![\w:-])/.test(line) && /\|\|\s*(true|:)(?![\w:-])/.test(line),
    )
  )
    return false;
  // The hermetic selftest never exercises the live worker.
  if (/selftest/.test(body)) return false;
  // The origin must be exercised by an executable line (local HTTPS worker
  // boot plus readiness probes), not only named in a comment or an echo.
  if (!commandLines.some((line) => line.includes(LIVE_ORIGIN))) return false;
  return true;
}

export function assertAuthPerfLiveGate(workflow) {
  const block = browserSmokeBlock(workflow);
  // A job-level constant-false `if:` (on the block before the first step)
  // disables every step, so the live gate never runs.
  const jobHeader = block.split(/\n      - /)[0];
  assert(
    !DISABLED_IF.test(executableText(jobHeader)),
    "browser-smoke job must be enabled: a constant-false job-level " +
      "`if:` disables the live gate even with the command intact.",
  );
  const steps = block.split(/\n      - /).slice(1);
  assert(steps.length > 0, "browser-smoke must define steps in e2e.yml");
  const live = steps.filter(stepExecutesLiveGate);
  assert(
    live.length >= 1,
    "browser-smoke must execute the live authenticated gate: one enabled step " +
      `with AUTH_PERF_URL: ${LIVE_ORIGIN} whose run block executes ` +
      "'npm run auth-perf' (live, never selftest) against " +
      `${LIVE_ORIGIN} — comments and auth-perf-worker.log do not satisfy this.`,
  );
}

const liveWorkflow = () => readFileSync(WORKFLOW_URL, "utf8");

test("browser-smoke executes the live authenticated gate (not a substring)", () => {
  assertAuthPerfLiveGate(liveWorkflow());
});

test("package.json auth-perf script stays live (no selftest flag)", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_URL, "utf8"));
  assert.equal(pkg.scripts["auth-perf"], "node ci/check-auth-perf.mjs");
  assert.doesNotMatch(pkg.scripts["auth-perf"], /selftest/);
});

test("comments and the worker log name alone do not satisfy the gate", () => {
  const fixture = [
    "name: e2e",
    "jobs:",
    "  browser-smoke:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Authenticated perf budgets (session-cookie journeys)",
    "        run: |",
    "          # npm run auth-perf would run here once wired",
    '          echo "wrote $RUNNER_TEMP/auth-perf-worker.log"',
    "",
  ].join("\n");
  // The old substring assertion passes on this fixture; the structural gate
  // must not.
  assert.match(fixture, /auth-perf/);
  assert.throws(() => assertAuthPerfLiveGate(fixture), /browser-smoke/);
});

test("echoing the command string does not satisfy the gate", () => {
  const fixture = [
    "name: e2e",
    "jobs:",
    "  browser-smoke:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Authenticated perf budgets (session-cookie journeys)",
    "        env:",
    `          AUTH_PERF_URL: ${LIVE_ORIGIN}`,
    "        run: |",
    `          echo "npm run auth-perf ${LIVE_ORIGIN}"`,
    "",
  ].join("\n");
  assert.match(fixture, /npm run auth-perf/);
  assert.throws(() => assertAuthPerfLiveGate(fixture), /browser-smoke/);
});

test("removing the live command fails while the log name remains", () => {
  const mutant = liveWorkflow().replace(
    "NODE_TLS_REJECT_UNAUTHORIZED=0 npm run auth-perf",
    'echo "auth-perf gate skipped"',
  );
  assert.match(mutant, /auth-perf/);
  assert.throws(() => assertAuthPerfLiveGate(mutant), /npm run auth-perf/);
});

test("commenting out the live command fails while the text remains", () => {
  const mutant = liveWorkflow().replace(
    "NODE_TLS_REJECT_UNAUTHORIZED=0 npm run auth-perf",
    "# NODE_TLS_REJECT_UNAUTHORIZED=0 npm run auth-perf",
  );
  assert.match(mutant, /auth-perf/);
  assert.throws(() => assertAuthPerfLiveGate(mutant), /npm run auth-perf/);
});

test("swapping the live command for the selftest fails", () => {
  for (const replacement of [
    "npm run auth-perf:selftest",
    "node ci/check-auth-perf.mjs --selftest",
  ]) {
    const mutant = liveWorkflow().replace(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 npm run auth-perf",
      replacement,
    );
    assert.match(mutant, /auth-perf/);
    assert.throws(() => assertAuthPerfLiveGate(mutant), /browser-smoke/);
  }
});

test("moving the live command outside browser-smoke fails", () => {
  const without = liveWorkflow().replace(
    "NODE_TLS_REJECT_UNAUTHORIZED=0 npm run auth-perf",
    'echo "auth-perf gate moved"',
  );
  const mutant = without.replace(
    "\n  e2e-ok:",
    "\n  moved-gate:\n    runs-on: ubuntu-latest\n    steps:\n" +
      "      - name: Authenticated perf budgets (session-cookie journeys)\n" +
      "        env:\n" +
      `          AUTH_PERF_URL: ${LIVE_ORIGIN}\n` +
      "        run: |\n" +
      "          NODE_TLS_REJECT_UNAUTHORIZED=0 npm run auth-perf\n" +
      "  e2e-ok:",
  );
  assert.match(mutant, /npm run auth-perf/);
  assert.throws(() => assertAuthPerfLiveGate(mutant), /browser-smoke/);
});

test("disabling the live step fails while the command remains", () => {
  const mutant = liveWorkflow().replace(
    "name: Authenticated perf budgets (session-cookie journeys)\n        if: ${{ !cancelled() }}",
    "name: Authenticated perf budgets (session-cookie journeys)\n        if: false",
  );
  assert.match(mutant, /npm run auth-perf/);
  assert.throws(() => assertAuthPerfLiveGate(mutant), /browser-smoke/);
});

test("disabling the live step with expression or quoted false fails", () => {
  for (const replacement of [
    "name: Authenticated perf budgets (session-cookie journeys)\n        if: ${{ false }}",
    "name: Authenticated perf budgets (session-cookie journeys)\n        if: 'false'",
    'name: Authenticated perf budgets (session-cookie journeys)\n        if: "false"',
  ]) {
    const mutant = liveWorkflow().replace(
      "name: Authenticated perf budgets (session-cookie journeys)\n        if: ${{ !cancelled() }}",
      replacement,
    );
    assert.match(mutant, /npm run auth-perf/);
    assert.throws(() => assertAuthPerfLiveGate(mutant), /browser-smoke/);
  }
});

test("disabling the browser-smoke job fails while the command remains", () => {
  const mutant = liveWorkflow().replace(
    "  browser-smoke:\n    name: browser-smoke",
    "  browser-smoke:\n    name: browser-smoke\n    if: false",
  );
  assert.match(mutant, /npm run auth-perf/);
  assert.throws(() => assertAuthPerfLiveGate(mutant), /browser-smoke/);
});

test("swallowing the live command exit code fails", () => {
  for (const replacement of [
    "NODE_TLS_REJECT_UNAUTHORIZED=0 npm run auth-perf || true",
    "NODE_TLS_REJECT_UNAUTHORIZED=0 npm run auth-perf || :",
  ]) {
    const mutant = liveWorkflow().replace(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 npm run auth-perf",
      replacement,
    );
    assert.match(mutant, /npm run auth-perf/);
    assert.throws(() => assertAuthPerfLiveGate(mutant), /browser-smoke/);
  }
});

test("continue-on-error on the live step fails", () => {
  const mutant = liveWorkflow().replace(
    "      - name: Authenticated perf budgets (session-cookie journeys)\n        if: ${{ !cancelled() }}",
    "      - name: Authenticated perf budgets (session-cookie journeys)\n        if: ${{ !cancelled() }}\n        continue-on-error: true",
  );
  assert.match(mutant, /npm run auth-perf/);
  assert.throws(() => assertAuthPerfLiveGate(mutant), /browser-smoke/);
});

test("downgrading the local origin away from HTTPS fails", () => {
  const mutant = liveWorkflow().split(LIVE_ORIGIN).join("http://localhost:8787");
  assert.match(mutant, /auth-perf/);
  assert.throws(() => assertAuthPerfLiveGate(mutant), /browser-smoke/);
});
