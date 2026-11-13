import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedCaptureNames,
  validateCaptureFiles,
  validateCaptureTap,
  validateSourceIdentities,
} from "./join-evidence-contract.mjs";

const application = "a".repeat(40);
const controller = "b".repeat(40);
const expected = { application, controller };
const clean = { ...expected, applicationClean: true, controllerClean: true };
const entry = (name, regular = true) => ({ name, isFile: () => regular });

function captureTap(names) {
  const suite = "Join presence state evidence";
  const cases = names
    .map((name, index) => `    # Subtest: ${name}\n    ok ${index + 1} - ${name}`)
    .join("\n");
  return `TAP version 13\n# Subtest: ${suite}\n${cases}\n    1..${names.length}\nok 1 - ${suite}\n1..1\n# tests ${names.length}\n# suites 1\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

test("admits only the complete, successful set of scenario identities", () => {
  const names = expectedCaptureNames().map((name) => {
    const match = /^(hono|kit)-(.+)-(1280|390)\.png$/.exec(name);
    return `${match[1]} ${match[2]} at ${match[3]}`;
  });
  const tap = captureTap(names);
  validateCaptureTap(tap);
  assert.throws(() => validateCaptureTap(captureTap(names.slice(1))));
  assert.throws(() => validateCaptureTap(captureTap([...names.slice(1), "unexpected"])));
  assert.throws(() => validateCaptureTap(captureTap([...names.slice(1), names[1]])));
  assert.throws(() => validateCaptureTap(tap.replace("    ok 1 -", "    not ok 1 -")));
  assert.throws(() => validateCaptureTap(tap.replace("# fail 0", "# fail 1")));
  assert.throws(() => validateCaptureTap(tap.replace("    1..20", "    1..19")));
  assert.throws(() => validateCaptureTap(`${tap}Bail out!\n`));
});

test("requires exactly the twenty regular captures and the TAP report", () => {
  const names = expectedCaptureNames();
  assert.equal(names.length, 20);
  assert.equal(new Set(names).size, 20);
  const entries = [...names, "test-report.tap"].map((name) => entry(name));
  validateCaptureFiles(entries);
  assert.throws(() => validateCaptureFiles(entries.slice(1)), /file set/);
  assert.throws(() => validateCaptureFiles([...entries, entry("extra.txt")]), /file set/);
  assert.throws(
    () => validateCaptureFiles([...entries.slice(1), entry(names[0], false)]),
    /regular files/,
  );
});

test("keeps baseline and target inventory and receipts distinct", () => {
  const targetNames = expectedCaptureNames("target");
  assert.equal(targetNames.length, 20);
  assert.ok(targetNames.includes("hono-stale-populated-1280.png"));
  assert.ok(targetNames.includes("kit-stale-empty-390.png"));
  assert.ok(targetNames.includes("kit-expired-390.png"));
  const entries = [...targetNames, "test-report.tap"].map((name) => entry(name));
  const names = targetNames.map((name) => {
    const match = /^(hono|kit)-(.+)-(1280|390)\.png$/.exec(name);
    return `${match[1]} ${match[2]} at ${match[3]}`;
  });
  const tap = captureTap(names);
  validateCaptureFiles(entries, "target");
  validateCaptureTap(tap, "target");
  assert.throws(() => validateCaptureFiles(entries, "baseline"));
  assert.throws(() => validateCaptureTap(tap, "baseline"));
  assert.throws(() => expectedCaptureNames("unknown"), /unknown capture profile/);
  assert.throws(() => expectedCaptureNames("toString"), /unknown capture profile/);
});

test("requires exact pinned clean application and controller identities", () => {
  validateSourceIdentities(clean, expected);
  assert.throws(
    () => validateSourceIdentities({ ...clean, application: controller }, expected),
    /application SHA mismatch/,
  );
  assert.throws(
    () => validateSourceIdentities({ ...clean, controller: application }, expected),
    /controller SHA mismatch/,
  );
  assert.throws(
    () => validateSourceIdentities(clean, { ...expected, application: "a" }),
    /invalid expected application SHA/,
  );
  assert.throws(
    () => validateSourceIdentities({ ...clean, applicationClean: false }, expected),
    /application worktree/,
  );
  assert.throws(
    () => validateSourceIdentities({ ...clean, controllerClean: false }, expected),
    /controller worktree/,
  );
});
