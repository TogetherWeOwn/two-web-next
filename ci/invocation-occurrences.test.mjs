import assert from "node:assert/strict";
import { test } from "node:test";
import { enumerateInvocationOccurrences } from "./invocation-occurrences.mjs";

const command = (location, npmEdges = []) => ({ location, npmEdges });
const edge = (script, location) => ({ script, location });
const origin = { workflow: "one.yml", job: "test", step: 2 };

test("retains each ordered path and its source locations", () => {
  const workflow = { ...command(3, [edge("a", 4), edge("a", 9)]), origin };
  const scripts = {
    a: [command(1, [edge("b", 7)]), command(2, [edge("b", 8)])],
    b: [command(5)],
  };
  const results = enumerateInvocationOccurrences([workflow, workflow], scripts);
  assert.equal(results.length, 18);
  assert.deepEqual(results[2], {
    origin,
    command: 5,
    npmEdges: [edge("a", 4), edge("b", 7)],
  });
  assert.deepEqual(results[4].npmEdges, [edge("a", 4), edge("b", 8)]);
  assert.deepEqual(results[6].npmEdges, [edge("a", 9), edge("b", 7)]);
  assert.deepEqual(results.slice(9), results.slice(0, 9));
});

test("retains parser safety flags on every npm edge", () => {
  const first = { ...edge("a", 4), forwarding: true, redirect: false, unknown: false };
  const second = { ...edge("b", 7), forwarding: false, redirect: true, unknown: true };
  const results = enumerateInvocationOccurrences([{ ...command(0, [first]), origin }], {
    a: [command(1, [second])],
    b: [command(2)],
  });
  assert.deepEqual(results[2].npmEdges, [first, second]);
  assert.notEqual(results[2].npmEdges[0], first);
  assert.notEqual(results[2].npmEdges[1], second);
});

test("keeps workflow contexts distinct for the same script", () => {
  const other = { workflow: "two.yml", job: "browser", step: 1 };
  const results = enumerateInvocationOccurrences(
    [
      { ...command(0, [edge("a", 0)]), origin },
      { ...command(0, [edge("a", 0)]), origin: other },
    ],
    { a: [command(2)] },
  );
  assert.deepEqual(
    results.map((item) => item.origin),
    [origin, origin, other, other],
  );
});

test("fails closed on excessive expansion and depth", () => {
  const workflow = [{ ...command(0, [edge("s0", 0)]), origin }];
  const expanding = Object.fromEntries(
    Array.from({ length: 15 }, (_, i) => [
      `s${i}`,
      [command(i, i === 14 ? [] : [edge(`s${i + 1}`, 0), edge(`s${i + 1}`, 1)])],
    ]),
  );
  assert.throws(() => enumerateInvocationOccurrences(workflow, expanding), /expansion limit/);
  const deep = Object.fromEntries(
    Array.from({ length: 130 }, (_, i) => [
      `s${i}`,
      [command(i, i === 129 ? [] : [edge(`s${i + 1}`, 0)])],
    ]),
  );
  assert.throws(() => enumerateInvocationOccurrences(workflow, deep), /depth limit/);
  const withinDepth = Object.fromEntries(
    Array.from({ length: 128 }, (_, i) => [
      `s${i}`,
      [command(i, i === 127 ? [] : [edge(`s${i + 1}`, 0)])],
    ]),
  );
  assert.equal(enumerateInvocationOccurrences(workflow, withinDepth).length, 129);
  const emptyEdges = (count) => [{ ...command(0, Array(count).fill(edge("empty", 0))), origin }];
  assert.equal(enumerateInvocationOccurrences(emptyEdges(9_999), { empty: [] }).length, 1);
  assert.throws(
    () => enumerateInvocationOccurrences(emptyEdges(10_000), { empty: [] }),
    /expansion limit/,
  );
});

test("counts work across workflow roots and resets the budget between scans", () => {
  const root = { ...command(0, [edge("leaf", 0)]), origin };
  const scripts = { leaf: [command(1)] };
  // Each root consumes one workflow command, one edge and one script command.
  assert.equal(enumerateInvocationOccurrences(Array(3_333).fill(root), scripts).length, 6_666);
  assert.throws(
    () => enumerateInvocationOccurrences(Array(3_334).fill(root), scripts),
    /expansion limit/,
  );
  assert.equal(enumerateInvocationOccurrences([root], scripts).length, 2);
});

test("rejects a bad occurrence regardless of root or chain order", () => {
  const good = { ...command(0, [edge("valid", 0)]), origin };
  const bad = {
    ...command(0, [edge("invalid", 0)]),
    origin: { workflow: "two.yml", job: "other", step: 4 },
  };
  const scripts = {
    valid: [command(1)],
    invalid: [command(2, [edge("missing", 1)])],
  };
  for (const roots of [
    [good, bad],
    [bad, good],
  ]) {
    assert.throws(
      () => enumerateInvocationOccurrences(roots, scripts),
      /Unknown npm script: missing/,
    );
  }
  for (const edges of [
    [edge("valid", 0), edge("invalid", 1)],
    [edge("invalid", 0), edge("valid", 1)],
  ]) {
    assert.throws(
      () => enumerateInvocationOccurrences([{ ...command(0, edges), origin }], scripts),
      /Unknown npm script: missing/,
    );
  }
});

test("rejects direct and indirect recursion but not repeated sibling paths", () => {
  const workflow = [{ ...command(0, [edge("a", 0)]), origin }];
  assert.throws(
    () => enumerateInvocationOccurrences(workflow, { a: [command(0, [edge("a", 1)])] }),
    /a -> a/,
  );
  assert.throws(
    () =>
      enumerateInvocationOccurrences(workflow, {
        a: [command(0, [edge("b", 1)])],
        b: [command(1, [edge("a", 2)])],
      }),
    /a -> b -> a/,
  );
  assert.throws(() => enumerateInvocationOccurrences(workflow, {}), /Unknown npm script: a/);
  assert.throws(
    () => enumerateInvocationOccurrences(workflow, { a: [command(0, [edge("toString", 1)])] }),
    /Unknown npm script/,
  );
});
