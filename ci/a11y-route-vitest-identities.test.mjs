import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { routeVitestIdentities } from "./route-vitest-identities.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/execution-receipt-vitest.json", import.meta.url), "utf8"),
);
const suite = "RSVP outcome focus in Chromium";

test("synthetic identities are checkout-relative and retain exact case selectors", () => {
  const dir = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "route-identities-"),
  );
  try {
    const roots = [join(dir, "one"), join(dir, "two")];
    const reports = roots.map((root) => {
      mkdirSync(join(root, "test"), { recursive: true });
      const file = join(root, "test", "control.test.mjs");
      writeFileSync(file, "fixture");
      const report = structuredClone(fixture);
      report.testResults[0].name = file;
      return report;
    });
    const first = routeVitestIdentities(reports[0], suite, 3, roots[0]);
    assert.deepEqual(first, routeVitestIdentities(reports[1], suite, 3, roots[1]));
    assert.equal(first.version, 1);
    assert.equal(first.cases.length, 3);
    assert.deepEqual(first.cases[0].selector, {
      file: "test/control.test.mjs",
      ancestors: [suite],
      title: "alpha",
    });
    assert.equal(new Set(first.cases.map((entry) => entry.id)).size, 3);

    assert.throws(() => routeVitestIdentities(reports[0], suite, 3, roots[1]));
    const alias = join(roots[0], "alias.test.mjs");
    symlinkSync(reports[0].testResults[0].name, alias);
    const aliased = structuredClone(reports[0]);
    aliased.testResults[0].name = alias;
    assert.throws(() => routeVitestIdentities(aliased, suite, 3, roots[0]));
    const failed = structuredClone(reports[0]);
    failed.testResults[0].assertionResults[0].status = "failed";
    assert.throws(() => routeVitestIdentities(failed, suite, 3, roots[0]));
    const duplicate = structuredClone(reports[0]);
    duplicate.testResults[0].assertionResults[1] = structuredClone(
      duplicate.testResults[0].assertionResults[0],
    );
    assert.throws(() => routeVitestIdentities(duplicate, suite, 3, roots[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
