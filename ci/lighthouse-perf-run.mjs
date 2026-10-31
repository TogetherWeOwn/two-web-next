#!/usr/bin/env node
// Hardened mobile Lighthouse performance collection (`npm run lighthouse`).
//
// A bare `lhci autorun --config=ci/lighthouserc.cjs` has no collect retry, so
// one transient Chrome/collect error (NO_NAVSTART, a Chrome crash) turns the
// lighthouse job red with no budget evaluated. This runs the desktop step's
// flow (ci/lighthouse-quality-run.mjs) with PROFILES.mobile: ONE whole-run
// retry when any planned URL is short of its samples, never when full evidence
// failed an assertion, plus `.lighthouseci/perf-collect.log` and, on failure,
// `.lighthouseci/perf-collect-diagnosis.md`. ci/lighthouserc.cjs budgets are
// never touched here.
// Usage: npm run lighthouse [-- <extra lhci args>]
// Selftest: node ci/lighthouse-perf-run.mjs --selftest (hermetic: stubbed
// collect, the real mobile assertions, temp dirs, no network or browser).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ASSERT_FAILURE_MARKER,
  PROFILES,
  clearAttemptEvidence,
  expectedLhrs,
  main,
} from "./lighthouse-quality-run.mjs";

const require = createRequire(import.meta.url);

async function selftest() {
  const { navigationMetadata } = await import("../test/lighthouse-navigation-fixtures.mjs");
  const { getAllAssertionResults } = require("@lhci/utils/src/assertions.js");
  const { assertions } = require("./lighthouserc.cjs").ci.assert;
  const profile = PROFILES.mobile;

  // Read from the real mobile config: 8 fixture routes x 3 runs, and a stray
  // QUALITY_ORIGIN never turns the fixture-only mobile step into a deployed run.
  const plan = expectedLhrs({ env: {}, profile });
  assert.equal(plan.expected, 8 * 3);
  assert.equal(plan.mode, "fixture");
  assert.equal(
    expectedLhrs({ env: { QUALITY_ORIGIN: "https://next.togetherweown.com" }, profile }).mode,
    "fixture",
  );
  const planned = plan.collect.url.flatMap((url) => Array(plan.runsPerRoute).fill(url));

  const audit = (numericValue, score = 1) => ({ numericValue, score });
  const lhr = (url, lcp) => ({
    ...navigationMetadata("mobile"),
    requestedUrl: url,
    finalUrl: url,
    finalDisplayedUrl: url,
    categories: { performance: { score: lcp > 2000 ? 0.8 : 0.99 } },
    audits: {
      "first-contentful-paint": audit(900),
      interactive: audit(1500),
      "largest-contentful-paint": audit(lcp, lcp > 2000 ? 0.5 : 1),
      "cumulative-layout-shift": audit(0.01),
      "server-response-time": audit(100),
      "total-blocking-time": audit(50),
    },
  });

  // Each stub attempt saves its LHRs the way collect does, then evaluates the
  // REAL mobile assertions over them, as `lhci assert` would, so a budget miss
  // here is the checked-in LCP budget, not a hand-written verdict.
  const runCase = async (script) => {
    const caseDir = mkdtempSync(join(tmpdir(), "lh-perf-case-"));
    const lhciDir = join(caseDir, ".lighthouseci");
    const reportsDir = join(lhciDir, "reports");
    const configs = [];
    let calls = 0;
    const run = async ({ config }) => {
      configs.push(config);
      calls += 1;
      const step = script[calls - 1];
      clearAttemptEvidence({ qualityDir: reportsDir, lhciDir });
      mkdirSync(reportsDir, { recursive: true });
      const lhrs = step.urls.map((url) => lhr(url, step.lcp ?? 1200));
      lhrs.forEach((report, i) => {
        writeFileSync(
          join(lhciDir, `lhr-${calls}${String(i).padStart(4, "0")}.json`),
          JSON.stringify(report),
        );
      });
      if (lhrs.length < planned.length)
        return { exitCode: 1, output: `stub ${calls}: ${step.note}` };
      const failures = getAllAssertionResults({ assertions }, lhrs);
      writeFileSync(join(lhciDir, "assertion-results.json"), JSON.stringify(failures));
      const breached = failures.some((f) => f.level === "error");
      return {
        exitCode: breached ? 1 : 0,
        output: `stub ${calls}${breached ? `\n${ASSERT_FAILURE_MARKER}\n` : ""}`,
      };
    };
    const code = await main([], {
      profile,
      env: {},
      run,
      qualityDir: reportsDir,
      lhciDir,
      logFile: join(caseDir, "perf-collect.log"),
      diagnosisFile: join(caseDir, "perf-collect-diagnosis.md"),
      log: () => {},
    });
    const read = (name) => {
      try {
        return readFileSync(join(caseDir, name), "utf8");
      } catch {
        return "";
      }
    };
    return { code, calls, configs, diagnosis: read("perf-collect-diagnosis.md") };
  };

  // Transient collect failure, then a full passing collect: one retry, green,
  // and every attempt runs the mobile config.
  {
    const r = await runCase([
      { urls: planned.slice(0, 5), note: "NO_NAVSTART" },
      { urls: planned },
    ]);
    assert.equal(r.code, 0);
    assert.equal(r.calls, 2);
    assert.deepEqual(r.configs, [profile.config, profile.config]);
    assert.equal(r.diagnosis, "");
  }
  // Short twice: bounded at two attempts, red, COLLECT FAILURE.
  {
    const r = await runCase([
      { urls: [], note: "chrome crash" },
      { urls: planned.slice(0, 23), note: "chrome crash again" },
    ]);
    assert.equal(r.code, 1);
    assert.equal(r.calls, 2);
    assert.match(r.diagnosis, /COLLECT FAILURE/);
    assert.match(r.diagnosis, /chrome crash again/);
    assert.match(r.diagnosis, /do not\s+lower ci\/lighthouserc\.cjs/);
  }
  // Full evidence over the real LCP budget: no retry, red, BUDGET BREACH.
  {
    const r = await runCase([{ urls: planned, lcp: 2600 }, { urls: planned }]);
    assert.equal(r.code, 1);
    assert.equal(r.calls, 1);
    assert.match(r.diagnosis, /BUDGET BREACH/);
  }
  // A retried collect that then misses the budget still fails: the retry
  // recovers evidence, never a score.
  {
    const r = await runCase([
      { urls: planned.slice(0, 3), note: "timeout" },
      { urls: planned, lcp: 2600 },
    ]);
    assert.equal(r.code, 1);
    assert.equal(r.calls, 2);
    assert.match(r.diagnosis, /BUDGET BREACH/);
  }
  console.log("lighthouse-perf-run selftest: ok");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--selftest")) {
    try {
      await selftest();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  } else process.exitCode = await main(process.argv.slice(2), { profile: PROFILES.mobile });
}
