import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import {
  collectCandidateKitPackage,
  createRebuiltBaselineManifest,
  finalizeRebuiltBaselineProducerReceipt,
} from "./candidate-staging-package.mjs";

const MANIFEST_REFUSED = { message: "Candidate package refused: rebuild-manifest" };
const PAIR_REFUSED = { message: "Candidate package refused: rebuild-pair" };
const CONFIG = "1".repeat(64);
const RECIPE = "2".repeat(64);
const JS = "application/javascript+module";
const MAP = "application/source-map";

const COMPONENTS = [
  { id: "web", mainModule: "worker/worker.mjs", assets: "present", sourceMaps: [] },
  { id: "jobs", mainModule: "index.js", assets: "empty", sourceMaps: ["index.js.map"] },
  { id: "tail", mainModule: "tail.js", assets: "none", sourceMaps: [] },
];

function rec(component, kind, path, text = path) {
  return {
    component,
    kind,
    path,
    type: "file",
    bytes: Buffer.from(text),
    contentType: kind === "asset" ? null : kind === "source-map" ? MAP : JS,
  };
}

function files() {
  return [
    rec("web", "module", "worker/worker.mjs"),
    rec("web", "asset", "assets/_app/version.json", "{}"),
    rec("jobs", "module", "index.js"),
    rec("jobs", "source-map", "index.js.map", "{}"),
    rec("tail", "module", "tail.js"),
  ];
}

function manifestOptions(overrides = {}) {
  return {
    components: structuredClone(COMPONENTS),
    configDigest: CONFIG,
    recipeDigest: RECIPE,
    files: files(),
    ...overrides,
  };
}

function build(n, overrides = {}) {
  const manifest = createRebuiltBaselineManifest(manifestOptions());
  const archiveSha256 = String(n).repeat(64);
  const selection = {
    runId: `${n}00`,
    runAttempt: "1",
    jobId: `${n}10`,
    artifactId: `${n}20`,
    archiveSha256,
  };
  return {
    selection,
    files: files(),
    artifact: {
      id: Number(selection.artifactId),
      expired: false,
      digest: `sha256:${archiveSha256}`,
      workflow_run: {
        id: Number(selection.runId),
        repository_id: 1234,
        head_repository_id: 1234,
        head_sha: "b".repeat(40),
      },
    },
    producer: {
      schema: "two.rebuilt-baseline-producer.v1",
      repositoryId: "1234",
      sourceSha: "a".repeat(40),
      producerSha: "b".repeat(40),
      ...selection,
      manifestRoot: manifest.rootSha256,
    },
    ...overrides,
  };
}

function pairOptions(builds = [build(3), build(4)], expected = {}) {
  return {
    expected: {
      repositoryId: "1234",
      sourceSha: "a".repeat(40),
      producerSha: "b".repeat(40),
      components: structuredClone(COMPONENTS),
      configDigest: CONFIG,
      recipeDigest: RECIPE,
      ...expected,
    },
    builds,
  };
}

test("manifest root is the sha256 of fixed canonical JSON plus LF, not any archive hash", () => {
  const m = createRebuiltBaselineManifest(manifestOptions());
  assert.equal(m.canonical.endsWith("]\n"), true);
  assert.equal(m.canonical.endsWith("\n\n"), false);
  const parsed = JSON.parse(m.canonical);
  assert.equal(parsed[0], "two.rebuilt-baseline-manifest.v1");
  assert.deepEqual(parsed.slice(2), [CONFIG, RECIPE]);
  const expectedRecords = [files()[2], files()[3], files()[4], files()[1], files()[0]].map((f) => [
    f.component,
    f.kind,
    f.path,
    f.bytes.length,
    candidateSha256(f.bytes),
    f.contentType,
  ]);
  assert.equal(
    m.canonical,
    `${JSON.stringify(["two.rebuilt-baseline-manifest.v1", expectedRecords, CONFIG, RECIPE])}\n`,
  );
  assert.equal(m.rootSha256, candidateSha256(Buffer.from(m.canonical)));
  assert.equal(m.promotable, false);
  assert.equal(m.scope, "complete-retained-manifest-only");
  assert.equal(
    m.bytes,
    files().reduce((n, f) => n + f.bytes.length, 0),
  );
});

test("manifest inventories every component with explicit none, empty and present assets", () => {
  const m = createRebuiltBaselineManifest(manifestOptions());
  assert.deepEqual(
    m.files.map((f) => [f.component, f.kind, f.path]),
    [
      ["jobs", "module", "index.js"],
      ["jobs", "source-map", "index.js.map"],
      ["tail", "module", "tail.js"],
      ["web", "asset", "assets/_app/version.json"],
      ["web", "module", "worker/worker.mjs"],
    ],
  );
  assert.deepEqual(
    m.components.map((c) => [c.id, c.assets]),
    [
      ["jobs", "empty"],
      ["tail", "none"],
      ["web", "present"],
    ],
  );
  assert.equal(Object.isFrozen(m), true);
  assert.equal(Object.isFrozen(m.files), true);
  assert.equal(Object.isFrozen(m.files[0]), true);
});

test("manifest root is independent of input file and component order", () => {
  const a = createRebuiltBaselineManifest(manifestOptions());
  const b = createRebuiltBaselineManifest(
    manifestOptions({
      files: files().reverse(),
      components: structuredClone(COMPONENTS).reverse(),
    }),
  );
  assert.equal(a.rootSha256, b.rootSha256);
});

test("changed bytes, config and recipe change the root", () => {
  const base = createRebuiltBaselineManifest(manifestOptions()).rootSha256;
  const changed = files();
  changed[0].bytes = Buffer.from("different");
  const roots = [
    createRebuiltBaselineManifest(manifestOptions({ files: changed })).rootSha256,
    createRebuiltBaselineManifest(manifestOptions({ configDigest: "3".repeat(64) })).rootSha256,
    createRebuiltBaselineManifest(manifestOptions({ recipeDigest: "3".repeat(64) })).rootSha256,
  ];
  for (const root of roots) assert.notEqual(root, base);
});

test("manifest copies bytes at creation so later mutation or aliasing cannot alter it", () => {
  const input = manifestOptions();
  const m = createRebuiltBaselineManifest(input);
  const { canonical, rootSha256 } = m;
  input.files[0].bytes.fill(0x7a);
  input.files.pop();
  input.components[0].id = "mutated";
  assert.equal(m.canonical, canonical);
  assert.equal(m.rootSha256, rootSha256);
  assert.throws(() => {
    "use strict";
    m.files[0].sha256 = "0".repeat(64);
  }, TypeError);
});

test("manifest requires the unchanged-stamp coverage rules for modules and source maps", () => {
  const mutate = (fn) => {
    const o = manifestOptions();
    fn(o);
    return o;
  };
  const cases = {
    "missing main module": (o) => o.files.splice(2, 1),
    "empty main module": (o) => (o.files[2].bytes = Buffer.alloc(0)),
    "missing required source map": (o) => o.files.splice(3, 1),
    "unlisted extra source map": (o) => o.files.push(rec("tail", "source-map", "tail.js.map")),
    "wrong source map name": (o) => (o.files[3].path = "other.js.map"),
    "assets present but none given": (o) => o.files.splice(1, 1),
    "assets none but one given": (o) => o.files.push(rec("tail", "asset", "a.txt")),
    "assets empty but one given": (o) => o.files.push(rec("jobs", "asset", "a.txt")),
  };
  for (const [name, fn] of Object.entries(cases)) {
    assert.throws(() => createRebuiltBaselineManifest(mutate(fn)), MANIFEST_REFUSED, name);
  }
});

test("manifest refuses unsafe, traversal, encoded, hidden and overlong paths", () => {
  for (const path of [
    "../x.js",
    "/abs.js",
    "a//b.js",
    "a/./b.js",
    "a/../b.js",
    ".hidden.js",
    "a/.hidden.js",
    "a\\b.js",
    "café.js",
    "a%2e.js",
    "a b.js",
    "a/",
    "",
    `${"a".repeat(241)}.js`,
    "a\0.js",
  ]) {
    const o = manifestOptions();
    o.files.push(rec("tail", "module", path));
    assert.throws(() => createRebuiltBaselineManifest(o), MANIFEST_REFUSED, JSON.stringify(path));
  }
});

test("manifest refuses case, ancestor, file-directory and duplicate collisions", () => {
  const cases = [
    [rec("tail", "module", "Tail.js")],
    [rec("tail", "module", "tail.js")],
    [rec("tail", "module", "tail.js/child.js")],
    [rec("tail", "module", "Dir/a.js"), rec("tail", "module", "dir/b.js")],
    [rec("tail", "module", "d/a.js"), rec("tail", "module", "d")],
    [rec("web", "asset", "assets/A.txt"), rec("web", "asset", "assets/a.txt")],
    [rec("web", "asset", "assets/x"), rec("web", "asset", "assets/x/y")],
  ];
  for (const extra of cases) {
    const o = manifestOptions();
    o.files.push(...extra);
    assert.throws(() => createRebuiltBaselineManifest(o), MANIFEST_REFUSED, extra[0].path);
  }
});

test("manifest refuses unknown components, bad kinds, types, content types and extra fields", () => {
  const cases = [
    (o) => (o.files[0].component = "unknown"),
    (o) => (o.files[0].kind = "script"),
    (o) => (o.files[0].type = "symlink"),
    (o) => (o.files[0].type = "directory"),
    (o) => (o.files[0].bytes = "text"),
    (o) => (o.files[0].contentType = "text/plain"),
    (o) => (o.files[1].contentType = JS),
    (o) => (o.files[3].contentType = JS),
    (o) => (o.files[0].extra = true),
    (o) => delete o.files[0].contentType,
    (o) => (o.extra = true),
    (o) => delete o.recipeDigest,
    (o) => (o.configDigest = "A".repeat(64)),
    (o) => (o.recipeDigest = "2".repeat(63)),
    (o) => (o.components[0].extra = true),
    (o) => (o.components[0].assets = "maybe"),
    (o) => (o.components[0].id = "Web"),
    (o) => o.components.push({ ...o.components[0] }),
    (o) => (o.components = []),
    (o) => (o.components[1].sourceMaps = ["index.js.map", "index.js.map"]),
    (o) => (o.components[1].sourceMaps = ["index.js"]),
    (o) => (o.files = []),
  ];
  for (const fn of cases) {
    const o = manifestOptions();
    fn(o);
    assert.throws(() => createRebuiltBaselineManifest(o), MANIFEST_REFUSED, String(fn));
  }
});

test("manifest refuses malformed, sparse and non-array inputs", () => {
  const sparseFiles = new Array(5);
  sparseFiles[0] = rec("tail", "module", "tail.js");
  const sparseComponents = new Array(2);
  sparseComponents[1] = COMPONENTS[2];
  for (const o of [
    manifestOptions({ files: sparseFiles }),
    manifestOptions({ components: sparseComponents }),
    manifestOptions({ files: "files" }),
    manifestOptions({ components: null }),
    manifestOptions({ files: [null] }),
    null,
    [],
    "options",
  ]) {
    assert.throws(() => createRebuiltBaselineManifest(o), MANIFEST_REFUSED);
  }
});

test("manifest enforces total byte and file count bounds", () => {
  const big = manifestOptions();
  big.files[0].bytes = Buffer.alloc(16 * 1024 * 1024);
  assert.throws(() => createRebuiltBaselineManifest(big), MANIFEST_REFUSED);
  const many = manifestOptions();
  for (let i = 0; i < 4097; i++) many.files.push(rec("web", "asset", `assets/f${i}.txt`, ""));
  assert.throws(() => createRebuiltBaselineManifest(many), MANIFEST_REFUSED);
  const maps = manifestOptions();
  maps.components[2].sourceMaps = Array.from({ length: 4097 }, (_, i) => `m${i}.map`);
  assert.throws(() => createRebuiltBaselineManifest(maps), MANIFEST_REFUSED);
});

test("pair joins two distinct artifacts and jobs into a non-promotable, non-admitting result", () => {
  const pair = finalizeRebuiltBaselineProducerReceipt(pairOptions());
  assert.equal(pair.schema, "two.rebuilt-baseline-pair.v1");
  assert.equal(pair.promotable, false);
  assert.equal(pair.operationalAdmission, false);
  assert.equal(pair.scope, "paired-retained-manifests-only");
  assert.equal(pair.repositoryId, "1234");
  assert.equal(pair.sourceSha, "a".repeat(40));
  assert.equal(pair.producerSha, "b".repeat(40));
  assert.deepEqual(pair.builds, [build(3).selection, build(4).selection]);
  assert.equal(
    pair.manifest.rootSha256,
    createRebuiltBaselineManifest(manifestOptions()).rootSha256,
  );
  assert.equal(Object.isFrozen(pair), true);
  assert.equal(Object.isFrozen(pair.builds), true);
  assert.equal(Object.isFrozen(pair.builds[0]), true);
});

test("pair refuses wrong build count, duplicate job, duplicate artifact and extra fields", () => {
  const dupJob = build(4);
  dupJob.selection.jobId = build(3).selection.jobId;
  dupJob.producer.jobId = dupJob.selection.jobId;
  const dupArtifact = build(4);
  dupArtifact.selection.artifactId = build(3).selection.artifactId;
  dupArtifact.producer.artifactId = dupArtifact.selection.artifactId;
  dupArtifact.artifact.id = Number(dupArtifact.selection.artifactId);
  const cases = [
    pairOptions([build(3)]),
    pairOptions([build(3), build(4), build(5)]),
    pairOptions([build(3), build(3)]),
    pairOptions([build(3), dupJob]),
    pairOptions([build(3), dupArtifact]),
    pairOptions([build(3), { ...build(4), extra: 1 }]),
    { ...pairOptions(), extra: 1 },
    pairOptions([build(3), build(4)], { extra: 1 }),
    pairOptions("builds"),
    null,
  ];
  for (const o of cases)
    assert.throws(() => finalizeRebuiltBaselineProducerReceipt(o), PAIR_REFUSED);
});

test("pair refuses artifact metadata that is expired or mismatched on repo, digest, run, head or id", () => {
  const cases = {
    expired: (a) => (a.expired = true),
    "expired not boolean": (a) => (a.expired = "false"),
    "wrong artifact id": (a) => (a.id += 1),
    "string artifact id": (a) => (a.id = String(a.id)),
    "wrong digest": (a) => (a.digest = `sha256:${"9".repeat(64)}`),
    "digest without prefix": (a) => (a.digest = a.digest.slice(7)),
    "wrong run": (a) => (a.workflow_run.id += 1),
    "wrong repository": (a) => (a.workflow_run.repository_id = 9999),
    "wrong head repository": (a) => (a.workflow_run.head_repository_id = 9999),
    "wrong head sha": (a) => (a.workflow_run.head_sha = "c".repeat(40)),
    "source sha is not producer sha": (a) => (a.workflow_run.head_sha = "a".repeat(40)),
    "missing run": (a) => delete a.workflow_run,
  };
  for (const [name, fn] of Object.entries(cases)) {
    const bad = build(4);
    fn(bad.artifact);
    assert.throws(
      () => finalizeRebuiltBaselineProducerReceipt(pairOptions([build(3), bad])),
      PAIR_REFUSED,
      name,
    );
  }
  assert.throws(
    () =>
      finalizeRebuiltBaselineProducerReceipt(pairOptions([build(3), build(4, { artifact: null })])),
    PAIR_REFUSED,
  );
});

test("pair refuses producer records with wrong root, ids, source, producer, schema or extra fields", () => {
  const cases = {
    "wrong root": (p) => (p.manifestRoot = "9".repeat(64)),
    "zip digest as root": (p) => (p.manifestRoot = p.archiveSha256),
    "wrong run": (p) => (p.runId = "999"),
    "wrong attempt": (p) => (p.runAttempt = "2"),
    "wrong job": (p) => (p.jobId = "999"),
    "wrong artifact": (p) => (p.artifactId = "999"),
    "wrong archive": (p) => (p.archiveSha256 = "9".repeat(64)),
    "wrong repository": (p) => (p.repositoryId = "99"),
    "wrong source": (p) => (p.sourceSha = "c".repeat(40)),
    "wrong producer": (p) => (p.producerSha = "c".repeat(40)),
    "wrong schema": (p) => (p.schema = "two.rebuilt-baseline-producer.v2"),
    "extra field": (p) => (p.extra = true),
    "missing field": (p) => delete p.runAttempt,
  };
  for (const [name, fn] of Object.entries(cases)) {
    const bad = build(4);
    fn(bad.producer);
    assert.throws(
      () => finalizeRebuiltBaselineProducerReceipt(pairOptions([build(3), bad])),
      PAIR_REFUSED,
      name,
    );
  }
});

test("pair refuses malformed selection ids and digests", () => {
  for (const [key, value] of [
    ["runId", "0"],
    ["runId", "01"],
    ["runAttempt", 1],
    ["jobId", "-1"],
    ["artifactId", "1e3"],
    ["archiveSha256", "A".repeat(64)],
  ]) {
    const bad = build(4);
    bad.selection[key] = value;
    bad.producer[key] = value;
    assert.throws(
      () => finalizeRebuiltBaselineProducerReceipt(pairOptions([build(3), bad])),
      PAIR_REFUSED,
      `${key}=${value}`,
    );
  }
});

test("pair refuses same-root-wrong-config, recipe, source or producer expectations", () => {
  for (const expected of [
    { configDigest: "3".repeat(64) },
    { recipeDigest: "3".repeat(64) },
    { sourceSha: "c".repeat(40) },
    { producerSha: "c".repeat(40) },
    { repositoryId: "99" },
    { components: COMPONENTS.slice(1) },
    { components: COMPONENTS.map((c) => (c.id === "web" ? { ...c, assets: "empty" } : c)) },
  ]) {
    assert.throws(
      () => finalizeRebuiltBaselineProducerReceipt(pairOptions([build(3), build(4)], expected)),
      PAIR_REFUSED,
      JSON.stringify(expected).slice(0, 60),
    );
  }
});

test("pair refuses when either build has a changed, missing, extra or incomplete file", () => {
  const cases = [
    (f) => (f[0].bytes = Buffer.from("changed")),
    (f) => f.pop(),
    (f) => f.push(rec("tail", "module", "extra.js")),
    (f) => (f[1].path = "assets/other.json"),
    (f) => (f[4].component = "web"),
  ];
  for (const fn of cases) {
    for (const index of [0, 1]) {
      const builds = [build(3), build(4)];
      fn(builds[index].files);
      assert.throws(
        () => finalizeRebuiltBaselineProducerReceipt(pairOptions(builds)),
        PAIR_REFUSED,
      );
    }
  }
});

test("pair compares both recomputed manifests even when each protected record has its correct root", () => {
  for (const change of [
    (f) => (f[1].bytes = Buffer.from('{"stamp":"2026-11-05T21:00:00Z"}')),
    (f) => (f[1].path = "assets/renamed.json"),
    (f) => f.push(rec("tail", "module", "extra.js")),
  ]) {
    const second = build(4);
    change(second.files);
    second.producer.manifestRoot = createRebuiltBaselineManifest(
      manifestOptions({ files: second.files }),
    ).rootSha256;
    assert.notEqual(second.producer.manifestRoot, build(3).producer.manifestRoot);
    assert.throws(
      () => finalizeRebuiltBaselineProducerReceipt(pairOptions([build(3), second])),
      PAIR_REFUSED,
    );
  }
});

test("manifest counts canonical metadata in its byte limit and bounds directory nodes", () => {
  const metadata = manifestOptions();
  const others = metadata.files.slice(1).reduce((n, f) => n + f.bytes.length, 0);
  metadata.files[0].bytes = Buffer.alloc(16 * 1024 * 1024 - others);
  assert.throws(() => createRebuiltBaselineManifest(metadata), MANIFEST_REFUSED);
  const nodes = manifestOptions();
  for (let i = 0; i < 3000; i++) nodes.files.push(rec("web", "asset", `d${i}/sub/f`, ""));
  assert.throws(() => createRebuiltBaselineManifest(nodes), MANIFEST_REFUSED);
});

test("pair resists mutation of caller inputs after finalization and aliased file arrays", () => {
  const options = pairOptions();
  const pair = finalizeRebuiltBaselineProducerReceipt(options);
  const root = pair.manifest.rootSha256;
  options.builds[0].files[0].bytes.fill(0x7a);
  options.builds[0].selection.runId = "999";
  options.expected.components[0].id = "mutated";
  assert.equal(pair.manifest.rootSha256, root);
  assert.equal(pair.builds[0].runId, "300");
  const shared = files();
  const a = build(3, { files: shared });
  const b = build(4, { files: shared });
  assert.equal(
    finalizeRebuiltBaselineProducerReceipt(pairOptions([a, b])).manifest.rootSha256,
    root,
  );
});

test("collected Kit package feeds typed components, a complete manifest and the pair without building", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "candidate-rebuild-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const assets = join(dir, "cloudflare");
  mkdirSync(join(assets, "_app"), { recursive: true });
  writeFileSync(join(assets, "_worker.js"), "throw new Error('candidate sentinel');");
  writeFileSync(join(assets, "_headers"), "/*\n  Candidate-Header: no");
  writeFileSync(join(assets, "_app", "version.json"), "{}");
  writeFileSync(join(assets, "styles.css"), "body{}");
  const worker = Buffer.from("globalThis.__rebuildExecuted = true;");
  const collected = collectCandidateKitPackage({ assetRoot: assets, worker });
  assert.equal(globalThis.__rebuildExecuted, undefined);
  const typed = collected.files.map((f) =>
    f.path === "worker/worker.mjs"
      ? {
          component: "web",
          kind: "module",
          path: f.path,
          type: f.type,
          bytes: f.bytes,
          contentType: JS,
        }
      : {
          component: "web",
          kind: "asset",
          path: f.path,
          type: f.type,
          bytes: f.bytes,
          contentType: null,
        },
  );
  const tail = rec("tail", "module", "tail.js");
  const jobs = [rec("jobs", "module", "index.js"), rec("jobs", "source-map", "index.js.map")];
  const all = () => [...typed.map((f) => ({ ...f })), ...jobs.map((f) => ({ ...f })), { ...tail }];
  const manifest = createRebuiltBaselineManifest(manifestOptions({ files: all() }));
  assert.deepEqual(
    manifest.files.filter((f) => f.component === "web").map((f) => f.path),
    ["assets/_app/version.json", "assets/styles.css", "worker/worker.mjs"],
  );
  assert.equal(
    manifest.files.some((f) => f.path.includes("_headers")),
    false,
  );
  assert.doesNotMatch(manifest.canonical, /candidate sentinel|Candidate-Header/);
  const join2 = (n) => {
    const b = build(n, { files: all() });
    b.producer.manifestRoot = manifest.rootSha256;
    return b;
  };
  const pair = finalizeRebuiltBaselineProducerReceipt(pairOptions([join2(3), join2(4)]));
  assert.equal(pair.manifest.rootSha256, manifest.rootSha256);
  assert.equal(pair.operationalAdmission, false);
  assert.equal(pair.promotable, false);
});
