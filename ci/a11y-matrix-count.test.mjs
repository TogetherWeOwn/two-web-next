import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { auditCases } from "./a11y-policy.mjs";
import { loadAuditWorkerRoutes } from "./a11y-test-worker.mjs";

// Pinned matrix: docs/a11y-ci.md states these same numbers. Any route or case
// add/remove changes the derived total and fails the pin; update the docs and
// this pin together in one PR.
const EXPECTED_CASES = 73;
const EXPECTED_EXPLICIT_CASES = 64;
const EXPECTED_AUTO_CASES = 9;
const EXPECTED_VIEWPORTS = 2;
const EXPECTED_SCANS = EXPECTED_CASES * EXPECTED_VIEWPORTS;

assert.equal(EXPECTED_SCANS, 146);

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

  const runner = await readFile(new URL("./a11y.mjs", import.meta.url), "utf8");
  const loop = runner.match(/for \(const viewport of \[(.*?)\]\)/s);
  assert(loop, "viewport loop must keep its shape so the scan multiplier stays readable");
  assert.equal(
    loop[1].match(/\{ width:/g)?.length ?? 0,
    EXPECTED_VIEWPORTS,
    "viewport count drifted; the scan total is cases x viewports",
  );

  const docs = await readFile(new URL("../docs/a11y-ci.md", import.meta.url), "utf8");
  assert.match(
    docs,
    new RegExp(`The matrix has ${EXPECTED_CASES} cases / ${EXPECTED_SCANS} scans`),
    "docs/a11y-ci.md case/scan total drifted from the derived matrix",
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
