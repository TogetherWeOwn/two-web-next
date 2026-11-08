// Hermetic fixtures only: every tree lives under a temp directory. Nothing is
// built, uploaded or sent over the network. These tests pin the immediate
// same-source CI diagnostic capture: a status journal written before capture,
// complete raw bytes with a recomputable receipt digest, retained failures that
// never qualify, exclusive destinations, and a sanitized CLI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { captureCanonicalBuild } from "./kit-canonical-capture.mjs";
import { verifyCanonicalBuild } from "./kit-upload-rehearsal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "kit-canonical-capture.mjs");
const WORKFLOW = join(HERE, "..", ".github", "workflows", "ci.yml");

const WORKER = "web/.svelte-kit/cloudflare/_worker.js";
const SERVER = "web/.svelte-kit/output/server";
const CLIENT = "web/.svelte-kit/output/client/_app";
const CLIENT_TREE = "web/.svelte-kit/output/client";
const CLOUDFLARE_TREE = "web/.svelte-kit/cloudflare";
const GROUP_IDS = ["kit.worker", "kit.server.js", "kit.client.js", "kit.client.css"];
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const SENTINEL = "RAW-SOURCE-SENTINEL-do-not-leak";

const authority = () => ({
  KIT_WORKER_PATH: WORKER,
  KIT_SERVER_DIR: SERVER,
  KIT_CLIENT_DIR: CLIENT,
  KIT_GROUP_IDS: [...GROUP_IDS],
});

const base = realpathSync(mkdtempSync(join(tmpdir(), "kit-capture-")));
after(() => rmSync(base, { recursive: true, force: true }));
let counter = 0;
const fresh = (label) => {
  const dir = join(base, `${label}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const blob = (seed, n = 2000) => Buffer.from(`${seed}:${"abcdefghij0123456789".repeat(n / 20)}\n`);

function put(root, rel, bytes) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
}

const RAW_WORKER = Buffer.concat([
  Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a, 0x1b, 0x07]),
  blob("worker"),
]);

function makeRoot(label = "root") {
  const root = fresh(label);
  put(root, WORKER, RAW_WORKER);
  put(root, `${SERVER}/index.js`, blob("server-index"));
  put(root, `${SERVER}/chunks/a.js`, blob("server-a"));
  put(root, `${SERVER}/binary.bin`, Buffer.from([0, 1, 2, 0xff, 0xfe, 0x0d, 0x0a, 0x00]));
  put(root, `${SERVER}/.control`, Buffer.from("hidden\r\ncontrol\n"));
  put(root, `${SERVER}/empty.txt`, Buffer.alloc(0));
  put(root, `${CLIENT}/version.json`, Buffer.from('{"version":"1"}'));
  put(root, `${CLIENT}/immutable/entry/start.js`, blob("client-start"));
  put(root, `${CLIENT}/immutable/assets/app.css`, blob("client-css"));
  put(root, `${CLIENT_TREE}/robots.txt`, Buffer.from("robots\r\n"));
  put(root, `${CLOUDFLARE_TREE}/_headers`, Buffer.from("/*\n  X-Test: 1\n"));
  return root;
}

const context = (over = {}) => ({
  sourceSha: SHA,
  workflowSha: SHA,
  runId: "123456",
  runAttempt: "1",
  producerOutcome: "success",
  ...over,
});

const target = (label = "out") => join(fresh(label), "capture");
const status = (dest) => JSON.parse(readFileSync(join(dest, "status.json"), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function digest(root, rel = ".") {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(`${full}:${sha(readFileSync(full))}`);
    }
  };
  visit(join(root, rel));
  return out.sort();
}

test("success captures all trees, raw bytes, and a recomputed receipt digest", async () => {
  const root = makeRoot();
  const before = digest(root);
  const dest = target();
  const result = captureCanonicalBuild(root, dest, context(), authority());
  const journal = status(dest);
  assert.deepEqual(result, journal);
  assert.equal(journal.schema, "two.kit-canonical-capture.v1");
  assert.equal(journal.evidence, "unqualified-same-source-ci-diagnostic");
  assert.equal(journal.capture, "complete");
  assert.equal(journal.qualified, false);
  assert.equal(journal.sourceSha, SHA);
  assert.equal(journal.workflowSha, SHA);
  assert.equal(journal.runId, "123456");
  assert.equal(journal.runAttempt, "1");
  assert.equal(journal.producerOutcome, "success");

  const receiptBytes = readFileSync(join(dest, "bytes/receipt.json"));
  assert.deepEqual(journal.receipt, {
    path: "bytes/receipt.json",
    bytes: receiptBytes.length,
    sha256: sha(receiptBytes),
  });

  const bytes = join(dest, "bytes");
  for (const rel of [
    WORKER,
    `${SERVER}/index.js`,
    `${SERVER}/chunks/a.js`,
    `${SERVER}/binary.bin`,
    `${SERVER}/.control`,
    `${SERVER}/empty.txt`,
    `${CLIENT}/version.json`,
    `${CLIENT}/immutable/entry/start.js`,
    `${CLIENT}/immutable/assets/app.css`,
    `${CLIENT_TREE}/robots.txt`,
    `${CLOUDFLARE_TREE}/_headers`,
  ]) {
    assert.deepEqual(readFileSync(join(bytes, rel)), readFileSync(join(root, rel)), rel);
  }
  // Raw binary and control bytes survive untouched.
  assert.deepEqual(readFileSync(join(bytes, WORKER)), RAW_WORKER);
  const verified = await verifyCanonicalBuild(bytes, authority());
  assert.deepEqual(verified, JSON.parse(receiptBytes.toString("utf8")));
  assert.deepEqual(digest(root), before, "source tree changed");
});

test("status journal is created before capture and only ever replaces itself", () => {
  const root = makeRoot();
  const dest = target();
  let observations = 0;
  const observedAuthority = {
    ...authority(),
    get KIT_WORKER_PATH() {
      observations++;
      assert.equal(status(dest).capture, "started");
      assert.equal(status(dest).receipt, null);
      return WORKER;
    },
  };
  captureCanonicalBuild(root, dest, context(), observedAuthority);
  assert.ok(observations > 0);
  assert.deepEqual(readdirSync(dest).sort(), ["bytes", "status.json"]);
  // A started journal has the same shape the complete one extends.
  const failedDest = target();
  rmSync(join(root, CLIENT_TREE), { recursive: true });
  assert.throws(() => captureCanonicalBuild(root, failedDest, context(), authority()));
  const journal = status(failedDest);
  assert.deepEqual(Object.keys(journal).sort(), [
    "capture",
    "evidence",
    "producerOutcome",
    "qualified",
    "receipt",
    "runAttempt",
    "runId",
    "schema",
    "sourceSha",
    "workflowSha",
  ]);
});

test("a missing group retains a failed status and no receipt", () => {
  for (const [name, mutate] of Object.entries({
    "no client css": (root) => unlinkSync(join(root, CLIENT, "immutable/assets/app.css")),
    "no client js": (root) => unlinkSync(join(root, CLIENT, "immutable/entry/start.js")),
    "no worker": (root) => unlinkSync(join(root, WORKER)),
    "no server tree": (root) => rmSync(join(root, SERVER), { recursive: true }),
  })) {
    const root = makeRoot("missing");
    mutate(root);
    const dest = target("missing-out");
    assert.throws(
      () => captureCanonicalBuild(root, dest, context(), authority()),
      /canonical byte capture failed/,
      name,
    );
    const journal = status(dest);
    assert.equal(journal.capture, "failed", name);
    assert.equal(journal.qualified, false, name);
    assert.equal(journal.receipt, null, name);
    assert.equal(existsSync(join(dest, "bytes/receipt.json")), false, name);
  }
});

test("symlinked output is rejected and retained as failed", () => {
  const outside = fresh("outside");
  writeFileSync(join(outside, "x.js"), blob("outside"));
  const root = makeRoot("symlink");
  symlinkSync(join(outside, "x.js"), join(root, SERVER, "linked.js"));
  const dest = target("symlink-out");
  assert.throws(
    () => captureCanonicalBuild(root, dest, context(), authority()),
    /canonical byte capture failed/,
  );
  const journal = status(dest);
  assert.equal(journal.capture, "failed");
  assert.equal(journal.qualified, false);
  assert.equal(journal.receipt, null);
  assert.equal(existsSync(join(dest, "bytes/receipt.json")), false);
});

test("skipped and cancelled producers are unavailable even with stale outputs", () => {
  for (const producerOutcome of ["skipped", "cancelled"]) {
    const root = makeRoot(`stale-${producerOutcome}`);
    const dest = target(`stale-${producerOutcome}-out`);
    assert.throws(
      () => captureCanonicalBuild(root, dest, context({ producerOutcome }), authority()),
      /canonical producer did not complete/,
    );
    const journal = status(dest);
    assert.equal(journal.capture, "unavailable", producerOutcome);
    assert.equal(journal.producerOutcome, producerOutcome);
    assert.equal(journal.qualified, false);
    assert.equal(journal.receipt, null);
    assert.deepEqual(readdirSync(dest), ["status.json"], "stale bytes must not be copied");
  }
  // Same without any outputs at all.
  const dest = target("bare");
  assert.throws(() =>
    captureCanonicalBuild(fresh("empty-root"), dest, context({ producerOutcome: "skipped" })),
  );
  assert.equal(status(dest).capture, "unavailable");
});

test("failed producer with complete trees preserves complete bytes but throws", async () => {
  const root = makeRoot();
  const dest = target();
  assert.throws(
    () => captureCanonicalBuild(root, dest, context({ producerOutcome: "failure" }), authority()),
    /canonical producer failed before capture/,
  );
  const journal = status(dest);
  assert.equal(journal.capture, "complete");
  assert.equal(journal.producerOutcome, "failure");
  assert.equal(journal.qualified, false);
  const receiptBytes = readFileSync(join(dest, "bytes/receipt.json"));
  assert.equal(journal.receipt.sha256, sha(receiptBytes));
  assert.equal(journal.receipt.bytes, receiptBytes.length);
  await verifyCanonicalBuild(join(dest, "bytes"), authority());
});

test("failed producer with missing trees is a failed capture", () => {
  const root = makeRoot();
  rmSync(join(root, CLIENT_TREE), { recursive: true });
  const dest = target();
  assert.throws(
    () => captureCanonicalBuild(root, dest, context({ producerOutcome: "failure" }), authority()),
    /canonical byte capture failed/,
  );
  const journal = status(dest);
  assert.equal(journal.capture, "failed");
  assert.equal(journal.producerOutcome, "failure");
  assert.equal(journal.qualified, false);
  assert.equal(journal.receipt, null);
});

test("wrong identity, run or outcome refuses before touching the destination", () => {
  const root = makeRoot();
  const bad = {
    "short source": { sourceSha: "abc123", workflowSha: "abc123" },
    "uppercase source": { sourceSha: SHA.toUpperCase(), workflowSha: SHA.toUpperCase() },
    "missing source": { sourceSha: undefined },
    "workflow mismatch": { workflowSha: OTHER_SHA },
    "missing workflow": { workflowSha: undefined },
    "empty run id": { runId: "" },
    "zero run id": { runId: "0" },
    "non-numeric run id": { runId: "12a" },
    "negative run id": { runId: "-5" },
    "missing run id": { runId: undefined },
    "zero attempt": { runAttempt: "0" },
    "non-numeric attempt": { runAttempt: "one" },
    "missing attempt": { runAttempt: undefined },
    "unknown outcome": { producerOutcome: "neutral" },
    "empty outcome": { producerOutcome: "" },
    "missing outcome": { producerOutcome: undefined },
  };
  for (const [name, over] of Object.entries(bad)) {
    const dest = target("refuse");
    assert.throws(
      () => captureCanonicalBuild(root, dest, context(over), authority()),
      undefined,
      name,
    );
    assert.equal(existsSync(dest), false, `${name}: destination created`);
  }
});

test("destination must be absent with an existing, unaliased parent", () => {
  const root = makeRoot();
  const parent = fresh("exclusive");

  const emptyDir = join(parent, "empty");
  mkdirSync(emptyDir);
  assert.throws(() => captureCanonicalBuild(root, emptyDir, context(), authority()));
  assert.deepEqual(readdirSync(emptyDir), []);

  const filePath = join(parent, "file");
  writeFileSync(filePath, "keep");
  assert.throws(() => captureCanonicalBuild(root, filePath, context(), authority()));
  assert.equal(readFileSync(filePath, "utf8"), "keep");

  const full = join(parent, "full");
  captureCanonicalBuild(root, full, context(), authority());
  const snapshot = digest(full);
  assert.throws(() => captureCanonicalBuild(root, full, context(), authority()));
  assert.throws(() =>
    captureCanonicalBuild(root, full, context({ producerOutcome: "skipped" }), authority()),
  );
  assert.deepEqual(digest(full), snapshot, "existing capture must be preserved");

  const missingParent = join(parent, "no-parent", "capture");
  assert.throws(() => captureCanonicalBuild(root, missingParent, context(), authority()));
  assert.equal(existsSync(join(parent, "no-parent")), false);

  const real = fresh("real-parent");
  const alias = join(fresh("alias"), "link");
  symlinkSync(real, alias);
  assert.throws(() => captureCanonicalBuild(root, join(alias, "capture"), context(), authority()));
  assert.deepEqual(readdirSync(real), []);
});

test("CLI exits nonzero with fixed sanitized stderr and no raw source content", () => {
  const root = fresh("cli-root");
  // Raw content in the worker with the other trees absent must never be echoed.
  put(root, WORKER, Buffer.from(`${SENTINEL}\n`));
  put(root, `${SERVER}/${SENTINEL}.js`, Buffer.from(SENTINEL));
  const dest = join(fresh("cli-out"), "capture");
  const result = spawnSync(process.execPath, [SCRIPT, dest], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 16384,
    env: {
      PATH: process.env.PATH,
      GITHUB_SHA: SHA,
      GITHUB_WORKFLOW_SHA: SHA,
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      CANONICAL_PRODUCER_OUTCOME: "success",
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, "canonical diagnostic capture failed; inspect retained status\n");
  assert.equal(result.stdout, "");
  for (const stream of [result.stdout, result.stderr]) {
    assert.ok(!stream.includes(SENTINEL));
    assert.ok(!stream.includes(root));
    assert.ok(!stream.includes("at "), "no stack trace");
  }
  const journal = status(dest);
  assert.equal(journal.capture, "failed");
  assert.equal(journal.qualified, false);
  assert.equal(journal.sourceSha, SHA);
  assert.ok(!JSON.stringify(journal).includes(SENTINEL));
});

test("CLI refuses a missing or wrong outcome and extra arguments with the fixed message", () => {
  const root = makeRoot("cli-args");
  const run = (args, env) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 16384,
      env: Object.fromEntries(
        Object.entries({ PATH: process.env.PATH, ...env }).filter(([, v]) => v !== undefined),
      ),
    });
  const good = {
    GITHUB_SHA: SHA,
    GITHUB_WORKFLOW_SHA: SHA,
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    CANONICAL_PRODUCER_OUTCOME: "success",
  };
  const cases = [
    [[], good],
    [[join(fresh("cli-extra"), "capture"), "extra"], good],
    [[join(fresh("cli-nooutcome"), "capture")], { ...good, CANONICAL_PRODUCER_OUTCOME: "" }],
    [[join(fresh("cli-nosha"), "capture")], { ...good, GITHUB_SHA: "abc" }],
    [[join(fresh("cli-nowf"), "capture")], { ...good, GITHUB_WORKFLOW_SHA: undefined }],
    [[join(fresh("cli-emptywf"), "capture")], { ...good, GITHUB_WORKFLOW_SHA: "" }],
    [[join(fresh("cli-wfmismatch"), "capture")], { ...good, GITHUB_WORKFLOW_SHA: OTHER_SHA }],
  ];
  for (const [args, env] of cases) {
    const result = run(args, env);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "canonical diagnostic capture failed; inspect retained status\n");
    assert.equal(result.stdout, "");
  }
});

test("workflow runs the capture immediately after the Kit build and retains raw trees", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  const steps = text.split(/\n(?=      - name: )/);
  const producerName = "Kit adapter build and local startup diagnostic (no deploy)";
  const index = steps.findIndex((step) => step.startsWith(`      - name: ${producerName}`));
  assert.ok(index >= 0, "producer step present");
  const producer = steps[index];
  assert.match(producer, /\n {8}id: kit-build\n/);
  // Original startup and budget gates remain on the producer and downstream.
  assert.ok(producer.includes("node ci/check-worker-startup.mjs"));
  assert.ok(text.includes("node ci/check-kit-perf.mjs"));
  assert.ok(text.includes("node ci/check-kit-route-perf.mjs"));
  assert.equal(
    steps.filter((step) => step.includes("node ci/check-worker-startup.mjs")).length,
    1,
    "startup gate stays single and unmoved",
  );

  const capture = steps[index + 1];
  assert.ok(capture, "step after producer");
  assert.ok(capture.includes("node ci/kit-canonical-capture.mjs"), "capture immediately follows");
  assert.ok(capture.includes("artifacts/kit-canonical-capture/"));
  assert.match(capture, /\n {8}if: always\(\)/);
  assert.match(capture, /CANONICAL_PRODUCER_OUTCOME: \$\{\{ steps\.kit-build\.outcome \}\}/);
  assert.equal(text.split("node ci/kit-canonical-capture.mjs").length - 1, 1);

  const upload = steps
    .slice(index + 1)
    .find(
      (step) =>
        step.includes("uses: actions/upload-artifact") &&
        step.includes("artifacts/kit-canonical-capture/"),
    );
  assert.ok(upload, "capture artifact upload present");
  assert.match(upload, /\n {8}if: always\(\)/);
  for (const raw of [
    "web/.svelte-kit/cloudflare",
    "web/.svelte-kit/output/server",
    "web/.svelte-kit/output/client",
  ]) {
    assert.ok(
      upload.split("\n").some((line) => line.trim() === raw || line.trim() === `${raw}/`),
      `raw root ${raw} retained`,
    );
  }
  assert.ok(resolve(WORKFLOW).endsWith("ci.yml"));
});
