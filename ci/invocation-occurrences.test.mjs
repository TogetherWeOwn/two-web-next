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
