#!/usr/bin/env node
// Runs only in the credential-free build. The checker consumes JSON, never
// imports executable build artifacts. Kit's manifest supplies actual layout
// resets, error boundaries, endpoint-only routes and node indexes.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "web/.svelte-kit/output");
const serverPath = resolve(output, "server/manifest-full.js");
const { manifest } = await import(pathToFileURL(serverPath).href);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const evidence = {
  version: 1,
  viteSha256: sha256(readFileSync(resolve(output, "client/.vite/manifest.json"))),
  serverSha256: sha256(readFileSync(serverPath)),
  nodeCount: manifest.nodes.length,
  bootstrap: [
    ...new Set([manifest.client.start, manifest.client.app, ...manifest.client.imports]),
  ].sort(),
  stylesheets: manifest.client.stylesheets,
  routes: manifest.routes
    .map(({ id, page }) => ({ id, page }))
    .sort((a, b) => a.id.localeCompare(b.id, "en")),
};
writeFileSync(
  resolve(output, "client-route-evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
