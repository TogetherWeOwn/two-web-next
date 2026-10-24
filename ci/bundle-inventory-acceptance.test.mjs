// Acceptance: bundle gates require the canonical artifact inventory.
//
// Behavioral contract (Builder implements; these tests pin it):
// - Canonical inventory, one repo authority, checked before reading artifacts:
//   Hono dry-run dist/worker.js; Kit _worker.js, server JS, client JS, client CSS.
//   Artifact identity is separate from configurable numeric ceilings.
// - Reject empty/missing/misspelled/substituted/unsupported sections or entries,
//   noncanonical/unsafe paths, and arbitrary repo-file substitution as cannot
//   enforce (exit 2). Supported metadata ($comment, startup) stays valid.
//   Unknown measurement sections never silently drop work. Invalid plans fail
//   before artifact measurement and never emit an overall fits message.
// - Preserve numeric ceilings, per-file gzip/count rules, sourcemap exclusion,
//   startup contract, missing/empty/incomplete-enumeration controls, and actual
//   breach results. Exits: 0 fit, 1 measured breach, 2 invalid plan or missing
//   evidence. Missing canonical Worker file is missing evidence (2), not breach.
// - Versioned `--format json` (two tokens) with stable group/check IDs, measured
//   counts/bytes when measured, fixed error.code, and concrete next_action.
//   Human output stays bounded and compatible. Measuring is local/read-only and
//   idempotent. `--dry-run`, if accepted, is the same read-only measurement.
//   Unknown/wrong flags fail (2) before any subprocess or file write. Never
//   install, rebuild, deploy, or invoke Wrangler to fill missing evidence.
// - CLI accepts `--root <dir>` (measurement root, default repo root) for hermetic
//   runs, plus `--format json` and the existing `--selftest`.
//
// Stable IDs pinned here (Builder must emit exactly these):
//   Kit groups: kit.worker, kit.server.js, kit.client.js, kit.client.css
//   Kit checks: kit.worker._worker.js, kit.server.js, kit.client.js, kit.client.css
//   Worker groups: worker.bundle
//   Worker checks: worker.bundle.dist/worker.js
// Fixed error.code set: INVALID_PLAN, MISSING_EVIDENCE, INCOMPLETE_ENUMERATION,
// INVALID_FLAGS. JSON error carries next_action (snake; nextAction accepted).
//
// Every fixture starts valid; each negative mutates one thing. No real builds,
// no network, no Wrangler. RED tests fail on the current gates for the named
// reason; CONTROL tests pass before and after.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { run as runKit } from "./check-kit-perf.mjs";
import { run as runWorker } from "./check-worker-bundle.mjs";
import {
  CSS_BODY,
  ERROR_CODES,
  HONO_BODY,
  HONO_WORKER_PATH,
  JS_BODY,
  KIT_CHECK_IDS,
  KIT_GROUP_IDS,
  SERVER_BODY,
  SMALL_BODY,
  WORKER_BODY,
  WORKER_CHECK_IDS,
  WORKER_GROUP_IDS,
  makeKitFixture,
  makeWorkerFixture,
  runCaptured,
  sameSnapshot,
  snapshotFs,
  writeFile,
} from "./bundle-inventory-acceptance.fixtures.mjs";

const kitScript = fileURLToPath(new URL("./check-kit-perf.mjs", import.meta.url));
const workerScript = fileURLToPath(new URL("./check-worker-bundle.mjs", import.meta.url));
const KIT_FITS = "every Kit asset fits";
const WORKER_FITS = "main Worker bundle fits";

function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Best effort; scratch is run-owned.
  }
}

function assertCannotEnforce(result, groupRe, label) {
  assert.equal(
    result.code,
    2,
    `${label}: expected cannot-enforce (2), got ${result.code}\nlogs: ${result.logs.join("\n")}\nerrors: ${result.errors.join("\n")}`,
  );
  assert.ok(
    result.errors.some((line) => groupRe.test(line)),
    `${label}: expected a diagnostic naming ${groupRe}, got: ${result.errors.join(" | ") || "(none)"}`,
  );
  assert.ok(
    !result.logs.some((line) => line.includes(KIT_FITS) || line.includes(WORKER_FITS)),
    `${label}: must never emit an overall fits message`,
  );
  assert.ok(
    result.errors.length <= 6,
    `${label}: diagnostics must stay bounded, got ${result.errors.length}`,
  );
  for (const line of [...result.logs, ...result.errors]) {
    assert.ok(line.length <= 500, `${label}: diagnostic line must stay bounded (${line.length})`);
  }
}

function assertNoOkLines(result, label) {
  assert.ok(
    !result.logs.some((line) => line.startsWith("ok ")),
    `${label}: invalid plan must fail before artifact measurement, got: ${result.logs.join(" | ")}`,
  );
}

function runCli(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function nextActionOf(error) {
  return error?.next_action ?? error?.nextAction;
}

function assertJsonReport({ parsed, stdout, stderr, status, check, groupIds, checkIds, label }) {
  assert.ok(
    stdout.length <= 20_480,
    `${label}: JSON output must stay bounded, got ${stdout.length} bytes`,
  );
  assert.equal(parsed.version, 1, `${label}: JSON must carry version 1`);
  assert.equal(parsed.check, check, `${label}: JSON check must be ${check}`);
  assert.equal(
    parsed.exitCode,
    status,
    `${label}: JSON exitCode must match process exit ${status}`,
  );
  assert.equal(parsed.ok, status === 0, `${label}: JSON ok must match exit ${status}`);
  assert.ok(Array.isArray(parsed.groups), `${label}: JSON must carry groups`);
  const groupIdSet = parsed.groups.map((g) => g.id).sort();
  assert.deepEqual(groupIdSet, [...groupIds].sort(), `${label}: groups must be the canonical set`);
  const seenChecks = [];
  for (const group of parsed.groups) {
    assert.ok(
      ["pass", "fail", "cannot-enforce"].includes(group.status),
      `${label}: group ${group.id} needs a stable status`,
    );
    assert.ok(
      Array.isArray(group.checks) && group.checks.length > 0,
      `${label}: group ${group.id} needs checks`,
    );
    for (const c of group.checks) {
      seenChecks.push(c.id);
      assert.ok(
        ["pass", "fail", "cannot-enforce"].includes(c.status),
        `${label}: check ${c.id} needs a stable status`,
      );
      if (c.status === "pass" || c.status === "fail") {
        assert.equal(
          typeof c.rawBytes,
          "number",
          `${label}: measured check ${c.id} must carry rawBytes`,
        );
        assert.equal(
          typeof c.gzipBytes,
          "number",
          `${label}: measured check ${c.id} must carry gzipBytes`,
        );
      }
    }
  }
  assert.deepEqual(
    seenChecks.sort(),
    [...checkIds].sort(),
    `${label}: checks must be the canonical set`,
  );
  const stderrLines = stderr.split("\n").filter((l) => l.trim().length > 0);
  assert.ok(stderrLines.length <= 20, `${label}: human output must stay bounded`);
  for (const line of stderrLines) {
    assert.ok(line.length <= 500, `${label}: human line must stay bounded`);
  }
  if (status === 2) {
    assert.ok(parsed.error, `${label}: exit 2 JSON must carry error`);
    assert.ok(
      ERROR_CODES.includes(parsed.error.code),
      `${label}: error.code must be fixed, got ${parsed.error.code}`,
    );
    assert.ok(
      typeof parsed.error.message === "string" && parsed.error.message.length > 0,
      `${label}: error.message must be concrete`,
    );
    assert.ok(parsed.error.message.length <= 500, `${label}: error.message must stay bounded`);
    const next = nextActionOf(parsed.error);
    assert.ok(
      typeof next === "string" && next.length > 0,
      `${label}: error must carry concrete next_action`,
    );
    assert.ok(next.length <= 500, `${label}: next_action must stay bounded`);
    assert.ok(
      /ci\/|npm run|wrangler|build|usage|flag|budget/i.test(next),
      `${label}: next_action must name a concrete file or command, got: ${next}`,
    );
    assert.ok(
      !stdout.includes(KIT_FITS) && !stdout.includes(WORKER_FITS),
      `${label}: invalid plan JSON must never claim fits`,
    );
  } else {
    assert.ok(!parsed.error, `${label}: exit ${status} JSON must not carry error`);
  }
}

function parseCliJson(result, label) {
  assert.ok(
    result.stdout.trim().length > 0,
    `${label}: expected JSON on stdout, got empty\nstderr: ${result.stderr}`,
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    assert.fail(
      `${label}: stdout must be pure JSON, got: ${result.stdout.slice(0, 500)}\nstderr: ${result.stderr.slice(0, 500)}`,
    );
  }
  return parsed;
}

// --- Kit inventory REDs (via run API) ---------------------------------------

test("RED kit: empty worker map cannot enforce (exit 2), never fits", (t) => {
  const fx = makeKitFixture({
    budgetMutate: (b) => {
      b.worker = {};
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assertCannotEnforce(result, /worker/i, "empty worker map");
  assertNoOkLines(result, "empty worker map");
});

test("RED kit: omitted server section cannot enforce (exit 2), never fits", (t) => {
  const fx = makeKitFixture({
    budgetMutate: (b) => {
      delete b.server;
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assertCannotEnforce(result, /server/i, "omitted server");
  assertNoOkLines(result, "omitted server");
});

test("RED kit: typo worker entry is invalid plan (2), not breach (1)", (t) => {
  const fx = makeKitFixture({
    omitWorkerFile: true,
    extraFiles: [{ path: "_worker_js", body: SMALL_BODY }],
    budgetMutate: (b) => {
      b.worker = { _worker_js: { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assertCannotEnforce(result, /worker|plan|inventory|canonical/i, "typo worker entry");
  assertNoOkLines(result, "typo worker entry");
});

test("RED kit: substituted small file cannot stand in for the Worker (2)", (t) => {
  const fx = makeKitFixture({
    omitWorkerFile: true,
    extraFiles: [{ path: "assets/small.js", body: SMALL_BODY }],
    budgetMutate: (b) => {
      b.worker = { "assets/small.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assertCannotEnforce(result, /worker|plan|inventory|canonical|substitut/i, "substituted worker");
  assertNoOkLines(result, "substituted worker");
});

test("RED kit: extra unknown measurement section cannot silently pass (2)", (t) => {
  const fx = makeKitFixture({
    budgetMutate: (b) => {
      b.extra = { js: { maxRawBytes: 10, maxGzipBytes: 10, maxFiles: 1 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assertCannotEnforce(result, /extra|unknown|plan|inventory/i, "extra section");
  assertNoOkLines(result, "extra section");
});

test("RED kit: absolute worker path is invalid plan (2)", (t) => {
  const fx = makeKitFixture({
    budgetMutate: (b) => {
      b.worker = { "/_worker.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assertCannotEnforce(result, /worker|plan|path|canonical/i, "absolute worker path");
  assertNoOkLines(result, "absolute worker path");
});

test("RED kit: dot-slash worker path is noncanonical (2)", (t) => {
  const fx = makeKitFixture({
    extraFiles: [{ path: "_worker.js", body: SMALL_BODY }],
    budgetMutate: (b) => {
      b.worker = { "./_worker.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assertCannotEnforce(result, /worker|plan|path|canonical/i, "dot-slash worker path");
  assertNoOkLines(result, "dot-slash worker path");
});

test("RED kit: arbitrary repo file cannot substitute for the Worker (2)", (t) => {
  const fx = makeKitFixture({
    omitWorkerFile: true,
    extraFiles: [{ path: "package.json", body: Buffer.from('{"name":"x"}\n') }],
    budgetMutate: (b) => {
      b.worker = { "package.json": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assertCannotEnforce(
    result,
    /worker|plan|inventory|canonical|substitut/i,
    "repo-file substitution",
  );
  assertNoOkLines(result, "repo-file substitution");
});

test("RED kit: missing canonical Worker file is missing evidence (2), not breach", (t) => {
  const fx = makeKitFixture({ omitWorkerFile: true });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assertCannotEnforce(result, /_worker\.js|worker/i, "missing worker file");
});

test("RED kit: invalid plan is checked before file reads (no ok lines)", (t) => {
  const fx = makeKitFixture({
    omitClientDir: true,
    budgetMutate: (b) => {
      b.worker = {};
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assertCannotEnforce(result, /worker|plan|inventory/i, "invalid plan before reads");
  assertNoOkLines(result, "invalid plan before reads");
});

// --- Worker inventory REDs (via run API) ------------------------------------

test("RED worker: budgets without dist/worker.js cannot enforce (2)", (t) => {
  const fx = makeWorkerFixture({
    omitBundle: true,
    extraFiles: [{ path: "dist/other.js", body: SMALL_BODY }],
    budgetMutate: (b) => {
      b.budgets = { "dist/other.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runWorker, fx.root);
  assertCannotEnforce(
    result,
    /dist\/worker\.js|worker|plan|inventory|canonical/i,
    "missing canonical",
  );
  assertNoOkLines(result, "missing canonical");
});

test("RED worker: substituted small file cannot stand in for dist/worker.js (2)", (t) => {
  const fx = makeWorkerFixture({
    omitBundle: true,
    extraFiles: [{ path: "dist/small.js", body: SMALL_BODY }],
    budgetMutate: (b) => {
      b.budgets = { "dist/small.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runWorker, fx.root);
  assertCannotEnforce(
    result,
    /dist\/worker\.js|plan|inventory|canonical|substitut/i,
    "substituted bundle",
  );
  assertNoOkLines(result, "substituted bundle");
});

test("RED worker: typo entry is invalid plan (2), not a measurement", (t) => {
  const fx = makeWorkerFixture({
    omitBundle: true,
    extraFiles: [{ path: "dist/worker.jsx", body: SMALL_BODY }],
    budgetMutate: (b) => {
      b.budgets = { "dist/worker.jsx": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runWorker, fx.root);
  assertCannotEnforce(result, /dist\/worker\.js|plan|inventory|canonical/i, "typo entry");
  assertNoOkLines(result, "typo entry");
});

test("RED worker: extra entry beyond the canonical bundle is unsupported (2)", (t) => {
  const fx = makeWorkerFixture({
    extraFiles: [{ path: "dist/extra.js", body: SMALL_BODY }],
    budgetMutate: (b) => {
      b.budgets["dist/extra.js"] = { maxRawBytes: 4096, maxGzipBytes: 4096 };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runWorker, fx.root);
  assertCannotEnforce(result, /extra|unknown|plan|inventory/i, "extra entry");
  assertNoOkLines(result, "extra entry");
});

test("RED worker: absolute bundle path is invalid plan (2)", (t) => {
  const fx = makeWorkerFixture({
    budgetMutate: (b) => {
      b.budgets = { "/dist/worker.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runWorker, fx.root);
  assertCannotEnforce(result, /plan|path|canonical/i, "absolute path");
  assertNoOkLines(result, "absolute path");
});

test("RED worker: double-slash bundle path is noncanonical (2)", (t) => {
  const fx = makeWorkerFixture({
    budgetMutate: (b) => {
      b.budgets = {
        "dist//worker.js": {
          maxRawBytes: HONO_BODY.length,
          maxGzipBytes: gzipSync(HONO_BODY).length,
        },
      };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runWorker, fx.root);
  assertCannotEnforce(result, /plan|path|canonical/i, "double-slash path");
  assertNoOkLines(result, "double-slash path");
});

test("RED worker: dot-slash bundle path is noncanonical (2)", (t) => {
  const fx = makeWorkerFixture({
    budgetMutate: (b) => {
      b.budgets = {
        "dist/./worker.js": {
          maxRawBytes: HONO_BODY.length,
          maxGzipBytes: gzipSync(HONO_BODY).length,
        },
      };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runWorker, fx.root);
  assertCannotEnforce(result, /plan|path|canonical/i, "dot-slash path");
  assertNoOkLines(result, "dot-slash path");
});

test("RED worker: arbitrary repo file cannot substitute for dist/worker.js (2)", (t) => {
  const fx = makeWorkerFixture({
    omitBundle: true,
    extraFiles: [{ path: "package.json", body: Buffer.from('{"name":"x"}\n') }],
    budgetMutate: (b) => {
      b.budgets = { "package.json": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runWorker, fx.root);
  assertCannotEnforce(
    result,
    /dist\/worker\.js|plan|inventory|canonical|substitut/i,
    "repo-file substitution",
  );
  assertNoOkLines(result, "repo-file substitution");
});

test("RED worker: invalid plan is checked before file reads (no ok lines)", (t) => {
  const fx = makeWorkerFixture({
    omitBundle: true,
    budgetMutate: (b) => {
      b.budgets = { "dist/other.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runWorker, fx.root);
  assertCannotEnforce(
    result,
    /dist\/worker\.js|plan|inventory|canonical/i,
    "invalid plan before reads",
  );
  assertNoOkLines(result, "invalid plan before reads");
});

// --- Versioned JSON contract (via CLI --root --format json) ------------------

test("RED kit: --format json emits versioned report with stable IDs (exit 0)", (t) => {
  const fx = makeKitFixture();
  t.after(() => cleanup(fx.root));
  const result = runCli(kitScript, ["--root", fx.root, "--format", "json"]);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
  const parsed = parseCliJson(result, "kit json fit");
  assertJsonReport({
    parsed,
    stdout: result.stdout,
    stderr: result.stderr,
    status: 0,
    check: "kit-perf",
    groupIds: KIT_GROUP_IDS,
    checkIds: KIT_CHECK_IDS,
    label: "kit json fit",
  });
});

test("RED kit: --format json on invalid plan carries INVALID_PLAN + next_action (2)", (t) => {
  const fx = makeKitFixture({
    budgetMutate: (b) => {
      b.worker = {};
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCli(kitScript, ["--root", fx.root, "--format", "json"]);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\nstderr: ${result.stderr}`);
  const parsed = parseCliJson(result, "kit json invalid plan");
  assert.equal(parsed.error?.code, "INVALID_PLAN", "invalid plan must use INVALID_PLAN");
  assertJsonReport({
    parsed,
    stdout: result.stdout,
    stderr: result.stderr,
    status: 2,
    check: "kit-perf",
    groupIds: KIT_GROUP_IDS,
    checkIds: KIT_CHECK_IDS,
    label: "kit json invalid plan",
  });
});

test("RED kit: --format json on breach reports failing check with bytes (1)", (t) => {
  const fx = makeKitFixture({
    budgetMutate: (b) => {
      b.client.js.maxRawBytes = JS_BODY.length - 1;
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCli(kitScript, ["--root", fx.root, "--format", "json"]);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstderr: ${result.stderr}`);
  const parsed = parseCliJson(result, "kit json breach");
  assertJsonReport({
    parsed,
    stdout: result.stdout,
    stderr: result.stderr,
    status: 1,
    check: "kit-perf",
    groupIds: KIT_GROUP_IDS,
    checkIds: KIT_CHECK_IDS,
    label: "kit json breach",
  });
  const failing = parsed.groups.flatMap((g) => g.checks).filter((c) => c.status === "fail");
  assert.ok(failing.length >= 1, "breach JSON must mark at least one check fail");
});

test("RED worker: --format json emits versioned report with stable IDs (exit 0)", (t) => {
  const fx = makeWorkerFixture();
  t.after(() => cleanup(fx.root));
  const result = runCli(workerScript, ["--root", fx.root, "--format", "json"]);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
  const parsed = parseCliJson(result, "worker json fit");
  assertJsonReport({
    parsed,
    stdout: result.stdout,
    stderr: result.stderr,
    status: 0,
    check: "worker-bundle",
    groupIds: WORKER_GROUP_IDS,
    checkIds: WORKER_CHECK_IDS,
    label: "worker json fit",
  });
});

test("RED worker: --format json on invalid plan carries INVALID_PLAN + next_action (2)", (t) => {
  const fx = makeWorkerFixture({
    omitBundle: true,
    extraFiles: [{ path: "dist/other.js", body: SMALL_BODY }],
    budgetMutate: (b) => {
      b.budgets = { "dist/other.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCli(workerScript, ["--root", fx.root, "--format", "json"]);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\nstderr: ${result.stderr}`);
  const parsed = parseCliJson(result, "worker json invalid plan");
  assert.equal(parsed.error?.code, "INVALID_PLAN", "invalid plan must use INVALID_PLAN");
  assertJsonReport({
    parsed,
    stdout: result.stdout,
    stderr: result.stderr,
    status: 2,
    check: "worker-bundle",
    groupIds: WORKER_GROUP_IDS,
    checkIds: WORKER_CHECK_IDS,
    label: "worker json invalid plan",
  });
});

test("RED worker: --format json on breach reports failing check with bytes (1)", (t) => {
  const fx = makeWorkerFixture({
    budgetMutate: (b) => {
      b.budgets[HONO_WORKER_PATH].maxRawBytes = HONO_BODY.length - 1;
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCli(workerScript, ["--root", fx.root, "--format", "json"]);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstderr: ${result.stderr}`);
  const parsed = parseCliJson(result, "worker json breach");
  assertJsonReport({
    parsed,
    stdout: result.stdout,
    stderr: result.stderr,
    status: 1,
    check: "worker-bundle",
    groupIds: WORKER_GROUP_IDS,
    checkIds: WORKER_CHECK_IDS,
    label: "worker json breach",
  });
  const failing = parsed.groups.flatMap((g) => g.checks).filter((c) => c.status === "fail");
  assert.equal(failing.length, 1, "breach JSON must mark exactly the canonical check fail");
  assert.equal(failing[0].id, "worker.bundle.dist/worker.js");
});

test("RED json: repeated --format json runs are byte-identical (idempotent)", (t) => {
  const fx = makeKitFixture();
  t.after(() => cleanup(fx.root));
  const first = runCli(kitScript, ["--root", fx.root, "--format", "json"]);
  const second = runCli(kitScript, ["--root", fx.root, "--format", "json"]);
  assert.equal(first.status, 0, `first run must exit 0, got ${first.status}\n${first.stderr}`);
  assert.equal(second.status, 0, `second run must exit 0, got ${second.status}\n${second.stderr}`);
  assert.equal(second.stdout, first.stdout, "JSON measurement must be idempotent");
});

// --- Flags: unknown/wrong fail before writes ---------------------------------

test("CONTROL kit: unknown flag fails (2) before any file write", (t) => {
  const fx = makeKitFixture();
  t.after(() => cleanup(fx.root));
  const before = snapshotFs(fx.root);
  const result = runCli(kitScript, ["--root", fx.root, "--nope-not-a-flag"]);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\n${result.stderr}`);
  assert.ok(
    /usage|unknown|invalid|flag/i.test(result.stderr),
    `unknown flag must name the flag problem, got: ${result.stderr.slice(0, 300)}`,
  );
  assert.ok(sameSnapshot(before, snapshotFs(fx.root)), "unknown flag must not write files");
});

test("CONTROL worker: unknown flag fails (2) before any file write", (t) => {
  const fx = makeWorkerFixture();
  t.after(() => cleanup(fx.root));
  const before = snapshotFs(fx.root);
  const result = runCli(workerScript, ["--root", fx.root, "--nope-not-a-flag"]);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\n${result.stderr}`);
  assert.ok(
    /usage|unknown|invalid|flag/i.test(result.stderr),
    `unknown flag must name the flag problem, got: ${result.stderr.slice(0, 300)}`,
  );
  assert.ok(sameSnapshot(before, snapshotFs(fx.root)), "unknown flag must not write files");
});

test("CONTROL both gates reject a wrong --format value (2) without writes", (t) => {
  const kitFx = makeKitFixture();
  t.after(() => cleanup(kitFx.root));
  const workerFx = makeWorkerFixture();
  t.after(() => cleanup(workerFx.root));
  const kitBefore = snapshotFs(kitFx.root);
  const workerBefore = snapshotFs(workerFx.root);
  const kitResult = runCli(kitScript, ["--root", kitFx.root, "--format", "xml"]);
  const workerResult = runCli(workerScript, ["--root", workerFx.root, "--format", "xml"]);
  for (const [name, result] of [
    ["kit", kitResult],
    ["worker", workerResult],
  ]) {
    assert.equal(result.status, 2, `${name}: wrong format must exit 2, got ${result.status}`);
    assert.ok(
      /usage|unknown|invalid|format/i.test(result.stderr),
      `${name}: wrong format must name the problem, got: ${result.stderr.slice(0, 300)}`,
    );
  }
  assert.ok(sameSnapshot(kitBefore, snapshotFs(kitFx.root)), "kit wrong format must not write");
  assert.ok(
    sameSnapshot(workerBefore, snapshotFs(workerFx.root)),
    "worker wrong format must not write",
  );
});

test("CONTROL --dry-run is either rejected or the same read-only measurement", (t) => {
  const kitFx = makeKitFixture();
  t.after(() => cleanup(kitFx.root));
  const before = snapshotFs(kitFx.root);
  const dry = runCli(kitScript, ["--root", kitFx.root, "--dry-run"]);
  if (dry.status === 2 && /usage|unknown|invalid|flag|dry/i.test(dry.stderr)) {
    assert.ok(sameSnapshot(before, snapshotFs(kitFx.root)), "rejected --dry-run must not write");
    return;
  }
  const plain = runCli(kitScript, ["--root", kitFx.root]);
  assert.equal(
    dry.status,
    plain.status,
    `--dry-run must match plain measurement exit (dry ${dry.status} vs plain ${plain.status})\nstderr: ${dry.stderr}`,
  );
  assert.equal(dry.stdout, plain.stdout, "--dry-run must emit the same measurement");
  assert.ok(sameSnapshot(before, snapshotFs(kitFx.root)), "accepted --dry-run must not write");
});

// --- Read-only / idempotent measurement --------------------------------------

test("CONTROL kit: measuring is read-only and idempotent", (t) => {
  const fx = makeKitFixture();
  t.after(() => cleanup(fx.root));
  const before = snapshotFs(fx.root);
  const first = runCaptured(runKit, fx.root);
  const second = runCaptured(runKit, fx.root);
  assert.equal(first.code, 0, `valid tree must fit, got ${first.code}\n${first.errors.join("\n")}`);
  assert.deepEqual(second, first, "repeated measurement must be identical");
  assert.ok(sameSnapshot(before, snapshotFs(fx.root)), "measuring must not write files");
});

test("CONTROL worker: measuring is read-only and idempotent", (t) => {
  const fx = makeWorkerFixture();
  t.after(() => cleanup(fx.root));
  const before = snapshotFs(fx.root);
  const first = runCaptured(runWorker, fx.root);
  const second = runCaptured(runWorker, fx.root);
  assert.equal(first.code, 0, `valid tree must fit, got ${first.code}\n${first.errors.join("\n")}`);
  assert.deepEqual(second, first, "repeated measurement must be identical");
  assert.ok(sameSnapshot(before, snapshotFs(fx.root)), "measuring must not write files");
});

// --- CONTROLs: preserved behavior --------------------------------------------

test("CONTROL kit: nested assets counted, sourcemaps excluded (exit 0)", (t) => {
  const bigMap = Buffer.from("m".repeat(100_000));
  const fx = makeKitFixture({
    server: [
      { name: "chunks/server.js", body: SERVER_BODY },
      { name: "chunks/deep/nested.js", body: SERVER_BODY },
    ],
    clientJs: [
      { name: "immutable/client.js", body: JS_BODY },
      { name: "immutable/nodes/page.js", body: JS_BODY },
    ],
    clientCss: [
      { name: "immutable/client.css", body: CSS_BODY },
      { name: "immutable/assets/page.css", body: CSS_BODY },
    ],
    extraFiles: [
      { path: "web/.svelte-kit/output/server/chunks/server.js.map", body: bigMap },
      { path: "web/.svelte-kit/output/client/_app/immutable/client.js.map", body: bigMap },
    ],
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assert.equal(
    result.code,
    0,
    `expected fits (0), got ${result.code}\n${result.errors.join("\n")}`,
  );
  assert.ok(result.logs.some((l) => l.includes("ok server js: 2/2 files")));
  assert.ok(result.logs.some((l) => l.includes("ok client js: 2/2 files")));
  assert.ok(result.logs.some((l) => l.includes("ok client css: 2/2 files")));
});

test("CONTROL kit: exact fit passes (0), one-byte breach fails (1)", (t) => {
  const fx = makeKitFixture();
  t.after(() => cleanup(fx.root));
  const fit = runCaptured(runKit, fx.root);
  assert.equal(fit.code, 0, `exact fit must exit 0, got ${fit.code}\n${fit.errors.join("\n")}`);
  writeFile(
    fx.root,
    "web/.svelte-kit/output/client/_app/immutable/client.js",
    Buffer.concat([JS_BODY, Buffer.from("x")]),
  );
  const breach = runCaptured(runKit, fx.root);
  assert.equal(breach.code, 1, `one-byte breach must exit 1, got ${breach.code}`);
  assert.ok(breach.errors.some((l) => /client js/i.test(l)));
});

test("CONTROL kit: malformed ceilings stay invalid plan (2)", (t) => {
  for (const mutate of [
    (b) => {
      b.worker["_worker.js"].maxRawBytes = -1;
    },
    (b) => {
      delete b.worker["_worker.js"].maxGzipBytes;
    },
    (b) => {
      b.client.js.maxFiles = 0;
    },
    (b) => {
      b.startup.maxMs = 0;
    },
  ]) {
    const fx = makeKitFixture({ budgetMutate: mutate });
    t.after(() => cleanup(fx.root));
    const result = runCaptured(runKit, fx.root);
    assert.equal(result.code, 2, `malformed ceilings must exit 2, got ${result.code}`);
  }
});

test("CONTROL kit: supported metadata stays valid (exit 0)", (t) => {
  const fx = makeKitFixture({
    budgetMutate: (b) => {
      b.$comment = "extra metadata stays valid";
      b.$schema = "https://example.invalid/schema.json";
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runKit, fx.root);
  assert.equal(
    result.code,
    0,
    `metadata must stay valid, got ${result.code}\n${result.errors.join("\n")}`,
  );
});

test("CONTROL kit: missing/empty output still cannot enforce (2)", (t) => {
  const missing = makeKitFixture({ omitClientDir: true });
  t.after(() => cleanup(missing.root));
  assert.equal(runCaptured(runKit, missing.root).code, 2, "missing client dir must exit 2");
  const empty = makeKitFixture({ clientJs: [] });
  t.after(() => cleanup(empty.root));
  assert.equal(runCaptured(runKit, empty.root).code, 2, "empty client js must exit 2");
});

test("CONTROL worker: exact fit passes (0), one-byte breach fails (1)", (t) => {
  const fx = makeWorkerFixture();
  t.after(() => cleanup(fx.root));
  const fit = runCaptured(runWorker, fx.root);
  assert.equal(fit.code, 0, `exact fit must exit 0, got ${fit.code}\n${fit.errors.join("\n")}`);
  writeFile(fx.root, HONO_WORKER_PATH, Buffer.concat([HONO_BODY, Buffer.from("x")]));
  const breach = runCaptured(runWorker, fx.root);
  assert.equal(breach.code, 1, `one-byte breach must exit 1, got ${breach.code}`);
  assert.ok(breach.errors.some((l) => l.includes(HONO_WORKER_PATH)));
});

test("CONTROL worker: malformed budgets stay invalid plan (2)", (t) => {
  for (const budgets of [
    {},
    { "dist/worker.js": { maxRawBytes: 1 } },
    { "dist/worker.js": { maxRawBytes: -1, maxGzipBytes: 10 } },
    { "../escape.js": { maxRawBytes: 10, maxGzipBytes: 10 } },
  ]) {
    const fx = makeWorkerFixture({
      budgetMutate: (b) => {
        b.budgets = budgets;
      },
    });
    t.after(() => cleanup(fx.root));
    const result = runCaptured(runWorker, fx.root);
    assert.equal(result.code, 2, `malformed budget must exit 2, got ${result.code}`);
  }
});

test("CONTROL worker: missing bundle cannot enforce (2) without auto-rebuild", (t) => {
  const fx = makeWorkerFixture({ omitBundle: true });
  t.after(() => cleanup(fx.root));
  const before = snapshotFs(fx.root);
  const result = runCaptured(runWorker, fx.root);
  assert.equal(result.code, 2, `missing bundle must exit 2, got ${result.code}`);
  assert.ok(
    result.errors.some((l) => /cannot enforce|missing/i.test(l)),
    `missing bundle must say cannot enforce, got: ${result.errors.join(" | ")}`,
  );
  assert.ok(
    sameSnapshot(before, snapshotFs(fx.root)),
    "missing evidence must not auto-create files",
  );
  assert.ok(
    result.errors.some((l) => /wrangler deploy --dry-run/i.test(l)),
    "missing bundle must point at the manual dry-run command",
  );
});

test("CONTROL worker: supported metadata stays valid (exit 0)", (t) => {
  const fx = makeWorkerFixture({
    budgetMutate: (b) => {
      b.$comment = "extra metadata stays valid";
      b.$schema = "https://example.invalid/schema.json";
    },
  });
  t.after(() => cleanup(fx.root));
  const result = runCaptured(runWorker, fx.root);
  assert.equal(
    result.code,
    0,
    `metadata must stay valid, got ${result.code}\n${result.errors.join("\n")}`,
  );
});

test("CONTROL worker body fixture is stable for exact-fit ceilings", () => {
  assert.ok(WORKER_BODY.length > 1000, "kit worker fixture must be nontrivial");
  assert.ok(HONO_BODY.length >= 2048, "hono fixture must be nontrivial");
});
