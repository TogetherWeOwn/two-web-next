import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGate } from "./check-kit-parity.mjs";

function reportFor(statuses) {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-parity-ledger-"),
  );
  const suites = [
    {
      specs: statuses.map(([title, status], index) => ({
        file: "e2e/kit-parity/parity.spec.ts",
        title: `${title} ${index}`,
        tests: [{ projectName: "chromium", status, annotations: [], results: [] }],
      })),
      suites: [],
    },
  ];
  const reportPath = join(root, "journeys.json");
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ suites }));
  const lines = [];
  const errors = [];
  const paths = {
    reportPath,
    ledgerJsonPath: join(root, "out", "ledger.json"),
    ledgerMdPath: join(root, "out", "ledger.md"),
    stepSummaryPath: null,
    stdout: { write: (text) => void lines.push(text) },
    stderr: { write: (text) => void errors.push(text) },
  };
  return { paths, lines, errors };
}

test("passing journeys exit 0 with a Kit parity ledger", () => {
  const { paths, lines } = reportFor([["archive", "expected"]]);
  assert.equal(runGate(paths), 0);
  assert.ok(lines.some((line) => line.includes("Kit parity ledger")));
});

test("failed journeys exit 1 with the failure named", () => {
  const { paths, lines, errors } = reportFor([["archive", "unexpected"]]);
  assert.equal(runGate(paths), 1);
  assert.ok(
    errors.some((line) => line.includes("failed")) || lines.some((line) => line.includes("failed")),
  );
});

test("all-skipped journeys exit 2, never a quiet green", () => {
  const { paths, errors } = reportFor([["archive", "skipped"]]);
  assert.equal(runGate(paths), 2);
  assert.ok(errors.some((line) => line.includes("LOUD ALL-SKIPPED")));
});

test("missing report exits 2, never a quiet green", () => {
  const errors = [];
  const code = runGate({
    reportPath: "/nonexistent/kit-parity-journeys.json",
    ledgerJsonPath: "/nonexistent/out.json",
    ledgerMdPath: "/nonexistent/out.md",
    stepSummaryPath: null,
    stdout: { write() {} },
    stderr: { write: (text) => void errors.push(text) },
  });
  assert.equal(code, 2);
  assert.ok(errors.some((line) => line.includes("LOUD ALL-SKIPPED")));
});
