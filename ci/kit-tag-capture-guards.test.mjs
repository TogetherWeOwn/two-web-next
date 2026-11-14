// Offline tests for the Tag gallery capture guards; no browser, network or git.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SOURCE_SHA,
  assertNoAxeViolations,
  assertSource,
  isAllowedRequest,
  parseArgs,
  summarizeLighthouse,
} from "./kit-tag-capture-guards.mjs";

test("parseArgs requires exactly two plain paths", () => {
  assert.deepEqual(parseArgs(["a", "b"]), { app: "a", output: "b" });
  for (const bad of [[], ["a"], ["a", "b", "c"], ["a", ""], ["--x", "b"]])
    assert.throws(() => parseArgs(bad));
});

test("assertSource fails on wrong sha or dirty tree", () => {
  assertSource({ head: SOURCE_SHA, status: "" });
  assert.throws(() => assertSource({ head: "0".repeat(40), status: "" }), /pinned/);
  assert.throws(() => assertSource({ head: SOURCE_SHA, status: " M x" }), /overlays/);
});

test("isAllowedRequest allows only the exact origin", () => {
  const o = "http://127.0.0.1:4180";
  assert.equal(isAllowedRequest(`${o}/a`, o), true);
  for (const bad of [
    "http://127.0.0.1:4181/",
    "https://example.com/",
    "http://127.0.0.1:4180.evil.test/",
    "not a url",
  ])
    assert.equal(isAllowedRequest(bad, o), false);
});

test("summarizeLighthouse reports without claiming policy and fails closed", () => {
  const lhr = {
    lighthouseVersion: "1",
    categories: { performance: { score: 1 }, accessibility: { score: 0.9 } },
  };
  assert.equal(summarizeLighthouse(lhr).policy, "not-evaluated");
  assert.throws(() => summarizeLighthouse({ categories: {} }), /Missing/);
  assert.throws(() => summarizeLighthouse({ ...lhr, runtimeError: { code: "X" } }), /runtime/);
});

test("assertNoAxeViolations rejects malformed or failing results", () => {
  assert.equal(assertNoAxeViolations({ violations: [], passes: [1] }).passes, 1);
  assert.throws(() => assertNoAxeViolations({}), /Malformed/);
  assert.throws(() => assertNoAxeViolations({ violations: [{ id: "x" }] }), /x/);
});
