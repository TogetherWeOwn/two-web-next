import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  applyAdmissions,
  admissionHeadroom,
  parseAdmission,
  readAdmissions,
  validateAdmissions,
  validateFrozenFiles,
} from "./budget-ledger.mjs";

const UNIT = "kit-client-js-gzip";
const NOW = "2026-10-28T12:00:00Z";
const FILE = `ci/budgets/decisions/${UNIT}/2026-10-28-feature.md`;
const bases = new Map([[UNIT, 100_000]]);
const decision = (overrides = {}) => ({
  unit: UNIT,
  delta_bytes: 500,
  before_bytes: 99_900,
  after_bytes: 100_400,
  cause: "Feature adds a shared view; checked imports for accidental duplication.",
  pr: 42,
  ...overrides,
});
const text = (data = decision()) =>
  `---\n${JSON.stringify(data, null, 2)}\n---\n\nMeasured locked builds.\n`;
const row = (overrides = {}) => ({ ...decision(), file: FILE, ...overrides });
const validate = (proposed, historical = [], extra = {}) =>
  validateAdmissions({ bases, proposed, historical, now: NOW, ...extra });

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "budget-ledger-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root, path, body) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

test("admission front matter records unit, integer bytes, cause and PR", () => {
  assert.deepEqual(parseAdmission(FILE, text()), row());
});

test("malformed, ambiguous or unexplained records fail closed", () => {
  for (const override of [
    { delta_bytes: -1 },
    { delta_bytes: 0 },
    { delta_bytes: 1.5 },
    { delta_bytes: Number.MAX_SAFE_INTEGER + 1 },
    { delta_bytes: "500" },
    { before_bytes: -1 },
    { before_bytes: 1.1 },
    { after_bytes: 99_900 },
    { after_bytes: null },
    { cause: "" },
    { cause: "  " },
    { pr: "42" },
    { pr: 0 },
    { date: "2000-01-01" },
    { unit: "unknown" },
  ]) {
    assert.throws(
      () => parseAdmission(FILE, text(decision(override))),
      undefined,
      JSON.stringify(override),
    );
  }
  for (const body of [
    "no front matter",
    "---\n{\n---\n",
    text().replace('"pr": 42', '"pr": 42, "pr": 43'),
  ]) {
    assert.throws(() => parseAdmission(FILE, body));
  }
  assert.throws(() => parseAdmission(FILE.replace(UNIT, "kit-client-css-gzip"), text()), /unit/);
  assert.throws(() => parseAdmission(FILE.replace("2026-10-28", "2026-02-30"), text()), /date/);
});

test("new deltas add, rather than overwrite; frozen prose is not an admission", (t) => {
  const root = scratch(t);
  put(root, FILE, text(decision({ delta_bytes: 200 })));
  put(root, FILE.replace("feature.md", "other.md"), text(decision({ delta_bytes: 300 })));
  put(root, "ci/budgets/decisions/kit-perf/0000-history.md", "Legacy prose only.");
  assert.equal(readAdmissions(root).length, 2);
  const plan = {
    client: {
      js: { maxRawBytes: 200_000, maxGzipBytes: 100_000, maxFiles: 55 },
    },
  };
  assert.equal(applyAdmissions(root, "kit", plan).client.js.maxGzipBytes, 100_500);
  assert.equal(plan.client.js.maxGzipBytes, 100_000, "base plan must not be mutated");
  assert.equal(applyAdmissions(root, "kit", plan).client.js.maxFiles, 55);
});

test("unknown units, malformed paths and unsafe totals cannot be applied", (t) => {
  const root = scratch(t);
  put(root, FILE, text());
  assert.throws(
    () => applyAdmissions(root, "kit", { client: { css: { maxGzipBytes: 10 } } }),
    /unknown unit/,
  );
  put(root, FILE, text(decision({ delta_bytes: Number.MAX_SAFE_INTEGER })));
  assert.throws(
    () => applyAdmissions(root, "kit", { client: { js: { maxGzipBytes: 1 } } }),
    /safe integer/,
  );
  put(root, `ci/budgets/decisions/${UNIT}/not-a-decision.txt`, "bad");
  assert.throws(() => readAdmissions(root), /decision path/);
});

test("exact 0.5% per PR passes; one byte over fails", () => {
  assert.doesNotThrow(() => validate([row()]));
  assert.throws(() => validate([row({ delta_bytes: 501 })]), /0.5%/);
});

test("ALL new files in one PR and unit share its 0.5% allowance", () => {
  const first = row({ delta_bytes: 250 });
  const second = row({
    file: FILE.replace("feature", "other"),
    delta_bytes: 251,
  });
  assert.throws(() => validate([first, second]), /0.5%/);
  second.delta_bytes = 250;
  assert.doesNotThrow(() => validate([first, second]));
});

test("different units have independent allowances and unknown units fail", () => {
  const other = "kit-client-css-gzip";
  assert.doesNotThrow(() =>
    validate([row(), row({ unit: other, file: FILE.replace(UNIT, other) })], [], {
      bases: new Map([
        [UNIT, 100_000],
        [other, 100_000],
      ]),
    }),
  );
  assert.throws(() => validate([row({ unit: other })]), /unknown unit/);
});

test("duplicate identities, invalid attribution and fabricated provenance fail", () => {
  assert.throws(() => validate([row(), row()]), /duplicate/);
  assert.throws(() => validate([row({ pr: 0 })]), /PR/);
  assert.throws(
    () => validate([row({ file: FILE.replace("feature", "new") })], [row()]),
    /merge provenance/,
  );
  assert.throws(
    () =>
      validate(
        [row({ file: FILE.replace("feature", "new") })],
        [row({ mergedAt: "2099-01-01T00:00:00Z" })],
      ),
    /merge provenance/,
  );
  assert.throws(() => validate([row()], [], { now: "bad" }), /clock/);
});

test("rolling seven days uses trusted merge time, NEVER filename dates", () => {
  const historical = [
    row({
      file: FILE.replace("2026-10-28-feature", "2000-01-01-backdated"),
      pr: 1,
      delta_bytes: 1_600,
      mergedAt: "2026-10-27T12:00:00Z",
    }),
  ];
  assert.throws(() => validate([row()], historical), /2%/);
  historical[0].delta_bytes = 1_500;
  assert.doesNotThrow(() => validate([row()], historical));
});

test("weekly denominator is the effective ceiling at the start of the window", () => {
  const historical = [
    row({
      file: FILE.replace("feature", "old"),
      pr: 1,
      delta_bytes: 100_000,
      mergedAt: "2026-10-21T12:00:00Z",
    }),
  ];
  // Exactly seven days old is outside (now - 7d, now], hence in the denominator.
  assert.doesNotThrow(() =>
    validate([row({ delta_bytes: 1_000, after_bytes: 200_500 })], historical),
  );
  historical[0].mergedAt = "2026-10-21T12:00:01Z";
  assert.throws(() => validate([row()], historical), /2%/);
});

test("all constituent PRs in a merge group share the rolling cap", () => {
  const proposed = Array.from({ length: 5 }, (_, index) =>
    row({
      file: FILE.replace("feature", `feature-${index}`),
      pr: 42 + index,
    }),
  );
  assert.doesNotThrow(() => validate(proposed.slice(0, 4)));
  assert.throws(() => validate(proposed), /2%/);
});

test("merge-group PR denominators do not compound sibling allowances", () => {
  assert.throws(
    () =>
      validate([
        row(),
        row({
          file: FILE.replace("feature", "sibling"),
          pr: 43,
          delta_bytes: 502,
        }),
      ]),
    /0.5%/,
  );
});

test("a decision must explain measured growth and cover its after measurement", () => {
  assert.throws(() => validate([row({ after_bytes: 100_501 })]), /after measurement/);
  assert.throws(() => validate([row({ before_bytes: 100_001 })]), /before measurement/);
});

test("base and ALL historical decisions are immutable; deletion and rename fail", () => {
  const old = new Map([
    ["ci/budgets/kit/client-js.json", "base"],
    [FILE, text()],
    ["ci/budgets/decisions/kit-perf/0000-history.md", "history"],
  ]);
  for (const path of old.keys()) {
    const changed = new Map(old);
    changed.set(path, "edited");
    assert.throws(() => validateFrozenFiles(old, changed), /frozen/);
    changed.delete(path);
    assert.throws(() => validateFrozenFiles(old, changed), /frozen/);
  }
  const newBase = new Map(old).set("ci/budgets/bundle/new.json", "unreviewed allocation");
  assert.throws(() => validateFrozenFiles(old, newBase), /initial allocation/);
  const legacyAddition = new Map(old).set("ci/budgets/decisions/kit-perf/new.md", "prose");
  assert.throws(() => validateFrozenFiles(old, legacyAddition), /admission/);
  assert.doesNotThrow(() =>
    validateFrozenFiles(old, new Map(old).set(FILE.replace("feature", "next"), text())),
  );
});

test("headroom is capped in bytes: no mandatory 256-byte minimum", () => {
  assert.equal(admissionHeadroom(336_640, 336_800), 1_683);
  assert.equal(admissionHeadroom(1_024, 1_025), 5);
  assert.equal(admissionHeadroom(100, 100), 0);
  assert.equal(admissionHeadroom(100_000, 99_999), 0, "reuse existing headroom first");
  assert.equal(admissionHeadroom(100_000, 100_000), 0, "an exact fit needs no admission");
  assert.throws(() => admissionHeadroom(100, 101), /0.5%/);
  assert.throws(() => admissionHeadroom(1_024, 1_030), /0.5%/);
});

test("recent growth cannot compound the weekly denominator", () => {
  const historical = [
    row({
      file: FILE.replace("feature", "recent"),
      pr: 1,
      delta_bytes: 1_510,
      mergedAt: "2026-10-27T12:00:00Z",
    }),
  ];
  // 2010 > 2% of 100000, but <= 2% of current=101510. Per-PR 500 fits either.
  assert.throws(() => validate([row()], historical), /2%/);
  historical[0].delta_bytes = 1_500;
  assert.doesNotThrow(() => validate([row()], historical));
});
