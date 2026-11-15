import assert from "node:assert/strict";
import { test } from "node:test";
import { createEvidence, routeCssFiles } from "./kit-css-evidence.mjs";

const node = (n) => `.svelte-kit/generated/build/client-optimized/nodes/${n}.js`;
const manifest = {
  [node(0)]: { file: "n0.js", imports: [node(2)], dynamicImports: [node(3)], css: ["a0.css"] },
  [node(1)]: { file: "n1.js", css: ["a1.css"] },
  [node(2)]: { file: "n2.js", css: ["a2.css"] },
  [node(3)]: { file: "n3.js", css: ["dyn.css"] },
  [node(4)]: { file: "n4.js", css: ["other.css"] },
};
const routeEvidence = {
  routes: [
    { id: "/x", page: { leaf: 0, layouts: [1], errors: [null] } },
    { id: "/api", page: null },
  ],
};

test("routeCssFiles follows static edges and only optionally dynamic edges", () => {
  assert.deepEqual(routeCssFiles(manifest, routeEvidence, "/x"), ["a0.css", "a1.css", "a2.css"]);
  assert.deepEqual(routeCssFiles(manifest, routeEvidence, "/x", { dynamic: true }), [
    "a0.css",
    "a1.css",
    "a2.css",
    "dyn.css",
  ]);
  assert.throws(() => routeCssFiles(manifest, routeEvidence, "/missing"), /Unknown route/);
  assert.throws(() => routeCssFiles(manifest, routeEvidence, "/api"), /no page/);
});

test("route traversal handles cycles, shared CSS and missing graph entries", () => {
  const graph = {
    [node(0)]: { css: ["z.css", "same.css"], imports: ["shared"] },
    [node(1)]: { css: ["same.css", "a.css"], imports: ["shared"] },
    shared: { css: ["shared.css"], imports: [node(0)] },
  };
  assert.deepEqual(routeCssFiles(graph, routeEvidence, "/x"), [
    "a.css",
    "same.css",
    "shared.css",
    "z.css",
  ]);
  assert.throws(
    () => routeCssFiles({ [node(0)]: {} }, routeEvidence, "/x"),
    /Missing client node 1/,
  );
  assert.throws(
    () => routeCssFiles({ ...graph, shared: { imports: ["missing"] } }, routeEvidence, "/x"),
    /Manifest references missing chunk: missing/,
  );
});

test("evidence queries match strings and patterns without crossing routes", () => {
  const client = [
    { file: "a0.css", text: ".a{--m:1}" },
    { file: "other.css", text: ".o{--m:2}" },
    { file: "a1.css", text: "" },
    { file: "a2.css", text: "" },
  ];
  const e = createEvidence({
    root: "/r",
    output: "/o",
    client,
    server: [],
    manifest,
    routeEvidence,
  });
  assert.deepEqual(e.cssContaining("--m:"), ["a0.css", "other.css"]);
  assert.deepEqual(e.cssContaining(/--m:2/), ["other.css"]);
  const global = /--m:/g;
  assert.deepEqual(e.cssContaining(global), ["a0.css", "other.css"]);
  assert.equal(e.routeCssContains("/x", global), true);
  assert.equal(e.routeCssContains("/x", global), true);
  assert.equal(global.lastIndex, 0);
  assert.equal(e.routeCssContains("/x", "--m:1"), true);
  assert.equal(e.routeCssContains("/x", "--m:2"), false);
  assert.throws(() => e.cssText("nope.css"), /No compiled client CSS/);
});
