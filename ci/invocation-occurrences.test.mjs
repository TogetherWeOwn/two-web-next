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

test("projects isolated commands and workflow roots without changing traversal", () => {
  const root = { ...command(0, [edge("a", 1), edge("a", 2)]), origin, metadata: { value: 1 } };
  const scripts = { a: [command(3, [edge("b", 4)])], b: [command(5)] };
  const before = structuredClone({ root, scripts });
  const results = enumerateInvocationOccurrences(
    [root],
    scripts,
    (occurrence, source, workflow) => {
      assert.equal(occurrence.origin.job, "test");
      assert.equal(workflow.metadata.value, 1);
      assert.equal(workflow.npmEdges.length, 2);
      assert.equal(
        source.npmEdges.length,
        source.location === 0 ? 2 : source.location === 3 ? 1 : 0,
      );
      const result = { occurrence, source: source.location, root: workflow.location };
      source.npmEdges.length = 0;
      workflow.npmEdges.length = 0;
      workflow.metadata.value = 2;
      if (occurrence.command === 3) {
        occurrence.origin.job = "changed";
        occurrence.npmEdges[0].location = -1;
        occurrence.npmEdges.length = 0;
        assert.equal(workflow.origin.job, "test");
      }
      return result;
    },
  );
  assert.deepEqual(
    results.map(({ source }) => source),
    [0, 3, 5, 3, 5],
  );
  assert.deepEqual(
    results.map(({ root: location }) => location),
    [0, 0, 0, 0, 0],
  );
  assert.deepEqual(results[2].occurrence.npmEdges, [edge("a", 1), edge("b", 4)]);
  assert.deepEqual(results[4].occurrence.npmEdges, [edge("a", 2), edge("b", 4)]);
  assert.deepEqual({ root, scripts }, before);
});

test("projects isolated parent commands and script indexes for each path", () => {
  const root = { ...command(0, [edge("a", 1), edge("a", 2)]), origin };
  const scripts = {
    a: [command(3), command(4, [edge("b", 5)])],
    b: [command(6), command(7)],
  };
  const before = structuredClone({ root, scripts });
  const results = enumerateInvocationOccurrences(
    [root],
    scripts,
    (occurrence, source, workflow, ancestry) => {
      const path = ancestry.map(({ command: parent, index }) => `${parent.location}:${index}`);
      for (const { command: parent } of ancestry) {
        assert.ok(parent.npmEdges.length > 0);
        parent.npmEdges.length = 0;
      }
      assert.equal(workflow.npmEdges.length, 2);
      return { location: source.location, path, edges: occurrence.npmEdges };
    },
    { includeAncestry: true },
  );
  const branch = [
    [3, ["0:0"]],
    [4, ["0:1"]],
    [6, ["0:1", "4:0"]],
    [7, ["0:1", "4:1"]],
  ];
  assert.deepEqual(
    results.map(({ location, path }) => [location, path]),
    [[0, []], ...branch, ...branch],
  );
  assert.deepEqual(results[3].edges, [edge("a", 1), edge("b", 5)]);
  assert.deepEqual(results[7].edges, [edge("a", 2), edge("b", 5)]);
  assert.deepEqual({ root, scripts }, before);
});

test("ancestry copies share the projection budget and reset between scans", () => {
  const root = { ...command(0, [edge("a", 1)]), origin };
  const scripts = {
    a: [{ ...command(2, [edge("b", 3)]), metadata: "x".repeat(600_000) }],
    b: [command(4)],
  };
  const project = (occurrence) => occurrence.command;
  assert.deepEqual(enumerateInvocationOccurrences([root], scripts, project), [0, 2, 4]);
  assert.throws(
    () => enumerateInvocationOccurrences([root], scripts, project, { includeAncestry: true }),
    /projection clone limit exceeded/,
  );
  assert.deepEqual(enumerateInvocationOccurrences([root], scripts, project), [0, 2, 4]);
});

test("projection cannot mutate traversal through an aliased edge array", () => {
  const edges = [edge("a", 1)];
  const root = { ...command(0, edges), origin, metadata: { edges } };
  const results = enumerateInvocationOccurrences(
    [root],
    { a: [command(2)] },
    (occurrence, source) => {
      source.metadata?.edges.splice(0);
      return occurrence;
    },
  );
  assert.deepEqual(
    results.map(({ command: location }) => location),
    [0, 2],
  );
  assert.deepEqual(root.npmEdges, [edge("a", 1)]);
});

test("fails closed when projection inputs are not cloneable", () => {
  const root = { ...command(0), origin, metadata: () => {} };
  let called = false;
  assert.throws(() =>
    enumerateInvocationOccurrences([root], {}, () => {
      called = true;
    }),
  );
  assert.equal(called, false);
  assert.deepEqual(enumerateInvocationOccurrences([root], {}), [
    { origin, command: 0, npmEdges: [] },
  ]);
});

test("refuses symbol-keyed metadata only on the projection path", () => {
  const flag = Symbol("parser flag");
  const root = { ...command(0, [{ ...edge("a", 1), [flag]: true }]), origin };
  const scripts = { a: [command(2)] };
  assert.equal(enumerateInvocationOccurrences([root], scripts)[1].npmEdges[0][flag], true);
  assert.throws(
    () => enumerateInvocationOccurrences([root], scripts, (value) => value),
    /projection requires plain data/,
  );
});

test("bounds repeated projection copies without changing ordinary traversal", () => {
  const root = {
    ...command(
      0,
      Array.from({ length: 400 }, (_, location) => edge("leaf", location)),
    ),
    origin,
  };
  const scripts = { leaf: [command(1)] };
  assert.equal(enumerateInvocationOccurrences([root], scripts).length, 401);
  assert.throws(
    () => enumerateInvocationOccurrences([root], scripts, (occurrence) => occurrence),
    /projection clone limit exceeded/,
  );
  const small = { ...command(0, [edge("leaf", 0)]), origin };
  assert.equal(enumerateInvocationOccurrences([small], scripts, (value) => value).length, 2);
});

test("accepts the exact projection copy budget and rejects one unit more", () => {
  const root = command(0, [edge("leaf", 0)]);
  const project = (occurrence) => occurrence.command;
  const scripts = (length) => ({ leaf: [{ ...command(1), metadata: "x".repeat(length) }] });
  // The six snapshots cost 254 units with empty leaf metadata. Its string is
  // copied only in the leaf source snapshot, so each character adds one unit.
  const limit = 1_000_000 - 254;
  assert.deepEqual(enumerateInvocationOccurrences([root], scripts(limit), project), [0, 1]);
  assert.throws(
    () => enumerateInvocationOccurrences([root], scripts(limit + 1), project),
    /projection clone limit exceeded/,
  );
});

test("accepts 128 nested projection objects and rejects the 129th", () => {
  const roots = (depth) => {
    let metadata = {};
    // The command itself counts as the outermost object.
    for (let i = 2; i < depth; i++) metadata = { child: metadata };
    return [{ ...command(0), metadata }];
  };
  const project = (occurrence) => occurrence.command;
  assert.deepEqual(enumerateInvocationOccurrences(roots(128), {}, project), [0]);
  assert.throws(
    () => enumerateInvocationOccurrences(roots(129), {}, project),
    /projection clone depth limit exceeded/,
  );
});

test("ancestry preserves the parent command clone depth limit", () => {
  let metadata = {};
  for (let depth = 2; depth < 128; depth++) metadata = { child: metadata };
  const root = { ...command(0, [edge("leaf", 1)]), metadata };
  const scripts = { leaf: [command(2)] };
  const project = (occurrence, _source, _workflow, ancestry) => [
    occurrence.command,
    ancestry.map(({ command: parent }) => parent.location),
  ];
  assert.deepEqual(
    enumerateInvocationOccurrences([root], scripts, project, { includeAncestry: true }),
    [
      [0, []],
      [2, [0]],
    ],
  );
});

test("refuses async projections instead of returning a rejected promise", () => {
  const root = { ...command(0), origin };
  assert.throws(
    () =>
      enumerateInvocationOccurrences([root], {}, async () => {
        throw new Error("projection rejected asynchronously");
      }),
    /projection must be synchronous/,
  );
});

test("propagates projection failures instead of returning partial occurrences", () => {
  const root = { ...command(0, [edge("a", 1)]), origin };
  const visited = [];
  assert.throws(
    () =>
      enumerateInvocationOccurrences([root], { a: [command(2)] }, (occurrence) => {
        visited.push(occurrence.command);
        if (occurrence.command === 2) throw new Error("projection rejected");
        return occurrence;
      }),
    /projection rejected/,
  );
  assert.deepEqual(visited, [0, 2]);
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
