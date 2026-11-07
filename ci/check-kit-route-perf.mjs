#!/usr/bin/env node
// Cold-cache route closure, not entry-file size and not a network waterfall.
// Include bootstrap, page/layout/error nodes, static AND dynamic dependencies,
// and CSS, deduplicated by emitted path. Only the generated app router's node
// dispatch edges are restricted to the current route; navigation to other
// routes is covered by their own budgets and the existing aggregate gate.
// Legacy public/ islands, fonts, inline scripts/styles and endpoint responses
// remain outside this immutable-JS/CSS metric and under existing served gates.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { KIT_CLIENT_DIR } from "./bundle-inventory.mjs";
import { approvedRouteBudget } from "./client-ratchet-approval.mjs";
import {
  ROUTE_BUDGET,
  ROUTE_SCOPE,
  targetBytes,
  validateRouteBudget,
} from "./kit-route-budget.mjs";
export { ROUTE_BUDGET, ROUTE_SCOPE, targetBytes, validateRouteBudget };
export const OUTPUT = "web/.svelte-kit/output";
const NODE_KEY = /^\.svelte-kit\/generated\/build\/client-optimized\/nodes\/(\d+)\.js$/;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const sorted = (values) => [...values].sort();
const same = (a, b) => assert.deepEqual(sorted(a), sorted(b), "inventory mismatch");

function keys(value, expected) {
  assert.ok(object(value), "expected object");
  same(Object.keys(value), expected);
}

function read(root, path) {
  // Reject symlinks in any path component, including the evidence itself.
  let current = root;
  for (const part of path.split("/")) {
    assert.ok(part && part !== "." && part !== ".." && !part.includes("\\"), "unsafe path");
    current = join(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), "symlink evidence");
  }
  assert.ok(lstatSync(current).isFile(), "not a file");
  assert.ok(lstatSync(current).size <= 32 * 1024 * 1024, "oversized evidence");
  return readFileSync(current);
}

function walk(root, path) {
  const stat = lstatSync(join(root, path));
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "invalid inventory directory");
  const result = [];
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), "symlink inventory");
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) result.push(...walk(root, child));
    else {
      assert.ok(entry.isFile(), "unsupported inventory entry");
      result.push(child);
    }
  }
  return result.sort();
}

function assetPath(path) {
  assert.ok(
    typeof path === "string" && /^_app\/immutable\/[A-Za-z0-9_./-]+\.(js|css)$/.test(path),
    "invalid asset path",
  );
  assert.ok(!path.split("/").some((p) => !p || p === "." || p === ".."), "unsafe asset path");
  return path;
}

function list(value) {
  assert.ok(
    Array.isArray(value) && value.every((v) => typeof v === "string"),
    "invalid manifest list",
  );
  assert.equal(new Set(value).size, value.length, "duplicate manifest reference");
  return value;
}

export function measureRoutes(root = resolve(import.meta.dirname, "..")) {
  const parse = (path) => JSON.parse(read(root, path));
  const manifestBytes = read(root, `${OUTPUT}/client/.vite/manifest.json`);
  const manifest = JSON.parse(manifestBytes);
  const evidence = parse(`${OUTPUT}/client-route-evidence.json`);
  keys(evidence, [
    "version",
    "viteSha256",
    "serverSha256",
    "nodeCount",
    "unusedNodes",
    "bootstrap",
    "stylesheets",
    "routes",
  ]);
  assert.equal(evidence.version, 2);
  assert.equal(evidence.viteSha256, sha256(manifestBytes), "stale Vite evidence");
  assert.equal(
    evidence.serverSha256,
    sha256(read(root, `${OUTPUT}/server/manifest-full.js`)),
    "stale server evidence",
  );
  assert.ok(
    Number.isSafeInteger(evidence.nodeCount) &&
      evidence.nodeCount > 0 &&
      evidence.nodeCount <= Object.keys(manifest).length,
    "missing nodes",
  );
  assert.ok(object(manifest) && Object.keys(manifest).length > 0, "empty manifest");
  const byFile = new Map();
  const nodes = new Map();
  const assets = new Set();
  let appKey;
  const entries = [];
  for (const [key, chunk] of Object.entries(manifest)) {
    assert.ok(object(chunk), "invalid chunk");
    assetPath(chunk.file);
    assert.ok(!byFile.has(chunk.file), "duplicate emitted file");
    byFile.set(chunk.file, key);
    assets.add(chunk.file);
    for (const field of ["imports", "dynamicImports", "css", "assets"]) {
      if (chunk[field] !== undefined) list(chunk[field]);
    }
    for (const field of ["isEntry", "isDynamicEntry"]) {
      if (chunk[field] !== undefined) assert.equal(typeof chunk[field], "boolean");
    }
    for (const dep of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
      assert.ok(Object.hasOwn(manifest, dep), "missing dependency");
    }
    for (const css of chunk.css ?? []) {
      assert.ok(assetPath(css).endsWith(".css"), "not CSS");
      assets.add(css);
    }
    for (const asset of chunk.assets ?? []) {
      assert.equal(typeof asset, "string");
      if (/\.(js|css)$/.test(asset)) assets.add(assetPath(asset));
    }
    const node = key.match(NODE_KEY);
    if (node) nodes.set(Number(node[1]), key);
    if (chunk.name === "entry/app") {
      assert.equal(appKey, undefined, "duplicate app entry");
      appKey = key;
    }
    if (chunk.isEntry && !node) entries.push(chunk.file);
  }
  assert.ok(appKey, "missing app router entry");
  same(
    [...nodes.keys()],
    Array.from({ length: evidence.nodeCount }, (_, i) => i),
  );
  // App router fan-out is the sole dynamic-edge exclusion. Every generated
  // node must be dispatched, and all other dynamic edges remain included.
  const dispatch = manifest[appKey].dynamicImports ?? [];
  for (const key of nodes.values()) assert.ok(dispatch.includes(key), "missing router dispatch");
  const bootstrap = list(evidence.bootstrap);
  assert.ok(bootstrap.length > 0, "empty bootstrap");
  for (const file of entries) assert.ok(bootstrap.includes(file), "unaccounted entry");
  for (const file of bootstrap) assert.ok(byFile.has(file), "missing bootstrap file");
  for (const css of list(evidence.stylesheets)) assets.add(assetPath(css));
  // Aggregate lowering must use the shipping gate's complete _app inventory,
  // including non-immutable runtime files. Route closure remains graph-backed
  // and immutable-only; do not silently label runtime files as route costs.
  const aggregateAssets = walk(root, KIT_CLIENT_DIR)
    .filter((p) => /\.(js|css)$/.test(p))
    .map((p) => relative(join(root, OUTPUT, "client"), join(root, p)).replaceAll("\\", "/"));
  same(
    aggregateAssets.filter((p) => p.startsWith("_app/immutable/")),
    [...assets],
  );

  assert.ok(Array.isArray(evidence.routes) && evidence.routes.length > 0, "empty route evidence");
  const sourceRoutes = new Map();
  for (const file of walk(root, "web/src/routes")) {
    if (
      !/\/(?:\+page(?:@[^/.]*)?\.(?:svelte|svx|(?:server\.)?(?:js|ts))|\+server\.(?:js|ts))$/.test(
        file,
      )
    )
      continue;
    const id =
      `/${relative("web/src/routes", file).replace(/\/?[^/]+$/, "")}`.replace(/\/$/, "") || "/";
    if (file.includes("/+page")) sourceRoutes.set(id, true);
    else if (!sourceRoutes.has(id)) sourceRoutes.set(id, false);
  }
  same(
    evidence.routes.map((r) => r.id),
    [...sourceRoutes.keys()],
  );
  assert.equal(
    new Set(evidence.routes.map((r) => r.id)).size,
    evidence.routes.length,
    "duplicate route",
  );
  const fileMetrics = new Map(
    aggregateAssets.map((file) => {
      const bytes = read(root, `${OUTPUT}/client/${file}`);
      return [file, { rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length }];
    }),
  );
  const used = new Set();
  const summarize = (files, kind) => {
    const selected = sorted(files).filter((p) => p.endsWith(`.${kind}`));
    return {
      rawBytes: selected.reduce((sum, file) => sum + fileMetrics.get(file).rawBytes, 0),
      gzipBytes: selected.reduce((sum, file) => sum + fileMetrics.get(file).gzipBytes, 0),
      files: selected.length,
      assets: selected,
    };
  };
  assert.ok(Array.isArray(evidence.unusedNodes), "missing unused node inventory");
  const referencedNodes = new Set([0, 1]); // Kit retains root layout/error for 404s.
  const unusedNodes = new Set(evidence.unusedNodes);
  assert.equal(unusedNodes.size, evidence.unusedNodes.length, "duplicate unused node");
  for (const index of unusedNodes)
    assert.ok(Number.isSafeInteger(index) && nodes.has(index), "invalid unused node");
  const routes = {};
  for (const route of [...evidence.routes].sort((a, b) => a.id.localeCompare(b.id, "en"))) {
    keys(route, ["id", "page"]);
    const files = new Set();
    if (route.page === null) {
      assert.equal(sourceRoutes.get(route.id), false, "page missing from evidence");
    } else {
      assert.equal(sourceRoutes.get(route.id), true, "unexpected page evidence");
      keys(route.page, ["layouts", "errors", "leaf"]);
      const indexes = [route.page.leaf];
      for (const field of ["layouts", "errors"]) {
        assert.ok(Array.isArray(route.page[field]), "invalid page nodes");
        indexes.push(...route.page[field].filter((n) => n !== null));
      }
      const seen = new Set();
      const visit = (key) => {
        if (seen.has(key)) return;
        seen.add(key);
        const chunk = manifest[key];
        assert.ok(chunk, "missing chunk");
        files.add(chunk.file);
        for (const css of chunk.css ?? []) files.add(css);
        for (const asset of chunk.assets ?? []) if (/\.(js|css)$/.test(asset)) files.add(asset);
        for (const dep of chunk.imports ?? []) visit(dep);
        for (const dep of chunk.dynamicImports ?? []) {
          if (key !== appKey || !NODE_KEY.test(dep)) visit(dep);
        }
      };
      for (const index of indexes) {
        assert.ok(Number.isSafeInteger(index) && nodes.has(index), "invalid route node index");
        assert.ok(!unusedNodes.has(index), "route node marked unused");
        referencedNodes.add(index);
        visit(nodes.get(index));
      }
      // Conservatively charge every unused emitted node and its full closure to
      // every page. Nothing is excluded from aggregate totals or orphan checks.
      for (const index of unusedNodes) visit(nodes.get(index));
      for (const file of bootstrap) visit(byFile.get(file));
      for (const css of evidence.stylesheets) files.add(css);
    }
    for (const file of files) used.add(file);
    routes[route.id] = { js: summarize(files, "js"), css: summarize(files, "css") };
  }
  same(
    [...unusedNodes],
    [...nodes.keys()].filter((index) => !referencedNodes.has(index)),
  );
  same([...used], [...assets]); // orphan graph chunks cannot silently pass
  return {
    version: 1,
    scope: ROUTE_SCOPE,
    routes,
    aggregate: { js: summarize(aggregateAssets, "js"), css: summarize(aggregateAssets, "css") },
  };
}

export function checkRoutes(root = resolve(import.meta.dirname, "..")) {
  try {
    const budget = validateRouteBudget(JSON.parse(read(root, ROUTE_BUDGET)));
    assert.deepEqual(
      budget,
      approvedRouteBudget(root),
      "live budget differs from approved route plan",
    );
    const measurement = measureRoutes(root);
    same(Object.keys(measurement.routes), Object.keys(budget.routes));
    const breaches = [];
    const headroomShortfalls = [];
    for (const [id, route] of Object.entries(measurement.routes)) {
      for (const kind of ["js", "css"]) {
        const value = route[kind];
        const ceiling = budget.routes[id][kind];
        if (
          value.rawBytes > ceiling.maxRawBytes ||
          value.gzipBytes > ceiling.maxGzipBytes ||
          value.files > ceiling.maxFiles
        )
          breaches.push(`${id} ${kind}`);
        if (
          targetBytes(value.rawBytes, 512) > ceiling.maxRawBytes ||
          targetBytes(value.gzipBytes, 256) > ceiling.maxGzipBytes
        )
          headroomShortfalls.push(`${id} ${kind}`);
      }
    }
    return { ...measurement, exitCode: breaches.length ? 1 : 0, breaches, headroomShortfalls };
  } catch (error) {
    return {
      version: 1,
      scope: ROUTE_SCOPE,
      exitCode: 2,
      error: String(error.message).slice(0, 1000),
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(
    process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === "--root"),
    "usage: node ci/check-kit-route-perf.mjs [--root DIR]",
  );
  const result = checkRoutes(process.argv[3]);
  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode;
}
