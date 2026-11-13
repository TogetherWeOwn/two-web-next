import assert from "node:assert/strict";
import { caseIdFor } from "./execution-receipt-authority.mjs";
import { admitTap, parseTapSummary } from "./rsvp-focus-require-executed.mjs";

const states = [
  "fresh-populated",
  "age61s-populated",
  "age61s-empty",
  "age180s-populated",
  "fresh-empty",
];

export function expectedCaptureNames() {
  return ["hono", "kit"].flatMap((renderer) =>
    [1280, 390].flatMap((width) => states.map((state) => `${renderer}-${state}-${width}.png`)),
  );
}

export function validateCaptureTap(tap) {
  const suite = "Join presence state evidence";
  const expected = ["hono", "kit"].flatMap((renderer) =>
    [1280, 390].flatMap((width) =>
      states.map((state) => caseIdFor("tap", [suite, `${renderer} ${state} at ${width}`])),
    ),
  );
  const receipt = admitTap(tap, suite, expected.length);
  assert.equal(parseTapSummary(tap).tests, expected.length, "unexpected TAP test count");
  assert.deepEqual(receipt.caseIds.sort(), expected.sort(), "unexpected TAP scenario identities");
}

export function validateCaptureFiles(entries) {
  const expected = [...expectedCaptureNames(), "test-report.tap"].sort();
  assert.ok(
    entries.every((entry) => entry.isFile()),
    "evidence entries must be regular files",
  );
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    expected,
    "unexpected evidence file set",
  );
}

export function validateSourceIdentities(actual, expected) {
  for (const source of ["application", "controller"]) {
    assert.match(expected[source] ?? "", /^[a-f0-9]{40}$/, `invalid expected ${source} SHA`);
    assert.equal(actual[source], expected[source], `${source} SHA mismatch`);
    assert.equal(actual[`${source}Clean`], true, `${source} worktree is not clean`);
  }
}
