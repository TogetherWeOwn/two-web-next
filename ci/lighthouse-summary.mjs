// One actionable summary for the web quality gate: per-route Lighthouse category scores vs ci/quality-budget.json,
// the failing audits behind any miss, and the heaviest offending resources, plus the web-standards findings.
// Written to .lighthouseci/quality-summary.md and printed (CI appends it to the job summary). Zero loaded LHRs
// fails the step (exit 1 plus a ::error:: annotation) instead of publishing a blank summary, unless the run was
// explicitly marked as skipped with LIGHTHOUSE_SUMMARY_ALLOW_EMPTY=1: the lhci and web-standards steps own the
// verdict, and this guard owns the missing-evidence case. --selftest checks the formatter and the guard.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { expectedLhrs, loadCollectedLhrs, loadLhrs } from "./lighthouse-quality-run.mjs";

const require = createRequire(import.meta.url);
const { sampleMatrix, evidenceLines } = require("./lighthouse-samples.cjs");

const budget = JSON.parse(readFileSync(new URL("./quality-budget.json", import.meta.url), "utf8"));

export function routeOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return url;
  }
}

export function summarize(lhrs, minScores) {
  const byRoute = new Map();
  for (const lhr of lhrs) {
    const route = routeOf(lhr.requestedUrl || lhr.finalDisplayedUrl || lhr.finalUrl || "");
    byRoute.set(route, [...(byRoute.get(route) ?? []), lhr]);
  }
  const lines = [
    "## Lighthouse quality (desktop)",
    "",
    `| route | ${Object.keys(minScores).join(" | ")} |`,
    `|---|${Object.keys(minScores)
      .map(() => "---")
      .join("|")}|`,
  ];
  const misses = [];
  for (const [route, runs] of byRoute) {
    // The middle run by performance score stands for the route (lhci's median-run).
    runs.sort(
      (a, b) => (a.categories?.performance?.score ?? 0) - (b.categories?.performance?.score ?? 0),
    );
    const lhr = runs[Math.floor(runs.length / 2)];
    const cells = Object.entries(minScores).map(([cat, min]) => {
      const score = lhr.categories?.[cat]?.score;
      const pct = score == null ? "n/a" : Math.round(score * 100);
      if (score == null || score < min) {
        misses.push({ route, cat, score, min, lhr });
        return `**${pct}** (< ${Math.round(min * 100)})`;
      }
      return String(pct);
    });
    lines.push(`| ${route} | ${cells.join(" | ")} |`);
  }
  if (misses.length) {
    lines.push("", "### What to fix (fix the cause; do not lower ci/quality-budget.json)", "");
    for (const { route, cat, lhr } of misses) {
      const refs = lhr.categories[cat]?.auditRefs ?? [];
      const failing = refs
        .filter((r) => r.weight > 0 && (lhr.audits[r.id]?.score ?? 1) < 0.9)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 5);
      lines.push(`- **${route} ${cat}**:`);
      for (const r of failing) {
        const audit = lhr.audits[r.id];
        lines.push(`  - ${audit.title}${audit.displayValue ? ` (${audit.displayValue})` : ""}`);
        const items = (audit.details?.items ?? [])
          .filter((i) => i.url || i.node?.snippet)
          .sort((a, b) => (b.wastedBytes ?? b.wastedMs ?? 0) - (a.wastedBytes ?? a.wastedMs ?? 0))
          .slice(0, 3);
        for (const i of items)
          lines.push(
            `    - ${i.url ?? i.node.snippet}${i.wastedBytes ? ` (${Math.round(i.wastedBytes / 1024)} KiB)` : ""}`,
          );
      }
    }
  }
  return lines.join("\n") + "\n";
}

// Fail-closed guard for missing evidence: a blank summary with no artifact is
// indistinguishable from all-budgets-passed, so zero loaded LHRs fails unless
// the run was explicitly marked as skipped (LIGHTHOUSE_SUMMARY_ALLOW_EMPTY=1,
// e.g. a workflow edit that skips the collect step but still runs the summary).
// Job-level skips (drafts, out-of-scope paths) never reach this script.
export const ALLOW_EMPTY_ENV = "LIGHTHOUSE_SUMMARY_ALLOW_EMPTY";

export function emptyResult({ allowEmpty }) {
  if (allowEmpty) {
    return {
      exitCode: 0,
      text: "## Lighthouse quality\n\nNo quality reports (the step did not run or failed before collecting).\n",
      error: null,
    };
  }
  const reason =
    "No Lighthouse LHRs loaded from .lighthouseci/quality (the quality step did not run or failed before collecting). Failing closed instead of publishing a blank summary.";
  return {
    exitCode: 1,
    text: `## Lighthouse quality\n\n${reason}\n`,
    error: `::error::${reason}`,
  };
}

// The main-block wiring extracted so the selftest pins it: the empty branch,
// the ALLOW_EMPTY_ENV read, and the exit code. Callers redirect stdout to
// $GITHUB_STEP_SUMMARY, so the ::error:: annotation must go to stderr.
export function buildSummary({
  lhrs,
  collectedLhrs = lhrs,
  hasReportFiles = lhrs.length + collectedLhrs.length > 0,
  env = process.env,
  standardsText = null,
}) {
  const parts = [];
  const allowEmpty = env[ALLOW_EMPTY_ENV] === "1" && !hasReportFiles;
  const { collect } = expectedLhrs({ env });
  const matrix = sampleMatrix(collectedLhrs, collect);
  let exitCode = 0;
  let error = null;
  if (lhrs.length === 0) {
    const result = emptyResult({ allowEmpty });
    parts.push(result.text);
    exitCode = result.exitCode;
    error = result.error;
  } else {
    parts.push(summarize(lhrs, budget.categories));
  }
  if (!(lhrs.length === 0 && allowEmpty)) {
    parts.push("### Planned URL collection evidence\n", ...evidenceLines(matrix));
    if (!matrix.complete) {
      exitCode = 1;
      error ??=
        "::error::Incomplete Lighthouse collection: planned per-URL sample quotas were not met.";
      parts.push(
        "\nCOLLECT FAILURE: incomplete per-URL evidence; category scores are not a completeness verdict.\n",
      );
    }
  }
  if (standardsText) parts.push(standardsText);
  return { text: parts.join("\n"), exitCode, error };
}

async function selftest() {
  const { navigationMetadata } = await import("../test/lighthouse-navigation-fixtures.mjs");
  const lhr = (url, a11y) => ({
    ...navigationMetadata("desktop"),
    requestedUrl: url,
    finalUrl: url,
    finalDisplayedUrl: url,
    categories: {
      performance: { score: 0.95, auditRefs: [] },
      accessibility: { score: a11y, auditRefs: [{ id: "color-contrast", weight: 7 }] },
    },
    audits: {
      "color-contrast": {
        title: "Contrast",
        score: 0,
        details: { items: [{ node: { snippet: "<a class=x>" } }] },
      },
    },
  });
  const out = summarize([lhr("http://h/", 0.9), lhr("http://h/", 0.9), lhr("http://h/faq", 1)], {
    performance: 0.9,
    accessibility: 0.95,
  });
  assert.match(out, /\| \/ \| 95 \| \*\*90\*\* \(< 95\) \|/);
  assert.match(out, /\| \/faq \| 95 \| 100 \|/);
  assert.match(out, /Contrast/);
  assert.match(out, /<a class=x>/);
  // Fail-closed pin: reverting the guard (exit 0 on zero LHRs) fails this selftest.
  const closed = emptyResult({ allowEmpty: false });
  assert.equal(closed.exitCode, 1);
  assert.match(closed.error, /^::error::/);
  assert.match(closed.text, /No Lighthouse LHRs loaded/);
  const skipped = emptyResult({ allowEmpty: true });
  assert.equal(skipped.exitCode, 0);
  assert.equal(skipped.error, null);
  assert.match(skipped.text, /No quality reports/);
  // Call-site wiring pin: buildSummary owns the empty branch, the env read,
  // and the exit code, so mutants on the main block fail here.
  const wiredClosed = buildSummary({ lhrs: [], env: {}, standardsText: null });
  assert.equal(wiredClosed.exitCode, 1);
  assert.match(wiredClosed.error, /^::error::/);
  assert.match(wiredClosed.text, /No Lighthouse LHRs loaded/);
  const wiredSkipped = buildSummary({
    lhrs: [],
    env: { [ALLOW_EMPTY_ENV]: "1" },
    standardsText: null,
  });
  assert.equal(wiredSkipped.exitCode, 0);
  assert.equal(wiredSkipped.error, null);
  assert.match(wiredSkipped.text, /No quality reports/);
  const { collect } = expectedLhrs({ env: {} });
  const full = collect.url.flatMap((url) =>
    Array.from({ length: collect.numberOfRuns }, () => ({
      ...lhr(url, 1),
      categories: Object.fromEntries(
        Object.keys(budget.categories).map((id) => [id, { score: 1 }]),
      ),
    })),
  );
  const wiredFull = buildSummary({ lhrs: full, env: {}, standardsText: null });
  assert.equal(wiredFull.exitCode, 0);
  assert.equal(wiredFull.error, null);
  assert.match(wiredFull.text, /Lighthouse quality/);
  // End-to-end pin: the script process itself fails closed. Kills mutants that
  // drop process.exitCode, force allowEmpty, or bypass the length check.
  const scriptPath = process.argv[1];
  const baseEnv = { ...process.env };
  delete baseEnv[ALLOW_EMPTY_ENV];
  const runScript = (dir, env) =>
    spawnSync(process.execPath, [scriptPath], { cwd: dir, env: { ...baseEnv, ...env } });
  const emptyDir = mkdtempSync(join(tmpdir(), "lh-summary-"));
  mkdirSync(join(emptyDir, ".lighthouseci/quality"), { recursive: true });
  const emptyRun = runScript(emptyDir, {});
  assert.equal(emptyRun.status, 1);
  assert.match(emptyRun.stderr.toString(), /::error::No Lighthouse LHRs loaded/);
  assert.doesNotMatch(emptyRun.stdout.toString(), /::error::/);
  const missingDir = mkdtempSync(join(tmpdir(), "lh-summary-"));
  const missingRun = runScript(missingDir, {});
  assert.equal(missingRun.status, 1);
  assert.match(missingRun.stderr.toString(), /::error::No Lighthouse LHRs loaded/);
  const skipRun = runScript(emptyDir, { [ALLOW_EMPTY_ENV]: "1" });
  assert.equal(skipRun.status, 0);
  assert.equal(skipRun.stderr.toString(), "");
  console.log("lighthouse-summary selftest: ok");
}

if (process.argv.includes("--selftest")) {
  try {
    await selftest();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
} else {
  const lhrs = loadLhrs(".lighthouseci/quality");
  const standardsText = existsSync(".lighthouseci/standards-summary.md")
    ? readFileSync(".lighthouseci/standards-summary.md", "utf8")
    : null;
  const result = buildSummary({
    lhrs,
    collectedLhrs: loadCollectedLhrs(),
    hasReportFiles: [
      [".lighthouseci", /^lhr-\d+\.json$/],
      [".lighthouseci/quality", /^(?!manifest\.json$).*\.json$/],
    ].some(
      ([dir, pattern]) => existsSync(dir) && readdirSync(dir).some((name) => pattern.test(name)),
    ),
    env: process.env,
    standardsText,
  });
  mkdirSync(".lighthouseci", { recursive: true });
  writeFileSync(".lighthouseci/quality-summary.md", result.text);
  console.log(result.text);
  // stderr: both callers redirect stdout to $GITHUB_STEP_SUMMARY, so a
  // console.log here would bury the annotation in the summary file.
  if (result.error) console.error(result.error);
  process.exitCode = result.exitCode;
}
