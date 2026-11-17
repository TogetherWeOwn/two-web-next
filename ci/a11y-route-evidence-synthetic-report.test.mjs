import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { test } from "node:test";
import {
  syntheticRouteReport,
  validateSyntheticRouteReport,
} from "./route-evidence-synthetic-report.mjs";

const root = realpathSync(process.cwd());

test("synthetic report is revalidated against the reviewed fixture", () => {
  const report = syntheticRouteReport(root);
  const result = validateSyntheticRouteReport(root, new Map([["report.json", report]]));
  assert.equal(result.cases.length, 3);
  assert.deepEqual(
    result.cases.map((entry) => entry.selector.title),
    ["alpha", "beta", "gamma"],
  );
  assert.ok(
    result.cases.every(
      (entry) => entry.selector.file === "ci/fixtures/execution-receipt-vitest.json",
    ),
  );
});

test("synthetic report refuses missing, extra, malformed, duplicate and changed data", () => {
  const report = syntheticRouteReport(root);
  const altered = (change) => {
    const value = JSON.parse(report.toString("utf8"));
    change(value);
    return new Map([["report.json", Buffer.from(JSON.stringify(value))]]);
  };
  const cases = [
    new Map(),
    new Map([
      ["report.json", report],
      ["extra", report],
    ]),
    new Map([["report.json", Buffer.from("{")]]),
    new Map([["report.json", Buffer.from('{"success":true,"success":true}')]]),
    altered((value) => (value.testResults[0].assertionResults[0].status = "failed")),
    altered((value) => (value.testResults[0].assertionResults[0].status = "pending")),
    altered(
      (value) =>
        (value.testResults[0].assertionResults[1] = value.testResults[0].assertionResults[0]),
    ),
    altered((value) => (value.testResults[0].assertionResults[0].title = "different")),
    new Map([["report.json", Buffer.from([0xff])]]),
  ];
  for (const entries of cases)
    assert.throws(() => validateSyntheticRouteReport(root, entries), /invalid synthetic report/);
});
