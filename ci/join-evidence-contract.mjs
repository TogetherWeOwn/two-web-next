import assert from "node:assert/strict";
import { caseIdFor } from "./execution-receipt-authority.mjs";
import { admitTap, parseTapSummary } from "./rsvp-focus-require-executed.mjs";

const profiles = {
  baseline: [
    "fresh-populated",
    "age61s-populated",
    "age61s-empty",
    "age180s-populated",
    "fresh-empty",
  ],
  target: ["fresh-populated", "stale-populated", "stale-empty", "expired", "fresh-empty"],
};

function captureStates(profile) {
  assert.ok(Object.hasOwn(profiles, profile), "unknown capture profile");
  return profiles[profile];
}

export function expectedCaptureNames(profile = "baseline") {
  const states = captureStates(profile);
  return ["hono", "kit"].flatMap((renderer) =>
    [1280, 390].flatMap((width) => states.map((state) => `${renderer}-${state}-${width}.png`)),
  );
}

export function validateCaptureTap(tap, profile = "baseline") {
  const suite = "Join presence state evidence";
  const expected = ["hono", "kit"].flatMap((renderer) =>
    [1280, 390].flatMap((width) =>
      captureStates(profile).map((state) =>
        caseIdFor("tap", [suite, `${renderer} ${state} at ${width}`]),
      ),
    ),
  );
  const receipt = admitTap(tap, suite, expected.length);
  assert.equal(parseTapSummary(tap).tests, expected.length, "unexpected TAP test count");
  assert.deepEqual(receipt.caseIds.sort(), expected.sort(), "unexpected TAP scenario identities");
}

export function validateCaptureFiles(entries, profile = "baseline") {
  const expected = [...expectedCaptureNames(profile), "test-report.tap"].sort();
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
