// Hermetic fixtures only: every tree lives under a temp directory. Nothing is
// built, uploaded or sent over the network. These tests pin the immediate
// same-source CI diagnostic capture: a status journal written before capture,
// complete raw bytes with a recomputable receipt digest, retained failures that
// never qualify, exclusive destinations, and a sanitized CLI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import {
  captureAfterCanonicalBuild,
  captureCanonicalBuild,
  finalizeCanonicalCapture,
} from "./kit-canonical-capture.mjs";
import { verifyCanonicalBuild } from "./kit-upload-rehearsal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "kit-canonical-capture.mjs");
const WORKFLOW = join(HERE, "..", ".github", "workflows", "ci.yml");
const STARTUP = join(HERE, "check-worker-startup.mjs");

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

test("separated capture binds distinct revisions through finalization", async () => {
  const root = makeRoot();
  const dest = target();
  const ctx = context({
    workflowSha: OTHER_SHA,
    sourceBindingSha256: "a".repeat(64),
    captureBoundary: "build-process-return",
  });
  const journal = captureCanonicalBuild(root, dest, ctx, authority());
  assert.equal(journal.schema, "two.kit-canonical-separated-capture.v1");
  assert.equal(journal.evidence, "unqualified-source-separated-diagnostic");
  assert.equal(journal.sourceSha, SHA);
  assert.equal(journal.workflowSha, OTHER_SHA);
  assert.equal(journal.sourceBindingSha256, ctx.sourceBindingSha256);
  assert.equal(journal.qualified, false);
  assert.deepEqual(await finalizeCanonicalCapture(root, dest, ctx, authority()), journal);
  await assert.rejects(
    finalizeCanonicalCapture(
      root,
      dest,
      { ...ctx, sourceBindingSha256: "b".repeat(64) },
      authority(),
    ),
    /mismatched immediate build capture/,
  );
});

for (const over of [
  { sourceBindingSha256: "short", workflowSha: OTHER_SHA },
  { sourceBindingSha256: "a".repeat(64) },
  { sourceBindingSha256: "a".repeat(64), workflowSha: "main" },
]) {
  test(`separated capture rejects invalid binding identity ${JSON.stringify(over)}`, () => {
    const dest = target();
    assert.throws(() => captureCanonicalBuild(makeRoot(), dest, context(over), authority()));
    assert.equal(existsSync(dest), false);
  });
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
  assert.equal(journal.captureBoundary, "caller-requested");
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
  // A failed journal adds only a fixed failure code to the original fields.
  const failedDest = target();
  rmSync(join(root, CLIENT_TREE), { recursive: true });
  assert.throws(() => captureCanonicalBuild(root, failedDest, context(), authority()));
  const journal = status(failedDest);
  assert.deepEqual(Object.keys(journal).sort(), [
    "capture",
    "captureBoundary",
    "evidence",
    "failureCode",
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

test("capture failure codes are finite and do not expose exception details", () => {
  for (const [name, mutate, expected] of [
    [
      "empty",
      (root) => {
        rmSync(join(root, SERVER), { recursive: true });
        mkdirSync(join(root, SERVER));
      },
      "empty-directory",
    ],
    ["missing", (root) => rmSync(join(root, SERVER), { recursive: true }), "filesystem-missing"],
    ["group", (root) => unlinkSync(join(root, WORKER)), "group-missing"],
  ]) {
    const root = makeRoot(name);
    mutate(root);
    const dest = target(name);
    assert.throws(
      () => captureCanonicalBuild(root, dest, context(), authority()),
      /canonical byte capture failed/,
    );
    const journal = status(dest);
    assert.equal(journal.capture, "failed");
    assert.equal(journal.failureCode, expected);
    assert.equal(journal.receipt, null);
    assert.equal(journal.qualified, false);
  }
  const root = makeRoot("private-error");
  const dest = target("private-error");
  const injected = {
    ...authority(),
    get KIT_WORKER_PATH() {
      throw Object.assign(new Error("private/path/generated-value"), { code: "private-code" });
    },
  };
  assert.throws(
    () => captureCanonicalBuild(root, dest, context(), injected),
    /canonical byte capture failed/,
  );
  assert.equal(status(dest).failureCode, "unclassified");
  assert.doesNotMatch(readFileSync(join(dest, "status.json"), "utf8"), /private/);
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
  assert.match(
    producer,
    /\n {10}CANONICAL_CAPTURE_DIRECTORY: artifacts\/kit-canonical-capture\/\n/,
    "producer names the immediate capture directory",
  );
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
  assert.ok(
    capture.includes(
      "node ci/kit-canonical-capture.mjs --finalize artifacts/kit-canonical-capture/",
    ),
    "always() step finalizes the immediate capture",
  );
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

// Immediate capture around the one canonical build, and its always() finalizer.
const contextWithoutOutcome = (over = {}) => {
  const { producerOutcome: _ignored, ...rest } = context(over);
  return rest;
};

function controlled() {
  let resolveBuild;
  let rejectBuild;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolveBuild = resolvePromise;
    rejectBuild = rejectPromise;
  });
  return { promise, resolveBuild, rejectBuild };
}

const microtasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

async function captured(label = "frozen") {
  const root = makeRoot(label);
  const dest = target(`${label}-out`);
  await captureAfterCanonicalBuild(
    root,
    dest,
    contextWithoutOutcome(),
    async () => {},
    authority(),
  );
  return { root, dest };
}

test("capture waits for the awaited build and freezes the bytes it produced", async () => {
  const root = makeRoot("after-build");
  const dest = target();
  const gate = controlled();
  const events = [];
  let calls = 0;
  const pending = captureAfterCanonicalBuild(
    root,
    dest,
    contextWithoutOutcome(),
    () => {
      calls++;
      events.push("build-start");
      return gate.promise;
    },
    authority(),
  ).then((result) => {
    events.push("settled");
    return result;
  });
  await microtasks();
  assert.equal(calls, 1);
  assert.deepEqual(events, ["build-start"], "must not settle before the build resolves");
  assert.equal(existsSync(join(dest, "bytes/receipt.json")), false, "no capture before build ends");
  // The build finishes by rewriting the worker; the capture must see that output.
  const built = Buffer.concat([RAW_WORKER, Buffer.from("rebuilt\n")]);
  put(root, WORKER, built);
  gate.resolveBuild();
  const result = await pending;
  assert.deepEqual(events, ["build-start", "settled"]);
  assert.equal(calls, 1, "no retry or rebuild");
  assert.equal(result.capture, "complete");
  assert.equal(result.captureBoundary, "build-process-return");
  assert.equal(result.producerOutcome, "success");
  assert.equal(result.qualified, false);
  assert.deepEqual(status(dest), result);
  assert.deepEqual(readFileSync(join(dest, "bytes", WORKER)), built);
  await verifyCanonicalBuild(join(dest, "bytes"), authority());
});

test("a context producerOutcome is overridden by the actual build completion", async () => {
  for (const claimed of ["failure", "skipped", "cancelled", "success"]) {
    const dest = target(`override-${claimed}`);
    const result = await captureAfterCanonicalBuild(
      makeRoot("override"),
      dest,
      context({ producerOutcome: claimed }),
      async () => {},
      authority(),
    );
    assert.equal(result.producerOutcome, "success", claimed);
    assert.equal(status(dest).producerOutcome, "success", claimed);
  }
});

test("invalid identity refuses before the build runs or the destination exists", async () => {
  const root = makeRoot();
  const bad = {
    "short source": { sourceSha: "abc123", workflowSha: "abc123" },
    "workflow mismatch": { workflowSha: OTHER_SHA },
    "missing workflow": { workflowSha: undefined },
    "zero run id": { runId: "0" },
    "missing run id": { runId: undefined },
    "non-numeric attempt": { runAttempt: "one" },
  };
  for (const [name, over] of Object.entries(bad)) {
    const dest = target("pre-refuse");
    let calls = 0;
    await assert.rejects(
      captureAfterCanonicalBuild(
        root,
        dest,
        contextWithoutOutcome(over),
        async () => {
          calls++;
        },
        authority(),
      ),
      undefined,
      name,
    );
    assert.equal(calls, 0, `${name}: build executed`);
    assert.equal(existsSync(dest), false, `${name}: destination created`);
  }
});

test("a failed build is captured and its original error is rethrown unchanged", async () => {
  const root = makeRoot();
  const dest = target();
  const original = new Error("build exploded RAW-ORIGINAL");
  let calls = 0;
  await assert.rejects(
    captureAfterCanonicalBuild(
      root,
      dest,
      contextWithoutOutcome(),
      async () => {
        calls++;
        throw original;
      },
      authority(),
    ),
    (error) => {
      assert.strictEqual(error, original);
      return true;
    },
  );
  assert.equal(calls, 1);
  const journal = status(dest);
  assert.equal(journal.capture, "complete");
  assert.equal(journal.captureBoundary, "build-process-return");
  assert.equal(journal.producerOutcome, "failure");
  assert.equal(journal.qualified, false);
  const receiptBytes = readFileSync(join(dest, "bytes/receipt.json"));
  assert.equal(journal.receipt.sha256, sha(receiptBytes));
  await verifyCanonicalBuild(join(dest, "bytes"), authority());
});

test("incomplete output records capture failure without replacing the build error", async () => {
  const root = makeRoot();
  const dest = target();
  const original = new Error("build exploded early");
  await assert.rejects(
    captureAfterCanonicalBuild(
      root,
      dest,
      contextWithoutOutcome(),
      async () => {
        rmSync(join(root, CLIENT_TREE), { recursive: true });
        throw original;
      },
      authority(),
    ),
    (error) => {
      assert.strictEqual(error, original, "capture failure must not mask the build error");
      return true;
    },
  );
  const journal = status(dest);
  assert.equal(journal.capture, "failed");
  assert.equal(journal.captureBoundary, "build-process-return");
  assert.equal(journal.producerOutcome, "failure");
  assert.equal(journal.receipt, null);
  assert.equal(existsSync(join(dest, "bytes/receipt.json")), false);
  // Incomplete trees fail before a snapshot is created; raw output remains for
  // the workflow's always() archive, never a fabricated complete receipt.
  assert.equal(existsSync(join(dest, "bytes")), false);
  assert.deepEqual(readFileSync(join(root, WORKER)), RAW_WORKER);
});

test("a failed build still rethrows the original when the destination is unusable", async () => {
  const root = makeRoot();
  const dest = target();
  mkdirSync(dest);
  const original = new Error("build exploded with blocked destination");
  await assert.rejects(
    captureAfterCanonicalBuild(
      root,
      dest,
      contextWithoutOutcome(),
      async () => {
        throw original;
      },
      authority(),
    ),
    (error) => {
      assert.strictEqual(error, original);
      return true;
    },
  );
  assert.deepEqual(readdirSync(dest), [], "existing destination preserved");
});

test("capture failure after a successful build rejects without retrying the build", async () => {
  const root = makeRoot();
  const dest = target();
  let calls = 0;
  await assert.rejects(
    captureAfterCanonicalBuild(
      root,
      dest,
      contextWithoutOutcome(),
      async () => {
        calls++;
        rmSync(join(root, SERVER), { recursive: true });
      },
      authority(),
    ),
    /canonical byte capture failed/,
  );
  assert.equal(calls, 1, "no retry or rebuild");
  const journal = status(dest);
  assert.equal(journal.capture, "failed");
  assert.equal(journal.captureBoundary, "build-process-return");
  assert.equal(journal.producerOutcome, "success");
  assert.equal(journal.qualified, false);
  assert.equal(journal.receipt, null);
});

test("finalize validates the frozen bytes even after the raw trees change", async () => {
  const { root, dest } = await captured();
  const frozen = digest(dest);
  const journal = status(dest);
  // Later steps rewrite or delete raw output; the finalizer must not recopy it.
  put(root, WORKER, blob("late-mutation"));
  rmSync(join(root, CLIENT_TREE), { recursive: true });
  const result = await finalizeCanonicalCapture(
    root,
    dest,
    context({ producerOutcome: "success" }),
    authority(),
  );
  assert.equal(result.capture, "complete");
  assert.equal(result.captureBoundary, "build-process-return");
  assert.equal(result.qualified, false);
  assert.deepEqual(result.receipt, journal.receipt);
  assert.deepEqual(digest(dest), frozen, "frozen bytes and journal untouched");
  assert.deepEqual(readFileSync(join(dest, "bytes", WORKER)), RAW_WORKER);
});

test("finalize without immediate capture is unavailable and copies no stale trees", async () => {
  const root = makeRoot("stale-finalize");
  const dest = target();
  const before = digest(root);
  await assert.rejects(
    finalizeCanonicalCapture(root, dest, context({ producerOutcome: "failure" }), authority()),
  );
  const journal = status(dest);
  assert.equal(journal.capture, "unavailable");
  assert.equal(journal.captureBoundary, "not-observed");
  assert.equal(journal.qualified, false);
  assert.equal(journal.receipt, null);
  assert.deepEqual(readdirSync(dest), ["status.json"], "stale bytes must not be copied");
  assert.deepEqual(digest(root), before);
  // A skipped producer has no capture either, even with a successful-looking outcome.
  const skipped = target("stale-finalize-success");
  await assert.rejects(
    finalizeCanonicalCapture(root, skipped, context({ producerOutcome: "success" }), authority()),
  );
  assert.equal(status(skipped).capture, "unavailable");
  assert.equal(status(skipped).captureBoundary, "not-observed");
  assert.deepEqual(readdirSync(skipped), ["status.json"]);
});

test("finalize rejects a mismatched identity, run or invalid context", async () => {
  const { root, dest } = await captured();
  const frozen = digest(dest);
  const mismatched = {
    "other source": { sourceSha: OTHER_SHA, workflowSha: OTHER_SHA },
    "workflow mismatch": { workflowSha: OTHER_SHA },
    "other run": { runId: "999999" },
    "other attempt": { runAttempt: "2" },
    "missing run": { runId: undefined },
    "unknown outcome": { producerOutcome: "neutral" },
    "missing outcome": { producerOutcome: undefined },
  };
  for (const [name, over] of Object.entries(mismatched)) {
    await assert.rejects(
      finalizeCanonicalCapture(root, dest, context(over), authority()),
      undefined,
      name,
    );
  }
  assert.deepEqual(digest(dest), frozen, "identity refusal preserves the entire capture");
});

test("finalize rejects a changed journal, receipt or frozen byte", async () => {
  const edits = {
    "journal source": (dest) => {
      const journal = status(dest);
      writeFileSync(
        join(dest, "status.json"),
        JSON.stringify({ ...journal, sourceSha: OTHER_SHA, workflowSha: OTHER_SHA }),
      );
    },
    "journal run": (dest) => {
      writeFileSync(
        join(dest, "status.json"),
        JSON.stringify({ ...status(dest), runId: "999999" }),
      );
    },
    "journal receipt digest": (dest) => {
      const journal = status(dest);
      writeFileSync(
        join(dest, "status.json"),
        JSON.stringify({ ...journal, receipt: { ...journal.receipt, sha256: "0".repeat(64) } }),
      );
    },
    "journal capture state": (dest) => {
      writeFileSync(
        join(dest, "status.json"),
        JSON.stringify({ ...status(dest), capture: "started", receipt: null }),
      );
    },
    "journal producer outcome": (dest) => {
      writeFileSync(
        join(dest, "status.json"),
        JSON.stringify({ ...status(dest), producerOutcome: "failure" }),
      );
    },
    "journal boundary downgraded": (dest) => {
      writeFileSync(
        join(dest, "status.json"),
        JSON.stringify({ ...status(dest), captureBoundary: "caller-requested" }),
      );
    },
    "journal boundary unobserved": (dest) => {
      writeFileSync(
        join(dest, "status.json"),
        JSON.stringify({ ...status(dest), captureBoundary: "not-observed" }),
      );
    },
    "journal boundary removed": (dest) => {
      const { captureBoundary: _removed, ...rest } = status(dest);
      writeFileSync(join(dest, "status.json"), JSON.stringify(rest));
    },
    "journal removed": (dest) => unlinkSync(join(dest, "status.json")),
    "receipt bytes": (dest) => {
      const path = join(dest, "bytes/receipt.json");
      chmodSync(path, 0o600);
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(" ")]));
    },
    "receipt removed": (dest) => unlinkSync(join(dest, "bytes/receipt.json")),
    "frozen worker": (dest) => {
      const path = join(dest, "bytes", WORKER);
      chmodSync(path, 0o600);
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([0])]));
    },
    "frozen server file": (dest) => {
      const path = join(dest, "bytes", SERVER, "index.js");
      chmodSync(path, 0o600);
      writeFileSync(path, blob("x"));
    },
    "frozen client file removed": (dest) =>
      unlinkSync(join(dest, "bytes", CLIENT, "immutable/assets/app.css")),
  };
  for (const [name, edit] of Object.entries(edits)) {
    const { root, dest } = await captured("tamper");
    edit(dest);
    await assert.rejects(
      finalizeCanonicalCapture(root, dest, context({ producerOutcome: "success" }), authority()),
      undefined,
      name,
    );
  }
});

test("finalize preserves build bytes but fails when the combined step failed", async () => {
  for (const producerOutcome of ["failure", "skipped", "cancelled"]) {
    const { root, dest } = await captured("combined");
    const before = digest(join(dest, "bytes"));
    await assert.rejects(
      finalizeCanonicalCapture(root, dest, context({ producerOutcome }), authority()),
      undefined,
      producerOutcome,
    );
    const journal = status(dest);
    assert.equal(journal.capture, "complete", producerOutcome);
    assert.equal(journal.qualified, false, producerOutcome);
    assert.deepEqual(digest(join(dest, "bytes")), before, producerOutcome);
    await verifyCanonicalBuild(join(dest, "bytes"), authority());
  }
});

test("a legacy direct capture is never accepted as immediate proof", async () => {
  const root = makeRoot();
  const dest = target();
  captureCanonicalBuild(root, dest, context(), authority());
  assert.equal(status(dest).captureBoundary, "caller-requested");
  await assert.rejects(
    finalizeCanonicalCapture(root, dest, context({ producerOutcome: "success" }), authority()),
  );
  assert.equal(status(dest).captureBoundary, "caller-requested");
  await verifyCanonicalBuild(join(dest, "bytes"), authority());
});

test("unknown capture boundaries refuse before touching the destination or build", async () => {
  const root = makeRoot();
  const direct = target();
  assert.throws(() =>
    captureCanonicalBuild(root, direct, context({ captureBoundary: "bogus" }), authority()),
  );
  assert.equal(existsSync(direct), false);
  const wrapped = target();
  let calls = 0;
  await assert.rejects(
    captureAfterCanonicalBuild(
      root,
      wrapped,
      contextWithoutOutcome({ captureBoundary: "bogus" }),
      async () => {
        calls++;
      },
      authority(),
    ),
  );
  assert.equal(calls, 0);
  assert.equal(existsSync(wrapped), false);
  await assert.rejects(
    finalizeCanonicalCapture(root, target(), context({ captureBoundary: "bogus" }), authority()),
  );
});

test("a failed-build capture cannot finalize as success", async () => {
  const root = makeRoot();
  const dest = target();
  await assert.rejects(
    captureAfterCanonicalBuild(
      root,
      dest,
      contextWithoutOutcome(),
      async () => {
        throw new Error("build failed");
      },
      authority(),
    ),
  );
  await assert.rejects(
    finalizeCanonicalCapture(root, dest, context({ producerOutcome: "success" }), authority()),
  );
  assert.equal(status(dest).capture, "complete");
});

test("the startup producer captures around the one npm build and before collection", () => {
  const text = readFileSync(STARTUP, "utf8");
  assert.match(
    text,
    /import\s*\{[^}]*\bcaptureAfterCanonicalBuild\b[^}]*\}\s*from\s*"\.\/kit-canonical-capture\.mjs"/,
  );
  assert.ok(text.includes("CANONICAL_CAPTURE_DIRECTORY"), "capture directory comes from env");
  const build = /runCommand\(\s*"npm",\s*\[\s*"run",\s*"build",\s*"--prefix",\s*"web"\s*\]/g;
  assert.equal(text.match(build)?.length, 1, "exactly one npm build execution");
  const start = text.indexOf("captureAfterCanonicalBuild(");
  const collect = text.indexOf("await collect(");
  assert.ok(start >= 0 && collect > start, "capture call precedes collect");
  assert.equal(text.split("captureAfterCanonicalBuild(").length - 1, 1);
  const buildOperation = text.indexOf("const runBuild = () =>");
  assert.ok(buildOperation >= 0 && buildOperation < start, "one build callback is defined first");
  assert.match(text.slice(buildOperation, start), build, "callback owns the one build command");
  const wrapped = text.slice(start, collect);
  assert.match(wrapped, /\brunBuild,\s*\);/, "capture wrapper receives the build callback");
  assert.match(wrapped, /else\s*\{\s*await runBuild\(\);/, "non-capture callers retain the build");
  assert.ok(
    text.slice(collect).includes("cli: tools.cli"),
    "startup collection invocation preserved",
  );
  assert.equal(text.split("await collect(").length - 1, 1);
});
