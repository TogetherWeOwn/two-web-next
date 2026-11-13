#!/usr/bin/env node
// Bounded CSS-only collector for .github/workflows/kit-css-diagnostic.yml.
// Reads the built Kit client CSS from an isolated source export, retains only
// those files plus a manifest, and fails closed on anything incomplete,
// oversized, linked or unexpected. Diagnostic only: it never judges budgets.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

export const CLIENT_DIR = "web/.svelte-kit/output/client/_app";
export const LIMITS = {
  files: 64,
  fileBytes: 1 << 20,
  totalBytes: 4 << 20,
  entries: 20000,
  depth: 12,
};
const SHA = /^[0-9a-f]{40}$/;
const NUMBER = /^[1-9][0-9]{0,18}$/;
const SAFE_PATH = /^[A-Za-z0-9._~@+-]+(?:\/[A-Za-z0-9._~@+-]+)*$/;
const OPTIONS = [
  "root",
  "out",
  "leg",
  "source-sha",
  "workflow-sha",
  "run-id",
  "run-attempt",
  "repository",
];

const fail = (message) => {
  throw new Error(message);
};
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);

function walk(dir, limits) {
  const found = [];
  let seen = 0;
  const visit = (current, depth) => {
    if (depth > limits.depth) fail(`CSS tree deeper than ${limits.depth}: ${current}`);
    for (const name of readdirSync(current)) {
      seen += 1;
      if (seen > limits.entries) fail(`more than ${limits.entries} directory entries`);
      const full = join(current, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) fail(`symbolic link refused: ${relative(dir, full)}`);
      if (stat.isDirectory()) visit(full, depth + 1);
      else if (!stat.isFile()) fail(`special filesystem entry refused: ${relative(dir, full)}`);
      else if (name.endsWith(".css")) found.push({ full, size: stat.size });
    }
  };
  visit(dir, 0);
  return found;
}

export function collect(opts, limits = LIMITS) {
  const { leg, sourceSha, workflowSha, runId, runAttempt, repository } = opts;
  if (leg !== "base" && leg !== "head") fail("leg must be base or head");
  for (const sha of [sourceSha, workflowSha])
    if (!SHA.test(sha ?? "")) fail("SHA must be 40 lowercase hex characters");
  for (const n of [runId, runAttempt])
    if (!NUMBER.test(n ?? "")) fail("run identity must be numeric");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) fail("repository must be owner/name");
  const root = resolve(opts.root ?? "");
  const out = resolve(opts.out ?? "");
  if (inside(root, out) || inside(out, root)) fail("export root and output must be disjoint");
  let clientDir = root;
  for (const part of ["", ...CLIENT_DIR.split("/")]) {
    clientDir = join(clientDir, part);
    if (!lstatSync(clientDir, { throwIfNoEntry: false })?.isDirectory())
      fail(`missing or linked client directory: ${clientDir}`);
  }
  const outStat = lstatSync(out, { throwIfNoEntry: false });
  if (outStat && (!outStat.isDirectory() || readdirSync(out).length > 0))
    fail("output must be a fresh directory");

  const found = walk(clientDir, limits);
  if (found.length === 0) fail("no client CSS found: build output is incomplete");
  if (found.length > limits.files) fail(`more than ${limits.files} CSS files`);
  const files = [];
  let rawTotal = 0;
  for (const { full, size } of found) {
    const path = relative(clientDir, full).split(sep).join("/");
    if (!SAFE_PATH.test(path)) fail(`unsafe CSS path: ${JSON.stringify(path)}`);
    if (size === 0) fail(`empty CSS file: ${path}`);
    if (size > limits.fileBytes) fail(`CSS file over ${limits.fileBytes} bytes: ${path}`);
    const bytes = readFileSync(full);
    if (bytes.length !== size) fail(`CSS file changed while reading: ${path}`);
    rawTotal += bytes.length;
    if (rawTotal > limits.totalBytes) fail(`CSS over ${limits.totalBytes} bytes in total`);
    files.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      rawBytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
      content: bytes,
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = {
    schema: "kit-css-diagnostic/1",
    leg,
    repository,
    sourceSha,
    workflow: { sha: workflowSha, runId, runAttempt },
    cssRoot: CLIENT_DIR,
    gzip: "node:zlib gzipSync, default options, per file",
    files: files.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      rawBytes: f.rawBytes,
      gzipBytes: f.gzipBytes,
    })),
    totals: {
      files: files.length,
      rawBytes: rawTotal,
      gzipBytes: files.reduce((sum, f) => sum + f.gzipBytes, 0),
    },
  };
  for (const f of files) {
    const target = join(out, "css", f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, { flag: "wx" });
  }
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(out, "manifest.json"), json, { flag: "wx" });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values: v } = parseArgs({
      options: Object.fromEntries(OPTIONS.map((k) => [k, { type: "string" }])),
      strict: true,
    });
    const m = collect({
      root: v.root,
      out: v.out,
      leg: v.leg,
      sourceSha: v["source-sha"],
      workflowSha: v["workflow-sha"],
      runId: v["run-id"],
      runAttempt: v["run-attempt"],
      repository: v.repository,
    });
    const t = m.totals;
    console.log(
      `${m.leg} ${m.sourceSha}: ${t.files} CSS files, ${t.rawBytes} raw, ${t.gzipBytes} gzip (summed per file)`,
    );
  } catch (error) {
    console.error(`::error::kit-css-collect: ${error.message}`);
    process.exit(1);
  }
}
