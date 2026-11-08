// Hermetic fixtures only: every tree lives under a temp directory. Nothing is
// built, uploaded or sent over the network, and no identity env is consulted.
// These tests pin the unqualified canonical-build byte capture: full trees,
// independent per-file gzip, exclusive frozen snapshot, and a verifier that
// recomputes everything from the copied bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  createCanonicalReceipt,
  freezeCanonicalBuild,
  verifyCanonicalBuild,
} from "./kit-upload-rehearsal.mjs";

const WORKER = "web/.svelte-kit/cloudflare/_worker.js";
const SERVER = "web/.svelte-kit/output/server";
const CLIENT = "web/.svelte-kit/output/client/_app";
const CLIENT_TREE = "web/.svelte-kit/output/client";
const CLOUDFLARE_TREE = "web/.svelte-kit/cloudflare";
const GROUP_IDS = ["kit.worker", "kit.server.js", "kit.client.js", "kit.client.css"];

const authority = () => ({
  KIT_WORKER_PATH: WORKER,
  KIT_SERVER_DIR: SERVER,
  KIT_CLIENT_DIR: CLIENT,
  KIT_GROUP_IDS: [...GROUP_IDS],
});

const base = realpathSync(mkdtempSync(join(tmpdir(), "kit-canonical-")));
after(() => rmSync(base, { recursive: true, force: true }));
let counter = 0;
const fresh = (label) => {
  const dir = join(base, `${label}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// Compressible, deterministic, and repeated so concatenation compresses
// differently from the sum of independent members.
const blob = (seed, n = 4000) => Buffer.from(`${seed}:${"abcdefghij0123456789".repeat(n / 20)}\n`);

function put(root, rel, bytes) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
}

function makeRoot(label = "root") {
  const root = fresh(label);
  // Non-UTF-8 bytes and CRLF must survive untouched.
  put(root, WORKER, Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a]), blob("worker")]));
  put(root, `${SERVER}/index.js`, blob("server-index"));
  put(root, `${SERVER}/chunks/a.js`, blob("server-a"));
  put(root, `${SERVER}/chunks/deep/b.js`, blob("server-b"));
  put(root, `${SERVER}/chunks/a.js.map`, blob("server-map"));
  put(root, `${SERVER}/manifest.json`, blob("server-json"));
  put(root, `${SERVER}/.assetsignore`, Buffer.from("_worker.js\n"));
  put(root, `${SERVER}/empty.txt`, Buffer.alloc(0));
  put(root, `${CLIENT}/version.json`, Buffer.from('{"version":"1"}'));
  put(root, `${CLIENT}/immutable/entry/start.js`, blob("client-start"));
  put(root, `${CLIENT}/immutable/entry/dup.js`, blob("client-start"));
  put(root, `${CLIENT}/immutable/chunks/c.js.map`, blob("client-map"));
  put(root, `${CLIENT}/immutable/assets/app.css`, blob("client-css"));
  put(root, `${CLIENT}/immutable/assets/nested/more.css`, blob("client-css2"));
  put(root, `${CLIENT}/.control`, Buffer.from("hidden control\n"));
  // The three trees are captured in full: non-_app client entries and other
  // adapter files are members with a null group.
  put(root, `${CLIENT_TREE}/robots.txt`, Buffer.from("robots\n"));
  put(root, `${CLIENT_TREE}/other.js`, blob("client-non-app-js"));
  put(root, `${CLOUDFLARE_TREE}/_headers`, Buffer.from("/*\n  X-Test: 1\n"));
  put(root, `${CLOUDFLARE_TREE}/.assetsignore`, Buffer.from("_worker.js\n"));
  put(root, `${CLOUDFLARE_TREE}/_app/immutable/adapter.js`, blob("adapter-js"));
  // Outside every tree.
  put(root, "web/package.json", Buffer.from("{}\n"));
  return root;
}

function walk(root, rel, out = [], directories = []) {
  directories.push(rel);
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(root, child, out, directories);
    else out.push(child);
  }
  return out;
}

function groupOf(path) {
  if (path === WORKER) return "kit.worker";
  if (path.startsWith(`${SERVER}/`) && path.endsWith(".js")) return "kit.server.js";
  if (path.startsWith(`${CLIENT}/`) && path.endsWith(".js")) return "kit.client.js";
  if (path.startsWith(`${CLIENT}/`) && path.endsWith(".css")) return "kit.client.css";
  return null;
}

function expectedReceipt(root) {
  const directories = [];
  const paths = [
    ...walk(root, CLOUDFLARE_TREE, [], directories),
    ...walk(root, SERVER, [], directories),
    ...walk(root, CLIENT_TREE, [], directories),
  ].sort();
  const files = paths.map((path) => {
    const bytes = readFileSync(join(root, path));
    return {
      path,
      group: groupOf(path),
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
  return {
    schema: "two.kit-canonical-build.v1",
    evidence: "unqualified-canonical-build-bytes",
    measurementRuntime: { node: process.versions.node, zlib: process.versions.zlib },
    directories: directories.sort(),
    files,
    totals: { files: files.length, bytes: sum(files, "bytes"), gzipBytes: sum(files, "gzipBytes") },
    groups: GROUP_IDS.map((id) => {
      const rows = files.filter((row) => row.group === id);
      return {
        id,
        files: rows.length,
        bytes: sum(rows, "bytes"),
        gzipBytes: sum(rows, "gzipBytes"),
      };
    }),
  };
}

// Content digest of a whole directory, for "unchanged" assertions.
function digest(root, rel = ".") {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(`${full}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  visit(join(root, rel));
  return out.sort();
}

const rejects = (fn) => assert.rejects(async () => fn());

function overwrite(path, bytes) {
  chmodSync(path, 0o644);
  unlinkSync(path);
  writeFileSync(path, bytes);
}

async function frozen(label = "snap") {
  const root = makeRoot(`${label}-root`);
  const destination = join(fresh(`${label}-out`), "build");
  const receipt = await freezeCanonicalBuild(root, destination, authority());
  return { root, destination, receipt };
}

function editReceipt(destination, mutate) {
  const path = join(destination, "receipt.json");
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  mutate(receipt);
  overwrite(path, JSON.stringify(receipt, null, 2));
}

test("createCanonicalReceipt returns the exact unqualified receipt for full trees", async () => {
  const root = makeRoot();
  const receipt = await createCanonicalReceipt(root, authority());
  assert.deepEqual(receipt, expectedReceipt(root));
  assert.deepEqual(Object.keys(receipt).sort(), [
    "directories",
    "evidence",
    "files",
    "groups",
    "measurementRuntime",
    "schema",
    "totals",
  ]);
  assert.equal(receipt.schema, "two.kit-canonical-build.v1");
  assert.equal(receipt.evidence, "unqualified-canonical-build-bytes");
  assert.deepEqual(
    receipt.groups.map((group) => group.id),
    GROUP_IDS,
  );
  for (const group of receipt.groups) assert.ok(group.files > 0, group.id);
});

test("nested empty directories survive capture and topology tampering fails", () => {
  const root = makeRoot("empty-topology");
  const empty = [
    `${SERVER}/entries/endpoints`,
    `${CLIENT_TREE}/.empty/nested`,
    `${CLOUDFLARE_TREE}/unused`,
  ];
  for (const path of empty) mkdirSync(join(root, path), { recursive: true });
  const before = createCanonicalReceipt(root, authority());
  for (const path of empty) assert.ok(before.directories.includes(path));
  assert.deepEqual(before.directories, [...before.directories].sort());
  assert.equal(new Set(before.directories).size, before.directories.length);
  const destination = join(fresh("empty-topology-out"), "build");
  const receipt = freezeCanonicalBuild(root, destination, authority());
  assert.deepEqual(receipt, before);
  for (const path of empty) {
    assert.ok(lstatSync(join(destination, path)).isDirectory());
    assert.deepEqual(readdirSync(join(destination, path)), []);
  }
  assert.deepEqual(verifyCanonicalBuild(destination, authority()), before);
  rmSync(join(destination, empty[0]), { recursive: true });
  assert.throws(() => verifyCanonicalBuild(destination, authority()), /receipt mismatch/);
  mkdirSync(join(destination, empty[0]));
  const extra = join(destination, SERVER, "unrecorded");
  mkdirSync(extra);
  assert.throws(() => verifyCanonicalBuild(destination, authority()), /receipt mismatch/);
  rmSync(extra, { recursive: true });
  rmSync(join(destination, empty[0]), { recursive: true });
  symlinkSync(join(destination, empty[2]), join(destination, empty[0]));
  assert.throws(() => verifyCanonicalBuild(destination, authority()), /not a regular file/);
});

test("receipt rows are sorted by full repo-relative path and keep exact keys", async () => {
  const receipt = await createCanonicalReceipt(makeRoot(), authority());
  const paths = receipt.files.map((row) => row.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(new Set(paths).size, paths.length);
  for (const row of receipt.files) {
    assert.deepEqual(Object.keys(row).sort(), ["bytes", "group", "gzipBytes", "path", "sha256"]);
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
    assert.ok(row.path.startsWith("web/.svelte-kit/"), row.path);
    assert.ok(!row.path.includes("\\"), row.path);
  }
});

test("hidden, map, json, version and empty files are included with null group", async () => {
  const receipt = await createCanonicalReceipt(makeRoot(), authority());
  const byPath = new Map(receipt.files.map((row) => [row.path, row]));
  for (const rel of [
    `${SERVER}/.assetsignore`,
    `${SERVER}/chunks/a.js.map`,
    `${SERVER}/manifest.json`,
    `${SERVER}/empty.txt`,
    `${CLIENT}/version.json`,
    `${CLIENT}/.control`,
    `${CLIENT}/immutable/chunks/c.js.map`,
    `${CLIENT_TREE}/robots.txt`,
    `${CLIENT_TREE}/other.js`,
    `${CLOUDFLARE_TREE}/_headers`,
    `${CLOUDFLARE_TREE}/.assetsignore`,
    `${CLOUDFLARE_TREE}/_app/immutable/adapter.js`,
  ]) {
    assert.ok(byPath.has(rel), `missing ${rel}`);
    assert.equal(byPath.get(rel).group, null, rel);
  }
  assert.equal(byPath.get(`${SERVER}/empty.txt`).bytes, 0);
  assert.equal(byPath.get(`${SERVER}/empty.txt`).gzipBytes, gzipSync(Buffer.alloc(0)).length);
  assert.equal(byPath.get(WORKER).group, "kit.worker");
  assert.equal(byPath.get(`${SERVER}/chunks/deep/b.js`).group, "kit.server.js");
  assert.equal(byPath.get(`${CLIENT}/immutable/entry/start.js`).group, "kit.client.js");
  assert.equal(byPath.get(`${CLIENT}/immutable/assets/nested/more.css`).group, "kit.client.css");
});

test("only the three full trees are captured", async () => {
  const receipt = await createCanonicalReceipt(makeRoot(), authority());
  const paths = receipt.files.map((row) => row.path);
  assert.ok(paths.includes(`${CLIENT_TREE}/robots.txt`));
  assert.ok(paths.includes(`${CLOUDFLARE_TREE}/_headers`));
  assert.ok(!paths.includes("web/package.json"));
  for (const path of paths) {
    assert.ok(
      [SERVER, CLIENT_TREE, CLOUDFLARE_TREE].some((tree) => path.startsWith(`${tree}/`)),
      path,
    );
  }
});

test("gzip is measured independently per file, never as a concatenation", async () => {
  const root = makeRoot();
  const receipt = await createCanonicalReceipt(root, authority());
  const all = [];
  for (const row of receipt.files) {
    const bytes = readFileSync(join(root, row.path));
    assert.equal(row.bytes, bytes.length, row.path);
    assert.equal(row.gzipBytes, gzipSync(bytes).length, row.path);
    all.push(bytes);
  }
  assert.equal(
    receipt.totals.gzipBytes,
    receipt.files.reduce((total, row) => total + row.gzipBytes, 0),
  );
  assert.notEqual(receipt.totals.gzipBytes, gzipSync(Buffer.concat(all)).length);
  const budgetOnly = receipt.files.filter((row) => row.group);
  assert.ok(receipt.totals.files > budgetOnly.length);
  assert.ok(receipt.totals.bytes > budgetOnly.reduce((total, row) => total + row.bytes, 0));
  // Duplicate-content members each pay their own gzip header.
  const a = receipt.files.find((row) => row.path.endsWith("immutable/entry/start.js"));
  const b = receipt.files.find((row) => row.path.endsWith("immutable/entry/dup.js"));
  assert.equal(a.gzipBytes, b.gzipBytes);
  assert.equal(a.sha256, b.sha256);
});

test("group totals only count their own budget members", async () => {
  const receipt = await createCanonicalReceipt(makeRoot(), authority());
  const clientJs = receipt.files.filter((row) => row.group === "kit.client.js");
  const group = receipt.groups.find((entry) => entry.id === "kit.client.js");
  assert.equal(group.files, clientJs.length);
  assert.equal(
    group.bytes,
    clientJs.reduce((total, row) => total + row.bytes, 0),
  );
  assert.equal(
    group.gzipBytes,
    clientJs.reduce((total, row) => total + row.gzipBytes, 0),
  );
  assert.equal(receipt.groups.find((entry) => entry.id === "kit.worker").files, 1);
});

test("receipt reads no identity env and makes no source or provenance claims", async () => {
  const names = [
    "GITHUB_SHA",
    "GITHUB_REF",
    "GITHUB_RUN_ID",
    "GITHUB_REPOSITORY",
    "CF_PAGES_COMMIT_SHA",
    "CI_COMMIT_SHA",
    "SOURCE_SHA",
    "BUILD_ID",
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const root = makeRoot();
  try {
    for (const name of names) delete process.env[name];
    const clean = await createCanonicalReceipt(root, authority());
    for (const name of names) process.env[name] = `sentinel-${name}-0123456789abcdef`;
    const loud = await createCanonicalReceipt(root, authority());
    assert.deepEqual(loud, clean);
    assert.ok(!JSON.stringify(loud).includes("sentinel-"));
    const forbidden = [
      "sourceSha",
      "commit",
      "provenance",
      "source",
      "workflow",
      "runId",
      "runAttempt",
    ];
    for (const name of forbidden) assert.ok(!Object.hasOwn(loud, name), name);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("absent or empty trees and missing groups are rejected", async () => {
  const cases = {
    "absent worker": (root) => unlinkSync(join(root, WORKER)),
    "worker is a directory": (root) => {
      unlinkSync(join(root, WORKER));
      mkdirSync(join(root, WORKER));
    },
    "absent server dir": (root) => rmSync(join(root, SERVER), { recursive: true }),
    "absent cloudflare dir": (root) => rmSync(join(root, CLOUDFLARE_TREE), { recursive: true }),
    "absent client tree": (root) => rmSync(join(root, CLIENT_TREE), { recursive: true }),
    "server with only empty directories": (root) => {
      rmSync(join(root, SERVER), { recursive: true });
      mkdirSync(join(root, SERVER, "chunks", "hollow"), { recursive: true });
    },
    "empty cloudflare dir": (root) => {
      rmSync(join(root, CLOUDFLARE_TREE), { recursive: true });
      mkdirSync(join(root, CLOUDFLARE_TREE));
    },
    "absent client dir": (root) => rmSync(join(root, CLIENT), { recursive: true }),
    "empty server dir": (root) => {
      rmSync(join(root, SERVER), { recursive: true });
      mkdirSync(join(root, SERVER));
    },
    "empty client dir": (root) => {
      rmSync(join(root, CLIENT), { recursive: true });
      mkdirSync(join(root, CLIENT));
    },
    "server without js": (root) => {
      for (const path of walk(root, SERVER)) if (path.endsWith(".js")) unlinkSync(join(root, path));
    },
    "client without js": (root) => {
      for (const path of walk(root, CLIENT)) if (path.endsWith(".js")) unlinkSync(join(root, path));
    },
    "client without css": (root) => {
      for (const path of walk(root, CLIENT))
        if (path.endsWith(".css")) unlinkSync(join(root, path));
    },
    "client css only": (root) => {
      for (const path of walk(root, CLIENT)) if (path.endsWith(".js")) unlinkSync(join(root, path));
      for (const path of walk(root, SERVER)) if (path.endsWith(".js")) unlinkSync(join(root, path));
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const root = makeRoot("absent");
    mutate(root);
    await assert.rejects(async () => createCanonicalReceipt(root, authority()), undefined, name);
  }
});

test("altered, missing or malformed authority is rejected by every export", async () => {
  const drifts = {
    "worker path": (a) => {
      a.KIT_WORKER_PATH = "web/.svelte-kit/cloudflare/_worker.mjs";
    },
    "server dir": (a) => {
      a.KIT_SERVER_DIR = "web/.svelte-kit/output/server/";
    },
    "client dir": (a) => {
      a.KIT_CLIENT_DIR = "web/.svelte-kit/output/client";
    },
    "reordered groups": (a) => {
      a.KIT_GROUP_IDS = [...GROUP_IDS].reverse();
    },
    "dropped group": (a) => {
      a.KIT_GROUP_IDS = GROUP_IDS.slice(0, 3);
    },
    "extra group": (a) => {
      a.KIT_GROUP_IDS = [...GROUP_IDS, "kit.extra"];
    },
    "renamed group": (a) => {
      a.KIT_GROUP_IDS = ["kit.worker", "kit.server.js", "kit.client.js", "kit.client.map"];
    },
    "missing key": (a) => {
      delete a.KIT_SERVER_DIR;
    },
  };
  const { destination: snapshot } = await frozen("drift");
  for (const [name, mutate] of Object.entries(drifts)) {
    const root = makeRoot("drift");
    put(root, "web/.svelte-kit/cloudflare/_worker.mjs", blob("alt-worker"));
    const altered = authority();
    mutate(altered);
    await rejects(() => createCanonicalReceipt(root, altered));
    const out = join(fresh("drift-out"), "build");
    await rejects(() => freezeCanonicalBuild(root, out, altered));
    assert.equal(existsSync(out), false, `${name}: freeze left output`);
    await rejects(() => verifyCanonicalBuild(snapshot, altered));
  }
  for (const bad of [undefined, null, {}, "authority", []]) {
    await rejects(() => createCanonicalReceipt(makeRoot("bad"), bad));
    await rejects(() => verifyCanonicalBuild(snapshot, bad));
  }
});

test("symlinked file, tree root, ancestor and worker are rejected", async () => {
  const outside = fresh("outside");
  writeFileSync(join(outside, "x.js"), blob("outside-x"));

  const fileLink = makeRoot("link-file");
  symlinkSync(join(outside, "x.js"), join(fileLink, SERVER, "linked.js"));
  await rejects(() => createCanonicalReceipt(fileLink, authority()));

  const clientDirLink = makeRoot("link-subdir");
  symlinkSync(outside, join(clientDirLink, CLIENT, "linkdir"));
  await rejects(() => createCanonicalReceipt(clientDirLink, authority()));

  const workerLink = makeRoot("link-worker");
  const realWorker = join(outside, "worker.js");
  writeFileSync(realWorker, blob("worker-out"));
  unlinkSync(join(workerLink, WORKER));
  symlinkSync(realWorker, join(workerLink, WORKER));
  await rejects(() => createCanonicalReceipt(workerLink, authority()));

  for (const [label, dir] of [
    ["server root", SERVER],
    ["client root", CLIENT],
    ["client tree", CLIENT_TREE],
    ["cloudflare tree", CLOUDFLARE_TREE],
  ]) {
    const root = makeRoot(`link-${label.replace(" ", "-")}`);
    const moved = join(fresh("moved"), "tree");
    renameSync(join(root, dir), moved);
    symlinkSync(moved, join(root, dir));
    await rejects(() => createCanonicalReceipt(root, authority()));
  }

  for (const ancestor of ["web/.svelte-kit/output", "web/.svelte-kit", "web"]) {
    const root = makeRoot("link-ancestor");
    const moved = join(fresh("moved"), "ancestor");
    renameSync(join(root, ancestor), moved);
    symlinkSync(moved, join(root, ancestor));
    await rejects(() => createCanonicalReceipt(root, authority()));
    const out = join(fresh("ancestor-out"), "build");
    await rejects(() => freezeCanonicalBuild(root, out, authority()));
    assert.equal(existsSync(out), false);
  }
});

test("canonical reader refuses oversized files and excessive directory depth", () => {
  const oversized = makeRoot("oversized");
  truncateSync(join(oversized, SERVER, "index.js"), 64 * 1024 * 1024 + 1);
  assert.throws(() => createCanonicalReceipt(oversized, authority()), /byte bound/);
  const deep = makeRoot("deep");
  put(deep, `${SERVER}/${"nested/".repeat(33)}data.json`, "{}");
  assert.throws(() => createCanonicalReceipt(deep, authority()), /depth exceeded/);
});

test("explicit candidate inventory may carry its other unchanged exports", () => {
  const root = makeRoot("namespace");
  const candidate = { ...authority(), JSON_VERSION: 1, WORKER_GROUP_IDS: ["worker.bundle"] };
  assert.deepEqual(createCanonicalReceipt(root, candidate), expectedReceipt(root));
});

test("backslash path names are rejected", async () => {
  const root = makeRoot("backslash");
  put(root, `${SERVER}/we\\ird.js`, blob("backslash"));
  await rejects(() => createCanonicalReceipt(root, authority()));
  const clientRoot = makeRoot("backslash-dir");
  put(clientRoot, `${CLIENT}/a\\b/c.css`, blob("backslash-dir"));
  await rejects(() => createCanonicalReceipt(clientRoot, authority()));
});

test("freezeCanonicalBuild copies original bytes with full paths and an exclusive receipt", async () => {
  const root = makeRoot();
  const before = digest(root);
  const destination = join(fresh("freeze-out"), "build");
  const receipt = await freezeCanonicalBuild(root, destination, authority());
  assert.deepEqual(receipt, expectedReceipt(root));
  assert.deepEqual(digest(root), before, "source tree changed");
  for (const row of receipt.files) {
    const copy = join(destination, row.path);
    assert.ok(lstatSync(copy).isFile(), row.path);
    assert.deepEqual(readFileSync(copy), readFileSync(join(root, row.path)), row.path);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(destination, "receipt.json"), "utf8")), receipt);
  const snapshotFiles = walk(destination, ".")
    .map((path) => path.slice(2))
    .sort();
  assert.deepEqual(snapshotFiles, [...receipt.files.map((row) => row.path), "receipt.json"].sort());
  assert.deepEqual(await verifyCanonicalBuild(destination, authority()), receipt);
});

test("freezeCanonicalBuild never overwrites an existing destination", async () => {
  const root = makeRoot();
  const parent = fresh("exclusive");

  const emptyDir = join(parent, "empty");
  mkdirSync(emptyDir);
  await rejects(() => freezeCanonicalBuild(root, emptyDir, authority()));
  assert.deepEqual(readdirSync(emptyDir), []);

  const filePath = join(parent, "file");
  writeFileSync(filePath, "keep");
  await rejects(() => freezeCanonicalBuild(root, filePath, authority()));
  assert.equal(readFileSync(filePath, "utf8"), "keep");

  const full = join(parent, "full");
  const first = await freezeCanonicalBuild(root, full, authority());
  const snapshot = digest(full);
  await rejects(() => freezeCanonicalBuild(root, full, authority()));
  assert.deepEqual(digest(full), snapshot);
  assert.deepEqual(JSON.parse(readFileSync(join(full, "receipt.json"), "utf8")), first);

  const dangling = join(parent, "dangling");
  symlinkSync(join(parent, "does-not-exist"), dangling);
  await rejects(() => freezeCanonicalBuild(root, dangling, authority()));
  assert.equal(existsSync(join(parent, "does-not-exist")), false);
});

test("freezeCanonicalBuild rejects output nested inside any captured tree", async () => {
  const root = makeRoot();
  const before = digest(root);
  const alias = join(fresh("alias"), "server-alias");
  symlinkSync(join(root, SERVER), alias);
  const targets = [
    join(root, SERVER, "frozen"),
    join(root, SERVER, "chunks", "frozen"),
    join(root, CLIENT, "frozen"),
    join(root, CLIENT, "immutable", "frozen"),
    join(alias, "frozen"),
    join(root, SERVER),
    join(root, CLIENT),
  ];
  for (const target of targets) {
    await rejects(() => freezeCanonicalBuild(root, target, authority()));
  }
  assert.deepEqual(digest(root), before, "captured trees must stay untouched");
  assert.equal(existsSync(join(root, SERVER, "frozen")), false);
  assert.equal(existsSync(join(root, CLIENT, "frozen")), false);
});

test("freezeCanonicalBuild leaves no output for an invalid build", async () => {
  const root = makeRoot();
  rmSync(join(root, CLIENT), { recursive: true });
  mkdirSync(join(root, CLIENT));
  const destination = join(fresh("invalid-out"), "build");
  await rejects(() => freezeCanonicalBuild(root, destination, authority()));
  assert.equal(existsSync(destination), false);
});

test("verifyCanonicalBuild accepts an untouched snapshot and recomputes the receipt", async () => {
  const { destination, receipt } = await frozen("verify-ok");
  const verified = await verifyCanonicalBuild(destination, authority());
  assert.deepEqual(verified, receipt);
  assert.deepEqual(verified, expectedReceipt(destination));
});

test("verifyCanonicalBuild refuses missing, corrupt and extra snapshot bytes", async () => {
  const mutations = {
    "missing worker": (dir) => unlinkSync(join(dir, WORKER)),
    "missing server file": (dir) => unlinkSync(join(dir, SERVER, "chunks", "a.js")),
    "missing hidden file": (dir) => unlinkSync(join(dir, SERVER, ".assetsignore")),
    "missing non-budget json": (dir) => unlinkSync(join(dir, CLIENT, "version.json")),
    "missing receipt": (dir) => unlinkSync(join(dir, "receipt.json")),
    "truncated worker": (dir) => {
      chmodSync(join(dir, WORKER), 0o600);
      truncateSync(join(dir, WORKER), 3);
    },
    "emptied client css": (dir) => {
      chmodSync(join(dir, CLIENT, "immutable/assets/app.css"), 0o600);
      truncateSync(join(dir, CLIENT, "immutable/assets/app.css"), 0);
    },
    "same-length flipped byte": (dir) => {
      const path = join(dir, SERVER, "index.js");
      const bytes = readFileSync(path);
      bytes[bytes.length - 3] ^= 0x01;
      overwrite(path, bytes);
    },
    "flipped non-budget byte": (dir) => {
      const path = join(dir, CLIENT, "version.json");
      const bytes = readFileSync(path);
      bytes[2] ^= 0x01;
      overwrite(path, bytes);
    },
    "extra server file": (dir) => put(dir, `${SERVER}/extra.js`, blob("extra")),
    "extra hidden file": (dir) => put(dir, `${CLIENT}/.extra`, blob("extra")),
    "extra file outside trees under web": (dir) => put(dir, "web/package.json", blob("extra")),
    "extra file in cloudflare tree": (dir) =>
      put(dir, `${CLOUDFLARE_TREE}/extra.txt`, blob("extra")),
    "extra non-_app client file": (dir) => put(dir, `${CLIENT_TREE}/extra.txt`, blob("extra")),
    "missing cloudflare headers": (dir) => unlinkSync(join(dir, CLOUDFLARE_TREE, "_headers")),
    "missing non-_app client file": (dir) => unlinkSync(join(dir, CLIENT_TREE, "robots.txt")),
    "unexpected empty directory": (dir) => mkdirSync(join(dir, "web", "stray")),
    "extra root file": (dir) => put(dir, "notes.txt", blob("extra")),
    "extra receipt copy": (dir) => put(dir, "receipt.json.bak", blob("extra")),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const { destination } = await frozen("tamper");
    mutate(destination);
    await assert.rejects(
      async () => verifyCanonicalBuild(destination, authority()),
      undefined,
      name,
    );
  }
});

test("verifyCanonicalBuild refuses unreadable or malformed receipts", async () => {
  for (const [name, content] of Object.entries({
    empty: "",
    garbage: "not json",
    array: "[]",
    null: "null",
  })) {
    const { destination } = await frozen("badreceipt");
    overwrite(join(destination, "receipt.json"), content);
    await assert.rejects(
      async () => verifyCanonicalBuild(destination, authority()),
      undefined,
      name,
    );
  }
  await rejects(() => verifyCanonicalBuild(join(fresh("nothing"), "absent"), authority()));
  await rejects(() => verifyCanonicalBuild(fresh("blank"), authority()));
});

test("verifyCanonicalBuild refuses forged receipt rows, groups, gzip and totals", async () => {
  const forgeries = {
    "directory omitted": (r) => {
      r.directories.pop();
    },
    "directories reordered": (r) => {
      r.directories.reverse();
    },
    "directory duplicated": (r) => {
      r.directories.push(r.directories[0]);
    },
    "directory invented": (r) => {
      r.directories.push(`${SERVER}/invented`);
    },
    schema: (r) => {
      r.schema = "two.kit-canonical-build.v2";
    },
    evidence: (r) => {
      r.evidence = "qualified-canonical-build-bytes";
    },
    "row bytes": (r) => {
      r.files[0].bytes += 1;
    },
    "row gzip": (r) => {
      r.files[1].gzipBytes += 1;
    },
    "row sha": (r) => {
      r.files[2].sha256 = "0".repeat(64);
    },
    "row group null to budget": (r) => {
      const row = r.files.find((entry) => entry.group === null);
      row.group = "kit.server.js";
    },
    "row group budget to null": (r) => {
      r.files.find((entry) => entry.group === "kit.client.css").group = null;
    },
    "row group swapped": (r) => {
      r.files.find((entry) => entry.group === "kit.client.js").group = "kit.client.css";
    },
    "row path renamed": (r) => {
      r.files[0].path = `${r.files[0].path}x`;
    },
    "row path backslash": (r) => {
      r.files[0].path = r.files[0].path.replaceAll("/", "\\");
    },
    "rows reordered": (r) => {
      r.files.reverse();
    },
    "row dropped": (r) => {
      r.files.pop();
    },
    "row duplicated": (r) => {
      r.files.push({ ...r.files[0] });
    },
    "row invented": (r) => {
      r.files.push({
        path: "web/.svelte-kit/output/server/zzz.js",
        group: "kit.server.js",
        bytes: 1,
        gzipBytes: 21,
        sha256: "1".repeat(64),
      });
    },
    "totals files": (r) => {
      r.totals.files -= 1;
    },
    "totals bytes": (r) => {
      r.totals.bytes -= 1;
    },
    "totals gzip as concatenation": (r) => {
      r.totals.gzipBytes -= 1;
    },
    "group files": (r) => {
      r.groups[1].files += 1;
    },
    "group bytes": (r) => {
      r.groups[2].bytes += 1;
    },
    "group gzip": (r) => {
      r.groups[3].gzipBytes += 1;
    },
    "group order": (r) => {
      r.groups.reverse();
    },
    "group dropped": (r) => {
      r.groups.pop();
    },
    "group id renamed": (r) => {
      r.groups[0].id = "kit.worker.js";
    },
    "provenance claim": (r) => {
      r.sourceSha = "a".repeat(40);
    },
  };
  for (const [name, mutate] of Object.entries(forgeries)) {
    const { destination } = await frozen("forge");
    editReceipt(destination, mutate);
    await assert.rejects(
      async () => verifyCanonicalBuild(destination, authority()),
      undefined,
      name,
    );
  }
});

test("verifyCanonicalBuild refuses symlinks inside and at the snapshot", async () => {
  const outside = fresh("verify-outside");
  writeFileSync(join(outside, "x.js"), blob("outside"));

  const replaced = await frozen("sym-replaced");
  const target = join(replaced.destination, SERVER, "index.js");
  const original = readFileSync(target);
  unlinkSync(target);
  writeFileSync(join(outside, "index.js"), original);
  symlinkSync(join(outside, "index.js"), target);
  await rejects(() => verifyCanonicalBuild(replaced.destination, authority()));

  const added = await frozen("sym-added");
  symlinkSync(join(outside, "x.js"), join(added.destination, SERVER, "linked.js"));
  await rejects(() => verifyCanonicalBuild(added.destination, authority()));

  const dirLink = await frozen("sym-dir");
  symlinkSync(outside, join(dirLink.destination, CLIENT, "linkdir"));
  await rejects(() => verifyCanonicalBuild(dirLink.destination, authority()));

  const receiptLink = await frozen("sym-receipt");
  const receiptPath = join(receiptLink.destination, "receipt.json");
  const receiptBytes = readFileSync(receiptPath);
  unlinkSync(receiptPath);
  writeFileSync(join(outside, "receipt.json"), receiptBytes);
  symlinkSync(join(outside, "receipt.json"), receiptPath);
  await rejects(() => verifyCanonicalBuild(receiptLink.destination, authority()));

  const rootLink = await frozen("sym-root");
  const alias = join(fresh("sym-root-alias"), "snapshot");
  symlinkSync(rootLink.destination, alias);
  await rejects(() => verifyCanonicalBuild(alias, authority()));

  const ancestor = await frozen("sym-ancestor");
  const moved = join(fresh("sym-ancestor-moved"), "output");
  renameSync(join(ancestor.destination, "web/.svelte-kit/output"), moved);
  symlinkSync(moved, join(ancestor.destination, "web/.svelte-kit/output"));
  await rejects(() => verifyCanonicalBuild(ancestor.destination, authority()));
});
