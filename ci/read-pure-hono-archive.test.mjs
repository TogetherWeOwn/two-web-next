import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { REQUIRED_PRODUCTION_SECRETS } from "./check-production-secrets.mjs";
import { verifyPureHonoArchiveContents } from "./pure-hono-archive-contents.mjs";
import { createPureHonoRollback } from "./pure-hono-rollback.mjs";
import { SCHEMA, deploymentReceipt, sha256, uploadReceipt } from "./worker-bundle-evidence.mjs";

const READER = fileURLToPath(new URL("./read-pure-hono-archive.py", import.meta.url));
const MIB = 1024 * 1024;

// Fixed literal builder. It only reads a JSON specification from stdin and
// writes ZIP bytes to stdout; nothing from the specification is evaluated.
const BUILDER = `
import base64, json, sys, zipfile, io, warnings
warnings.simplefilter("ignore")
spec = json.load(sys.stdin)
methods = {"stored": zipfile.ZIP_STORED, "deflate": zipfile.ZIP_DEFLATED, "bzip2": zipfile.ZIP_BZIP2}
out = io.BytesIO()
with zipfile.ZipFile(out, "w") as zf:
    for e in spec["entries"]:
        if "b64" in e:
            data = base64.b64decode(e["b64"])
        else:
            data = (e.get("text", "") * e.get("repeat", 1)).encode("utf-8")
        info = zipfile.ZipInfo(e["name"], date_time=(2020, 1, 1, 0, 0, 0))
        info.compress_type = methods[e.get("method", "deflate")]
        info.external_attr = e.get("attr", 0o100644) << 16
        zf.writestr(info, data)
sys.stdout.buffer.write(out.getvalue())
`;

const REQUIRED = [
  "worker.js",
  "worker.js.map",
  "bundle-meta.json",
  "inventory.json",
  "upload.json",
  "deployed.json",
  "pure-hono-rollback.json",
];
const TEXT_NAMES = [
  "inventory.json",
  "upload.json",
  "deployed.json",
  "pure-hono-rollback.json",
  "bundle-meta.json",
];

function contentFor(name) {
  return name.endsWith(".json") ? `{"name":"${name}"}\n` : `// ${name}\n`;
}

function baseEntries() {
  return REQUIRED.map((name) => ({ name, text: contentFor(name) }));
}

function buildZip(entries) {
  const result = spawnSync("python3", ["-I", "-c", BUILDER], {
    input: JSON.stringify({ entries }),
    maxBuffer: 256 * MIB,
  });
  assert.equal(result.status, 0, `fixture builder failed: ${result.stderr}`);
  return result.stdout;
}

function runReader(zip) {
  const result = spawnSync("python3", ["-I", READER], {
    input: zip,
    maxBuffer: 256 * MIB,
  });
  return {
    status: result.status,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

function assertRejected(zip) {
  const result = runReader(zip);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "invalid pure-Hono archive\n");
}

function withEntries(mutate) {
  const entries = baseEntries();
  return buildZip(mutate(entries) ?? entries);
}

function replaceAllBytes(buf, from, to) {
  assert.equal(from.length, to.length);
  const copy = Buffer.from(buf);
  let at = 0;
  let count = 0;
  while ((at = copy.indexOf(from, at)) !== -1) {
    to.copy(copy, at);
    at += from.length;
    count += 1;
  }
  assert.ok(count > 0, "pattern not found in fixture");
  return copy;
}

function centralOffsets(buf) {
  const out = [];
  let at = 0;
  while ((at = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at)) !== -1) {
    out.push(at);
    at += 4;
  }
  return out;
}

function findCentral(buf, name) {
  for (const off of centralOffsets(buf)) {
    const len = buf.readUInt16LE(off + 28);
    if (buf.subarray(off + 46, off + 46 + len).toString("latin1") === name) return off;
  }
  throw new Error(`no central entry ${name}`);
}

test("accepts required files and returns sorted inventory with texts", () => {
  const entries = baseEntries();
  const result = runReader(buildZip(entries));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.files.map((f) => f.path), [...REQUIRED].sort());
  for (const file of parsed.files) {
    const data = Buffer.from(contentFor(file.path), "utf8");
    assert.equal(file.bytes, data.length);
    assert.equal(file.sha256, createHash("sha256").update(data).digest("hex"));
  }
  assert.deepEqual(Object.keys(parsed.texts).sort(), [...TEXT_NAMES].sort());
  for (const name of TEXT_NAMES) assert.equal(parsed.texts[name], contentFor(name));
});

test("accepts stored members and an optional README", () => {
  const entries = baseEntries().map((e) => ({ ...e, method: "stored" }));
  entries.push({ name: "README.md", text: "hello\n" });
  const result = runReader(buildZip(entries));
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.files.map((f) => f.path), [...REQUIRED, "README.md"].sort());
  assert.equal("README.md" in parsed.texts, false);
});

test("accepts an empty README but sorts it with the rest", () => {
  const entries = [{ name: "README.md", text: "" }, ...baseEntries()];
  const result = runReader(buildZip(entries));
  assert.equal(result.status, 0, result.stderr);
  const readme = JSON.parse(result.stdout).files.find((f) => f.path === "README.md");
  assert.equal(readme.bytes, 0);
  assert.equal(readme.sha256, createHash("sha256").update("").digest("hex"));
});

test("accepts non-ASCII UTF-8 in text members verbatim", () => {
  const entries = baseEntries();
  entries.find((e) => e.name === "inventory.json").text = '{"n":"café ☃"}';
  const result = runReader(buildZip(entries));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).texts["inventory.json"], '{"n":"café ☃"}');
});

for (const name of REQUIRED) {
  test(`rejects missing ${name}`, () => {
    assertRejected(withEntries((e) => e.filter((x) => x.name !== name)));
  });
}

test("rejects an extra member", () => {
  assertRejected(withEntries((e) => [...e, { name: "extra.txt", text: "x" }]));
});

test("rejects duplicate members", () => {
  assertRejected(withEntries((e) => [...e, { name: "worker.js", text: "second" }]));
});

for (const [label, name] of [
  ["leading dot-slash", "./worker.js"],
  ["absolute path", "/worker.js"],
  ["parent traversal", "../worker.js"],
  ["nested path", "sub/worker.js"],
  ["backslash path", "sub\\worker.js"],
  ["trailing slash", "worker.js/"],
  ["case variant", "Worker.js"],
]) {
  test(`rejects path variant: ${label}`, () => {
    assertRejected(
      withEntries((e) => {
        e.find((x) => x.name === "worker.js").name = name;
      }),
    );
  });
}

test("rejects a directory member", () => {
  assertRejected(withEntries((e) => [...e, { name: "dir/", text: "", attr: 0o040755 }]));
});

test("rejects a symlink member", () => {
  assertRejected(
    withEntries((e) => {
      e.find((x) => x.name === "worker.js").attr = 0o120777;
    }),
  );
});

test("rejects special file modes", () => {
  assertRejected(
    withEntries((e) => {
      e.find((x) => x.name === "worker.js.map").attr = 0o010644;
    }),
  );
});

test("rejects unsupported compression", () => {
  assertRejected(
    withEntries((e) => {
      e.find((x) => x.name === "worker.js").method = "bzip2";
    }),
  );
});

test("rejects encrypted members", () => {
  const zip = Buffer.from(buildZip(baseEntries()));
  const central = findCentral(zip, "worker.js");
  zip.writeUInt16LE(zip.readUInt16LE(central + 8) | 1, central + 8);
  const local = zip.readUInt32LE(central + 42);
  zip.writeUInt16LE(zip.readUInt16LE(local + 6) | 1, local + 6);
  assertRejected(zip);
});

test("rejects an invalid raw-deflate payload", () => {
  const zip = Buffer.from(buildZip(baseEntries()));
  const central = findCentral(zip, "worker.js");
  assert.equal(zip.readUInt16LE(central + 10), 8, "fixture member must be deflated");
  const local = zip.readUInt32LE(central + 42);
  const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  // BFINAL=1 with reserved block type 3 is invalid deflate data.
  zip[data] = 0xff;
  zip[data + 1] = 0xff;
  assertRejected(zip);
});

test("rejects names containing a NUL byte", () => {
  const entries = baseEntries();
  entries.find((x) => x.name === "worker.js").name = "worker.js_x";
  const zip = replaceAllBytes(
    buildZip(entries),
    Buffer.from("worker.js_x"),
    Buffer.from("worker.js\0x"),
  );
  assertRejected(zip);
});

test("rejects a wrong CRC", () => {
  const zip = Buffer.from(buildZip(baseEntries()));
  const central = findCentral(zip, "worker.js");
  const crc = zip.readUInt32LE(central + 16) ^ 0xffffffff;
  zip.writeUInt32LE(crc >>> 0, central + 16);
  zip.writeUInt32LE(crc >>> 0, zip.readUInt32LE(central + 42) + 14);
  assertRejected(zip);
});

test("rejects empty required files", () => {
  assertRejected(
    withEntries((e) => {
      e.find((x) => x.name === "worker.js").text = "";
    }),
  );
});

test("rejects invalid UTF-8 in a text member", () => {
  assertRejected(
    withEntries((e) => {
      const target = e.find((x) => x.name === "upload.json");
      delete target.text;
      target.b64 = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]).toString("base64");
    }),
  );
});

test("accepts non-UTF-8 bytes in non-text members", () => {
  const entries = baseEntries();
  const target = entries.find((x) => x.name === "worker.js");
  delete target.text;
  target.b64 = Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString("base64");
  const result = runReader(buildZip(entries));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).files.find((f) => f.path === "worker.js").bytes, 4);
});

test("rejects a text member larger than 4 MiB", () => {
  assertRejected(
    withEntries((e) => {
      const target = e.find((x) => x.name === "inventory.json");
      target.text = "a";
      target.repeat = 4 * MIB + 1;
    }),
  );
});

test("rejects a declared member size above 64 MiB without inflating it", () => {
  const zip = Buffer.from(buildZip(baseEntries()));
  const central = findCentral(zip, "worker.js");
  zip.writeUInt32LE(64 * MIB + 1, central + 24);
  zip.writeUInt32LE(64 * MIB + 1, zip.readUInt32LE(central + 42) + 22);
  assertRejected(zip);
});

test("rejects a declared total size above 128 MiB", () => {
  const zip = Buffer.from(buildZip(baseEntries()));
  for (const name of ["worker.js", "worker.js.map"]) {
    const central = findCentral(zip, name);
    zip.writeUInt32LE(64 * MIB, central + 24);
    zip.writeUInt32LE(64 * MIB, zip.readUInt32LE(central + 42) + 22);
  }
  const central = findCentral(zip, "bundle-meta.json");
  zip.writeUInt32LE(4 * MIB, central + 24);
  zip.writeUInt32LE(4 * MIB, zip.readUInt32LE(central + 42) + 22);
  assertRejected(zip);
});

test("rejects a truncated archive", () => {
  const zip = buildZip(baseEntries());
  assertRejected(zip.subarray(0, zip.length - 10));
  assertRejected(zip.subarray(0, Math.floor(zip.length / 2)));
});

test("rejects empty, garbage, and non-ZIP input", () => {
  assertRejected(Buffer.alloc(0));
  assertRejected(Buffer.from("not a zip archive at all"));
  assertRejected(Buffer.alloc(1024, 0x50));
});

test("rejects an archive larger than 64 MiB", () => {
  assertRejected(Buffer.alloc(64 * MIB + 1));
});

test("error output never leaks member names or content", () => {
  const entries = baseEntries();
  entries.push({ name: "secret-token-name.txt", text: "secret-token-content" });
  const result = runReader(buildZip(entries));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "invalid pure-Hono archive\n");
});

// ---- Content verifier fixtures -------------------------------------------
// These exercise verifyPureHonoArchiveContents on synthetic, hand-built
// archives. They do not claim production behavior or recompute historical
// source inputs; the producer owns input verification.

const GENERIC_FAILURE = "pure-Hono archive content verification failed";
const SOURCE_SHA = "a".repeat(40);
const VERSION_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_VERSION_ID = "99999999-2222-4333-8444-555555555555";
const RUN_ID = "123";
const RUN_ATTEMPT = "1";
const TAG = `${SOURCE_SHA}-${RUN_ID}-${RUN_ATTEMPT}`;
const fileRecord = (path, text) => ({
  path,
  bytes: Buffer.byteLength(text),
  sha256: sha256(text),
});

function makeNative(overrides = {}) {
  return {
    id: VERSION_ID,
    annotations: { "workers/tag": TAG },
    resources: {
      bindings: [
        ...REQUIRED_PRODUCTION_SECRETS.map((name) => ({ name, type: "secret_text" })),
        { name: "DB", type: "hyperdrive" },
      ],
    },
    ...overrides,
  };
}

// pre(state) edits inputs before receipts are derived; post(state) edits the
// derived, otherwise consistent state just before it is serialized.
function makeContents({ pre, post } = {}) {
  const state = {
    worker: "export default {};\n",
    map: '{"version":3}\n',
    metaOutputBytes: null,
    inputs: [
      {
        path: "src/worker.ts",
        bytes: 10,
        sha256: sha256("src/worker.ts"),
        packageRoot: null,
        bytesInOutput: 10,
      },
      {
        path: "node_modules/hono/dist/hono.js",
        bytes: 10,
        sha256: sha256("hono"),
        packageRoot: "node_modules/hono",
        bytesInOutput: 10,
      },
    ],
    native: makeNative(),
  };
  pre?.(state);
  const meta = {
    outputs: {
      "dist-production/worker.js": { bytes: Buffer.byteLength(state.worker) },
      "dist-production/worker.js.map": { bytes: Buffer.byteLength(state.map) },
    },
  };
  state.metaText = JSON.stringify(meta);
  state.inventory = {
    schema: SCHEMA,
    evidence: "build-only",
    sourceSha: SOURCE_SHA,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    target: "two-web-next-production",
    environment: "production",
    bundle: { algorithm: "sha256", sha256: sha256(state.worker), entry: "worker.js" },
    inputs: state.inputs,
    packages: [{ name: "hono", version: "1.0.0" }],
    externals: [],
    absenceEligible: true,
    unknownExternals: [],
    outputs: [fileRecord("worker.js", state.worker), fileRecord("worker.js.map", state.map)],
    metafile: fileRecord("bundle-meta.json", state.metaText),
  };
  state.inventoryText = JSON.stringify(state.inventory);
  const verified = { inventory: state.inventory, inventorySha256: sha256(state.inventoryText) };
  state.upload = uploadReceipt(verified, [
    {
      type: "version-upload",
      version: 1,
      worker_name: state.inventory.target,
      wrangler_environment: state.inventory.environment,
      version_id: VERSION_ID,
    },
  ]);
  state.deployed = deploymentReceipt(verified, state.upload, VERSION_ID);
  state.pointer = {
    schema: "two.pure-hono-rollback.v1",
    target: "two-web-next-production",
    environment: "production",
    sourceSha: SOURCE_SHA,
    versionId: VERSION_ID,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    bundleSha256: state.inventory.bundle.sha256,
    inventorySha256: verified.inventorySha256,
    versionTag: TAG,
    expiresAt: null,
  };
  state.verified = verified;
  state.archivedPointer = structuredClone(state.pointer);
  post?.(state);
  const entries = [
    { name: "worker.js", text: state.worker },
    { name: "worker.js.map", text: state.map },
    { name: "bundle-meta.json", text: state.metaText },
    { name: "inventory.json", text: state.inventoryText },
    { name: "upload.json", text: JSON.stringify(state.upload) },
    { name: "deployed.json", text: JSON.stringify(state.deployed) },
    { name: "pure-hono-rollback.json", text: JSON.stringify(state.archivedPointer) },
  ];
  const archive = buildZip(entries);
  const transport = {
    archiveSha256: sha256(archive),
    archiveBytes: archive.length,
    provenance: {
      repository: "TogetherWeOwn/two-web-next",
      workflow: ".github/workflows/deploy-production.yml",
      sourceSha: SOURCE_SHA,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      artifactName: `worker-bundle-production-${SOURCE_SHA}-${RUN_ID}-${RUN_ATTEMPT}`,
    },
  };
  return { ...state, archive, transport };
}

function verifyContents(fixture, overrides = {}) {
  return verifyPureHonoArchiveContents(
    overrides.pointer ?? fixture.pointer,
    overrides.archive ?? fixture.archive,
    overrides.transport ?? fixture.transport,
    "native" in overrides ? overrides.native : fixture.native,
  );
}

function assertContentFailure(fixture, overrides) {
  assert.throws(() => verifyContents(fixture, overrides), { message: GENERIC_FAILURE });
}

test("content verifier accepts a consistent archive and returns a sanitized receipt", () => {
  const fixture = makeContents();
  // The hand-built pointer must match the real rollback helper's shape.
  assert.deepEqual(
    fixture.pointer,
    createPureHonoRollback(fixture.verified, fixture.deployed, fixture.native),
  );
  const receipt = verifyContents(fixture);
  assert.equal(receipt.schema, "two.pure-hono-archive-contents.v1");
  assert.equal(receipt.evidence, "authenticated-producer-archive");
  assert.deepEqual(receipt.pointer, fixture.pointer);
  assert.deepEqual(receipt.provenance, fixture.transport.provenance);
  assert.equal(receipt.archiveSha256, fixture.transport.archiveSha256);
  assert.equal(receipt.archiveBytes, fixture.archive.length);
  assert.deepEqual(receipt.files.map((f) => f.path), [...REQUIRED].sort());
  assert.equal(JSON.stringify(receipt).includes("export default"), false);
});

for (const [label, mutate] of [
  ["archive bytes", (t) => ({ ...t, archiveBytes: t.archiveBytes + 1 })],
  ["archive digest", (t) => ({ ...t, archiveSha256: "0".repeat(64) })],
  ["repository", (t) => ({ ...t, provenance: { ...t.provenance, repository: "evil/fork" } })],
  [
    "workflow",
    (t) => ({ ...t, provenance: { ...t.provenance, workflow: ".github/workflows/ci.yml" } }),
  ],
  ["source SHA", (t) => ({ ...t, provenance: { ...t.provenance, sourceSha: "b".repeat(40) } })],
  ["run ID", (t) => ({ ...t, provenance: { ...t.provenance, runId: "124" } })],
  ["run attempt", (t) => ({ ...t, provenance: { ...t.provenance, runAttempt: "2" } })],
  [
    "artifact name",
    (t) => ({ ...t, provenance: { ...t.provenance, artifactName: "worker-bundle-other" } }),
  ],
]) {
  test(`content verifier rejects transport ${label} mismatch`, () => {
    const fixture = makeContents();
    assertContentFailure(fixture, { transport: mutate(fixture.transport) });
  });
}

test("content verifier rejects changed archive bytes against the transport digest", () => {
  const fixture = makeContents();
  const changed = Buffer.from(fixture.archive);
  changed[changed.length - 1] ^= 0xff;
  assertContentFailure(fixture, { archive: changed });
});

test("content verifier rejects a pointer with a different identity", () => {
  const fixture = makeContents();
  assertContentFailure(fixture, { pointer: { ...fixture.pointer, runId: "999" } });
});

test("content verifier rejects an inventory output digest that disagrees with the file", () => {
  assertContentFailure(
    makeContents({
      post(state) {
        state.inventory.outputs[1].sha256 = "0".repeat(64);
        state.inventoryText = JSON.stringify(state.inventory);
        state.pointer.inventorySha256 = sha256(state.inventoryText);
        state.archivedPointer = structuredClone(state.pointer);
      },
    }),
  );
});

test("content verifier rejects an inventory output size that disagrees with the file", () => {
  assertContentFailure(
    makeContents({
      post(state) {
        state.inventory.outputs[0].bytes += 1;
        state.inventoryText = JSON.stringify(state.inventory);
        state.pointer.inventorySha256 = sha256(state.inventoryText);
        state.archivedPointer = structuredClone(state.pointer);
      },
    }),
  );
});

test("content verifier rejects a bundle-meta file that differs from inventory metafile", () => {
  assertContentFailure(
    makeContents({
      post(state) {
        state.metaText = `${state.metaText}\n`;
      },
    }),
  );
});

test("content verifier rejects bundle-meta output sizes that disagree with the inventory", () => {
  assertContentFailure(
    makeContents({
      post(state) {
        const meta = JSON.parse(state.metaText);
        meta.outputs["dist-production/worker.js"].bytes += 1;
        state.metaText = JSON.stringify(meta);
        state.inventory.metafile = fileRecord("bundle-meta.json", state.metaText);
        state.inventoryText = JSON.stringify(state.inventory);
        state.pointer.inventorySha256 = sha256(state.inventoryText);
        state.archivedPointer = structuredClone(state.pointer);
      },
    }),
  );
});

test("content verifier rejects changed worker.js bytes", () => {
  assertContentFailure(
    makeContents({
      post(state) {
        state.worker = "export default { evil: true };\n";
      },
    }),
  );
});

test("content verifier rejects an inventory digest that differs from the pointer", () => {
  assertContentFailure(
    makeContents({
      post(state) {
        state.pointer.inventorySha256 = "0".repeat(64);
        state.archivedPointer = structuredClone(state.pointer);
      },
    }),
  );
});

test("content verifier rejects an upload receipt for a different version", () => {
  assertContentFailure(
    makeContents({
      post(state) {
        state.upload = { ...state.upload, versionId: OTHER_VERSION_ID };
      },
    }),
  );
});

test("content verifier rejects a deployed receipt for a different version", () => {
  assertContentFailure(
    makeContents({
      post(state) {
        state.deployed = { ...state.deployed, versionId: OTHER_VERSION_ID };
      },
    }),
  );
});

test("content verifier rejects an archived pointer that differs from the supplied pointer", () => {
  assertContentFailure(
    makeContents({
      post(state) {
        state.archivedPointer.versionId = OTHER_VERSION_ID;
      },
    }),
  );
});

test("content verifier rejects an expiring pointer", () => {
  assertContentFailure(
    makeContents({
      post(state) {
        state.pointer.expiresAt = "2030-01-01T00:00:00.000Z";
        state.archivedPointer = structuredClone(state.pointer);
      },
    }),
  );
});

test("content verifier rejects Kit inputs even when every digest is consistent", () => {
  assertContentFailure(
    makeContents({
      pre(state) {
        state.inputs.push({
          path: "web/src/routes/+page.svelte",
          bytes: 10,
          sha256: sha256("kit"),
          packageRoot: null,
          bytesInOutput: 10,
        });
      },
    }),
  );
});

for (const [label, native] of [
  ["missing", null],
  ["wrong version id", makeNative({ id: OTHER_VERSION_ID })],
  ["wrong tag", makeNative({ annotations: { "workers/tag": `${SOURCE_SHA}-${RUN_ID}-2` } })],
  [
    "missing secret",
    makeNative({
      resources: {
        bindings: REQUIRED_PRODUCTION_SECRETS.slice(1).map((name) => ({
          name,
          type: "secret_text",
        })),
      },
    }),
  ],
]) {
  test(`content verifier rejects native version: ${label}`, () => {
    assertContentFailure(makeContents(), { native });
  });
}

test("content verifier failure reveals no archive or native values", () => {
  const fixture = makeContents();
  try {
    verifyContents(fixture, { native: makeNative({ id: OTHER_VERSION_ID }) });
    assert.fail("expected failure");
  } catch (error) {
    assert.equal(error.message, GENERIC_FAILURE);
    assert.equal(error.message.includes(OTHER_VERSION_ID), false);
  }
});
