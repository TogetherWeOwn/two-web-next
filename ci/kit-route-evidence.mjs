#!/usr/bin/env node
// Runs only in the credential-free build. The checker consumes JSON, never
// imports executable build artifacts. Kit's manifest supplies actual layout
// resets, error boundaries, endpoint-only routes and node indexes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "web/.svelte-kit/output");
const serverPath = resolve(output, "server/manifest-full.js");
const { manifest } = await import(pathToFileURL(serverPath).href);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const serverBytes = readFileSync(serverPath);
const viteBytes = readFileSync(resolve(output, "client/.vite/manifest.json"));
// Kit generate_manifest compacts used nodes, but preserves original node filenames
// in its loader table. Read that pinned syntax, not the compacted route indexes.
// Importing node modules to read their `index` would also load cloudflare: modules.
const table = serverBytes.toString("utf8").match(/nodes: \[([\s\S]*?)\n\s*\],/);
assert.ok(table, "missing Kit node loader table");
const mapping = [...table[1].matchAll(/__memo\(\(\) => import\('\.\/nodes\/(\d+)\.js'\)\)/g)].map(
  (m) => Number(m[1]),
);
assert.equal(mapping.length, manifest.nodes.length, "unsupported Kit node loader syntax");
assert.equal(new Set(mapping).size, mapping.length, "duplicate server node mapping");
const clientNodes = Object.keys(JSON.parse(viteBytes)).flatMap((key) => {
  const match = key.match(/^\.svelte-kit\/generated\/build\/client-optimized\/nodes\/(\d+)\.js$/);
  return match ? [Number(match[1])] : [];
});
for (const index of mapping) assert.ok(clientNodes.includes(index), "missing client node mapping");
const remap = (index) => {
  if (index === undefined || index === null) return null;
  assert.ok(
    Number.isSafeInteger(index) && index >= 0 && index < mapping.length,
    "invalid compact node",
  );
  return mapping[index];
};
const evidence = {
  version: 2,
  viteSha256: sha256(viteBytes),
  serverSha256: sha256(serverBytes),
  nodeCount: clientNodes.length,
  unusedNodes: clientNodes.filter((index) => !mapping.includes(index)).sort((a, b) => a - b),
  bootstrap: [
    ...new Set([manifest.client.start, manifest.client.app, ...manifest.client.imports]),
  ].sort(),
  stylesheets: manifest.client.stylesheets,
  routes: manifest.routes
    .map(({ id, page }) => ({
      id,
      page: page
        ? {
            layouts: Array.from(page.layouts, remap),
            errors: Array.from(page.errors, remap),
            leaf: remap(page.leaf),
          }
        : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, "en")),
};
writeFileSync(
  resolve(output, "client-route-evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
