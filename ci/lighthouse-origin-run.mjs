#!/usr/bin/env node
// Lighthouse against a deployed origin (the cutover 48h watch, runbook and
// watch-run-record section 6). GET only: discovery issues feed/listing GETs
// plus one verification GET per candidate event, and Lighthouse navigates.
// Usage: npm run lighthouse:origin -- <origin>
//
// `lhci autorun` has no collect retry, so one transient Chrome/collect error
// yields partial LHRs with the tail routes unmeasured, and the summary then
// fails closed with "no Lighthouse run completed" — with no collect error in
// the artifact to diagnose. Like ci/lighthouse-quality-run.mjs for the
// desktop step, this runner tees the full lhci output to the job log and
// `.lighthouseci/origin-collect.log`, counts collect's per-run
// `.lighthouseci/lhr-*.json` files against the planned routes x numberOfRuns,
// retries the whole run ONCE on short evidence (including the truncation
// signature of exit 0 with tail routes unmeasured) or on a marginal `/` LCP
// breach (complete evidence, only error inside the narrow band over budget —
// see isMarginalLcpBreach in ci/lighthouse-origin-lib.cjs), gates on the
// retry, preserves both tables plus the first attempt's per-run LHRs, and
// writes `.lighthouseci/origin-collect-diagnosis.md` on failure. Any other
// full-evidence assert failure never retries. Budgets in ci/lighthouserc.cjs
// are never touched here.
// Selftest: node ci/lighthouse-origin-run.mjs --selftest (hermetic: stubbed
// discovery fetch, stubbed lhci and temp dirs, no network or browser).
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ASSERT_FAILURE_MARKER,
  hasAssertFailure,
  loadCollectedLhrs,
  loadAssertions,
} from "./lighthouse-quality-run.mjs";
import { STAGING_ORIGIN } from "./operator-constants.mjs";

const require = createRequire(import.meta.url);
const lib = require("./lighthouse-origin-lib.cjs");
const {
  sampleMatrix,
  evidenceLines,
  checkFixtureDirectory,
  parseCheckFixtureArgs,
  invalidArgumentsResult,
} = require("./lighthouse-samples.cjs");

const OUTPUT_DIR = ".lighthouseci";
const CONFIG = "ci/lighthouse-origin.cjs";
// One retry: the truncation flake hit twice in one day against surrounding
// greens, so a single transient needs two bad runs in a row; more attempts
// would not fit the quality job's timeout (mobile plus desktop collect and
// standards share it). The single retry covers a short collect OR a marginal
// `/` LCP breach, whichever hits first — a second consecutive anomaly of
// either kind stays red.
const MAX_ATTEMPTS = 2;
const DIAGNOSIS_TAIL_LINES = 60;
const ATTEMPT1_TABLE_MD = "watch-summary.attempt1.md";
const ATTEMPT1_TABLE_JSON = "watch-summary.attempt1.json";
const ATTEMPT1_LHR_DIR = "marginal-attempt1";

// One `lhci autorun` attempt. Streams combined output to the parent's stdout
// (the CI job log) and returns the exit code plus the captured text for the
// artifact log, so a collect error is visible in both places.
function runLhci(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        require.resolve("@lhci/cli/src/cli.js"),
        "autorun",
        `--config=${CONFIG}`,
        `--collect.settings.configPath=${fileURLToPath(new URL("./lighthouse-diagnostics.config.mjs", import.meta.url))}`,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let text = "";
    const pump = (chunk) => {
      text += chunk.toString();
      process.stdout.write(chunk);
    };
    if (child.stdout) child.stdout.on("data", pump);
    if (child.stderr) child.stderr.on("data", pump);
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output: text }));
  });
}

// Fresh evidence for a retry: stale per-run LHRs from the short attempt must
// never count toward the new one. The assertion verdicts over those runs go
// too: attempt 2 re-collects and re-evaluates everything, so attempt 1's
// failures must not leak into the retry's summary rows. Mirrors lhci's own
// clearSavedReportsAndLHRs. The collect log and any earlier summary stay.
async function clearOriginAttemptEvidence(dir) {
  const names = await readdir(dir).catch(() => []);
  for (const name of names) {
    if (!/^lhr-\d+\.(json|html)$/.test(name) && name !== "assertion-results.json") continue;
    try {
      await rm(join(dir, name), { force: true });
    } catch {
      // Already gone between listing and removal: nothing stale remains.
    }
  }
}

export function buildOriginDiagnosis({
  origin,
  eventPath,
  eventSource,
  expected,
  attempts,
  marginalRetry = null,
}) {
  const last = attempts[attempts.length - 1];
  const collected = last.lhrs;
  const lines = [
    "## Lighthouse mobile collection diagnosis",
    "",
    `- origin: ${origin}`,
    `- event route: ${eventPath ? `${eventPath} (from ${eventSource})` : "skipped, see watch-summary.md"}`,
    `- expected LHRs: ${expected}`,
    ...attempts.map((a, i) => {
      // ", retried" only when a retry actually followed: the terminal attempt
      // of a marginal-twice run breached marginally but ran last.
      const followed = i < attempts.length - 1 ? ", retried" : "";
      return `- attempt ${a.n}: exit ${a.exitCode}, ${a.lhrs} LHRs${a.marginal?.marginal ? ` (marginal / LCP breach at ${a.marginal.actual} ms${followed})` : ""}`;
    }),
  ];
  if (marginalRetry) {
    lines.push(
      `- marginal retry: attempt 1 ${marginalRetry.reason}; first table in ${ATTEMPT1_TABLE_MD}, first per-run LHRs in ${ATTEMPT1_LHR_DIR}/`,
    );
  }
  let verdict;
  if (last.matrix.complete && last.assertFailed) {
    verdict =
      "BUDGET BREACH: full evidence collected and an assertion vs " +
      "ci/lighthouserc.cjs missed. See watch-summary.md for the route and " +
      "the failing audits. Fix the cause; do not lower the budgets." +
      (marginalRetry ? " The retry also breached, so this is systematic, not variance." : "");
  } else if (last.matrix.complete) {
    verdict =
      "UNCLASSIFIED STEP FAILURE: full evidence collected but process or assertion evidence " +
      "did not establish success. No evaluated assertion failure, so no budget " +
      "breach was evidenced. The failure came from a collect, upload or " +
      "config step — read the tails below. Do not lower ci/lighthouserc.cjs.";
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

function marginalRetryNotice(marginal) {
  return (
    `> Attempt 1 breached marginally (${marginal.reason}); retried once — this table gates on ` +
    `attempt 2. First table: \`${ATTEMPT1_TABLE_MD}\`; first per-run LHRs: \`${ATTEMPT1_LHR_DIR}/\`.`
  );
}

async function writeSummary(
  dir,
  { origin, eventPath, found, exitCode, rows, rejectionCounts = {}, marginalRetry = null },
) {
  const summary = lib.renderSummary({
    origin,
    eventPath,
    eventSource: found.source,
    rows,
    notice: marginalRetry ? marginalRetryNotice(marginalRetry) : undefined,
  });
  await writeFile(join(dir, "watch-summary.md"), summary);
  await writeFile(
    join(dir, "watch-summary.json"),
    `${JSON.stringify({ schemaVersion: 1, origin, eventPath: eventPath ?? null, skipReason: found.reason ?? null, exitCode, rows, rejectionCounts, ...(marginalRetry ? { marginalRetry } : {}) }, null, 2)}\n`,
  );
  return summary;
}

// Dual evidence for a marginal-breach retry: attempt 1's table (markdown plus
// JSON rows) and its per-run LHRs plus assertion verdicts, snapshotted before
// the retry clears the top-level evidence files. The subdir survives both
// clearOriginAttemptEvidence here (top-level per-run files only) and the
// desktop quality step's later clear (same top-level scope), so both attempts
// stay in the uploaded `.lighthouseci/` artifact for the next investigation.
async function archiveMarginalAttempt(
  dir,
  { origin, eventPath, found, exitCode, rows, rejectionCounts = {}, marginal },
) {
  const attemptDir = join(dir, ATTEMPT1_LHR_DIR);
  await mkdir(attemptDir, { recursive: true });
  const summary = lib.renderSummary({
    origin,
    eventPath,
    eventSource: found.source,
    rows,
  });
  await writeFile(
    join(dir, ATTEMPT1_TABLE_MD),
    `# Attempt 1 (marginal breach, retried)\n\n${summary}`,
  );
  await writeFile(
    join(dir, ATTEMPT1_TABLE_JSON),
    `${JSON.stringify({ schemaVersion: 1, origin, eventPath: eventPath ?? null, skipReason: found.reason ?? null, exitCode, rows, rejectionCounts, marginal }, null, 2)}\n`,
  );
  const names = await readdir(dir).catch(() => []);
  for (const name of names) {
    if (!/^lhr-\d+\.(json|html)$/.test(name) && name !== "assertion-results.json") continue;
    try {
      await copyFile(join(dir, name), join(attemptDir, name));
    } catch {
      // Gone between listing and copy, or unreadable: the tables above are
      // the required evidence; per-run files are best-effort detail.
    }
  }
}

// Every finished attempt, including short/failed collects, is immutable before
// either retry cleanup or the later desktop collect can delete top-level LHRs.
// Archives are never read by sample accounting, assertions or retry selection.
async function archiveMobileAttempt(dir, { n, exitCode }) {
  const parent = join(dir, "mobile-attempts");
  await mkdir(parent, { recursive: true });
  const attemptDir = join(parent, `attempt-${n}`);
  await mkdir(attemptDir);
  const names = (await readdir(dir))
    .filter((name) => /^lhr-\d+\.json$/.test(name) || name === "assertion-results.json")
    .sort();
  for (const name of names) await copyFile(join(dir, name), join(attemptDir, name));
  await writeFile(
    join(attemptDir, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        profile: "mobile",
        attempt: n,
        exitCode,
        files: names,
        assertions: names.includes("assertion-results.json") ? "assertion-results.json" : "unknown",
      },
      null,
      2,
    )}\n`,
  );
}

export async function main(
  argv,
  {
    env = process.env,
    fetchImpl = fetch,
    lhci = runLhci,
    dir = OUTPUT_DIR,
    log = console.log,
    logFile,
    diagnosisFile,
  } = {},
) {
  if (argv.length === 0) {
    log("usage: npm run lighthouse:origin -- <origin>");
    log(`origin is one of: ${lib.ALLOWED_ORIGINS.join(", ")}`);
    return 2;
  }
  let origin;
  try {
    origin = lib.requireAllowedOrigin(argv[0]);
  } catch (error) {
    log(error.message);
    return 2;
  }
  // Read-only fixture verification: no discovery, collection, writes or
  // archives. Unknown or malformed check flags fail here, before any of that.
  if (argv.length > 1) {
    const parsed = parseCheckFixtureArgs(argv.slice(1));
    if (!parsed.ok) {
      log(JSON.stringify(invalidArgumentsResult("mobile")));
      return 2;
    }
    const { collect } = lib.buildConfig({ origin, eventPath: undefined }).ci;
    const result = checkFixtureDirectory(parsed.dir, collect, "mobile");
    log(JSON.stringify(result));
    return result.code === "collection_complete" ? 0 : 1;
  }
  const collectLog = logFile ?? join(dir, "origin-collect.log");
  const diagnosisPath = diagnosisFile ?? join(dir, "origin-collect-diagnosis.md");

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(collectLog, "");

  let found;
  try {
    found = await lib.discoverEventPath(origin, fetchImpl);
  } catch (error) {
    // An origin that does not answer GET /events.rss is itself the finding.
    const failure = `Event discovery failed, origin not healthy: ${error.message}`;
    await writeFile(
      join(dir, "watch-summary.md"),
      `## Lighthouse watch run\n\nOrigin: ${origin}\n\n${failure}\n`,
    );
    log(failure);
    return 1;
  }
  const eventPath = found.path ?? undefined;
  log(
    eventPath
      ? `Event route: ${eventPath} (from ${found.source})`
      : `Event route skipped: ${found.reason}`,
  );

  // The config is validated here once more, before anything is launched.
  // Expected LHRs come from the same config lhci runs: every planned URL
  // measured numberOfRuns times (8 x 3 with a discovered event, 7 x 3 when
  // the event route is skipped).
  const { collect } = lib.buildConfig({ origin, eventPath }).ci;
  const expected = collect.url.length * collect.numberOfRuns;
  log(
    `Measuring ${collect.url.length} routes, ${collect.numberOfRuns} runs each:\n${collect.url.map((url) => `  ${url}`).join("\n")}`,
  );

  const lhciEnv = {
    ...env,
    LIGHTHOUSE_ORIGIN: origin,
    LIGHTHOUSE_EVENT_PATH: eventPath ?? "",
  };
  const attempts = [];
  // The marginal-breach verdict that triggered the retry (if any): attempt 1's
  // table and per-run LHRs are archived before the retry clears them, and the
  // final summary gates on attempt 2 while pointing at both.
  let pendingMarginal = null;
  let firstAttemptMarginal = null;
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    if (n > 1) {
      // Clean accounting for the retry: attempt 1's per-run LHRs must not
      // masquerade as fresh evidence (the log and any earlier summary stay,
      // since they live outside the per-run evidence files; a marginal
      // attempt's table and LHRs were archived before reaching here).
      await clearOriginAttemptEvidence(dir);
      if (pendingMarginal) {
        log(
          `Marginal breach (${pendingMarginal.reason}): retrying (attempt ${n}/${MAX_ATTEMPTS}); gating on the retry.`,
        );
        pendingMarginal = null;
      } else {
        log(
          `Collect short (${attempts[0].lhrs}/${expected} LHRs): retrying (attempt ${n}/${MAX_ATTEMPTS}).`,
        );
      }
    }
    log(`Lighthouse mobile collect: attempt ${n}/${MAX_ATTEMPTS} (expecting ${expected} LHRs).`);
    const started = Date.now();
    // Sequential by design: attempt 2 runs only when attempt 1 came up short
    // or breached marginally. A spawn failure (missing CLI, process error) is
    // a failed attempt with its error text, so the retry and diagnosis flow
    // still handles it.
    let result;
    try {
      result = await lhci(lhciEnv);
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      result = { exitCode: 1, output: `lhci autorun failed to start: ${detail}\n` };
    }
    const { exitCode, output } = result;
    const elapsed = Math.round((Date.now() - started) / 1000);
    await writeFile(
      collectLog,
      `\n=== attempt ${n}: exit ${exitCode}, ${elapsed}s ===\n${output}`,
      {
        flag: "a",
      },
    );
    await archiveMobileAttempt(dir, { n, exitCode });
    const lhrObjects = loadCollectedLhrs(dir);
    const matrix = sampleMatrix(lhrObjects, collect);
    const assertions = loadAssertions(dir);
    const assertFailed =
      hasAssertFailure(output) ||
      assertions.some((failure) => failure.level === "error" && !failure.readError);
    const rows = lib.summarizeRoutes({
      origin,
      eventPath,
      skipReason: found.reason,
      lhrs: lhrObjects,
      assertions,
    });
    attempts.push({
      matrix,
      n,
      exitCode,
      lhrs: lhrObjects.length,
      lhrObjects,
      assertFailed,
      tail: output.split("\n").slice(-DIAGNOSIS_TAIL_LINES).join("\n"),
    });
    // lhci exits non-zero on an error-level assertion or a crashed run. A
    // pass also needs every planned run present: exit 0 over partial runs
    // (medians over thin evidence) retries below instead of passing.
    const unmeasured = rows.some((row) => row.verdict === "fail");

    if (
      exitCode === 0 &&
      !unmeasured &&
      matrix.complete &&
      !assertFailed &&
      !assertions.some((failure) => failure.readError)
    ) {
      const summary = await writeSummary(dir, {
        origin,
        eventPath,
        found,
        exitCode,
        rows,
        rejectionCounts: matrix.rejectionCounts ?? {},
        marginalRetry: firstAttemptMarginal,
      });
      log(summary);
      log(`Collect complete: exit 0 with ${lhrObjects.length}/${expected} LHRs in ${elapsed}s.`);
      return 0;
    }
    if (matrix.complete) {
      // Full evidence. A marginal `/` LCP breach retries once (variance
      // suspected; the retry gates); anything else — a real breach or an
      // unclassified step failure — never retries, the evidence already
      // answers the gate.
      const marginal = lib.isMarginalLcpBreach({ rows, assertions });
      attempts[attempts.length - 1].marginal = marginal.marginal ? marginal : null;
      if (marginal.marginal && n < MAX_ATTEMPTS) {
        await archiveMarginalAttempt(dir, {
          origin,
          eventPath,
          found,
          exitCode,
          rows,
          rejectionCounts: matrix.rejectionCounts ?? {},
          marginal,
        });
        firstAttemptMarginal = marginal;
        pendingMarginal = marginal;
        continue;
      }
      // Observability-only: log the eligibility decision on every
      // full-evidence non-retry path, so a declined hardening is verifiable
      // from the job log (previously zero marginal/retry lines was the
      // expected steady-state for every non-marginal run). No gate, band,
      // retry, or budget behavior change: the predicate above is untouched.
      if (!marginal.marginal) {
        log(`Marginal retry declined (${marginal.reason}): no retry.`);
      }
      const summary = await writeSummary(dir, {
        origin,
        eventPath,
        found,
        exitCode,
        rows,
        rejectionCounts: matrix.rejectionCounts ?? {},
        marginalRetry: firstAttemptMarginal,
      });
      const { text, verdict } = buildOriginDiagnosis({
        origin,
        eventPath,
        eventSource: found.source,
        expected,
        attempts,
        marginalRetry: firstAttemptMarginal,
      });
      await writeFile(diagnosisPath, text);
      log(summary);
      log(verdict);
      return exitCode === 0 ? 1 : exitCode;
    }
    if (n === MAX_ATTEMPTS) {
      const summary = await writeSummary(dir, {
        origin,
        eventPath,
        found,
        exitCode,
        rows,
        rejectionCounts: matrix.rejectionCounts ?? {},
        marginalRetry: firstAttemptMarginal,
      });
      const { text, verdict } = buildOriginDiagnosis({
        origin,
        eventPath,
        eventSource: found.source,
        expected,
        attempts,
        marginalRetry: firstAttemptMarginal,
      });
      await writeFile(diagnosisPath, text);
      log(summary);
      log(verdict);
      log(`Diagnosis written to ${diagnosisPath}; full output in ${collectLog}.`);
      return exitCode === 0 ? 1 : exitCode;
    }
    // Short evidence with an attempt left: the whole run retries below.
  }
  return 1;
}

async function selftest() {
  const { navigationMetadata } = await import("../test/lighthouse-navigation-fixtures.mjs");
  const ORIGIN = STAGING_ORIGIN;
  const EVENT = "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const ROUTES = ["/", "/events", EVENT, "/join", "/about", "/faq", "/rules", "/privacy"];
  const NO_EVENT_ROUTES = ["/", "/events", "/join", "/about", "/faq", "/rules", "/privacy"];

  const rss = (items) =>
    `<rss><channel>${items.map(([title, path]) => `<item><title>${title}</title><link>${ORIGIN}${path}</link></item>`).join("")}</channel></rss>`;

  const fetchWithEvent = async (url) => {
    if (url === `${ORIGIN}/events.rss`)
      return { status: 200, text: async () => rss([["Community game night", EVENT]]) };
    if (url === `${ORIGIN}/events`) return { status: 200, text: async () => "" };
    if (url === `${ORIGIN}${EVENT}`)
      return { status: 200, text: async () => "<h1>Community game night</h1>" };
    throw new Error(`unexpected fetch ${url}`);
  };
  // Only a staging-journey fixture is listed: the event route is skipped, so
  // 7 routes x 3 runs are expected instead of 8 x 3.
  const fetchFixtureOnly = async (url) => {
    if (url === `${ORIGIN}/events.rss`)
      return { status: 200, text: async () => rss([["Staging E2E game night", EVENT]]) };
    if (url === `${ORIGIN}/events`) return { status: 200, text: async () => "" };
    throw new Error(`unexpected fetch ${url}`);
  };

  const stubLhr = (url, lcp = 1000) => ({
    ...navigationMetadata("mobile"),
    requestedUrl: url,
    finalUrl: url,
    finalDisplayedUrl: url,
    categories: { performance: { score: 1 } },
    audits: {
      "largest-contentful-paint": { numericValue: lcp },
      "cumulative-layout-shift": { numericValue: 0 },
      "server-response-time": { numericValue: 100 },
      "total-blocking-time": { numericValue: 50 },
      "first-contentful-paint": { numericValue: 900 },
    },
  });
  const urlsFor = (routes) => routes.flatMap((route) => [0, 1, 2].map(() => `${ORIGIN}${route}`));

  // Retry matrix with stubbed discovery and lhci (hermetic: temp dirs, no
  // network or browser). The stub mirrors a real collect: one lhr-<n>.json
  // per run in the lhci dir.
  const runCase = async (script, { fetchImpl = fetchWithEvent } = {}) => {
    const caseDir = mkdtempSync(join(tmpdir(), "lh-origin-"));
    const lhciDir = join(caseDir, ".lighthouseci");
    let calls = 0;
    const lhci = async () => {
      calls += 1;
      const step = script[calls - 1];
      if (step.reject) throw new Error(step.reject);
      mkdirSync(lhciDir, { recursive: true });
      step.urls.forEach((url, i) => {
        writeFileSync(
          join(lhciDir, `lhr-${calls * 100000 + i}.json`),
          JSON.stringify(stubLhr(url, step.lcps?.[i])),
        );
      });
      for (const [name, content] of Object.entries(step.raw ?? {}))
        writeFileSync(join(lhciDir, name), content);
      const marker = step.assertFailed ? `\n${ASSERT_FAILURE_MARKER}\n` : "";
      return {
        exitCode: step.exitCode,
        output: `stub attempt ${calls} ${step.note ?? ""}${marker}`,
      };
    };
    const logs = [];
    const code = await main([ORIGIN], {
      fetchImpl,
      lhci,
      dir: lhciDir,
      log: (message) => logs.push(String(message)),
    });
    return { code, calls, caseDir, lhciDir, logs };
  };
  const summaryRows = (lhciDir) =>
    JSON.parse(readFileSync(join(lhciDir, "watch-summary.json"), "utf8")).rows;

  // Usage and origin validation never launch lhci.
  assert.equal(await main([], { lhci: () => assert.fail("must not run") }), 2);
  assert.equal(
    await main(["https://evil.example/"], { lhci: () => assert.fail("must not run") }),
    2,
  );
  // Discovery failure is a finding, not a collect: exit 1, no lhci call.
  {
    let calls = 0;
    const code = await main([ORIGIN], {
      fetchImpl: async () => {
        throw new Error("boom");
      },
      lhci: async () => {
        calls += 1;
        return { exitCode: 0, output: "" };
      },
      dir: join(mkdtempSync(join(tmpdir(), "lh-origin-")), ".lighthouseci"),
      log: () => {},
    });
    assert.equal(code, 1);
    assert.equal(calls, 0);
  }
  // Green first attempt: 8 routes x 3 runs, no retry, no diagnosis, exit 0.
  {
    const { code, calls, lhciDir } = await runCase([{ exitCode: 0, urls: urlsFor(ROUTES) }]);
    assert.equal(code, 0);
    assert.equal(calls, 1);
    assert.equal(loadCollectedLhrs(lhciDir).length, 24);
    assert.deepEqual(
      summaryRows(lhciDir).map((row) => row.verdict),
      Array(8).fill("pass"),
    );
    assert.equal(existsSync(join(lhciDir, "origin-collect-diagnosis.md")), false);
    assert.match(readFileSync(join(lhciDir, "origin-collect.log"), "utf8"), /stub attempt 1/);
  }
  // The truncation signature: exit 0 but tail routes unmeasured. The old
  // runner failed closed here with no diagnosis; the retry must fire.
  {
    const { code, calls, lhciDir, logs } = await runCase([
      { exitCode: 0, urls: urlsFor(ROUTES).slice(0, 15), note: "cut off mid-collect" },
      { exitCode: 0, urls: urlsFor(ROUTES) },
    ]);
    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.match(logs.join("\n"), /retrying \(attempt 2\/2\)/);
    assert.equal(loadCollectedLhrs(lhciDir).length, 24);
  }
  // Exit 0 over thin evidence still retries: one /privacy run missing
  // leaves every route measured, but medians over partial runs are not a
  // pass. A full second attempt goes green with no diagnosis.
  {
    const { code, calls, lhciDir, logs } = await runCase([
      { exitCode: 0, urls: urlsFor(ROUTES).slice(0, 23), note: "one run short" },
      { exitCode: 0, urls: urlsFor(ROUTES) },
    ]);
    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.match(logs.join("\n"), /retrying \(attempt 2\/2\)/);
    assert.equal(loadCollectedLhrs(lhciDir).length, 24);
    assert.equal(existsSync(join(lhciDir, "origin-collect-diagnosis.md")), false);
  }
  // Short failure then green: exactly one retry, exit 0. Attempt 1's
  // assertion verdicts are cleared with its LHRs, never leaking into the
  // retry's summary.
  {
    const staleFailure = JSON.stringify([
      {
        url: `${ORIGIN}/`,
        auditId: "largest-contentful-paint",
        level: "error",
        actual: 9999,
        expected: 2000,
      },
    ]);
    const { code, calls, lhciDir } = await runCase([
      {
        exitCode: 1,
        urls: urlsFor(ROUTES).slice(0, 4),
        raw: { "assertion-results.json": staleFailure },
      },
      { exitCode: 0, urls: urlsFor(ROUTES) },
    ]);
    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.equal(existsSync(join(lhciDir, "assertion-results.json")), false);
  }
  // A spawn failure becomes a failed attempt (not a crash): short evidence
  // retries once, then COLLECT FAILURE keeps the last exit code.
  {
    const { code, calls, lhciDir } = await runCase([
      { reject: "spawn /nope ENOENT" },
      { exitCode: 0, urls: urlsFor(ROUTES) },
    ]);
    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.match(readFileSync(join(lhciDir, "origin-collect.log"), "utf8"), /failed to start/);
  }
  // Short twice: COLLECT FAILURE naming the short tail routes, last exit
  // code preserved, tail recorded.
  {
    const { code, calls, lhciDir } = await runCase([
      { exitCode: 2, urls: [], note: "NO_NAVSTART boom" },
      { exitCode: 3, urls: urlsFor(ROUTES).slice(0, 6), note: "chrome crash boom" },
    ]);
    assert.equal(code, 3);
    assert.equal(calls, 2);
    const diagnosis = readFileSync(join(lhciDir, "origin-collect-diagnosis.md"), "utf8");
    assert.match(diagnosis, /COLLECT FAILURE/);
    assert.match(diagnosis, /chrome crash boom/);
    assert.match(diagnosis, /attempt 1: exit 2, 0 LHRs/);
    assert.match(diagnosis, /attempt 2: exit 3, 6 LHRs/);
    assert.match(diagnosis, /\/rules: 0\/3 runs \(no run completed\)/);
    assert.match(diagnosis, /\/privacy: 0\/3 runs \(no run completed\)/);
    const rows = summaryRows(lhciDir);
    assert.equal(rows.find((row) => row.path === "/rules").verdict, "fail");
    assert.equal(rows.find((row) => row.path === "/rules").runs, 0);
    assert.match(rows.find((row) => row.path === "/rules").note, /no Lighthouse run completed/);
  }
  // Full evidence plus the evaluated-assertion marker: real breach, NO
  // retry, BUDGET BREACH. The decline decision is logged with its reason.
  {
    const { code, calls, lhciDir, logs } = await runCase([
      { exitCode: 1, urls: urlsFor(ROUTES), assertFailed: true },
    ]);
    assert.equal(code, 1);
    assert.equal(calls, 1);
    assert.match(
      readFileSync(join(lhciDir, "origin-collect-diagnosis.md"), "utf8"),
      /BUDGET BREACH/,
    );
    assert.match(
      logs.join("\n"),
      /Marginal retry declined \(no error-level assertion to retry\): no retry\./,
    );
  }
  // Marginal `/` LCP breach retries once and gates on the retry: attempt 1
  // (2060, band (2000, 2200), everything else pass plus one FCP warn)
  // archives both tables and the first per-run LHRs; attempt 2 goes green.
  {
    const urls = urlsFor(ROUTES);
    const lcps = urls.map((url, i) => (i < 3 ? [1940, 2060, 2065][i] : 1000));
    const marginalFailure = JSON.stringify([
      {
        url: `${ORIGIN}/`,
        auditId: "largest-contentful-paint",
        level: "error",
        actual: 2060,
        expected: 2000,
      },
      {
        url: `${ORIGIN}/events`,
        auditId: "first-contentful-paint",
        level: "warn",
        actual: 1850,
        expected: 1800,
      },
    ]);
    const { code, calls, lhciDir, logs } = await runCase([
      {
        exitCode: 1,
        urls,
        lcps,
        raw: { "assertion-results.json": marginalFailure },
        assertFailed: true,
      },
      { exitCode: 0, urls: urlsFor(ROUTES) },
    ]);
    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.match(
      logs.join("\n"),
      /Marginal breach \(only error is \/ LCP 2060 within \(2000, 2200\)\): retrying \(attempt 2\/2\)/,
    );
    assert.doesNotMatch(
      logs.join("\n"),
      /Marginal retry declined/,
      "a retried run keeps its retry line, with no decline line",
    );
    // Dual evidence: the archived first table, the gating table pointing at
    // it, and the first attempt's per-run LHRs.
    assert.match(
      readFileSync(join(lhciDir, "watch-summary.attempt1.md"), "utf8"),
      /Attempt 1 \(marginal breach, retried\)/,
    );
    assert.match(
      readFileSync(join(lhciDir, "watch-summary.attempt1.md"), "utf8"),
      /\| \/ \| fail \| 3 \|/,
    );
    assert.match(readFileSync(join(lhciDir, "watch-summary.md"), "utf8"), /gates on attempt 2/);
    assert.equal(
      JSON.parse(readFileSync(join(lhciDir, "watch-summary.json"), "utf8")).marginalRetry.actual,
      2060,
    );
    assert.equal(
      JSON.parse(readFileSync(join(lhciDir, "watch-summary.attempt1.json"), "utf8")).marginal
        .actual,
      2060,
    );
    assert.equal(loadCollectedLhrs(join(lhciDir, "marginal-attempt1")).length, 24);
    assert.equal(
      loadCollectedLhrs(lhciDir).length,
      24,
      "top-level LHRs are the retry's, not the archived attempt's",
    );
    assert.equal(existsSync(join(lhciDir, "origin-collect-diagnosis.md")), false);
  }
  // Marginal twice: the retry also breaches, so the gate stays red with
  // BUDGET BREACH naming the retry as systematic, not variance.
  {
    const urls = urlsFor(ROUTES);
    const lcps = urls.map((url, i) => (i < 3 ? 2100 : 1000));
    const marginalFailure = JSON.stringify([
      {
        url: `${ORIGIN}/`,
        auditId: "largest-contentful-paint",
        level: "error",
        actual: 2100,
        expected: 2000,
      },
    ]);
    const step = {
      exitCode: 1,
      urls,
      lcps,
      raw: { "assertion-results.json": marginalFailure },
      assertFailed: true,
    };
    const { code, calls, lhciDir, logs } = await runCase([step, { ...step }]);
    assert.equal(code, 1);
    assert.equal(calls, 2);
    const diagnosis = readFileSync(join(lhciDir, "origin-collect-diagnosis.md"), "utf8");
    assert.match(diagnosis, /BUDGET BREACH/);
    assert.match(diagnosis, /systematic, not variance/);
    assert.match(diagnosis, /marginal \/ LCP breach at 2100 ms, retried/);
    assert.doesNotMatch(
      diagnosis,
      /attempt 2: exit 1, 24 LHRs \(marginal \/ LCP breach at 2100 ms, retried\)/,
    );
    assert.match(readFileSync(join(lhciDir, "watch-summary.md"), "utf8"), /gates on attempt 2/);
    assert.match(
      logs.join("\n"),
      /Marginal breach \(only error is \/ LCP 2100 within \(2000, 2200\)\): retrying \(attempt 2\/2\)/,
    );
    assert.doesNotMatch(
      logs.join("\n"),
      /Marginal retry declined/,
      "a terminal marginal breach is not a decline",
    );
  }
  // Far over budget: `/` LCP at 2500 is outside the band, NO retry.
  {
    const farFailure = JSON.stringify([
      {
        url: `${ORIGIN}/`,
        auditId: "largest-contentful-paint",
        level: "error",
        actual: 2500,
        expected: 2000,
      },
    ]);
    const { code, calls, lhciDir, logs } = await runCase([
      {
        exitCode: 1,
        urls: urlsFor(ROUTES),
        raw: { "assertion-results.json": farFailure },
        assertFailed: true,
      },
    ]);
    assert.equal(code, 1);
    assert.equal(calls, 1);
    assert.equal(existsSync(join(lhciDir, "watch-summary.attempt1.md")), false);
    const diagnosis = readFileSync(join(lhciDir, "origin-collect-diagnosis.md"), "utf8");
    assert.match(diagnosis, /BUDGET BREACH/);
    assert.doesNotMatch(diagnosis, /systematic, not variance/);
    assert.match(
      logs.join("\n"),
      /Marginal retry declined \(\/ LCP 2500 outside the marginal band \(2000, 2200\)\): no retry\./,
    );
  }
  // The band edge is exclusive: exactly 2200 (10% over) is not marginal.
  {
    const edgeFailure = JSON.stringify([
      {
        url: `${ORIGIN}/`,
        auditId: "largest-contentful-paint",
        level: "error",
        actual: 2200,
        expected: 2000,
      },
    ]);
    const { code, calls, lhciDir, logs } = await runCase([
      {
        exitCode: 1,
        urls: urlsFor(ROUTES),
        raw: { "assertion-results.json": edgeFailure },
        assertFailed: true,
      },
    ]);
    assert.equal(code, 1);
    assert.equal(calls, 1);
    assert.equal(existsSync(join(lhciDir, "watch-summary.attempt1.md")), false);
    assert.match(
      logs.join("\n"),
      /Marginal retry declined \(\/ LCP 2200 outside the marginal band \(2000, 2200\)\): no retry\./,
    );
  }
  // A second error anywhere else vetoes the retry, even with `/` LCP in the
  // band: the gate is no longer pass/warn-only outside `/`.
  {
    const mixedFailure = JSON.stringify([
      {
        url: `${ORIGIN}/`,
        auditId: "largest-contentful-paint",
        level: "error",
        actual: 2060,
        expected: 2000,
      },
      {
        url: `${ORIGIN}/events`,
        auditId: "server-response-time",
        level: "error",
        actual: 900,
        expected: 600,
      },
    ]);
    const { code, calls, lhciDir, logs } = await runCase([
      {
        exitCode: 1,
        urls: urlsFor(ROUTES),
        raw: { "assertion-results.json": mixedFailure },
        assertFailed: true,
      },
    ]);
    assert.equal(code, 1);
    assert.equal(calls, 1);
    assert.equal(existsSync(join(lhciDir, "watch-summary.attempt1.md")), false);
    assert.match(
      logs.join("\n"),
      /Marginal retry declined \(\/events is fail, not pass\/warn-only\): no retry\./,
    );
  }
  // Full evidence but no assertion verdict (upload/config blew up): NO
  // retry, and the verdict must NOT claim a budget breached.
  {
    const { code, calls, lhciDir, logs } = await runCase([{ exitCode: 1, urls: urlsFor(ROUTES) }]);
    assert.equal(code, 1);
    assert.equal(calls, 1);
    const diagnosis = readFileSync(join(lhciDir, "origin-collect-diagnosis.md"), "utf8");
    assert.match(diagnosis, /UNCLASSIFIED STEP FAILURE/);
    assert.doesNotMatch(diagnosis, /BUDGET BREACH/);
    assert.match(
      logs.join("\n"),
      /Marginal retry declined \(no error-level assertion to retry\): no retry\./,
    );
  }
  // A half-written report from a crashed run is missing evidence, never a
  // crash: truncated JSON is skipped and the short attempt retries.
  {
    const { code, calls, lhciDir } = await runCase([
      { exitCode: 1, urls: urlsFor(ROUTES).slice(0, 4), raw: { "lhr-7.json": "{truncated" } },
      { exitCode: 0, urls: urlsFor(ROUTES) },
    ]);
    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.equal(loadCollectedLhrs(lhciDir).length, 24);
  }
  // Fixture-only discovery skips the event route: 7 x 3 expected, the
  // event row is reported skipped, and a full 21-LHR run passes.
  {
    const { code, calls, lhciDir } = await runCase(
      [{ exitCode: 0, urls: urlsFor(NO_EVENT_ROUTES) }],
      { fetchImpl: fetchFixtureOnly },
    );
    assert.equal(code, 0);
    assert.equal(calls, 1);
    const rows = summaryRows(lhciDir);
    assert.equal(rows.length, 8);
    assert.equal(rows.find((row) => row.path === "/e/<key>").verdict, "skipped");
  }
  console.log("lighthouse-origin-run selftest: ok");
}

// Gated on being the entry point, so importing main() or the diagnosis
// builder from another script never runs the selftest as a side effect.
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
