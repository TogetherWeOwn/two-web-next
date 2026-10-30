// No-member-data contract on public Kit payloads: one JSON-reporting check.
//
// Static half: every Kit server file (web/src/routes/**/+page.server.{ts,js},
// +server.{ts,js}, +layout.server.{ts,js}) must be classified in
// ci/kit-public-payloads.json (public check, session-required, or
// out-of-scope), so a new route cannot escape the contract by omission.
// Dynamic half: runs the hostile-fixture acceptance suite and maps each
// result onto its stable check ID. Stdout is pure JSON (pipe it to jq);
// the human one-liner goes to stderr. Exit 0 only when everything passes.
//
// Usage: node ci/check-kit-payloads.mjs [--selftest] [--static-only]
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TRUTH_PATH = join(ROOT, "ci/kit-public-payloads.json");
const ROUTES_DIR = join(ROOT, "web/src/routes");
// Include unknown extensions/shapes too: a new server binding must not pass
// unseen just because the classifier has not learned its suffix yet.
const SERVER_FILE = /^\+(?:.*\.)?server\./;

// Stable check ID -> suite-name matcher. The IDs live in
// ci/kit-public-payloads.json; this table owns the describe/it mapping and
// fails closed on drift (unknown ID, unmapped assertion, vacuous check).
const CHECK_MATCHERS = [
  {
    id: "kit-payload-root-layout",
    describe: "Kit root layout load: requestId forwarding",
    testContains: null,
  },
  { id: "kit-payload-detector", describe: "no-member-data detector", testContains: null },
  { id: "kit-payload-home", describe: "Kit GET / anonymous payload", testContains: null },
  { id: "kit-payload-events", describe: "Kit GET /events anonymous payload", testContains: null },
  {
    id: "kit-payload-events-binding",
    describe: "Kit GET /events binding anonymous payload",
    testContains: null,
  },
  {
    id: "kit-payload-events-past",
    describe: "Kit GET /events/past anonymous payload",
    testContains: null,
  },
  {
    id: "kit-payload-about",
    describe: "Kit static-leaf anonymous payloads",
    testContains: "GET /about",
  },
  {
    id: "kit-payload-faq",
    describe: "Kit static-leaf anonymous payloads",
    testContains: "GET /faq",
  },
  {
    id: "kit-payload-rules",
    describe: "Kit static-leaf anonymous payloads",
    testContains: "GET /rules",
  },
  {
    id: "kit-payload-privacy",
    describe: "Kit static-leaf anonymous payloads",
    testContains: "GET /privacy",
  },
  { id: "kit-payload-join", describe: "Kit GET /join anonymous payload", testContains: null },
  {
    id: "kit-payload-hotzones",
    describe: "Kit GET /hotzones anonymous payload",
    testContains: null,
  },
  {
    id: "kit-payload-hotzones-joins",
    describe: "Kit GET /hotzones/:signal anonymous payloads",
    testContains: "joins serves",
  },
  {
    id: "kit-payload-hotzones-voice",
    describe: "Kit GET /hotzones/:signal anonymous payloads",
    testContains: "voice serves",
  },
  {
    id: "kit-payload-hotzones-games",
    describe: "Kit GET /hotzones/:signal anonymous payloads",
    testContains: "games serves",
  },
  {
    id: "kit-payload-negative-controls",
    describe: "member-gated negative controls",
    testContains: null,
  },
];

/** Kit server files under web/src/routes, as posix repo-relative paths. */
export function listKitServerFiles(routesDir = ROUTES_DIR) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (SERVER_FILE.test(entry)) found.push(relative(ROOT, abs).split(sep).join("/"));
    }
  };
  walk(routesDir);
  return found.sort();
}

export function classifiedBindings(truth) {
  const bindings = [];
  for (const check of truth.checks ?? []) if (check.binding) bindings.push(check.binding);
  for (const row of truth.sessionRequired ?? []) bindings.push(row.binding);
  for (const row of truth.outOfScope ?? []) bindings.push(row.binding);
  return [...new Set(bindings)].sort();
}

/** Every server file classified, every classification extant. Fails closed both ways. */
export function auditCoverage(serverFiles, truth) {
  const classified = new Set(classifiedBindings(truth));
  const files = new Set(serverFiles);
  const unlisted = serverFiles.filter((f) => !classified.has(f));
  const missing = [...classified]
    .filter((f) => !files.has(f))
    .filter((f) => !existsSync(join(ROOT, f)));
  // A classified binding whose file is gone is stale enumeration, not coverage.
  const staleInTruth = [...classified].filter((f) => !files.has(f) && existsSync(join(ROOT, f)));
  return { files: serverFiles.length, unlisted, missing, stale: staleInTruth };
}

export function matchCheckId(matchers, ancestorTitles, title) {
  const describe = ancestorTitles[0] ?? "";
  const hits = matchers.filter(
    (m) => m.describe === describe && (m.testContains === null || title.includes(m.testContains)),
  );
  // A null testContains matcher only wins when no specific matcher hits, so
  // shared describes (static leaves, hotzone signals) map to the leaf/signal.
  const specific = hits.filter((m) => m.testContains !== null);
  const winner = (specific.length > 0 ? specific : hits)[0];
  return winner ? winner.id : null;
}

export function summarizeSuite(matchers, checkIds, report) {
  const results = (report.testResults ?? []).flatMap((r) => r.assertionResults ?? []);
  const byCheck = new Map(checkIds.map((id) => [id, { passed: 0, failed: 0 }]));
  const unmapped = [];
  for (const a of results) {
    const id = matchCheckId(matchers, a.ancestorTitles ?? [], a.title ?? "");
    if (!id || !byCheck.has(id)) {
      unmapped.push([...(a.ancestorTitles ?? []), a.title].join(" > "));
      continue;
    }
    const bucket = byCheck.get(id);
    if (a.status === "passed") bucket.passed += 1;
    else bucket.failed += 1;
  }
  const checks = checkIds.map((id) => {
    const bucket = byCheck.get(id);
    const total = bucket.passed + bucket.failed;
    return {
      id,
      status: total === 0 ? "vacuous" : bucket.failed > 0 ? "fail" : "pass",
      tests: total,
    };
  });
  return {
    total: results.length,
    passed: results.filter((a) => a.status === "passed").length,
    failed: results.filter((a) => a.status !== "passed").length,
    checks,
    unmapped,
  };
}

function runStatic(truth) {
  const files = listKitServerFiles();
  const coverage = auditCoverage(files, truth);
  const ok =
    coverage.unlisted.length === 0 && coverage.missing.length === 0 && coverage.stale.length === 0;
  return { ok, ...coverage };
}

export function runDynamic(truth, runner = spawnSync) {
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-payloads-"),
  );
  const outputFile = join(scratch, "vitest.json");
  const suites = [truth.suite, ...(truth.additionalSuites ?? [])];
  const failure = (code) => ({
    code,
    retryable: false,
    next_action: `Run npx vitest run ${suites.join(" ")} and fix the Vitest process, hooks or assertions before rerunning this check.`,
  });
  try {
    const run = runner(
      "npx",
      ["vitest", "run", ...suites, "--reporter=json", `--outputFile=${outputFile}`],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const execution = {
      suite: truth.suite,
      suites,
      exitStatus: run.status ?? null,
      signal: run.signal ?? null,
      spawnError: run.error ? (run.error.code ?? run.error.name) : null,
    };
    if (!existsSync(outputFile)) {
      return { ok: false, ...execution, ...failure("suite_report_missing") };
    }
    let report;
    try {
      report = JSON.parse(readFileSync(outputFile, "utf8"));
    } catch {
      return { ok: false, ...execution, ...failure("suite_report_invalid") };
    }
    if (!report || !Array.isArray(report.testResults)) {
      return { ok: false, ...execution, ...failure("suite_report_invalid") };
    }
    const runOk = run.status === 0 && !run.error && !run.signal;
    const reportOk =
      report.success === true &&
      report.numFailedTestSuites === 0 &&
      report.testResults.every((result) => result.status === "passed");
    // Matcher drift fails closed: the script must name exactly the JSON's IDs.
    const checkIds = (truth.checks ?? []).map((c) => c.id);
    const matcherIds = CHECK_MATCHERS.map((m) => m.id);
    const drift = [
      ...matcherIds
        .filter((id) => !checkIds.includes(id))
        .map((id) => `matcher without check: ${id}`),
      ...checkIds
        .filter((id) => !matcherIds.includes(id))
        .map((id) => `check without matcher: ${id}`),
    ];
    const summary = summarizeSuite(CHECK_MATCHERS, checkIds, report);
    const ok =
      runOk &&
      reportOk &&
      drift.length === 0 &&
      summary.failed === 0 &&
      summary.unmapped.length === 0 &&
      summary.checks.every((c) => c.status === "pass");
    return {
      ok,
      ...execution,
      drift,
      ...summary,
      ...(ok ? {} : failure(!runOk || !reportOk ? "suite_run_failed" : "suite_contract_failed")),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function run(staticOnly) {
  const truth = JSON.parse(readFileSync(TRUTH_PATH, "utf8"));
  const staticResult = runStatic(truth);
  const dynamicResult = staticOnly ? { skipped: true } : runDynamic(truth);
  const ok = staticResult.ok && (staticOnly || dynamicResult.ok === true);
  console.log(
    JSON.stringify(
      {
        check: "kit-payloads",
        contract: truth.contract,
        ok,
        static: staticResult,
        dynamic: dynamicResult,
      },
      null,
      2,
    ),
  );
  console.error(
    ok
      ? `kit-payloads: ok (${staticResult.files} server files classified${staticOnly ? "; suite skipped" : `; suite ${dynamicResult.passed}/${dynamicResult.total} passed`})`
      : "kit-payloads: FAIL (see JSON report above)",
  );
  return ok ? 0 : 1;
}

function selftest() {
  let cases = 0;
  const assert = (cond, label) => {
    cases += 1;
    if (!cond) throw new Error(`selftest case failed: ${label}`);
  };
  // Coverage audit: unlisted, missing and stale all fail closed.
  const truth = {
    checks: [{ id: "a", binding: "web/src/routes/+page.server.ts" }],
    sessionRequired: [{ binding: "web/src/routes/profile/+page.server.ts" }],
    outOfScope: [{ binding: "web/src/routes/gone/+page.server.ts" }],
  };
  const coverage = auditCoverage(
    ["web/src/routes/+page.server.ts", "web/src/routes/new/+page.server.ts"],
    truth,
  );
  assert(coverage.unlisted.join() === "web/src/routes/new/+page.server.ts", "unlisted file fails");
  assert(coverage.missing.join() === "web/src/routes/gone/+page.server.ts", "missing file fails");
  assert(coverage.stale.join() === "web/src/routes/profile/+page.server.ts", "stale binding fails");
  assert(
    auditCoverage(["web/src/routes/+page.server.ts"], {
      checks: [{ id: "a", binding: "web/src/routes/+page.server.ts" }],
      sessionRequired: [],
      outOfScope: [],
    }).unlisted.length === 0,
    "clean coverage passes",
  );
  // Matcher: shared describes disambiguate by test name; unknown names miss.
  assert(
    matchCheckId(
      CHECK_MATCHERS,
      ["Kit static-leaf anonymous payloads"],
      "GET /faq serves its leaf",
    ) === "kit-payload-faq",
    "static leaf maps by test name",
  );
  assert(
    matchCheckId(
      CHECK_MATCHERS,
      ["Kit GET /hotzones/:signal anonymous payloads"],
      "voice serves the seeded estimate",
    ) === "kit-payload-hotzones-voice",
    "signal maps by test name",
  );
  assert(
    matchCheckId(CHECK_MATCHERS, ["Kit GET / anonymous payload"], "serves hostile rows") ===
      "kit-payload-home",
    "whole-describe maps",
  );
  assert(
    matchCheckId(CHECK_MATCHERS, ["Some new describe"], "whatever") === null,
    "unmapped assertion misses",
  );
  // Summary: vacuous and unmapped fail closed.
  const summary = summarizeSuite(CHECK_MATCHERS, ["kit-payload-home", "kit-payload-events"], {
    testResults: [
      {
        assertionResults: [
          { ancestorTitles: ["Kit GET / anonymous payload"], title: "t", status: "passed" },
          { ancestorTitles: ["New describe"], title: "t", status: "passed" },
        ],
      },
    ],
  });
  assert(summary.checks.find((c) => c.id === "kit-payload-home").status === "pass", "pass maps");
  assert(
    summary.checks.find((c) => c.id === "kit-payload-events").status === "vacuous",
    "vacuous fails",
  );
  assert(summary.unmapped.length === 1, "unmapped reported");
  console.log(`kit payloads selftest: ${cases} cases passed.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && args[0] === "--selftest") process.exitCode = selftest();
    else if (args.length === 0) process.exitCode = run(false);
    else if (args.length === 1 && args[0] === "--static-only") process.exitCode = run(true);
    else {
      console.error("Usage: node ci/check-kit-payloads.mjs [--selftest] [--static-only]");
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`kit-payloads: error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
