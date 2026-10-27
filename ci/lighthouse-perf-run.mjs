#!/usr/bin/env node
// Hardened mobile-fixture Lighthouse performance collection: one retry plus a
// diagnosis that tells a transient collect failure apart from a real budget
// breach.
//
// `lhci autorun` has no collect retry, so one transient Chrome/collect error
// (NO_NAVSTART, a Chrome crash) fails the whole `lighthouse` job even when
// every other run is green — as seen on main when /privacy run 2 of 3 hit
// NO_NAVSTART and the rerun passed fully. The desktop quality step
// (ci/lighthouse-quality-run.mjs) and the deployed-origin mobile step
// (ci/lighthouse-origin-run.mjs) already wrap their collects this way; this
// runner gives the local fixture mobile collect (ci/lighthouserc.cjs: 8 routes
// x 3 runs = 24 LHRs) the same treatment, keeping the same config, budgets
// and evidence, and adding:
//   1. a tee of the full lhci output to stdout (job log) AND
//      .lighthouseci/perf-collect.log (uploaded artifact);
//   2. an LHR count vs expected, counted from collect's own per-run
//      `.lighthouseci/lhr-*.json` files — the reports dir holds only the
//      median report per route, so it can never reach the expected total;
//   3. ONE whole-run retry when lhci fails with short evidence (transient
//      suspected); a full-evidence assert failure (real breach) never retries;
//   4. .lighthouseci/perf-collect-diagnosis.md classifying COLLECT FAILURE
//      (short evidence: re-run the step, do NOT lower budgets) vs BUDGET
//      BREACH (full evidence plus an evaluated assertion failure) vs an
//      unclassified step failure (full evidence but no assertion verdict: the
//      tails below name it).
// ci/lighthouserc.cjs budgets are never touched here.
// Usage: npm run lighthouse [-- <extra lhci args>]
// Selftest: node ci/lighthouse-perf-run.mjs --selftest (hermetic: injected
// lhci stub and temp dirs, no network or browser).
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  clearAttemptEvidence,
  hasAssertFailure,
  loadAssertions,
  loadCollectedLhrs,
  routeOf,
} from "./lighthouse-quality-run.mjs";

const require = createRequire(import.meta.url);
const { sampleMatrix, evidenceLines } = require("./lighthouse-samples.cjs");

const REPORTS_DIR = ".lighthouseci/reports";
const LHCI_DIR = ".lighthouseci";
const LOG_FILE = ".lighthouseci/perf-collect.log";
const DIAGNOSIS_FILE = ".lighthouseci/perf-collect-diagnosis.md";
// One retry: a single transient needs two bad runs in a row to stay red; more
// attempts would not fit the lighthouse job's timeout (mobile plus desktop
// collect and standards share it).
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
    "## Lighthouse mobile-fixture collection diagnosis",
    "",
    `- mode: ${mode}`,
    `- expected LHRs: ${expected}`,
    ...attempts.map((a) => `- attempt ${a.n}: exit ${a.exitCode}, ${a.lhrs} LHRs`),
  ];
  let verdict;
  if (last.matrix.complete && last.assertFailed) {
    verdict =
      "BUDGET BREACH: full evidence collected and an assertion vs " +
      "ci/lighthouserc.cjs missed. Fix the cause; do not lower the budgets.";
  } else if (last.matrix.complete) {
    verdict =
      "UNCLASSIFIED STEP FAILURE: full evidence collected but process or assertion evidence " +
      "did not establish success. No evaluated assertion failure, so no budget breach " +
      "was evidenced. The failure came from a collect, upload or config step — " +
      "read the tails below. Do not lower ci/lighthouserc.cjs.";
  } else {
    verdict =
      `COLLECT FAILURE (transient/infra suspected): ${collected}/${expected} LHR files, ` +
      "but the planned per-URL sample quotas were not met. Re-run the failed step; do not " +
      "lower ci/lighthouserc.cjs. If this recurs, the tail below names the " +
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
  const { collect, expected, mode } = expectedLhrs();
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
    // outside both evidence dirs). The shared clearer takes the mobile
    // reports dir as the per-route upload dir to empty.
    clearAttemptEvidence({ qualityDir: reportsDir, lhciDir });
    log(
      `Lighthouse mobile-fixture collect: attempt ${n}/${MAX_ATTEMPTS} (${mode}, expecting ${expected} LHRs).`,
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
  const { ASSERT_FAILURE_MARKER } = await import("./lighthouse-quality-run.mjs");
  // expectedLhrs reads the real mobile-fixture config (no network): 8 routes
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
  // holds one lhr-<n>.json per run.
  const runCase = async (script) => {
    const caseDir = mkdtempSync(join(tmpdir(), "lh-perf-case-"));
    const lhci = join(caseDir, ".lighthouseci");
    const rdir = join(lhci, "reports");
    mkdirSync(rdir, { recursive: true });
    let calls = 0;
    const run = async () => {
      calls += 1;
      const step = script[calls - 1];
      if (step.reject) throw new Error(step.reject);
      // Emulate a fresh collect: per-run saved LHRs, then the deduping upload.
      clearAttemptEvidence({ qualityDir: rdir, lhciDir: lhci });
      mkdirSync(rdir, { recursive: true });
      step.urls.forEach((url, i) => {
        writeFileSync(
          join(lhci, `lhr-${calls}${String(i).padStart(4, "0")}.json`),
          JSON.stringify(lhr(url)),
        );
      });
      for (const route of new Set(step.urls.map(routeOf))) {
        const slug = route === "/" ? "root" : route.replaceAll("/", "_");
        writeFileSync(join(rdir, `${slug}-report.json`), JSON.stringify(lhr(`https://h${route}`)));
      }
      const marker = step.assertFailed ? `\n${ASSERT_FAILURE_MARKER}\n` : "";
      return {
        exitCode: step.exitCode,
        output: `stub attempt ${calls} ${step.note ?? ""}${marker}`,
      };
    };
    const code = await main([], {
      run,
      reportsDir: rdir,
      lhciDir: lhci,
      logFile: join(caseDir, "collect.log"),
      diagnosisFile: join(caseDir, "diagnosis.md"),
    });
    return { code, calls, caseDir };
  };
  const fixtureUrls = fixture.collect.url.flatMap((url) =>
    Array.from({ length: fixture.collect.numberOfRuns }, () => url),
  );

  // Green first attempt: no retry, no diagnosis, exit 0.
  {
    const { code, calls, caseDir } = await runCase([{ exitCode: 0, urls: fixtureUrls }]);
    assert.equal(code, 0);
    assert.equal(calls, 1);
    assert.equal(loadCollectedLhrs(join(caseDir, ".lighthouseci")).length, 24);
  }
  // Stale evidence from an earlier invocation never counts: leftover LHRs and
  // old reports are cleared before attempt 1.
  {
    const probe = mkdtempSync(join(tmpdir(), "lh-perf-stale-"));
    const lhci = join(probe, ".lighthouseci");
    const rdir = join(lhci, "reports");
    mkdirSync(rdir, { recursive: true });
    writeFileSync(join(lhci, "lhr-9.json"), JSON.stringify(lhr("https://h/stale/")));
    writeFileSync(join(rdir, "stale-report.json"), JSON.stringify(lhr("https://h/stale/")));
    const code = await main([], {
      run: async () => ({ exitCode: 0, output: "stub green" }),
      reportsDir: rdir,
      lhciDir: lhci,
      logFile: join(probe, "collect.log"),
      diagnosisFile: join(probe, "diagnosis.md"),
    });
    assert.equal(code, 1);
    assert.match(readFileSync(join(probe, "diagnosis.md"), "utf8"), /COLLECT FAILURE/);
    assert.equal(loadCollectedLhrs(lhci).length, 0);
  }
  // A spawn failure becomes a failed attempt (not a crash): short evidence
  // retries once, then COLLECT FAILURE keeps the last exit code.
  {
    const { code, calls, caseDir } = await runCase([
      { reject: "spawn /nope ENOENT" },
      { exitCode: 0, urls: fixtureUrls },
    ]);
    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.match(readFileSync(join(caseDir, "collect.log"), "utf8"), /failed to start/);
  }
  // Transient short failure then green (the NO_NAVSTART shape: exit 1 with a
  // partial per-run set): exactly one retry, exit 0.
  {
    const { code, calls } = await runCase([
      { exitCode: 1, urls: fixtureUrls.slice(0, 23), note: "NO_NAVSTART boom" },
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
  // retry, and the verdict must NOT claim a budget breached.
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
  console.log("lighthouse-perf-run selftest: ok");
}

// Gated on being the entry point: importing the helpers above must never
// trigger this selftest (or a main run) as a side effect of that import.
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
