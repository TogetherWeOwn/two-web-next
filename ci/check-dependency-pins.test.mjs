// Offline tests for the dependency-pins gate: fixture scanners plus a live
// inventory assertion over the real checkout. No network, no registry, no
// node_modules install: everything runs with node --test on a bare checkout.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectPins,
  holdBackNames,
  isExactRange,
  parseManifestPins,
  scanTestSource,
  updatableNames,
  verifyPins,
} from "./check-dependency-pins.mjs";

test("exact ranges admit only bare semver", () => {
  assert.equal(isExactRange("4.152.0"), true);
  assert.equal(isExactRange("5.20260926.1-alpha"), true);
  assert.equal(isExactRange("^4.152.0"), false);
  assert.equal(isExactRange("~1.2.3"), false);
  assert.equal(isExactRange(">=1.0.0 <2.0.0"), false);
  assert.equal(isExactRange("npm:tmp@0.2.7"), false);
});

test("manifest scan separates exact ranges from overrides keys", () => {
  const { exact, overrides } = parseManifestPins({
    dependencies: { zod: "4.6.7", hono: "^4.13.13" },
    devDependencies: { wrangler: "^4.152.0" },
    overrides: { esbuild: "0.28.2", "@lhci/cli": { tmp: "0.2.7" } },
  });
  assert.deepEqual(
    exact.map((pin) => pin.name),
    ["zod"],
  );
  assert.deepEqual(overrides.map((pin) => pin.key).sort(), ["@lhci/cli", "esbuild"]);
});

test("live inventory pins wrangler and holds it back", () => {
  const pins = collectPins();
  const wrangler = pins.installed.find((pin) => pin.name === "wrangler");
  assert.ok(wrangler, "the remote-runner isolation pin is discovered");
  assert.equal(wrangler.version, "4.152.0");
  assert.ok(wrangler.file.endsWith("remote-runner-isolation.test.ts"));
  assert.deepEqual(holdBackNames(pins), ["wrangler"]);
  assert.ok(!updatableNames(pins).includes("wrangler"));
  assert.ok(updatableNames(pins).length > 0);
});

test("live inventory verifies clean on the current tree", () => {
  const pins = collectPins();
  const result = verifyPins(pins);
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => c.status !== "pass")));
});

test("drifted lockfile entries fail with a restore hint", () => {
  const pins = collectPins();
  const drifted = {
    ...pins,
    lockfile: {
      packages: { ...pins.lockfile.packages, "node_modules/wrangler": { version: "9.9.9" } },
    },
  };
  const result = verifyPins(drifted);
  assert.equal(result.ok, false);
  assert.match(
    JSON.stringify(result.checks),
    /npm install wrangler@4\.152\.0/,
    "the failure names the lockfile-only restore",
  );
});
