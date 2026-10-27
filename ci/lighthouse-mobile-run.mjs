#!/usr/bin/env node
// Hardened mobile fixture-perf collection: one retry plus a diagnosis that
// tells a transient collect failure apart from a real budget breach.
//
// `lhci autorun` has no collect retry, so one transient Chrome/collect error
// (NO_NAVSTART, a Chrome crash) on any of the 24 runs aborts the whole mobile
// step with exit 1 — indistinguishable from a real budget breach. This wrapper
// keeps the same config, budgets and evidence, and adds:
//   1. a tee of the full lhci output to stdout (job log) AND
//      .lighthouseci/mobile-collect.log (uploaded artifact);
//   2. an LHR count vs expected (routes x numberOfRuns from
//      ci/lighthouserc.cjs: 8 x 3 = 24 on the fixture worker), counted from
//      collect's own per-run `.lighthouseci/lhr-*.json` files — the reports
//      dir holds only the median report per route, so it can never reach the
//      expected total;
//   3. ONE whole-run retry when lhci fails with short evidence (transient
//      suspected); a full-evidence assert failure (real breach) never retries;
//   4. .lighthouseci/mobile-collect-diagnosis.md classifying COLLECT FAILURE
//      (short evidence: re-run the step, do NOT lower budgets) vs BUDGET
//      BREACH (full evidence plus an evaluated assertion failure) vs an
//      unclassified step failure (full evidence but no assertion verdict: the
//      tails below name it).
// The mobile budgets (ci/lighthouserc.cjs assertions, performance floor in
// ci/quality-budget.json) are never touched here.
// Usage: npm run lighthouse [-- <extra lhci args>]
// Selftest: node ci/lighthouse-mobile-run.mjs --selftest (hermetic: injected
// lhci stub and temp dirs, no network or browser).
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ASSERT_FAILURE_MARKER,
  clearAttemptEvidence,
  hasAssertFailure,
  loadAssertions,
  loadCollectedLhrs,
} from "./lighthouse-quality-run.mjs";

const require = createRequire(import.meta.url);
const { sampleMatrix, evidenceLines } = require("./lighthouse-samples.cjs");

const REPORTS_DIR = ".lighthouseci/reports";
const LHCI_DIR = ".lighthouseci";
const LOG_FILE = ".lighthouseci/mobile-collect.log";
const DIAGNOSIS_FILE = ".lighthouseci/mobile-collect-diagnosis.md";
// One retry: a single transient needs two bad runs in a row to stay red; the
// mobile collect takes ~5 minutes, so a second attempt fits the lighthouse
// job's timeout with margin.
const MAX_ATTEMPTS = 2;
const DIAGNOSIS_TAIL_LINES = 60;

function lhciCli() {
  return require.resolve("@lhci/cli/src/cli.js");
}

// One `lhci autorun` attempt. Streams combined output to the parent's stdout
// (the CI job log) and returns the exit code plus the captured text for the
// artifact log, so a collect error is visible in both places.
export function runAutorun({ env = process.env, extraArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [lhciCli(), "autorun", "--config=ci/lighthouserc.cjs", ...extraArgs],
      { env },
    );
    let text = "";
    const pump = (chunk) => {
      text += chunk;
      process.stdout.write(chunk);
    };
    if (child.stdout) child.stdout.on("data", pump);
    if (child.stderr) child.stderr.on("data", pump);
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output: text }));
  });
}

// Expected LHRs, read from the same config lhci runs: every configured URL
// measured numberOfRuns times.
export function expectedLhrs() {
  delete require.cache[require.resolve("./lighthouserc.cjs")];
  try {
    const { ci } = require("./lighthouserc.cjs");
    return {
      collect: structuredClone(ci.collect),
      expected: ci.collect.url.length * ci.collect.numberOfRuns,
      runsPerRoute: ci.collect.numberOfRuns,
      mode: "fixture",
    };
  } finally {
    delete require.cache[require.resolve("./lighthouserc.cjs")];
  }
}

export function buildDiagnosis({ mode, expected, attempts }) {
  const last = attempts[attempts.length - 1];
  const collected = last.lhrs;
  const lines = [
    "## Lighthouse mobile collection diagnosis",
    "",
    `- mode: ${mode}`,
    `- expected LHRs: ${expected}`,
    ...attempts.map((a) => `- attempt ${a.n}: exit ${a.exitCode}, ${a.lhrs} LHRs`),
  ];
  let verdict;
  if (last.matrix.complete && last.assertFailed) {
    verdict =
      "BUDGET BREACH: full evidence collected and an assertion vs the mobile " +
      "budgets missed (performance floor ci/quality-budget.json, LCP/CLS/TBT " +
      "budgets ci/lighthouserc.cjs). See .lighthouseci/assertion-results.json " +
      "and .lighthouseci/reports/ for the route and the failing audits. Fix " +
      "the cause; do not lower the budgets.";
  } else if (last.matrix.complete) {
    verdict =
      "UNCLASSIFIED STEP FAILURE: full evidence collected but process or assertion evidence " +
      "did not establish success. No evaluated assertion failure, so no budget breach " +
      "was evidenced. The failure came from a collect, upload or config step — " +
      "read the tails below. Do not lower the budgets.";
  } else {
    verdict =
      `COLLECT FAILURE (transient/infra suspected): ${collected}/${expected} LHR files, ` +
      "but the planned per-URL sample quotas were not met. Re-run the failed step; do not " +
      "lower the budgets. If this recurs, the tail below names the " +
      "collect error (Chrome crash, NO_NAVSTART, timeout) to chase next.";
  }
  lines.push(`- verdict: ${verdict}`, "");
  lines.push("### Planned URL evidence", "", ...evidenceLines(last.matrix), "");
  lines.push("### Collect-error tails (last lines of each attempt)", "");
  for (const a of attempts) {
    lines.push(`#### Attempt ${a.n} (exit ${a.exitCode})`, "", "```", a.tail.trimEnd(), "```", "");
  }
  return { text: `${lines.join("\n")}\n`, verdict };
}

export async function main(
  argv,
  {
    env = process.env,
    run = runAutorun,
    reportsDir = REPORTS_DIR,
    lhciDir = LHCI_DIR,
    logFile = LOG_FILE,
    diagnosisFile = DIAGNOSIS_FILE,
    log = console.log,
  } = {},
) {
  const { collect, expected, runsPerRoute, mode } = expectedLhrs();
  const extraArgs = argv.filter((a) => a !== "--selftest");
  mkdirSync(join(logFile, ".."), { recursive: true });
  writeFileSync(logFile, "");

  const attempts = [];
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    if (n > 1) {
      log(
        `Collect short (${attempts[0].lhrs}/${expected} LHRs): retrying (attempt ${n}/${MAX_ATTEMPTS}).`,
      );
    }
    // Clean accounting for every attempt, including the first: stale LHRs or
    // reports from an earlier invocation must not masquerade as fresh
    // evidence (the log and any earlier diagnosis stay, since they live
    // outside both evidence dirs). clearAttemptEvidence's first parameter is
    // named for the desktop uploader but takes any per-route upload dir.
    clearAttemptEvidence({ qualityDir: reportsDir, lhciDir });
    log(
      `Lighthouse mobile collect: attempt ${n}/${MAX_ATTEMPTS} (${mode}, expecting ${expected} LHRs).`,
    );
    const started = Date.now();
    // Sequential by design: attempt 2 runs only when attempt 1 came up short.
    // A spawn failure (missing CLI, process error) is a failed attempt with
    // its error text, so the retry and diagnosis flow still handles it.
    let result;
    try {
      result = await run({ env, extraArgs });
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      result = { exitCode: 1, output: `lhci autorun failed to start: ${detail}\n` };
    }
    const { exitCode, output } = result;
    const elapsed = Math.round((Date.now() - started) / 1000);
    writeFileSync(logFile, `\n=== attempt ${n}: exit ${exitCode}, ${elapsed}s ===\n${output}`, {
      flag: "a",
    });
    const lhrObjects = loadCollectedLhrs(lhciDir);
    const matrix = sampleMatrix(lhrObjects, collect);
    const assertions = loadAssertions(lhciDir);
    const assertFailed =
      hasAssertFailure(output) ||
      assertions.some((failure) => failure.level === "error" && !failure.readError);
    attempts.push({
      matrix,
      n,
      exitCode,
      lhrs: lhrObjects.length,
      lhrObjects,
      runsPerRoute,
      assertFailed,
      tail: output.split("\n").slice(-DIAGNOSIS_TAIL_LINES).join("\n"),
    });
    if (
      exitCode === 0 &&
      matrix.complete &&
      !assertFailed &&
      !assertions.some((failure) => failure.readError)
    ) {
      log(`Collect complete: exit 0 with ${lhrObjects.length}/${expected} LHRs in ${elapsed}s.`);
      return 0;
    }
    if (matrix.complete) {
      const { text, verdict } = buildDiagnosis({ mode, expected, attempts });
      writeFileSync(diagnosisFile, text);
      log(verdict);
      return exitCode === 0 ? 1 : exitCode;
    }
    if (n === MAX_ATTEMPTS) {
      const { text, verdict } = buildDiagnosis({ mode, expected, attempts });
      writeFileSync(diagnosisFile, text);
      log(verdict);
      log(`Diagnosis written to ${diagnosisFile}; full output in ${logFile}.`);
      return exitCode === 0 ? 1 : exitCode;
    }
  }
  return 1;
}

async function selftest() {
  const { navigationMetadata } = await import("../test/lighthouse-navigation-fixtures.mjs");
  // expectedLhrs reads the real mobile config (no network): 8 fixture routes
  // at 3 runs each.
  const fixture = expectedLhrs();
  assert.equal(fixture.mode, "fixture");
  assert.equal(fixture.expected, 8 * 3);
  assert.equal(fixture.runsPerRoute, 3);

  const lhr = (url) => ({
    ...navigationMetadata("mobile"),
    requestedUrl: url,
    finalUrl: url,
    finalDisplayedUrl: url,
    categories: { performance: { score: 1 } },
  });

  // Retry matrix with a stubbed lhci (hermetic: temp dirs, no browser). The
  // stub mirrors the real filesystem upload: the reports dir holds ONE file
  // per route (runs overwrite each other, median survives) while the lhci dir
  // holds one lhr-<n>.json per run. A stub that wrote uniquely named reports
  // files would hide the dedup miscount this counting must survive.
  const runCase = async (script) => {
    const caseDir = mkdtempSync(join(tmpdir(), "lh-mobile-case-"));
    const lhci = join(caseDir, ".lighthouseci");
    const reports = join(lhci, "reports");
    mkdirSync(reports, { recursive: true });
    let calls = 0;
    const run = async () => {
      calls += 1;
      const step = script[calls - 1];
      if (step.reject) throw new Error(step.reject);
      // Emulate a fresh collect: per-run saved LHRs, then the deduping upload.
      step.urls.forEach((url, i) => {
        writeFileSync(
          join(lhci, `lhr-${calls}${String(i).padStart(4, "0")}.json`),
          JSON.stringify(lhr(url)),
        );
      });
      const marker = step.assertFailed ? `\n${ASSERT_FAILURE_MARKER}\n` : "";
      return {
        exitCode: step.exitCode,
        output: `stub attempt ${calls} ${step.note ?? ""}${marker}`,
      };
    };
    const code = await main([], {
      run,
      reportsDir: reports,
      lhciDir: lhci,
      logFile: join(caseDir, "collect.log"),
      diagnosisFile: join(caseDir, "diagnosis.md"),
    });
    return { code, calls, caseDir };
  };
  const urlsFor = ({ collect }) =>
    collect.url.flatMap((url) => Array.from({ length: collect.numberOfRuns }, () => url));
  const fixtureUrls = urlsFor(fixture);

  // Green first attempt: no retry, no diagnosis, exit 0.
  {
    const { code, calls, caseDir } = await runCase([{ exitCode: 0, urls: fixtureUrls }]);
    assert.equal(code, 0);
    assert.equal(calls, 1);
    assert.equal(loadCollectedLhrs(join(caseDir, ".lighthouseci")).length, 24);
  }
  // Stale evidence from an earlier invocation never counts: a leftover LHR
  // plus old reports are cleared before attempt 1.
  {
    const probe = mkdtempSync(join(tmpdir(), "lh-mobile-stale-"));
    const lhci = join(probe, ".lighthouseci");
    const reports = join(lhci, "reports");
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(lhci, "lhr-9.json"), JSON.stringify(lhr("https://h/stale/")));
    writeFileSync(join(reports, "stale-report.json"), JSON.stringify(lhr("https://h/stale/")));
    const code = await main([], {
      run: async () => ({ exitCode: 0, output: "stub green" }),
      reportsDir: reports,
      lhciDir: lhci,
      logFile: join(probe, "collect.log"),
      diagnosisFile: join(probe, "diagnosis.md"),
    });
    assert.equal(code, 1);
    assert.match(readFileSync(join(probe, "diagnosis.md"), "utf8"), /COLLECT FAILURE/);
    assert.equal(loadCollectedLhrs(lhci).length, 0);
  }
  // A spawn failure becomes a failed attempt (not a crash): short evidence
  // retries once, then the green second attempt gates.
  {
    const { code, calls, caseDir } = await runCase([
      { reject: "spawn /nope ENOENT" },
      { exitCode: 0, urls: fixtureUrls },
    ]);
    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.match(readFileSync(join(caseDir, "collect.log"), "utf8"), /failed to start/);
  }
  // Transient short failure then green: exactly one retry, exit 0.
  {
    const { code, calls } = await runCase([
      { exitCode: 1, urls: fixtureUrls.slice(0, 23), note: "NO_NAVSTART on run 24" },
      { exitCode: 0, urls: fixtureUrls },
    ]);
    assert.equal(code, 0);
    assert.equal(calls, 2);
  }
  // Full evidence plus the evaluated-assertion marker: real breach, NO retry,
  // BUDGET BREACH.
  {
    const { code, calls, caseDir } = await runCase([
      { exitCode: 1, urls: fixtureUrls, assertFailed: true },
    ]);
    assert.equal(code, 1);
    assert.equal(calls, 1);
    assert.match(readFileSync(join(caseDir, "diagnosis.md"), "utf8"), /BUDGET BREACH/);
  }
  // Full evidence but no assertion verdict (upload/config blew up): NO
  // retry, and the verdict must NOT claim budgets breached.
  {
    const { code, calls, caseDir } = await runCase([{ exitCode: 1, urls: fixtureUrls }]);
    assert.equal(code, 1);
    assert.equal(calls, 1);
    const diagnosis = readFileSync(join(caseDir, "diagnosis.md"), "utf8");
    assert.match(diagnosis, /UNCLASSIFIED STEP FAILURE/);
    assert.doesNotMatch(diagnosis, /BUDGET BREACH/);
  }
  // Short twice: COLLECT FAILURE, last exit code preserved, tail recorded.
  {
    const { code, calls, caseDir } = await runCase([
      { exitCode: 2, urls: [], note: "NO_NAVSTART boom" },
      { exitCode: 3, urls: fixtureUrls.slice(0, 6), note: "chrome crash boom" },
    ]);
    assert.equal(code, 3);
    assert.equal(calls, 2);
    const diagnosis = readFileSync(join(caseDir, "diagnosis.md"), "utf8");
    assert.match(diagnosis, /COLLECT FAILURE/);
    assert.match(diagnosis, /chrome crash boom/);
    assert.match(diagnosis, /attempt 1: exit 2, 0 LHRs/);
    assert.match(diagnosis, /attempt 2: exit 3, 6 LHRs/);
    assert.match(readFileSync(join(caseDir, "collect.log"), "utf8"), /stub attempt 1/);
  }
  // The mobile upload dir is cleared between attempts like the desktop one:
  // per-route median files from attempt 1 never leak into attempt 2.
  {
    const lhci = mkdtempSync(join(tmpdir(), "lh-mobile-clear-"));
    const reports = join(lhci, "reports");
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(lhci, "lhr-1.json"), "{}");
    writeFileSync(join(lhci, "mobile-collect.log"), "keep");
    writeFileSync(join(reports, "old-report.json"), "{}");
    clearAttemptEvidence({ qualityDir: reports, lhciDir: lhci });
    assert.equal(readdirSync(lhci).sort().join(","), "mobile-collect.log");
  }
  console.log("lighthouse-mobile-run selftest: ok");
}

// Gated on being the entry point: importing the helpers above must never
// trigger the selftest (or a main run) as a side effect of that import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--selftest")) {
    try {
      await selftest();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  } else process.exitCode = await main(process.argv.slice(2));
}
