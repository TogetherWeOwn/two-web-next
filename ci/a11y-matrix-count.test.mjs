import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { auditCases, AUDIT_VIEWPORTS } from "./a11y-policy.mjs";
import { loadAuditWorkerRoutes } from "./a11y-test-worker.mjs";

// Pinned matrix: docs/a11y-ci.md states these same numbers. Any route, case,
// or viewport add/remove changes the derived total and fails the pin; update
// the docs and this pin together in one PR.
const EXPECTED_CASES = 77;
const EXPECTED_EXPLICIT_CASES = 68;
const EXPECTED_AUTO_CASES = 9;
const EXPECTED_VIEWPORTS = 2;
const EXPECTED_SCANS = EXPECTED_CASES * EXPECTED_VIEWPORTS;

assert.equal(EXPECTED_SCANS, 154);

const worker = await loadAuditWorkerRoutes();

test("documented matrix count matches the derived audit matrix", async () => {
  const scenarios = auditCases(worker.routes, worker.coverage);
  assert.equal(scenarios.length, EXPECTED_CASES, "case total drifted; reconcile docs/a11y-ci.md");
  const auto = scenarios.filter((scenario) => !Object.hasOwn(worker.coverage, scenario.route));
  assert.equal(auto.length, EXPECTED_AUTO_CASES, "auto-derived static GET count drifted");
  assert.equal(
    scenarios.length - auto.length,
    EXPECTED_EXPLICIT_CASES,
    "explicit coverage case count drifted",
  );

  // Derive the scan multiplier from the viewport list the runner iterates,
  // not from source text: a spread/variable addition or dimension edit fails
  // here even though the literal count in ci/a11y.mjs would be unchanged.
  // The loop assertion binds the runner to this constant, so a loop-site
  // spread such as [...AUDIT_VIEWPORTS, extra] also fails the pin.
  assert.deepEqual(
    AUDIT_VIEWPORTS,
    [
      { width: 360, height: 780 },
      { width: 1280, height: 900 },
    ],
    "viewport list drifted; the scan total is cases x viewports",
  );
  assert(Object.isFrozen(AUDIT_VIEWPORTS), "AUDIT_VIEWPORTS must stay frozen so a push throws");
  const runner = await readFile(new URL("./a11y.mjs", import.meta.url), "utf8");
  assert.match(
    runner,
    /for \(const viewport of AUDIT_VIEWPORTS\)/,
    "runner must iterate the pinned AUDIT_VIEWPORTS list; loop-site spreads bypass the pin",
  );
  assert.equal(
    runner.match(/for \(const viewport of /g)?.length,
    1,
    "exactly one viewport loop must iterate AUDIT_VIEWPORTS; a second loop adds scans silently",
  );
  assert.equal(AUDIT_VIEWPORTS.length, EXPECTED_VIEWPORTS);
  assert.equal(
    scenarios.length * AUDIT_VIEWPORTS.length,
    EXPECTED_SCANS,
    "scan total drifted; reconcile docs/a11y-ci.md",
  );

  const docs = await readFile(new URL("../docs/a11y-ci.md", import.meta.url), "utf8");
  assert.match(
    docs,
    new RegExp(`The matrix has ${EXPECTED_CASES} cases / ${EXPECTED_SCANS} scans`),
    "docs/a11y-ci.md case/scan total drifted from the derived matrix",
  );
  const viewportSizes = AUDIT_VIEWPORTS.map((v) => `${v.width}×${v.height}`).join(" and ");
  assert.match(
    docs,
    new RegExp(`scanned at ${viewportSizes}`),
    "docs/a11y-ci.md viewport sizes drifted from the executed list",
  );
  assert.match(
    docs,
    new RegExp(`all ${EXPECTED_SCANS}\\n  document scans pass`),
    "docs/a11y-ci.md acceptance row drifted from the derived scan total",
  );
});

test("one case removed or added fails the pin", () => {
  const removed = structuredClone(worker.coverage);
  removed["/events"].cases = removed["/events"].cases.slice(0, -1);
  const fewer = auditCases(worker.routes, removed);
  assert.equal(fewer.length, EXPECTED_CASES - 1);
  assert.notEqual(fewer.length, EXPECTED_CASES, "pin must fail when a case is removed");

  const added = auditCases(
    [...worker.routes, { method: "GET", path: "/pin-probe-new-page" }],
    worker.coverage,
  );
  assert.equal(added.length, EXPECTED_CASES + 1);
  assert.notEqual(added.length, EXPECTED_CASES, "pin must fail when a route is added");
});
