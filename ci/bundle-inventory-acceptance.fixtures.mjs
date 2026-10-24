// Bundle-inventory acceptance fixtures (test-only).
//
// Synthetic-root helpers for the canonical artifact-inventory gates. No
// product behavior, no builds, no network. Every fixture starts from an
// otherwise-valid budget/artifact tree so a negative reaches the intended
// missing-inventory/substitution branch, not an unrelated parse failure.
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

export const KIT_SERVER_DIR = "web/.svelte-kit/output/server";
export const KIT_CLIENT_DIR = "web/.svelte-kit/output/client/_app";
export const KIT_WORKER_PATH = "web/.svelte-kit/cloudflare/_worker.js";
export const HONO_WORKER_PATH = "dist/worker.js";

// Canonical inventory the gates must enforce (behavioral contract).
export const KIT_GROUP_IDS = ["kit.worker", "kit.server.js", "kit.client.js", "kit.client.css"];
export const KIT_CHECK_IDS = [
  "kit.worker._worker.js",
  "kit.server.js",
  "kit.client.js",
  "kit.client.css",
];
export const WORKER_GROUP_IDS = ["worker.bundle"];
export const WORKER_CHECK_IDS = ["worker.bundle.dist/worker.js"];
export const ERROR_CODES = [
  "INVALID_PLAN",
  "MISSING_EVIDENCE",
  "INCOMPLETE_ENUMERATION",
  "INVALID_FLAGS",
];

export const WORKER_BODY = Buffer.from(`/* worker */\n${"x".repeat(1000)}`);
export const SERVER_BODY = Buffer.from(`/* server chunk */\n${"w".repeat(800)}`);
export const JS_BODY = Buffer.from(`console.log(1);\n${"y".repeat(500)}`);
export const CSS_BODY = Buffer.from(`.a{color:red}\n${"z".repeat(200)}`);
export const SMALL_BODY = Buffer.from("tiny\n");
export const HONO_BODY = Buffer.from(`${"h".repeat(2048)}\n`);

export function scratchRoot(prefix) {
  return mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), prefix));
}

export function writeFile(root, relative, body) {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function groupBudget(files) {
  if (files.length === 0) return { maxRawBytes: 4096, maxGzipBytes: 4096, maxFiles: 4 };
  return {
    maxRawBytes: files.reduce((sum, f) => sum + f.body.length, 0),
    maxGzipBytes: files.reduce((sum, f) => sum + gzipSync(f.body).length, 0),
    maxFiles: files.length,
  };
}

function ceilingFor(body) {
  return { maxRawBytes: body.length, maxGzipBytes: gzipSync(body).length };
}

// Complete valid Kit tree; callers mutate one thing to reach a negative.
export function makeKitFixture({
  server = [{ name: "chunks/server.js", body: SERVER_BODY }],
  clientJs = [{ name: "immutable/client.js", body: JS_BODY }],
  clientCss = [{ name: "immutable/client.css", body: CSS_BODY }],
  workerBody = WORKER_BODY,
  omitWorkerFile = false,
  extraFiles = [],
  budgetMutate = null,
  omitServerDir = false,
  omitClientDir = false,
} = {}) {
  const root = scratchRoot("bundle-inv-kit-");
  if (!omitWorkerFile) writeFile(root, KIT_WORKER_PATH, workerBody);
  if (!omitServerDir) {
    mkdirSync(join(root, KIT_SERVER_DIR), { recursive: true });
    for (const f of server) writeFile(root, join(KIT_SERVER_DIR, f.name), f.body);
  }
  if (!omitClientDir) {
    mkdirSync(join(root, KIT_CLIENT_DIR), { recursive: true });
    for (const f of clientJs) writeFile(root, join(KIT_CLIENT_DIR, f.name), f.body);
    for (const f of clientCss) writeFile(root, join(KIT_CLIENT_DIR, f.name), f.body);
  }
  for (const f of extraFiles) writeFile(root, f.path, f.body);
  const budget = {
    $comment: "synthetic acceptance budget; metadata must stay valid",
    worker: { "_worker.js": ceilingFor(workerBody) },
    server: { js: groupBudget(server) },
    client: { js: groupBudget(clientJs), css: groupBudget(clientCss) },
    startup: { maxMs: 30_000 },
  };
  if (budgetMutate) budgetMutate(budget);
  writeFile(root, "ci/kit-perf-budgets/base.json", JSON.stringify(budget));
  return { root, budget };
}

export function makeWorkerFixture({
  body = HONO_BODY,
  omitBundle = false,
  extraFiles = [],
  budgetMutate = null,
} = {}) {
  const root = scratchRoot("bundle-inv-hono-");
  if (!omitBundle) writeFile(root, HONO_WORKER_PATH, body);
  for (const f of extraFiles) writeFile(root, f.path, f.body);
  const budget = {
    $comment: "synthetic acceptance budget; metadata must stay valid",
    budgets: { [HONO_WORKER_PATH]: ceilingFor(body) },
  };
  if (budgetMutate) budgetMutate(budget);
  writeFile(root, "ci/worker-bundle-budget.json", JSON.stringify(budget));
  return { root, budget };
}

export function runCaptured(runFn, root) {
  const logs = [];
  const errors = [];
  const code = runFn(root, {
    log: (text) => logs.push(String(text)),
    error: (text) => errors.push(String(text)),
  });
  return { code, logs, errors };
}

export function snapshotFs(root) {
  const entries = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        let bytes = null;
        try {
          bytes = readFileSync(full);
        } catch {
          bytes = null;
        }
        entries.push({ path: full, size: st.size, mtimeMs: st.mtimeMs, bytes });
      }
    }
  };
  walk(root);
  return entries;
}

export function sameSnapshot(before, after) {
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i += 1) {
    const a = before[i];
    const b = after[i];
    if (a.path !== b.path || a.size !== b.size) return false;
    if (a.bytes === null || b.bytes === null) {
      if ((a.bytes === null) !== (b.bytes === null)) return false;
    } else if (!a.bytes.equals(b.bytes)) {
      return false;
    }
  }
  return true;
}
