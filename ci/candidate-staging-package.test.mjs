import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  admitCandidateBundle,
  candidateIdentity,
  candidateSha256,
} from "./candidate-staging-admission.mjs";
import {
  collectCandidateKitPackage,
  finalizeCandidateProducerReceipt,
} from "./candidate-staging-package.mjs";

const REFUSED = { message: "Candidate package refused: output" };
const RECEIPT_REFUSED = { message: "Candidate package refused: receipt" };
const WORKER = Buffer.from(
  "globalThis.__candidatePackageExecuted = true; throw new Error('candidate sentinel');",
);
const MAX = 16 * 1024 * 1024;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "candidate-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assets = join(root, "cloudflare");
  mkdirSync(assets);
  writeFileSync(
    join(assets, "_worker.js"),
    "import { server } from '../cloudflare-tmp/server.js';",
  );
  writeFileSync(join(assets, "_headers"), "/*\n  Candidate-Header: must-not-publish");
  function file(path, bytes = "asset") {
    const parts = path.split("/");
    mkdirSync(join(assets, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(assets, path), bytes);
  }
  return { root, assets, file, options: { assetRoot: assets, worker: WORKER } };
}

function identity() {
  return candidateIdentity(
    { prNumber: "42", headSha: "a".repeat(40), ciRunId: "100", ciRunAttempt: "1" },
    {
      repositoryId: "1234",
      repository: "TogetherWeOwn/two-web-next",
      controllerSha: "b".repeat(40),
      launcherSha: "c".repeat(40),
      checkoutSha: "b".repeat(40),
      runId: "200",
      runAttempt: "1",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      path: ".github/workflows/candidate-staging.yml",
    },
  );
}

function receiptOptions(files) {
  const build = { runId: "500", runAttempt: "1", artifactId: "600", archiveSha256: "d".repeat(64) };
  return {
    identity: identity(),
    build,
    files,
    artifact: {
      id: 600,
      expired: false,
      digest: `sha256:${build.archiveSha256}`,
      workflow_run: {
        id: 500,
        repository_id: 1234,
        head_repository_id: 1234,
        head_sha: "a".repeat(40),
      },
    },
  };
}

test("package maps Kit assets, discards root controls, sorts records and never executes bytes", (t) => {
  const w = fixture(t);
  w.file("_app/immutable/chunks/B_a-1.js");
  w.file("_app/version.json", "{}");
  w.file("styles.css", "body{}");
  w.file("empty.txt", "");
  const output = collectCandidateKitPackage(w.options);
  assert.deepEqual(
    output.files.map((f) => f.path),
    [
      "assets/_app/immutable/chunks/B_a-1.js",
      "assets/_app/version.json",
      "assets/empty.txt",
      "assets/styles.css",
      "worker/worker.mjs",
    ],
  );
  assert.equal(output.ignoredControlFiles, 2);
  assert.equal(output.bytes, WORKER.length + 5 + 2 + 6);
  assert.equal(output.files.at(-1).bytes.equals(WORKER), true);
  assert.notEqual(output.files.at(-1).bytes, WORKER);
  assert.equal(globalThis.__candidatePackageExecuted, undefined);
  const o = receiptOptions(output.files);
  const receipt = finalizeCandidateProducerReceipt(o);
  assert.deepEqual(admitCandidateBundle(o.identity, o.build, o.artifact, receipt, output.files), {
    rootSha256: receipt.rootSha256,
    bytes: output.bytes,
    files: output.files.length,
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.files), true);
  assert.equal(Object.isFrozen(receipt.files[0]), true);
  assert.equal(
    receipt.rootSha256,
    candidateSha256(JSON.stringify(receipt.files.map((f) => [f.path, f.size, f.sha256]))),
  );
  assert.doesNotMatch(JSON.stringify(receipt), /candidate sentinel|Candidate-Header/);
});

test("adapter .assetsignore is discarded without interpreting candidate ignore rules", (t) => {
  const w = fixture(t);
  w.file(".assetsignore", "*\nprivate-candidate-ignore-rule\n");
  w.file("styles.css", "body{}");
  const result = collectCandidateKitPackage(w.options);
  assert.equal(result.ignoredControlFiles, 3);
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["assets/styles.css", "worker/worker.mjs"],
  );
});

test("headers are optional and empty asset sets are module-only", (t) => {
  const w = fixture(t);
  rmSync(join(w.assets, "_headers"));
  const result = collectCandidateKitPackage(w.options);
  assert.equal(result.files.length, 1);
  assert.equal(result.ignoredControlFiles, 1);
});

for (const name of [
  "_redirects",
  "_routes.json",
  "nested/.assetsignore",
  "_HEADERS",
  "_WORKER.JS",
  "nested/_headers",
  "nested/_worker.js",
  "nested/_redirects",
]) {
  test(`package rejects unexpected control ${name}`, (t) => {
    const w = fixture(t);
    w.file(name);
    assert.throws(() => collectCandidateKitPackage(w.options), REFUSED);
  });
}

for (const name of [
  ".env",
  ".secret/file",
  "with space.txt",
  "percent%2e.txt",
  "unicodé.txt",
  "back\\slash.txt",
]) {
  test(`package rejects unsafe asset name ${name}`, (t) => {
    const w = fixture(t);
    w.file(name);
    assert.throws(() => collectCandidateKitPackage(w.options), REFUSED);
  });
}

for (const [a, b] of [
  ["x.css", "X.css"],
  ["dir/a", "DIR/b"],
]) {
  test(`package rejects case collision ${a} and ${b}`, (t) => {
    const w = fixture(t);
    w.file(a);
    w.file(b);
    assert.throws(() => collectCandidateKitPackage(w.options), REFUSED);
  });
}

for (const kind of ["asset", "directory", "worker", "headers", "root", "hardlink", "fifo"]) {
  test(`package rejects ${kind} links or special files without following or waiting`, (t) => {
    const w = fixture(t);
    writeFileSync(join(w.root, "private.txt"), "must-not-read");
    let options = w.options;
    if (kind === "asset") symlinkSync("../private.txt", join(w.assets, "asset.txt"));
    if (kind === "directory") symlinkSync(w.root, join(w.assets, "directory"));
    if (kind === "worker" || kind === "headers") {
      const name = kind === "worker" ? "_worker.js" : "_headers";
      rmSync(join(w.assets, name));
      symlinkSync("../private.txt", join(w.assets, name));
    }
    if (kind === "root") {
      symlinkSync(w.assets, join(w.root, "alias"));
      options = { ...options, assetRoot: join(w.root, "alias") };
    }
    if (kind === "hardlink") linkSync(join(w.root, "private.txt"), join(w.assets, "alias.txt"));
    if (kind === "fifo") execFileSync("mkfifo", [join(w.assets, "pipe.txt")]);
    assert.throws(() => collectCandidateKitPackage(options), REFUSED);
  });
}

for (const kind of [
  "worker-directory",
  "header-directory",
  "missing-worker",
  "oversize-worker",
  "oversize-file",
  "total-bytes",
  "count",
  "depth",
  "path-length",
]) {
  test(`package rejects ${kind} incomplete or unbounded output`, (t) => {
    const w = fixture(t);
    let options = w.options;
    if (kind.endsWith("directory")) {
      const name = kind === "worker-directory" ? "_worker.js" : "_headers";
      rmSync(join(w.assets, name));
      mkdirSync(join(w.assets, name));
    }
    if (kind === "missing-worker") rmSync(join(w.assets, "_worker.js"));
    if (kind === "oversize-worker") options = { ...options, worker: Buffer.alloc(MAX + 1) };
    if (kind === "oversize-file") w.file("big.bin", Buffer.alloc(MAX + 1));
    if (kind === "total-bytes") w.file("big.bin", Buffer.alloc(MAX));
    if (kind === "count") for (let i = 0; i < 4096; i++) w.file(`asset-${i}`, "");
    if (kind === "depth") w.file(`${"a/".repeat(17)}asset.txt`);
    if (kind === "path-length") w.file(`${"a".repeat(230)}/asset.txt`);
    assert.throws(() => collectCandidateKitPackage(options), REFUSED);
  });
}

for (const edit of [
  (o) => {
    o.extra = true;
  },
  (o) => {
    o.assetRoot = "relative";
  },
  (o) => {
    o.worker = new Uint8Array([1]);
  },
  (o) => {
    o.worker = Buffer.alloc(0);
  },
]) {
  test("package rejects malformed options", (t) => {
    const w = fixture(t);
    const o = { ...w.options };
    edit(o);
    assert.throws(() => collectCandidateKitPackage(o), REFUSED);
  });
}

test("repeated refusals do not leak directory or file descriptors", (t) => {
  const w = fixture(t);
  w.file("z/asset");
  symlinkSync("../../private", join(w.assets, "z/link"));
  const count = readdirSync("/proc/self/fd").length;
  for (let i = 0; i < 30; i++) assert.throws(() => collectCandidateKitPackage(w.options), REFUSED);
  assert.equal(readdirSync("/proc/self/fd").length, count);
});

for (const [name, edit] of [
  [
    "Q",
    (o) => {
      o.identity = { ...o.identity, q: "e".repeat(64) };
    },
  ],
  [
    "descriptor schema",
    (o) => {
      o.identity = structuredClone(o.identity);
      o.identity.descriptor[0] = "other";
    },
  ],
  [
    "identity extra",
    (o) => {
      o.identity = { ...o.identity, extra: true };
    },
  ],
  [
    "archive",
    (o) => {
      o.build.archiveSha256 = "e".repeat(64);
    },
  ],
  [
    "artifact",
    (o) => {
      o.artifact.id++;
    },
  ],
  [
    "head",
    (o) => {
      o.artifact.workflow_run.head_sha = "e".repeat(40);
    },
  ],
  [
    "repository",
    (o) => {
      o.artifact.workflow_run.head_repository_id++;
    },
  ],
  [
    "expired",
    (o) => {
      o.artifact.expired = true;
    },
  ],
  [
    "build run",
    (o) => {
      o.build.runId = "501";
    },
  ],
  [
    "build shape",
    (o) => {
      o.build.extra = true;
    },
  ],
  [
    "missing entrypoint",
    (o) => {
      o.files = [];
    },
  ],
  [
    "duplicate",
    (o) => {
      o.files.push(o.files[0]);
    },
  ],
  [
    "link type",
    (o) => {
      o.files[0].type = "symlink";
    },
  ],
  [
    "path",
    (o) => {
      o.files[0].path = "../private.txt";
    },
  ],
  [
    "bytes",
    (o) => {
      o.files[0].bytes = "not bytes";
    },
  ],
  [
    "file extra",
    (o) => {
      o.files[0].extra = true;
    },
  ],
]) {
  test(`receipt refuses mismatched ${name}`, (t) => {
    const w = fixture(t);
    const o = receiptOptions(collectCandidateKitPackage(w.options).files);
    edit(o);
    assert.throws(() => finalizeCandidateProducerReceipt(o), RECEIPT_REFUSED);
  });
}

test("receipt refuses aggregate bytes and oversized downstream producer manifests", () => {
  const worker = { path: "worker/worker.mjs", type: "file", bytes: Buffer.from("x") };
  assert.throws(
    () =>
      finalizeCandidateProducerReceipt(
        receiptOptions([
          worker,
          { path: "assets/big.bin", type: "file", bytes: Buffer.alloc(MAX) },
        ]),
      ),
    RECEIPT_REFUSED,
  );
  const files = [worker];
  for (let i = 0; i < 4095; i++) {
    files.push({
      path: `assets/${"a".repeat(220)}${String(i).padStart(4, "0")}.txt`,
      type: "file",
      bytes: Buffer.alloc(0),
    });
  }
  assert.throws(() => finalizeCandidateProducerReceipt(receiptOptions(files)), RECEIPT_REFUSED);
});

test("receipt accepts the exact file-count boundary with a bounded manifest", () => {
  const files = [{ path: "worker/worker.mjs", type: "file", bytes: Buffer.from("x") }];
  for (let i = 0; i < 4095; i++)
    files.push({ path: `assets/a${i}`, type: "file", bytes: Buffer.alloc(0) });
  const result = finalizeCandidateProducerReceipt(receiptOptions(files));
  assert.equal(result.files.length, 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024);
});

test("collector bounds empty directories as well as files", (t) => {
  const w = fixture(t);
  for (let i = 0; i < 8192; i++) mkdirSync(join(w.assets, `dir-${i}`));
  assert.throws(() => collectCandidateKitPackage(w.options), REFUSED);
});

test("receipt deterministically records copied bytes independent of input order", (t) => {
  const w = fixture(t);
  w.file("styles.css");
  const files = collectCandidateKitPackage(w.options).files;
  const o = receiptOptions(files);
  const a = finalizeCandidateProducerReceipt(o);
  const b = finalizeCandidateProducerReceipt({ ...o, files: [...files].reverse() });
  assert.deepEqual(a, b);
  files[0].bytes.fill(0);
  assert.notDeepEqual(finalizeCandidateProducerReceipt(o), a);
  assert.throws(
    () => admitCandidateBundle(o.identity, o.build, o.artifact, a, files),
    /bundle-file-digest/,
  );
});
