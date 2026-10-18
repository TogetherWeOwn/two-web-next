// Acceptance: the web-standards gate must fail loudly when its link cap
// truncates coverage, instead of passing over partial coverage.
//
// The defect this pins: ci/web-standards.mjs checks only the first 300
// collected internal links (`maxLinks`) and silently drops the rest. A page
// set collecting more than 300 links exits 0 even when a link past position
// 300 resolves to nothing, and the summary reports only how many links were
// checked, never how many were collected.
//
// These tests pin the outcome contract only, through the gate's pure-helper
// seam (the same style as the existing exported `headerFindings` /
// `htmlFindings` helpers and the `--selftest` path that exercises them):
//
// - a new exported pure helper `linkFindings(links, matchers, publicDir)`
//   returns the findings for a collected link list in collection order;
// - under the cap its findings are byte-identical to today's inline check
//   (`internal link <link>: no app route or public file serves it`, in
//   order, nothing added);
// - over the cap it additionally emits exactly one truncation finding that
//   names the cap (300) and the total collected, so the gate (which exits 1
//   on any finding) fails loudly; links past the cap are not reported as
//   individually checked;
// - the summary line prints the total collected alongside the checked
//   count;
// - `--selftest` exercises the over-cap case, so the hermetic CI path
//   (`npm run standards:selftest`) covers it without a server.
//
// The helper is exercised in a child process: importing
// ci/web-standards.mjs in-process would run its top-level dispatch, and the
// child imports helpers only (with `--selftest` in argv, matching the
// module's existing dispatch) with an empty environment, an empty public
// dir, and synthetic matchers. No server, no network, no credentials.
//
// This file is owned by the acceptance test author. Implement against it;
// do not edit it to make it pass — return it to its author if it is wrong.
//
// Run: node --test ci/web-standards-maxlinks-acceptance.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repoRoot, "ci/web-standards.mjs");
const CAP = 300;

const resolvable = (n) => Array.from({ length: n }, (_, i) => `/ok-${i}`);
const resolutionFinding = (link) => `internal link ${link}: no app route or public file serves it`;

// One child run evaluates every behavioural case against the real module.
// Each case is a collected link list; `/ok-<n>` links resolve through the
// synthetic matcher, everything else resolves nowhere (empty public dir).
function runCases(cases) {
  const moduleUrl = new URL("./web-standards.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { mkdtempSync, readFileSync } from "node:fs";
       import { tmpdir } from "node:os";
       import { join } from "node:path";
       import * as standards from ${JSON.stringify(moduleUrl)};
       const cases = JSON.parse(readFileSync(0, "utf8"));
       const publicDir = mkdtempSync(join(tmpdir(), "standards-public-"));
       const matchers = [/^\\/ok-\\d+\\/?$/];
       const out = { hasLinkFindings: typeof standards.linkFindings === "function", findings: {} };
       if (out.hasLinkFindings) {
         for (const [name, links] of Object.entries(cases)) {
           out.findings[name] = standards.linkFindings(links, matchers, publicDir);
         }
       }
       console.log("ACCEPTANCE_JSON:" + JSON.stringify(out));`,
      "--",
      "--selftest",
    ],
    {
      cwd: repoRoot,
      env: {},
      input: JSON.stringify(cases),
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `helper child must run hermetically, got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  const line = result.stdout.split("\n").find((l) => l.startsWith("ACCEPTANCE_JSON:"));
  assert.ok(line, `helper child must report results\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("ACCEPTANCE_JSON:".length));
}

const CASES = {
  overCapBadPastCap: [...resolvable(CAP), "/past-cap-missing"],
  overCapBadWithinCap: [...resolvable(4), "/within-cap-missing", ...resolvable(CAP)],
  exactlyCapAllOk: resolvable(CAP),
  exactlyCapBadAtCap: [...resolvable(CAP - 1), "/at-cap-missing"],
  underCapMixed: ["/ok-1", "/bad-a", "/ok-2", "/bad-b"],
  empty: [],
};
let cachedResults;
const results = () => (cachedResults ??= runCases(CASES));
const truncations = (findings) => findings.filter((f) => /truncat/i.test(f));

test("web-standards exports the pure linkFindings helper the selftest seam uses", () => {
  assert.equal(
    results().hasLinkFindings,
    true,
    "ci/web-standards.mjs must export linkFindings(links, matchers, publicDir) returning findings in collection order",
  );
});

test("over-cap set with an unresolvable link past position 300 emits one truncation finding with the total collected", () => {
  assert.equal(results().hasLinkFindings, true, "linkFindings must exist");
  const findings = results().findings.overCapBadPastCap;
  assert.equal(
    truncations(findings).length,
    1,
    `expected one truncation finding, got: ${findings}`,
  );
  const [finding] = truncations(findings);
  assert.ok(
    finding.includes(String(CAP + 1)),
    `truncation finding must name total collected (${CAP + 1}): ${finding}`,
  );
  assert.ok(
    finding.includes(String(CAP)),
    `truncation finding must name the cap (${CAP}): ${finding}`,
  );
  // The past-cap link was not checked, so it is not reported as checked;
  // the truncation finding is what fails the gate over partial coverage.
  assert.ok(
    !findings.includes(resolutionFinding("/past-cap-missing")),
    `past-cap link must not be reported as checked: ${findings}`,
  );
  assert.deepEqual(
    findings.filter((f) => !/truncat/i.test(f)),
    [],
    `all ${CAP} checked links resolve, so only the truncation finding remains: ${findings}`,
  );
});

test("truncation does not suppress resolution findings for links within the cap", () => {
  assert.equal(results().hasLinkFindings, true, "linkFindings must exist");
  const total = CASES.overCapBadWithinCap.length;
  const findings = results().findings.overCapBadWithinCap;
  assert.ok(
    findings.includes(resolutionFinding("/within-cap-missing")),
    `within-cap unresolvable link must still be reported: ${findings}`,
  );
  assert.equal(
    truncations(findings).length,
    1,
    `expected one truncation finding, got: ${findings}`,
  );
  assert.ok(
    truncations(findings)[0].includes(String(total)),
    `truncation finding must name total collected (${total}): ${truncations(findings)[0]}`,
  );
});

test("exactly at the cap nothing is truncated", () => {
  assert.equal(results().hasLinkFindings, true, "linkFindings must exist");
  assert.deepEqual(results().findings.exactlyCapAllOk, []);
  assert.deepEqual(results().findings.exactlyCapBadAtCap, [resolutionFinding("/at-cap-missing")]);
});

test("under-cap findings are byte-identical to today's inline check", () => {
  assert.equal(results().hasLinkFindings, true, "linkFindings must exist");
  assert.deepEqual(results().findings.underCapMixed, [
    resolutionFinding("/bad-a"),
    resolutionFinding("/bad-b"),
  ]);
  assert.deepEqual(results().findings.empty, []);
});

test("summary prints total collected alongside the checked count", () => {
  const source = readFileSync(scriptPath, "utf8");
  const summaryLine = source
    .split("\n")
    .find((l) => /checked/i.test(l) && /collected/i.test(l) && /\$\{/.test(l));
  assert.ok(
    summaryLine,
    "the summary line must interpolate both the checked count and the total collected",
  );
});

test("--selftest exercises linkFindings and passes hermetically", () => {
  const source = readFileSync(scriptPath, "utf8");
  const selftestBody = source.slice(
    source.indexOf("function selftest()"),
    source.indexOf("async function waitForServer"),
  );
  assert.ok(
    selftestBody.includes("linkFindings"),
    "--selftest must cover the over-cap case through linkFindings",
  );
  const result = spawnSync(process.execPath, [scriptPath, "--selftest"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(
    result.status,
    0,
    `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stdout, /web-standards selftest: ok/);
});

test("standards:selftest stays wired to the web-standards selftest", () => {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  assert.ok(
    pkg.scripts["standards:selftest"].includes("node ci/web-standards.mjs --selftest"),
    "standards:selftest must keep running the web-standards selftest",
  );
});
