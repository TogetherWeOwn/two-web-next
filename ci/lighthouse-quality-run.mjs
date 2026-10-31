#!/usr/bin/env node
// Hardened desktop Lighthouse quality collection: one retry plus a diagnosis
// that tells a transient collect failure apart from a real floor breach.
//
// `lhci autorun` has no collect retry, so one transient Chrome/collect error
// (NO_NAVSTART, a Chrome crash, a staging timeout) yields partial or zero
// LHRs, and the gate then fails closed with "No Lighthouse LHRs loaded" —
// indistinguishable from a real floor breach, holding the staging deploy.
// This wrapper keeps the same config, floors and evidence, and adds:
//   1. a tee of the full lhci output to stdout (job log) AND
//      .lighthouseci/quality-collect.log (uploaded artifact);
//   2. an LHR count vs expected (routes x numberOfRuns from
//      ci/lighthouserc.quality.cjs: 21 on a deployed origin, 24 on the fixture
//      worker), counted from collect's own per-run `.lighthouseci/lhr-*.json`
//      files — the quality dir holds only the median report per route, so it
//      can never reach the expected total;
//   3. ONE whole-run retry when lhci fails with short evidence (transient
//      suspected); a full-evidence assert failure (real breach) never retries;
//   4. .lighthouseci/quality-collect-diagnosis.md classifying COLLECT FAILURE
//      (short evidence: re-run the step, do NOT lower floors) vs BUDGET
//      BREACH (full evidence plus an evaluated assertion failure: see
//      quality-summary.md) vs an unclassified step failure (full evidence but
//      no assertion verdict: the tails below name it).
// ci/quality-budget.json floors are never touched here.
// The mobile performance step (`npm run lighthouse`, ci/lighthouse-perf-run.mjs)
// runs this same flow with PROFILES.mobile: its own config, report dir, log and
// diagnosis, and the same rule that only short evidence ever retries.
// Usage: npm run lighthouse:quality [-- <extra lhci args>]
// Selftest: node ci/lighthouse-quality-run.mjs --selftest (hermetic: injected
// lhci stub and temp dirs, no network or browser).
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const {
  sampleMatrix,
  evidenceLines,
  checkFixtureDirectory,
  parseCheckFixtureArgs,
  invalidArgumentsResult,
} = require("./lighthouse-samples.cjs");

const LHCI_DIR = ".lighthouseci";
// One entry per gated collect. `budget` names the floors a diagnosis tells the
// reader not to lower; `breachEvidence` is where an evaluated miss is listed.
export const PROFILES = {
  desktop: {
    name: "desktop",
    label: "quality",
    config: "ci/lighthouserc.quality.cjs",
    configModule: require.resolve("./lighthouserc.quality.cjs"),
    loadConfig: () => require("./lighthouserc.quality.cjs"),
    reportsDir: ".lighthouseci/quality",
    logFile: ".lighthouseci/quality-collect.log",
    diagnosisFile: ".lighthouseci/quality-collect-diagnosis.md",
    budget: "ci/quality-budget.json",
    breachEvidence: "quality-summary.md",
    deployable: true,
  },
  mobile: {
    name: "mobile",
    label: "perf",
    config: "ci/lighthouserc.cjs",
    configModule: require.resolve("./lighthouserc.cjs"),
    loadConfig: () => require("./lighthouserc.cjs"),
    reportsDir: ".lighthouseci/reports",
    logFile: ".lighthouseci/perf-collect.log",
    diagnosisFile: ".lighthouseci/perf-collect-diagnosis.md",
    budget: "ci/lighthouserc.cjs",
    breachEvidence: "assertion-results.json",
    deployable: false,
  },
};
// Mirrors @lhci/utils saved-reports.js: collect saves every run as
// `.lighthouseci/lhr-<timestamp>.json` and clears those files at the start of
// each (non-additive) collect. The filesystem upload instead writes ONE file
// per route into the quality dir (reportFilenamePattern has no per-run token,
// so the runs of a route overwrite each other and only the median survives).
const LHR_FILE_REGEX = /^lhr-\d+\.json$/;
const LHR_HTML_REGEX = /^lhr-\d+\.html$/;
// One retry: the flake hit 3 runs in 3 days against many greens, so a single
// consecutive-failure needs two bad runs in a row; more attempts would not fit
// the quality job's timeout (mobile + desktop + standards share it).
const MAX_ATTEMPTS = 2;
const DIAGNOSIS_TAIL_LINES = 60;
// The exact line `lhci assert` prints (to stderr) when it evaluated the
// assertions and at least one error-level assertion missed (verified against
// @lhci/cli 0.15.1: `Assertion failed. Exiting with status code 1.`). A
// non-zero exit WITHOUT this marker means no floor was ever evaluated (the
// failure came from collect, upload or config), so it must not read as a
// floor breach.
export const ASSERT_FAILURE_MARKER = "Assertion failed. Exiting with status code 1.";

export function hasAssertFailure(output) {
  return output.includes(ASSERT_FAILURE_MARKER);
}

function lhciCli() {
  return require.resolve("@lhci/cli/src/cli.js");
}

// One `lhci autorun` attempt. Streams combined output to the parent's stdout
// (the CI job log) and returns the exit code plus the captured text for the
// artifact log, so a collect error is visible in both places.
export function runAutorun({
  env = process.env,
  extraArgs = [],
  config = PROFILES.desktop.config,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [lhciCli(), "autorun", `--config=${config}`, ...extraArgs],
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
// measured numberOfRuns times. Requiring the config also fails closed on an
// unallowlisted QUALITY_ORIGIN, exactly as the bare `lhci autorun` would.
// The mobile config is fixture-only and ignores QUALITY_ORIGIN.
export function expectedLhrs({ env = process.env, profile = PROFILES.desktop } = {}) {
  const saved = process.env.QUALITY_ORIGIN;
  try {
    if (env.QUALITY_ORIGIN !== undefined) process.env.QUALITY_ORIGIN = env.QUALITY_ORIGIN;
    else delete process.env.QUALITY_ORIGIN;
    delete require.cache[profile.configModule];
    const { ci } = profile.loadConfig();
    const deployed = profile.deployable && process.env.QUALITY_ORIGIN;
    return {
      collect: structuredClone(ci.collect),
      expected: ci.collect.url.length * ci.collect.numberOfRuns,
      runsPerRoute: ci.collect.numberOfRuns,
      mode: deployed ? `deployed (${process.env.QUALITY_ORIGIN})` : "fixture",
    };
  } finally {
    if (saved !== undefined) process.env.QUALITY_ORIGIN = saved;
    else delete process.env.QUALITY_ORIGIN;
    delete require.cache[profile.configModule];
  }
}

export function routeOf(url) {
  try {
    return new URL(url).pathname.replace(/\/$/, "") || "/";
  } catch {
    return url;
  }
}

// Same LHR filter as ci/lighthouse-summary.mjs: parsed JSON reports that carry
// categories (manifest.json and non-report files excluded).
export function loadLhrs(dir) {
  return readLhrFiles(dir, (name) => name.endsWith(".json") && name !== "manifest.json");
}

// Per-run evidence from collect itself: every collected run is saved under a
// name like `lhr-1729660800000.json`, surviving the upload dedup that collapses
// the quality dir to one median report per route. Counting here (not the
// quality dir) is what keeps a full-evidence floor breach from reading as a
// short collect.
export function loadCollectedLhrs(dir = LHCI_DIR) {
  return readLhrFiles(dir, (name) => LHR_FILE_REGEX.test(name));
}

function readLhrFiles(dir, accept) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const lhrs = [];
  for (const name of names) {
    if (!accept(name)) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (parsed.categories) lhrs.push(parsed);
    } catch {
      // A half-written report from a crashed run is missing evidence, not a
      // parse to hide: it simply does not count toward the expected total.
    }
  }
  return lhrs;
}

export function loadAssertions(dir = LHCI_DIR) {
  const path = join(dir, "assertion-results.json");
  if (!existsSync(path)) return [];
  try {
    const assertions = JSON.parse(readFileSync(path, "utf8"));
    if (
      !Array.isArray(assertions) ||
      assertions.some((entry) => !entry || typeof entry !== "object")
    ) {
      throw new Error("Invalid assertion results");
    }
    return assertions.filter((entry) => entry.passed !== true);
  } catch {
    // Malformed assertion evidence must not silently become an empty success.
    return [{ level: "error", auditId: "unreadable-assertion-results", readError: true }];
  }
}

// Fresh evidence for every attempt: stale quality reports AND stale saved LHRs
// (from the mobile `lhci autorun` step sharing this checkout, or an earlier
// invocation) must never count toward the new attempt. Mirrors lhci's own
// clearSavedReportsAndLHRs. The collect log and any earlier diagnosis live
// outside both dirs and survive.
export function clearAttemptEvidence({
  qualityDir = PROFILES.desktop.reportsDir,
  lhciDir = LHCI_DIR,
} = {}) {
  rmSync(qualityDir, { recursive: true, force: true });
  let names;
  try {
    names = readdirSync(lhciDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (
      !LHR_FILE_REGEX.test(name) &&
      !LHR_HTML_REGEX.test(name) &&
      name !== "assertion-results.json"
    )
      continue;
    try {
      rmSync(join(lhciDir, name));
    } catch {
      // Already gone between listing and removal: nothing stale remains.
    }
  }
}

export function shortfalls(lhrs, collect) {
  return sampleMatrix(lhrs, collect)
    .rows.filter((row) => row.runs.length < row.quota)
    .map((row) => [row.url, row.runs.length]);
}

export function buildDiagnosis({ mode, expected, attempts, profile = PROFILES.desktop }) {
  const last = attempts[attempts.length - 1];
  const collected = last.lhrs;
  const lines = [
    `## Lighthouse ${profile.label} collection diagnosis`,
    "",
    `- mode: ${mode}`,
    `- expected LHRs: ${expected}`,
    ...attempts.map((a) => `- attempt ${a.n}: exit ${a.exitCode}, ${a.lhrs} LHRs`),
  ];
  let verdict;
  if (last.matrix.complete && last.assertFailed) {
    verdict =
      "BUDGET BREACH: full evidence collected and an assertion vs " +
      `${profile.budget} missed. See ${profile.breachEvidence} for the route and ` +
      "the failing audits. Fix the cause; do not lower the floors.";
  } else if (last.matrix.complete) {
    verdict =
      "UNCLASSIFIED STEP FAILURE: full evidence collected but process or assertion evidence " +
      "did not establish success. No evaluated assertion failure, so no floor breach " +
      "was evidenced. The failure came from a collect, upload or config step — " +
      `read the tails below. Do not lower ${profile.budget}.`;
  } else {
    verdict =
      `COLLECT FAILURE (transient/infra suspected): ${collected}/${expected} LHR files, ` +
      "but the planned per-URL sample quotas were not met. Re-run the failed step; do not " +
      `lower ${profile.budget}. If this recurs, the tail below names the ` +
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
    profile = PROFILES.desktop,
    env = process.env,
    run = runAutorun,
    qualityDir = profile.reportsDir,
    lhciDir = LHCI_DIR,
    logFile = profile.logFile,
    diagnosisFile = profile.diagnosisFile,
    log = console.log,
  } = {},
) {
  // Read-only fixture verification: no collection, writes or archives.
  // Any check-shaped flag enters strict validation; unknown or malformed
  // check flags fail here with invalid_arguments before anything else runs.
  const wantsCheck = argv.some(
    (a) => a === "--check-fixture" || a === "--check-fixtures" || a === "--format",
  );
  if (wantsCheck) {
    const parsed = parseCheckFixtureArgs(argv.filter((a) => a !== "--selftest"));
    if (!parsed.ok) {
      log(JSON.stringify(invalidArgumentsResult(profile.name)));
      return 2;
    }
    const { collect } = expectedLhrs({ env, profile });
    const result = checkFixtureDirectory(parsed.dir, collect, profile.name);
    log(JSON.stringify(result));
    return result.code === "collection_complete" ? 0 : 1;
  }
  const { collect, expected, runsPerRoute, mode } = expectedLhrs({ env, profile });
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
    // quality reports from an earlier invocation must not masquerade as fresh
    // evidence (the log and any earlier diagnosis stay, since they live
    // outside both evidence dirs).
    clearAttemptEvidence({ qualityDir, lhciDir });
    log(
      `Lighthouse ${profile.label} collect: attempt ${n}/${MAX_ATTEMPTS} (${mode}, expecting ${expected} LHRs).`,
    );
    const started = Date.now();
    // Sequential by design: attempt 2 runs only when attempt 1 came up short.
    // A spawn failure (missing CLI, process error) is a failed attempt with
    // its error text, so the retry and diagnosis flow still handles it.
    let result;
    try {
      result = await run({ env, extraArgs, config: profile.config });
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
      const { text, verdict } = buildDiagnosis({ mode, expected, attempts, profile });
      writeFileSync(diagnosisFile, text);
      log(verdict);
      return exitCode === 0 ? 1 : exitCode;
    }
    if (n === MAX_ATTEMPTS) {
      const { text, verdict } = buildDiagnosis({ mode, expected, attempts, profile });
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
  // expectedLhrs reads the real configs (no network): fixture mode lists 8
  // routes (one is the fixture event), the staging deployed mode lists 7,
  // both at 3 runs each.
  const fixture = expectedLhrs({ env: {} });
  assert.equal(fixture.mode, "fixture");
  assert.equal(fixture.expected, 8 * 3); // 8 fixture routes (incl. the fixture event)
  const staging = expectedLhrs({ env: { QUALITY_ORIGIN: "https://next.togetherweown.com" } });
  assert.match(staging.mode, /deployed/);
  assert.equal(staging.expected, 7 * 3);
  assert.throws(
    () => expectedLhrs({ env: { QUALITY_ORIGIN: "https://evil.example/" } }),
    /allowlist|runs only against/,
  );

  // The breach marker is the exact line lhci assert prints on an evaluated
  // miss (verified by running `lhci assert` on a below-floor LHR: the run
  // exits 1 after this line). Plain stderr chatter must not count as a breach.
  assert.equal(hasAssertFailure("noise\nAssertion failed. Exiting with status code 1.\n"), true);
  assert.equal(hasAssertFailure("All results processed!\n"), false);
  assert.equal(hasAssertFailure(""), false);
  // Pin the marker against the installed lhci: if a future @lhci/cli rewords
  // the assert line, this fails loudly here instead of silently mislabeling a
  // real breach as UNCLASSIFIED.
  const installedAssert = readFileSync(require.resolve("@lhci/cli/src/assert/assert.js"), "utf8");
  assert.ok(
    installedAssert.includes(ASSERT_FAILURE_MARKER),
    "ASSERT_FAILURE_MARKER drifted from the installed @lhci/cli assert output",
  );

  // loadLhrs counts only parsed reports carrying categories.
  const dir = mkdtempSync(join(tmpdir(), "lh-quality-"));
  const lhr = (url, deployed = false) => ({
    ...navigationMetadata("desktop", { deployed }),
    requestedUrl: url,
    finalUrl: url,
    finalDisplayedUrl: url,
    categories: Object.fromEntries(
      ["performance", "accessibility", "best-practices", "seo"].map((id) => [id, { score: 1 }]),
    ),
  });
  writeFileSync(join(dir, "a-report.json"), JSON.stringify(lhr("https://h/")));
  writeFileSync(join(dir, "manifest.json"), "{}");
  writeFileSync(join(dir, "half.json"), "{truncated");
  assert.equal(loadLhrs(dir).length, 1);
  assert.equal(loadLhrs(join(dir, "missing")).length, 0);
  assert.deepEqual(
    shortfalls([lhr("https://h/"), lhr("https://h/")], {
      url: ["https://h/"],
      numberOfRuns: 3,
    }).map(([r]) => r),
    ["https://h/"],
  );
  assert.deepEqual(
    shortfalls([lhr("https://h/"), lhr("https://h/"), lhr("https://h/")], {
      url: ["https://h/"],
      numberOfRuns: 3,
    }),
    [],
  );

  // loadCollectedLhrs counts collect's per-run files (lhr-<digits>.json with
  // categories); the upload manifest and half-written files never count.
  {
    const lhci = mkdtempSync(join(tmpdir(), "lh-quality-collected-"));
    writeFileSync(join(lhci, "lhr-1.json"), JSON.stringify(lhr("https://h/")));
    writeFileSync(join(lhci, "lhr-2.json"), "{truncated");
    writeFileSync(join(lhci, "manifest.json"), "{}");
    writeFileSync(join(lhci, "assertion-results.json"), "{}");
    assert.equal(loadCollectedLhrs(lhci).length, 1);
    assert.equal(loadCollectedLhrs(join(lhci, "missing")).length, 0);
  }

  // clearAttemptEvidence removes stale per-run LHRs and the quality dir but
  // keeps the collect log, diagnosis and manifest-style files.
  {
    const lhci = mkdtempSync(join(tmpdir(), "lh-quality-clear-"));
    const qdir = join(lhci, "quality");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(lhci, "lhr-1.json"), "{}");
    writeFileSync(join(lhci, "lhr-1.html"), "<html></html>");
    writeFileSync(join(lhci, "quality-collect.log"), "keep");
    writeFileSync(join(qdir, "old-report.json"), "{}");
    clearAttemptEvidence({ qualityDir: qdir, lhciDir: lhci });
    assert.equal(readdirSync(lhci).sort().join(","), "quality-collect.log");
  }

  // Retry matrix with a stubbed lhci (hermetic: temp dirs, no browser). The
  // stub mirrors the real filesystem upload: the quality dir holds ONE file
  // per route (runs overwrite each other, median survives) while the lhci dir
  // holds one lhr-<n>.json per run. A stub that wrote uniquely named quality
  // files would hide the dedup miscount this wrapper once had.
  const runCase = async (script, { env = {} } = {}) => {
    const caseDir = mkdtempSync(join(tmpdir(), "lh-quality-case-"));
    const lhci = join(caseDir, ".lighthouseci");
    const qdir = join(lhci, "quality");
    mkdirSync(qdir, { recursive: true });
    const deployed = Boolean(env.QUALITY_ORIGIN);
    let calls = 0;
    const run = async () => {
      calls += 1;
      const step = script[calls - 1];
      if (step.reject) throw new Error(step.reject);
      // Emulate a fresh collect: per-run saved LHRs, then the deduping upload.
      clearAttemptEvidence({ qualityDir: qdir, lhciDir: lhci });
      mkdirSync(qdir, { recursive: true });
      step.urls.forEach((url, i) => {
        writeFileSync(
          join(lhci, `lhr-${calls}${String(i).padStart(4, "0")}.json`),
          JSON.stringify(lhr(url, deployed)),
        );
      });
      for (const route of new Set(step.urls.map(routeOf))) {
        const slug = route === "/" ? "root" : route.replaceAll("/", "_");
        writeFileSync(
          join(qdir, `${slug}-report.json`),
          JSON.stringify(lhr(`https://h${route}`, deployed)),
        );
      }
      const marker = step.assertFailed ? `\n${ASSERT_FAILURE_MARKER}\n` : "";
      return {
        exitCode: step.exitCode,
        output: `stub attempt ${calls} ${step.note ?? ""}${marker}`,
      };
    };
    const code = await main([], {
      env,
      run,
      qualityDir: qdir,
      lhciDir: lhci,
      logFile: join(caseDir, "collect.log"),
      diagnosisFile: join(caseDir, "diagnosis.md"),
    });
    return { code, calls, caseDir };
  };
  // 8 fixture routes x 3 runs; 7 staging routes x 3 runs.
  const urlsFor = ({ collect }) =>
    collect.url.flatMap((url) => Array.from({ length: collect.numberOfRuns }, () => url));
  const fixtureUrls = urlsFor(fixture);
  const stagingUrls = urlsFor(staging);
  const stagingEnv = { env: { QUALITY_ORIGIN: "https://next.togetherweown.com" } };

  // Green first attempt: no retry, no diagnosis, exit 0.
  {
    const { code, calls, caseDir } = await runCase([{ exitCode: 0, urls: fixtureUrls }]);
    assert.equal(code, 0);
    assert.equal(calls, 1);
    assert.equal(loadCollectedLhrs(join(caseDir, ".lighthouseci")).length, 24);
  }
  // Stale evidence from an earlier invocation never counts: a leftover
  // mobile-run LHR plus old quality reports are cleared before attempt 1.
  {
    const probe = mkdtempSync(join(tmpdir(), "lh-quality-stale-"));
    const lhci = join(probe, ".lighthouseci");
    const qdir = join(lhci, "quality");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(lhci, "lhr-9.json"), JSON.stringify(lhr("https://h/stale/")));
    writeFileSync(join(qdir, "stale-report.json"), JSON.stringify(lhr("https://h/stale/")));
    const code = await main([], {
      env: {},
      run: async () => ({ exitCode: 0, output: "stub green" }),
      qualityDir: qdir,
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
  // Transient short failure then green: exactly one retry, exit 0.
  {
    const { code, calls } = await runCase([
      { exitCode: 1, urls: fixtureUrls.slice(0, 4) },
      { exitCode: 0, urls: fixtureUrls },
    ]);
    assert.equal(code, 0);
    assert.equal(calls, 2);
  }
  // Full evidence plus the evaluated-assertion marker on the staging shape
  // (21 runs deduped to 7 quality files): real breach, NO retry,
  // BUDGET BREACH. This is the PR #1021 review finding, pinned.
  {
    const { code, calls, caseDir } = await runCase(
      [{ exitCode: 1, urls: stagingUrls, assertFailed: true }],
      stagingEnv,
    );
    assert.equal(code, 1);
    assert.equal(calls, 1);
    assert.match(readFileSync(join(caseDir, "diagnosis.md"), "utf8"), /BUDGET BREACH/);
  }
  // Full evidence but no assertion verdict (upload/config blew up): NO
  // retry, and the verdict must NOT claim a floor breached.
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
  console.log("lighthouse-quality-run selftest: ok");
}

// Gated on being the entry point: ci/lighthouse-origin-run.mjs imports the
// helpers above, and must never trigger this selftest (or a main run) as a
// side effect of that import.
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
