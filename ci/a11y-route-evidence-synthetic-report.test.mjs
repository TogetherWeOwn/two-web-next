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

test("synthetic report enforces byte boundaries", () => {
  const report = syntheticRouteReport(root);
  const limit = 1024 * 1024;
  const atLimit = Buffer.concat([report, Buffer.alloc(limit - report.length, 0x20)]);
  assert.equal(atLimit.length, limit);
  assert.equal(
    validateSyntheticRouteReport(root, new Map([["report.json", atLimit]])).cases.length,
    3,
  );
  for (const bytes of [Buffer.alloc(0), Buffer.concat([atLimit, Buffer.from(" ")])]) {
    assert.throws(
      () => validateSyntheticRouteReport(root, new Map([["report.json", bytes]])),
      /invalid synthetic report/,
    );
  }
});

test("synthetic report refuses duplicate keys even when parsed data matches", () => {
  const report = syntheticRouteReport(root);
  const value = JSON.parse(report.toString("utf8"));
  const key = Object.keys(value)[0];
  const duplicate = Buffer.from(
    `{${JSON.stringify(key)}:${JSON.stringify(value[key])},${report.toString("utf8").slice(1)}`,
  );
  assert.deepEqual(JSON.parse(duplicate.toString("utf8")), value);
  assert.throws(
    () => validateSyntheticRouteReport(root, new Map([["report.json", duplicate]])),
    /invalid synthetic report/,
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
