import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateArtifactReader } from "./candidate-staging-artifact.mjs";

const BASE = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
const CONTROLLER = "b".repeat(40);
const VERSION = "11111111-2222-3333-4444-555555555555";
const WORKFLOW = ".github/workflows/deploy.yml";
// Synthetic values; neither may ever appear in a diagnostic or a result.
const TOKEN = "fixture-token-not-a-secret";
const SAS = "sig-fixture-not-a-secret";
const REFUSED = "Candidate artifact refused: baseline-evidence";
const MAX = 16 * 1024 * 1024;
const RUN = "/actions/runs/500";
const JOBS = "/actions/runs/500/attempts/1/jobs?per_page=100&page=1";
const LIST = "/actions/runs/500/artifacts?per_page=100&page=1";
const PAYLOAD_DETAIL = "/actions/artifacts/600";
const PRODUCER_DETAIL = "/actions/artifacts/601";
const PAYLOAD_ZIP = "/actions/artifacts/600/zip";
const PRODUCER_ZIP = "/actions/artifacts/601/zip";
const PAYLOAD_SIGNED = `https://productionresultssa7.blob.core.windows.net/actions-results/600/payload.zip?sig=${SAS}%2Bx&se=2026-11-04T00%3A00%3A00Z`;
const PRODUCER_SIGNED = `https://productionresultssa8.blob.core.windows.net/actions-results/601/producer.zip?sig=${SAS}%2By&se=2026-11-04T00%3A00%3A00Z`;
const SENTINEL = "globalThis.__baselineArtifactExecuted = true;\nthrow new Error('executed');\n";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------- ZIP builder
// Narrow profile writer: no descriptors, no extras, UTF-8 flag, unix regular
// file attributes. Each option deliberately breaks one property.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = entry.name ?? Buffer.from(entry.path);
    const bytes = entry.bytes ?? Buffer.from("x");
    const method = entry.method ?? 8;
    const data = method === 0 ? bytes : deflateRawSync(bytes);
    const crc = (crc32(bytes) + (entry.crcDelta ?? 0)) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    const record = Buffer.concat([local, name, data]);
    locals.push(record);
    centrals.push(Buffer.concat([central, name]));
    offset += record.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// -------------------------------------------------------------- retained data
function defaultFiles() {
  return [
    {
      kind: "module",
      path: "_worker.js",
      contentType: "application/javascript+module",
      bytes: Buffer.from(SENTINEL),
    },
    {
      kind: "module",
      path: "_worker.js.map",
      contentType: "application/source-map",
      bytes: Buffer.from('{"version":3,"mappings":""}'),
    },
    { kind: "asset", path: "app.css", contentType: null, bytes: Buffer.from("body{margin:0}\n") },
    {
      kind: "asset",
      path: "img/logo.png",
      contentType: null,
      bytes: Buffer.from("a".repeat(5000)),
    },
  ];
}

const keyOf = (file) => `${file.kind}:${file.path}`;
const sortFiles = (files) =>
  [...files].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
const entryName = (index) => `file-${String(index).padStart(4, "0")}`;

function artifactRow(id, name, digest) {
  return {
    id,
    name,
    expired: false,
    digest: `sha256:${digest}`,
    workflow_run: { id: 500, repository_id: 1234, head_repository_id: 1234, head_sha: CONTROLLER },
  };
}

// opts break exactly one property and keep every other join consistent:
//   files, order(list), manifest(m), rehash=false, manifestBytes(m), payload(entries),
//   producerRecord(p), producerBytes, producerZip(entries)
function world(opts = {}) {
  const identity = candidateIdentity(
    { prNumber: "42", headSha: "a".repeat(40), ciRunId: "100", ciRunAttempt: "1" },
    {
      repositoryId: "1234",
      repository: "TogetherWeOwn/two-web-next",
      controllerSha: CONTROLLER,
      launcherSha: "c".repeat(40),
      checkoutSha: CONTROLLER,
      runId: "200",
      runAttempt: "1",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      path: ".github/workflows/candidate-staging.yml",
    },
  );
  const workflowBytes = Buffer.from("name: deploy\n# inert installed producer source\n");
  const blob = createHash("sha1")
    .update(`blob ${workflowBytes.length}\0`)
    .update(workflowBytes)
    .digest("hex");
  const treeIds = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];
  const sourceManifest = Buffer.from(
    JSON.stringify({
      schema: "two.candidate-controller-sources.v1",
      controllerSha: CONTROLLER,
      files: [
        {
          path: WORKFLOW,
          gitBlobSha: blob,
          sha256: candidateSha256(workflowBytes),
          size: workflowBytes.length,
        },
      ],
    }),
  );
  const contract = {
    workflowId: "300",
    path: WORKFLOW,
    event: "workflow_run",
    job: "deploy-staging",
    steps: ["Set up job", "Retain baseline archive", "Complete job"],
    sourceManifestSha256: candidateSha256(sourceManifest),
  };

  const ordered = opts.order
    ? opts.order(sortFiles(opts.files ?? defaultFiles()))
    : sortFiles(opts.files ?? defaultFiles());
  const records = ordered.map((file, index) => ({
    kind: file.kind,
    path: file.path,
    contentType: file.contentType,
    size: file.bytes.length,
    sha256: candidateSha256(file.bytes),
    entry: entryName(index),
  }));
  const manifest = {
    schema: "two.staging-baseline-retention.v1",
    promotable: false,
    scope: "retained-bytes-only",
    producer: {
      repository: "TogetherWeOwn/two-web-next",
      repositoryId: "1234",
      sourceSha: CONTROLLER,
      workflowSha: CONTROLLER,
      runId: "500",
      runAttempt: "1",
      event: "workflow_run",
    },
    versionId: VERSION,
    mainModule: "_worker.js",
    files: records,
    rootSha256: candidateSha256(JSON.stringify(records)),
  };
  opts.manifest?.(manifest);
  if (opts.rehash !== false && Array.isArray(manifest.files)) {
    manifest.rootSha256 = candidateSha256(JSON.stringify(manifest.files));
  }
  const manifestBytes = opts.manifestBytes
    ? opts.manifestBytes(manifest)
    : Buffer.from(JSON.stringify(manifest));
  const payloadEntries = [
    { path: "baseline.json", bytes: manifestBytes },
    ...ordered.map((file, index) => ({ path: entryName(index), bytes: file.bytes })),
  ];
  opts.payload?.(payloadEntries);
  const payload = zip(payloadEntries);
  const payloadDigest = candidateSha256(payload);

  const producerRecord = {
    schema: "two.staging-baseline-producer.v1",
    promotable: false,
    scope: "producer-join-only",
    producer: structuredClone(manifest.producer),
    versionId: VERSION,
    artifactId: "600",
    archiveSha256: payloadDigest,
    manifestSha256: candidateSha256(manifestBytes),
    rootSha256: manifest.rootSha256,
  };
  opts.producerRecord?.(producerRecord);
  const producerBytes = opts.producerBytes ?? Buffer.from(JSON.stringify(producerRecord));
  const producerEntries = [{ path: "producer.json", bytes: producerBytes }];
  opts.producerZip?.(producerEntries);
  const producerArchive = zip(producerEntries);
  const producerDigest = candidateSha256(producerArchive);

  const selection = {
    runId: "500",
    runAttempt: "1",
    artifactId: "600",
    archiveSha256: payloadDigest,
    versionId: VERSION,
    producerArtifactId: "601",
    producerArchiveSha256: producerDigest,
  };
  const repository = {
    id: 1234,
    full_name: "TogetherWeOwn/two-web-next",
    fork: false,
    archived: false,
  };
  const run = {
    id: 500,
    run_attempt: 1,
    workflow_id: 300,
    path: WORKFLOW,
    event: "workflow_run",
    head_branch: "main",
    head_sha: CONTROLLER,
    repository: structuredClone(repository),
    head_repository: structuredClone(repository),
    status: "completed",
    conclusion: "success",
  };
  const job = {
    id: 700,
    run_id: 500,
    run_attempt: 1,
    head_sha: CONTROLLER,
    name: contract.job,
    status: "completed",
    conclusion: "success",
    steps: contract.steps.map((name, index) => ({
      name,
      number: index + 1,
      status: "completed",
      conclusion: "success",
    })),
  };
  const payloadArtifact = artifactRow(600, `candidate-baseline-500-1-${VERSION}`, payloadDigest);
  const producerArtifact = artifactRow(
    601,
    `candidate-baseline-producer-500-1-${VERSION}`,
    producerDigest,
  );
  const routes = {
    [`/git/commits/${CONTROLLER}`]: { sha: CONTROLLER, tree: { sha: treeIds[0] } },
    [`/git/trees/${treeIds[0]}`]: {
      sha: treeIds[0],
      truncated: false,
      tree: [{ path: ".github", type: "tree", mode: "040000", sha: treeIds[1] }],
    },
    [`/git/trees/${treeIds[1]}`]: {
      sha: treeIds[1],
      truncated: false,
      tree: [{ path: "workflows", type: "tree", mode: "040000", sha: treeIds[2] }],
    },
    [`/git/trees/${treeIds[2]}`]: {
      sha: treeIds[2],
      truncated: false,
      tree: [
        { path: "deploy.yml", type: "blob", mode: "100644", sha: blob, size: workflowBytes.length },
      ],
    },
    [`/contents/${WORKFLOW}?ref=${CONTROLLER}`]: {
      type: "file",
      path: WORKFLOW,
      sha: blob,
      size: workflowBytes.length,
      encoding: "base64",
      content: workflowBytes.toString("base64"),
    },
    "": repository,
    [RUN]: run,
    [`${RUN}/attempts/1`]: run,
    [JOBS]: { total_count: 1, jobs: [job] },
    [LIST]: { total_count: 2, artifacts: [payloadArtifact, producerArtifact] },
    [PAYLOAD_DETAIL]: payloadArtifact,
    [PRODUCER_DETAIL]: producerArtifact,
    [PAYLOAD_ZIP]: () => redirect(PAYLOAD_SIGNED),
    [PRODUCER_ZIP]: () => redirect(PRODUCER_SIGNED),
    [PAYLOAD_SIGNED]: () => archiveResponse(payload),
    [PRODUCER_SIGNED]: () => archiveResponse(producerArchive),
  };
  const f = {
    identity,
    contract,
    selection,
    sourceManifest,
    routes,
    run,
    job,
    payloadArtifact,
    producerArtifact,
    payload,
    producerArchive,
    ordered,
    manifest,
    manifestBytes,
    producerRecord,
    calls: [],
    downloaded: false,
    options: undefined,
  };
  f.counts = new Map();
  f.fetchImpl = async (url, init) => {
    const key = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const index = f.counts.get(key) ?? 0;
    f.counts.set(key, index + 1);
    f.calls.push({ key, url, init });
    if (key === PAYLOAD_SIGNED || key === PRODUCER_SIGNED) f.downloaded = true;
    if (!Object.hasOwn(f.routes, key)) throw new Error(`unrouted ${key} ${TOKEN} ${SAS}`);
    const route = typeof f.routes[key] === "function" ? f.routes[key](index, init) : f.routes[key];
    const value = await route;
    return value instanceof Response ? value : json(value);
  };
  f.keys = () => f.calls.map((call) => call.key);
  f.reader = () => createCandidateArtifactReader({ token: TOKEN, fetchImpl: f.fetchImpl });
  f.read = () =>
    f.reader().readBaseline(f.identity, f.contract, f.selection, f.sourceManifest, f.options);
  return f;
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function redirect(location, status = 302) {
  return new Response(null, { status, headers: location === null ? {} : { location } });
}

function archiveResponse(bytes, headers = {}) {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-length": String(bytes.length),
      ...headers,
    },
  });
}

function openStream(chunk, state) {
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

// A route that changes only after the first archive download began, i.e. between
// the metadata read before and the metadata read after the byte transfer.
const afterDownload = (f, before, after) => () => (f.downloaded ? after : before);

function redacted(error) {
  assert.equal(error.message, REFUSED);
  assert.equal(error.cause, undefined);
  const text = `${error.stack}${JSON.stringify(Object.getOwnPropertyNames(error))}`;
  for (const secret of [
    TOKEN,
    SAS,
    "blob.core.windows.net",
    "api.github.com",
    "sig=",
    "executed",
    "private upstream",
  ]) {
    assert.ok(!text.includes(secret), `diagnostic leaks ${secret}`);
  }
  return true;
}

async function refuses(f) {
  await assert.rejects(f.read(), redacted);
}

function noStorageRequest(f) {
  assert.ok(
    !f.keys().some((key) => key === PAYLOAD_SIGNED || key === PRODUCER_SIGNED),
    "no storage request expected",
  );
}

// --------------------------------------------------------------------- tokens
test("baseline reader refuses unusable tokens before any request", () => {
  for (const token of [undefined, "", 7, "a b", "a\nb", "a\x7fb", "x".repeat(4097)]) {
    assert.throws(
      () => createCandidateArtifactReader({ token, fetchImpl: () => assert.fail() }),
      /^Error: Candidate artifact refused: /,
    );
  }
  assert.throws(() => createCandidateArtifactReader(), /^Error: Candidate artifact refused: /);
});

test("the reader never stores or exposes the token", () => {
  const reader = createCandidateArtifactReader({ token: TOKEN, fetchImpl: () => assert.fail() });
  assert.equal(Object.isFrozen(reader), true);
  assert.equal(typeof reader.readBaseline, "function");
  assert.ok(!JSON.stringify(reader).includes(TOKEN));
  for (const value of Object.values(reader)) assert.notEqual(value, TOKEN);
  assert.ok(!Object.getOwnPropertyNames(reader).includes("token"));
  assert.ok(!String(reader.readBaseline).includes(TOKEN));
});

// ---------------------------------------------------------------- happy path
test("baseline artifacts are authenticated, downloaded once each and returned as inert bytes", async () => {
  const f = world();
  const before = JSON.stringify([f.identity, f.contract, f.selection, f.sourceManifest]);
  const result = await f.read();
  assert.equal(Object.isFrozen(result), true);
  assert.equal(JSON.stringify([f.identity, f.contract, f.selection, f.sourceManifest]), before);
  assert.deepEqual(Object.keys(result).sort(), [
    "files",
    "manifest",
    "observation",
    "producer",
    "promotable",
    "q",
    "schema",
    "scope",
  ]);
  assert.equal(result.schema, "two.candidate-baseline-bytes.v1");
  assert.equal(result.promotable, false);
  assert.equal(result.scope, "authenticated-retained-bytes-only");
  assert.equal(result.q, f.identity.q);
  // Metadata observation is the pinned-source, exact-attempt GitHub join.
  assert.equal(result.observation.promotable, false);
  assert.equal(result.observation.q, f.identity.q);
  assert.equal(result.observation.controllerSha, CONTROLLER);
  for (const [key, value] of Object.entries(f.selection)) {
    assert.equal(result.observation[key], value, key);
  }
  assert.equal(result.manifest.schema, "two.staging-baseline-retention.v1");
  assert.equal(result.manifest.promotable, false);
  assert.equal(result.manifest.versionId, VERSION);
  assert.deepEqual(result.manifest.files, f.manifest.files);
  assert.equal(result.manifest.rootSha256, f.manifest.rootSha256);
  assert.deepEqual(result.producer, f.producerRecord);
  assert.deepEqual(
    result.files.map((file) => [file.kind, file.path, file.contentType]),
    [
      ["asset", "app.css", null],
      ["asset", "img/logo.png", null],
      ["module", "_worker.js", "application/javascript+module"],
      ["module", "_worker.js.map", "application/source-map"],
    ],
  );
  for (const [index, file] of result.files.entries()) {
    assert.deepEqual(Object.keys(file).sort(), ["bytes", "contentType", "kind", "path"]);
    assert.ok(Buffer.isBuffer(file.bytes));
    assert.deepEqual(file.bytes, f.ordered[index].bytes);
  }
  // Retained worker bytes are data only: nothing ran, imported or evaluated.
  assert.equal(globalThis.__baselineArtifactExecuted, undefined);
  const text = JSON.stringify(result);
  for (const secret of [TOKEN, SAS, "blob.core.windows.net", "api.github.com"]) {
    assert.ok(!text.includes(secret), secret);
  }
});

test("metadata is verified before and again after both byte transfers", async () => {
  const f = world();
  await f.read();
  const keys = f.keys();
  for (const key of [PAYLOAD_ZIP, PRODUCER_ZIP, PAYLOAD_SIGNED, PRODUCER_SIGNED]) {
    assert.equal(keys.filter((k) => k === key).length, 1, key);
  }
  const first = Math.min(keys.indexOf(PAYLOAD_SIGNED), keys.indexOf(PRODUCER_SIGNED));
  const last = Math.max(keys.lastIndexOf(PAYLOAD_SIGNED), keys.lastIndexOf(PRODUCER_SIGNED));
  assert.ok(keys.indexOf(PAYLOAD_ZIP) < keys.indexOf(PAYLOAD_SIGNED));
  assert.ok(keys.indexOf(PRODUCER_ZIP) < keys.indexOf(PRODUCER_SIGNED));
  for (const key of [RUN, PAYLOAD_DETAIL, PRODUCER_DETAIL, LIST, JOBS]) {
    assert.ok(keys.slice(0, first).includes(key), `before ${key}`);
    assert.ok(keys.slice(last + 1).includes(key), `after ${key}`);
  }
  assert.equal(keys.at(-1), RUN);
  assert.ok(!keys.some((key) => key.includes("latest") || key.includes("/pulls/")));
});

test("each API download requests the exact artifact with a manual redirect and no ambient credentials", async () => {
  const f = world();
  await f.read();
  for (const [zipKey, id] of [
    [PAYLOAD_ZIP, "600"],
    [PRODUCER_ZIP, "601"],
  ]) {
    const call = f.calls.find((c) => c.key === zipKey);
    assert.equal(call.url, `${BASE}/actions/artifacts/${id}/zip`);
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
  }
  for (const call of f.calls.filter((c) => c.url.startsWith(BASE))) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect === "error" || call.init.redirect === "manual", true);
  }
});

test("signed storage requests are fresh, credential-free, cookie-less and referrer-less", async () => {
  const f = world();
  await f.read();
  for (const signed of [PAYLOAD_SIGNED, PRODUCER_SIGNED]) {
    const call = f.calls.find((c) => c.key === signed);
    assert.equal(call.url, new URL(signed).href);
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.referrerPolicy, "no-referrer");
    assert.equal(call.init.cache, "no-store");
    assert.deepEqual(Object.keys(call.init.headers), ["Accept"]);
    const lowered = Object.keys(call.init.headers).map((name) => name.toLowerCase());
    for (const name of ["authorization", "cookie", "referer", "x-github-api-version"]) {
      assert.ok(!lowered.includes(name), name);
    }
    assert.ok(!JSON.stringify(call.init).includes(TOKEN));
  }
  for (const call of f.calls.filter((c) => !c.url.startsWith(BASE))) {
    assert.equal(call.init.headers.Authorization, undefined);
  }
});

test("pipelines.actions.githubusercontent.com is an accepted storage origin", async () => {
  const location = "https://pipelines.actions.githubusercontent.com/abc/def?sig=1";
  const f = world();
  f.routes[PAYLOAD_ZIP] = () => redirect(location);
  f.routes[location] = () => archiveResponse(f.payload);
  const result = await f.read();
  assert.equal(result.files.length, f.ordered.length);
});

test("a module-only retained baseline without a source map or assets is accepted", async () => {
  const f = world({ files: defaultFiles().slice(0, 1) });
  const result = await f.read();
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["_worker.js"],
  );
});

test("a content type with parameters or case and octet-stream are accepted", async () => {
  for (const type of ["application/octet-stream", "Application/ZIP; charset=binary"]) {
    const f = world();
    f.routes[PAYLOAD_SIGNED] = () => archiveResponse(f.payload, { "content-type": type });
    f.routes[PRODUCER_SIGNED] = () => archiveResponse(f.producerArchive, { "content-type": type });
    await f.read();
  }
});

test("a body without a content length is accepted when the digest matches", async () => {
  const f = world();
  f.routes[PAYLOAD_SIGNED] = () =>
    new Response(f.payload, { status: 200, headers: { "content-type": "application/zip" } });
  await f.read();
});

test("optional abort signal is accepted as the fifth argument and omitted options work", async () => {
  const f = world();
  f.options = { signal: new AbortController().signal };
  await f.read();
  const g = world();
  g.options = {};
  await g.read();
  const h = world();
  const result = await h
    .reader()
    .readBaseline(h.identity, h.contract, h.selection, h.sourceManifest);
  assert.equal(result.schema, "two.candidate-baseline-bytes.v1");
});

// ------------------------------------------------------- selection and inputs
for (const [name, mutate] of [
  ["null contract", (f) => (f.contract = null)],
  ["arbitrary workflow", (f) => (f.contract.path = ".github/workflows/foreign.yml")],
  ["unpinned source manifest", (f) => (f.contract.sourceManifestSha256 = "0".repeat(64))],
  ["source manifest not bytes", (f) => (f.sourceManifest = f.sourceManifest.toString())],
  ["source manifest tamper", (f) => (f.sourceManifest[0] ^= 1)],
  ["null identity", (f) => (f.identity = null)],
  [
    "foreign identity",
    (f) => {
      f.identity = structuredClone(f.identity);
      f.identity.descriptor[2] = "elsewhere/repo";
    },
  ],
  ["null selection", (f) => (f.selection = null)],
  ["array selection", (f) => (f.selection = Object.values(f.selection))],
  ["string selection", (f) => (f.selection = JSON.stringify(f.selection))],
  [
    "legacy selection without producer",
    (f) => {
      delete f.selection.producerArtifactId;
      delete f.selection.producerArchiveSha256;
    },
  ],
  ["missing producer digest", (f) => delete f.selection.producerArchiveSha256],
  ["missing producer artifact", (f) => delete f.selection.producerArtifactId],
  ["missing run", (f) => delete f.selection.runId],
  ["extra selection field", (f) => (f.selection.url = "https://example.com")],
  ["extra selection channel", (f) => (f.selection.thirdArtifactId = "602")],
  ["duplicate artifact IDs", (f) => (f.selection.producerArtifactId = f.selection.artifactId)],
  ["numeric artifact ID", (f) => (f.selection.artifactId = 600)],
  ["numeric producer ID", (f) => (f.selection.producerArtifactId = 601)],
  ["traversal artifact ID", (f) => (f.selection.artifactId = "../600")],
  ["traversal producer ID", (f) => (f.selection.producerArtifactId = "601/../600")],
  ["zero artifact ID", (f) => (f.selection.artifactId = "0")],
  ["leading-zero producer ID", (f) => (f.selection.producerArtifactId = "0601")],
  ["rerun", (f) => (f.selection.runAttempt = "2")],
  ["numeric attempt", (f) => (f.selection.runAttempt = 1)],
  ["numeric run", (f) => (f.selection.runId = 500)],
  ["uppercase archive digest", (f) => (f.selection.archiveSha256 = "D".repeat(64))],
  ["short producer digest", (f) => (f.selection.producerArchiveSha256 = "d".repeat(63))],
  [
    "prefixed producer digest",
    (f) => (f.selection.producerArchiveSha256 = `sha256:${"d".repeat(64)}`),
  ],
  ["version alias", (f) => (f.selection.versionId = "latest")],
]) {
  test(`baseline selection refuses ${name} before any request`, async () => {
    const f = world();
    mutate(f);
    await refuses(f);
    assert.equal(f.calls.length, 0);
  });
}

test("inputs are cloned synchronously before any asynchronous work", async () => {
  const f = world();
  const identity = structuredClone(f.identity);
  const contract = structuredClone(f.contract);
  const selection = { ...f.selection };
  const source = Buffer.from(f.sourceManifest);
  f.routes[PAYLOAD_SIGNED] = () => {
    // A mid-flight mutation must not influence the still-pending read either.
    selection.artifactId = "602";
    selection.producerArtifactId = "603";
    contract.steps[1] = "candidate step";
    source.fill(0);
    return archiveResponse(f.payload);
  };
  const pending = f.reader().readBaseline(identity, contract, selection, source);
  identity.descriptor[4] = "e".repeat(40);
  selection.versionId = "latest";
  selection.archiveSha256 = "0".repeat(64);
  contract.job = "other";
  const result = await pending;
  assert.equal(result.manifest.versionId, VERSION);
  assert.equal(result.observation.artifactId, "600");
  assert.equal(result.observation.producerArtifactId, "601");
});

test("accessor properties are read once and uncloneable inputs fail before a request", async () => {
  const f = world();
  let reads = 0;
  f.selection = {
    ...f.selection,
    get artifactId() {
      reads++;
      return reads === 1 ? "600" : "602";
    },
  };
  await f.read();
  assert.equal(reads, 1);
  for (const selection of [
    { ...f.selection, fn() {} },
    { ...f.selection, extra: Symbol("x") },
  ]) {
    const g = world();
    g.selection = selection;
    await refuses(g);
    assert.equal(g.calls.length, 0);
  }
});

// ----------------------------------------------------------- metadata refusals
for (const [name, mutate] of [
  ["expired payload archive", (f) => (f.payloadArtifact.expired = true)],
  ["expired producer archive", (f) => (f.producerArtifact.expired = true)],
  ["wrong payload digest", (f) => (f.payloadArtifact.digest = `sha256:${"e".repeat(64)}`)],
  ["wrong producer digest", (f) => (f.producerArtifact.digest = `sha256:${"e".repeat(64)}`)],
  [
    "payload name with producer prefix",
    (f) => (f.payloadArtifact.name = `candidate-baseline-producer-500-1-${VERSION}`),
  ],
  [
    "producer name with payload prefix",
    (f) => (f.producerArtifact.name = `candidate-baseline-500-1-${VERSION}`),
  ],
  [
    "producer name with another version",
    (f) => (f.producerArtifact.name = "candidate-baseline-producer-500-1-latest"),
  ],
  [
    "producer name with rerun attempt",
    (f) => (f.producerArtifact.name = `candidate-baseline-producer-500-2-${VERSION}`),
  ],
  [
    "producer name with another run",
    (f) => (f.producerArtifact.name = `candidate-baseline-producer-501-1-${VERSION}`),
  ],
  ["producer wrong run", (f) => f.producerArtifact.workflow_run.id++],
  ["producer wrong repository", (f) => f.producerArtifact.workflow_run.repository_id++],
  ["producer foreign head repository", (f) => f.producerArtifact.workflow_run.head_repository_id++],
  [
    "producer candidate source",
    (f) => (f.producerArtifact.workflow_run.head_sha = f.identity.descriptor[4]),
  ],
  ["payload wrong run", (f) => f.payloadArtifact.workflow_run.id++],
  [
    "payload candidate source",
    (f) => (f.payloadArtifact.workflow_run.head_sha = f.identity.descriptor[4]),
  ],
  ["producer ID changed", (f) => f.producerArtifact.id++],
  ["payload ID changed", (f) => f.payloadArtifact.id++],
  ["rerun started", (f) => f.run.run_attempt++],
  ["failed run", (f) => (f.run.conclusion = "failure")],
  ["candidate run source", (f) => (f.run.head_sha = f.identity.descriptor[4])],
  ["missing job", (f) => (f.routes[JOBS] = { total_count: 0, jobs: [] })],
  ["skipped upload step", (f) => (f.job.steps[1].conclusion = "skipped")],
  [
    "missing producer listing",
    (f) => (f.routes[LIST] = { total_count: 1, artifacts: [f.payloadArtifact] }),
  ],
  [
    "missing payload listing",
    (f) => (f.routes[LIST] = { total_count: 1, artifacts: [f.producerArtifact] }),
  ],
  [
    "duplicate payload listing",
    (f) =>
      (f.routes[LIST] = {
        total_count: 3,
        artifacts: [f.payloadArtifact, f.payloadArtifact, f.producerArtifact],
      }),
  ],
  [
    "duplicate producer listing",
    (f) =>
      (f.routes[LIST] = {
        total_count: 3,
        artifacts: [f.payloadArtifact, f.producerArtifact, f.producerArtifact],
      }),
  ],
  [
    "mismatched exact producer artifact",
    (f) => (f.routes[PRODUCER_DETAIL] = { ...f.producerArtifact, name: "other-artifact" }),
  ],
]) {
  test(`baseline metadata refuses ${name} before any storage request`, async () => {
    const f = world();
    mutate(f);
    await refuses(f);
    noStorageRequest(f);
  });
}

// ------------------------------------------------- race and rerun after bytes
for (const [name, install] of [
  [
    "payload artifact expires",
    (f) =>
      (f.routes[PAYLOAD_DETAIL] = afterDownload(f, f.payloadArtifact, {
        ...f.payloadArtifact,
        expired: true,
      })),
  ],
  [
    "producer artifact expires",
    (f) =>
      (f.routes[PRODUCER_DETAIL] = afterDownload(f, f.producerArtifact, {
        ...f.producerArtifact,
        expired: true,
      })),
  ],
  [
    "producer artifact is replaced with a different digest",
    (f) =>
      (f.routes[PRODUCER_DETAIL] = afterDownload(f, f.producerArtifact, {
        ...f.producerArtifact,
        digest: `sha256:${"e".repeat(64)}`,
      })),
  ],
  [
    "payload listing loses the producer",
    (f) =>
      (f.routes[LIST] = afterDownload(
        f,
        { total_count: 2, artifacts: [f.payloadArtifact, f.producerArtifact] },
        { total_count: 1, artifacts: [f.payloadArtifact] },
      )),
  ],
  [
    "a rerun is started",
    (f) =>
      (f.routes[RUN] = afterDownload(f, f.run, {
        ...f.run,
        run_attempt: 2,
        status: "in_progress",
      })),
  ],
  [
    "the run is no longer successful",
    (f) => (f.routes[RUN] = afterDownload(f, f.run, { ...f.run, conclusion: "cancelled" })),
  ],
  [
    "the exact attempt changes",
    (f) => (f.routes[`${RUN}/attempts/1`] = afterDownload(f, f.run, { ...f.run, run_attempt: 2 })),
  ],
  [
    "the job list changes",
    (f) =>
      (f.routes[JOBS] = afterDownload(
        f,
        { total_count: 1, jobs: [f.job] },
        { total_count: 1, jobs: [{ ...f.job, conclusion: "failure" }] },
      )),
  ],
]) {
  test(`baseline bytes are refused when ${name} after transfer`, async () => {
    const f = world();
    install(f);
    await refuses(f);
    // The bytes were fetched; the failure is the post-transfer metadata check.
    assert.ok(f.keys().includes(PAYLOAD_SIGNED) && f.keys().includes(PRODUCER_SIGNED));
  });
}

// ----------------------------------------------------------------- transfers
for (const [name, install] of [
  [
    "a 200 instead of the redirect",
    (f) => (f.routes[PAYLOAD_ZIP] = () => archiveResponse(f.payload)),
  ],
  [
    "a producer 200 instead of the redirect",
    (f) => (f.routes[PRODUCER_ZIP] = () => archiveResponse(f.producerArchive)),
  ],
  ["a 301 redirect", (f) => (f.routes[PAYLOAD_ZIP] = () => redirect(PAYLOAD_SIGNED, 301))],
  ["a missing location", (f) => (f.routes[PAYLOAD_ZIP] = () => redirect(null))],
  [
    "an http location",
    (f) => (f.routes[PAYLOAD_ZIP] = () => redirect(PAYLOAD_SIGNED.replace("https:", "http:"))),
  ],
  [
    "a foreign location",
    (f) => (f.routes[PRODUCER_ZIP] = () => redirect("https://evil.example.com/a.zip?sig=1")),
  ],
  [
    "an api location",
    (f) => (f.routes[PAYLOAD_ZIP] = () => redirect(`${BASE}/actions/artifacts/600/zip`)),
  ],
  [
    "a lookalike storage host",
    (f) =>
      (f.routes[PAYLOAD_ZIP] = () =>
        redirect("https://productionresultssa7.blob.core.windows.net.evil.example/a.zip")),
  ],
  [
    "a location with credentials",
    (f) =>
      (f.routes[PAYLOAD_ZIP] = () =>
        redirect("https://user:pw@productionresultssa7.blob.core.windows.net/a.zip")),
  ],
  [
    "a location with a port",
    (f) =>
      (f.routes[PAYLOAD_ZIP] = () =>
        redirect("https://productionresultssa7.blob.core.windows.net:444/a.zip")),
  ],
  [
    "a location with a fragment",
    (f) => (f.routes[PAYLOAD_ZIP] = () => redirect(`${PAYLOAD_SIGNED}#x`)),
  ],
  [
    "a relative location",
    (f) => (f.routes[PAYLOAD_ZIP] = () => redirect("/actions-results/a.zip")),
  ],
  [
    "a second redirect from storage",
    (f) => (f.routes[PAYLOAD_SIGNED] = () => redirect(PRODUCER_SIGNED)),
  ],
  [
    "a storage 404",
    (f) => (f.routes[PRODUCER_SIGNED] = () => new Response("nope", { status: 404 })),
  ],
  [
    "a storage 206",
    (f) =>
      (f.routes[PAYLOAD_SIGNED] = () =>
        new Response(f.payload, { status: 206, headers: { "content-type": "application/zip" } })),
  ],
  [
    "an HTML payload",
    (f) =>
      (f.routes[PAYLOAD_SIGNED] = () =>
        archiveResponse(f.payload, { "content-type": "text/html" })),
  ],
  [
    "a JSON producer",
    (f) =>
      (f.routes[PRODUCER_SIGNED] = () =>
        archiveResponse(f.producerArchive, { "content-type": "application/json" })),
  ],
  [
    "a missing content type",
    (f) => (f.routes[PAYLOAD_SIGNED] = () => new Response(f.payload, { status: 200 })),
  ],
  [
    "a short payload content length",
    (f) =>
      (f.routes[PAYLOAD_SIGNED] = () =>
        archiveResponse(f.payload, { "content-length": String(f.payload.length - 1) })),
  ],
  [
    "a long producer content length",
    (f) =>
      (f.routes[PRODUCER_SIGNED] = () =>
        archiveResponse(f.producerArchive, {
          "content-length": String(f.producerArchive.length + 1),
        })),
  ],
  [
    "an oversize content length",
    (f) =>
      (f.routes[PAYLOAD_SIGNED] = () =>
        archiveResponse(f.payload, { "content-length": String(MAX + 1) })),
  ],
  [
    "a malformed content length",
    (f) =>
      (f.routes[PAYLOAD_SIGNED] = () => archiveResponse(f.payload, { "content-length": "12abc" })),
  ],
  [
    "an empty payload",
    (f) =>
      (f.routes[PAYLOAD_SIGNED] = () =>
        new Response(new Uint8Array(0), {
          status: 200,
          headers: { "content-type": "application/zip" },
        })),
  ],
  [
    "a bodyless payload",
    (f) =>
      (f.routes[PAYLOAD_SIGNED] = () =>
        new Response(null, { status: 200, headers: { "content-type": "application/zip" } })),
  ],
  [
    "a truncated payload",
    (f) =>
      (f.routes[PAYLOAD_SIGNED] = () =>
        archiveResponse(f.payload.subarray(0, f.payload.length - 5))),
  ],
  [
    "a payload digest mismatch",
    (f) => {
      const other = Buffer.from(f.payload);
      other[other.length - 30] ^= 1;
      f.routes[PAYLOAD_SIGNED] = () => archiveResponse(other);
    },
  ],
  [
    "a producer digest mismatch",
    (f) => {
      const other = Buffer.from(f.producerArchive);
      other[10] ^= 1;
      f.routes[PRODUCER_SIGNED] = () => archiveResponse(other);
    },
  ],
  [
    "swapped channel archives",
    (f) => {
      f.routes[PAYLOAD_SIGNED] = () => archiveResponse(f.producerArchive);
      f.routes[PRODUCER_SIGNED] = () => archiveResponse(f.payload);
    },
  ],
  [
    "a storage transport failure",
    (f) =>
      (f.routes[PAYLOAD_SIGNED] = () => {
        throw new Error(`${TOKEN} ${SAS} private upstream detail`);
      }),
  ],
  [
    "an API transport failure",
    (f) =>
      (f.routes[PRODUCER_ZIP] = () => {
        throw new Error(`${TOKEN} private upstream detail`);
      }),
  ],
  [
    "a metadata transport failure",
    (f) =>
      (f.routes[RUN] = () => {
        throw new Error(`${TOKEN} private upstream detail`);
      }),
  ],
  [
    "a failing storage stream",
    (f) =>
      (f.routes[PAYLOAD_SIGNED] = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`${SAS} stream detail`));
            },
          }),
          { status: 200, headers: { "content-type": "application/zip" } },
        )),
  ],
]) {
  test(`baseline transfer refuses ${name} with a redacted error`, async () => {
    const f = world();
    install(f);
    await refuses(f);
  });
}

test("an oversize streamed archive is cancelled and refused", async () => {
  const f = world();
  const state = { cancelled: false };
  f.routes[PAYLOAD_SIGNED] = () =>
    new Response(openStream(new Uint8Array(1024 * 1024), state), {
      status: 200,
      headers: { "content-type": "application/zip" },
    });
  await refuses(f);
  assert.equal(state.cancelled, true);
});

// -------------------------------------------------------------- cancellation
test("an already aborted signal refuses before any request", async () => {
  const f = world();
  const controller = new AbortController();
  controller.abort();
  f.options = { signal: controller.signal };
  await refuses(f);
  assert.equal(f.calls.length, 0);
});

test("aborting during the API download refuses and skips the post-transfer metadata read", async () => {
  const f = world();
  const controller = new AbortController();
  f.options = { signal: controller.signal };
  f.routes[PAYLOAD_ZIP] = async (_index, init) => {
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    if (init?.signal?.aborted) throw new Error(`${TOKEN} aborted upstream`);
    return redirect(PAYLOAD_SIGNED);
  };
  await refuses(f);
  assert.ok(!f.keys().includes(PAYLOAD_SIGNED));
  assert.equal(f.counts.get(RUN), 2);
});

test("aborting during the byte transfer refuses", async () => {
  const f = world();
  const controller = new AbortController();
  f.options = { signal: controller.signal };
  const state = { cancelled: false };
  f.routes[PAYLOAD_SIGNED] = (_index, init) => {
    queueMicrotask(() => controller.abort());
    const body = new ReadableStream({
      pull() {
        assert.ok(init.signal);
        return new Promise((_resolve, reject) => {
          if (init.signal.aborted) return reject(new Error(`${SAS} aborted`));
          init.signal.addEventListener("abort", () => reject(new Error(`${SAS} aborted`)), {
            once: true,
          });
        });
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/zip" } });
  };
  await refuses(f);
  // Whatever completed, no post-transfer success was reported and the run was
  // not re-read after the abort.
  assert.equal(f.counts.get(RUN) ?? 0, 2);
});

test("aborting after both transfers but before verification completes still refuses", async () => {
  const f = world();
  const controller = new AbortController();
  f.options = { signal: controller.signal };
  f.routes[RUN] = (index) => {
    if (f.downloaded && index >= 2) controller.abort();
    return f.run;
  };
  f.routes[`${RUN}/attempts/1`] = async () => {
    if (f.downloaded) await new Promise((resolve) => setImmediate(resolve));
    return f.run;
  };
  await refuses(f);
});

// ------------------------------------------------------------- ZIP profiles
const zipCases = [
  ["payload without baseline.json", { payload: (e) => e.splice(0, 1) }],
  ["payload with an extra unreferenced file", { payload: (e) => e.push({ path: "file-0099" }) }],
  ["payload with an unexpected name", { payload: (e) => e.push({ path: "evil.txt" }) }],
  ["payload with a nested name", { payload: (e) => e.push({ path: "dir/file-0099" }) }],
  ["payload with traversal", { payload: (e) => e.push({ path: "../file-0099" }) }],
  ["payload with a worker bundle name", { payload: (e) => e.push({ path: "worker/worker.mjs" }) }],
  ["payload missing a referenced file", { payload: (e) => e.pop() }],
  ["payload missing the first referenced file", { payload: (e) => e.splice(1, 1) }],
  ["payload with a duplicate entry", { payload: (e) => e.push({ ...e[1] }) }],
  ["payload with a duplicate baseline.json", { payload: (e) => e.push({ ...e[0] }) }],
  ["payload with a case-folded duplicate", { payload: (e) => e.push({ path: "BASELINE.JSON" }) }],
  ["payload with a bad CRC", { payload: (e) => (e[2].crcDelta = 1) }],
  ["payload with a symlink entry", { payload: (e) => (e[2].mode = 0o120777) }],
  [
    "payload with a directory entry",
    { payload: (e) => e.push({ path: "file-0099/", bytes: Buffer.alloc(0) }) },
  ],
  [
    "payload with swapped entry bytes",
    { payload: (e) => ([e[1].bytes, e[2].bytes] = [e[2].bytes, e[1].bytes]) },
  ],
  ["payload with tampered file bytes", { payload: (e) => (e[3].bytes = Buffer.from("tampered")) }],
  [
    "payload with same-size tampered file bytes",
    { payload: (e) => (e[1].bytes = Buffer.alloc(e[1].bytes.length, 0x41)) },
  ],
  ["payload with an empty file entry", { payload: (e) => (e[2].bytes = Buffer.alloc(0)) }],
  [
    "producer without producer.json",
    { producerZip: (e) => e.splice(0, 1, { path: "other.json" }) },
  ],
  ["producer with an extra file", { producerZip: (e) => e.push({ path: "file-0000" }) }],
  ["producer with a baseline.json", { producerZip: (e) => e.push({ path: "baseline.json" }) }],
  ["producer with a duplicate", { producerZip: (e) => e.push({ ...e[0] }) }],
  [
    "producer with a case-folded duplicate",
    { producerZip: (e) => e.push({ path: "Producer.json" }) },
  ],
  ["producer with a bad CRC", { producerZip: (e) => (e[0].crcDelta = 1) }],
  ["producer with a nested name", { producerZip: (e) => (e[0].path = "dir/producer.json") }],
];
for (const [name, opts] of zipCases) {
  test(`baseline archive refuses ${name}`, async () => {
    const f = world(opts);
    await refuses(f);
  });
}

test("a payload ZIP with only a manifest and no declared files is refused", async () => {
  const f = world({ payload: (e) => e.splice(1) });
  await refuses(f);
});

test("a ZIP carrying a swapped-in ZIP of the other channel is refused", async () => {
  const f = world();
  const producerOnly = zip([
    { path: "producer.json", bytes: Buffer.from(JSON.stringify(f.producerRecord)) },
  ]);
  f.selection.archiveSha256 = candidateSha256(producerOnly);
  f.payloadArtifact.digest = `sha256:${f.selection.archiveSha256}`;
  f.routes[PAYLOAD_SIGNED] = () => archiveResponse(producerOnly);
  await refuses(f);
});

// ------------------------------------------------------------------- manifest
const wrongSha = "f".repeat(64);
const manifestCases = [
  ["malformed JSON", { manifestBytes: () => Buffer.from("{not json") }],
  ["invalid UTF-8", { manifestBytes: () => Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) }],
  ["non-object JSON", { manifestBytes: () => Buffer.from("[]") }],
  ["a null manifest", { manifestBytes: () => Buffer.from("null") }],
  ["an empty manifest object", { manifestBytes: () => Buffer.from("{}") }],
  ["an extra manifest key", { manifest: (m) => (m.extra = true) }],
  ["a missing manifest key", { manifest: (m) => delete m.mainModule }],
  ["another schema", { manifest: (m) => (m.schema = "two.staging-baseline-retention.v2") }],
  ["promotable true", { manifest: (m) => (m.promotable = true) }],
  ["promotable as a string", { manifest: (m) => (m.promotable = "false") }],
  ["another scope", { manifest: (m) => (m.scope = "provider-snapshot") }],
  ["another main module", { manifest: (m) => (m.mainModule = "index.js") }],
  ["another version", { manifest: (m) => (m.versionId = "22222222-2222-3333-4444-555555555555") }],
  ["a version alias", { manifest: (m) => (m.versionId = "latest") }],
  ["an empty file list", { manifest: (m) => (m.files = []), payload: (e) => e.splice(1) }],
  ["a non-array file list", { manifest: (m) => (m.files = {}), rehash: false }],
  ["a missing root", { manifest: (m) => delete m.rootSha256, rehash: false }],
  [
    "an uppercase root",
    { manifest: (m) => (m.rootSha256 = m.rootSha256.toUpperCase()), rehash: false },
  ],
  ["a wrong root", { manifest: (m) => (m.rootSha256 = wrongSha), rehash: false }],
  [
    "a root over reordered keys",
    {
      manifest: (m) =>
        (m.rootSha256 = candidateSha256(JSON.stringify(m.files.map((r) => ({ path: r.path }))))),
      rehash: false,
    },
  ],
  // Producer provenance inside the manifest.
  ["producer provenance with an extra key", { manifest: (m) => (m.producer.extra = "x") }],
  ["producer provenance missing a key", { manifest: (m) => delete m.producer.event }],
  ["a candidate source SHA", { manifest: (m) => (m.producer.sourceSha = "a".repeat(40)) }],
  [
    "a workflow SHA different from the controller",
    { manifest: (m) => (m.producer.workflowSha = "a".repeat(40)) },
  ],
  [
    "a source SHA different from the workflow SHA only",
    { manifest: (m) => (m.producer.sourceSha = "c".repeat(40)) },
  ],
  ["a short source SHA", { manifest: (m) => (m.producer.sourceSha = CONTROLLER.slice(0, 39)) }],
  ["a foreign repository", { manifest: (m) => (m.producer.repository = "elsewhere/repo") }],
  ["a foreign repository ID", { manifest: (m) => (m.producer.repositoryId = "1235") }],
  ["a numeric repository ID", { manifest: (m) => (m.producer.repositoryId = 1234) }],
  ["another run", { manifest: (m) => (m.producer.runId = "501") }],
  ["a numeric run", { manifest: (m) => (m.producer.runId = 500) }],
  ["a rerun attempt", { manifest: (m) => (m.producer.runAttempt = "2") }],
  ["a push event", { manifest: (m) => (m.producer.event = "push") }],
  ["a pull request event", { manifest: (m) => (m.producer.event = "pull_request") }],
  [
    "a workflow_dispatch event when the installed contract is workflow_run",
    { manifest: (m) => (m.producer.event = "workflow_dispatch") },
  ],
  ["a null producer", { manifest: (m) => (m.producer = null) }],
  // File records.
  ["a record with an extra key", { manifest: (m) => (m.files[0].mode = "0755") }],
  ["a record missing a key", { manifest: (m) => delete m.files[0].size }],
  ["a null record", { manifest: (m) => (m.files[0] = null) }],
  ["an unknown kind", { manifest: (m) => (m.files[0].kind = "config") }],
  ["a wrong size", { manifest: (m) => m.files[0].size++ }],
  ["a negative size", { manifest: (m) => (m.files[0].size = -1) }],
  ["a fractional size", { manifest: (m) => (m.files[0].size += 0.5) }],
  ["a string size", { manifest: (m) => (m.files[0].size = String(m.files[0].size)) }],
  ["a wrong digest", { manifest: (m) => (m.files[0].sha256 = wrongSha) }],
  [
    "an uppercase digest",
    { manifest: (m) => (m.files[0].sha256 = m.files[0].sha256.toUpperCase()) },
  ],
  ["a non-sequential entry", { manifest: (m) => (m.files[1].entry = "file-0005") }],
  [
    "an entry starting at one",
    { manifest: (m) => m.files.forEach((r, i) => (r.entry = entryName(i + 1))) },
  ],
  ["a duplicated entry", { manifest: (m) => (m.files[1].entry = m.files[0].entry) }],
  ["a traversal entry", { manifest: (m) => (m.files[0].entry = "../file-0000") }],
  ["baseline.json as an entry", { manifest: (m) => (m.files[0].entry = "baseline.json") }],
  ["a short entry number", { manifest: (m) => (m.files[0].entry = "file-000") }],
  ["an unsorted file list", { order: (list) => list.reverse() }],
  ["a swapped pair of records", { order: (list) => [list[1], list[0], ...list.slice(2)] }],
  [
    "a duplicate kind and path",
    {
      manifest: (m) => m.files.push({ ...m.files.at(-1), entry: "file-0004" }),
      payload: (e) => e.push({ path: "file-0004", bytes: Buffer.from(SENTINEL) }),
    },
  ],
  [
    "a case-folded duplicate asset path",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "APP.css", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "a case-folded duplicate module path",
    {
      files: [
        ...defaultFiles(),
        {
          kind: "module",
          path: "_WORKER.JS.MAP",
          contentType: "application/source-map",
          bytes: Buffer.from("x"),
        },
      ],
    },
  ],
  // Modules and assets.
  ["a missing worker module", { files: defaultFiles().slice(1) }],
  ["a source map without a worker", { files: [defaultFiles()[1], defaultFiles()[2]] }],
  [
    "a module with another name",
    {
      files: [
        ...defaultFiles().slice(0, 1),
        {
          kind: "module",
          path: "evil.js",
          contentType: "application/javascript+module",
          bytes: Buffer.from("x"),
        },
      ],
    },
  ],
  [
    "a nested module",
    {
      files: [
        ...defaultFiles().slice(0, 1),
        {
          kind: "module",
          path: "chunks/a.js",
          contentType: "application/javascript+module",
          bytes: Buffer.from("x"),
        },
      ],
    },
  ],
  [
    "a worker module with the wrong MIME",
    {
      files: [
        { ...defaultFiles()[0], contentType: "application/javascript" },
        ...defaultFiles().slice(1),
      ],
    },
  ],
  [
    "a worker module with a null MIME",
    { files: [{ ...defaultFiles()[0], contentType: null }, ...defaultFiles().slice(1)] },
  ],
  [
    "a source map with the wrong MIME",
    {
      files: [
        defaultFiles()[0],
        { ...defaultFiles()[1], contentType: "application/json" },
        ...defaultFiles().slice(2),
      ],
    },
  ],
  [
    "a swapped module MIME",
    {
      files: [
        { ...defaultFiles()[0], contentType: "application/source-map" },
        { ...defaultFiles()[1], contentType: "application/javascript+module" },
        ...defaultFiles().slice(2),
      ],
    },
  ],
  [
    "an asset with a MIME type",
    {
      files: [
        ...defaultFiles().slice(0, 2),
        { kind: "asset", path: "app.css", contentType: "text/css", bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an asset with an empty MIME",
    {
      files: [
        ...defaultFiles().slice(0, 2),
        { kind: "asset", path: "app.css", contentType: "", bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an asset with a traversal path",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "../secret", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an asset with a nested traversal path",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "a/../../b", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an absolute asset path",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "/etc/passwd", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an asset path with a double slash",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "a//b", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an asset path with a backslash",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "a\\b", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an asset path with a dot segment",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "./a", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an empty asset path",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an asset path with a control character",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "a\nb", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an asset path with a NUL",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "a\0b", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an asset path with a trailing slash",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "dir/", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an asset path prefixed with assets/../",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "assets/../x", contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  [
    "an oversize asset path",
    {
      files: [
        ...defaultFiles(),
        { kind: "asset", path: "a".repeat(1025), contentType: null, bytes: Buffer.from("x") },
      ],
    },
  ],
  ["an oversize manifest", { manifest: (m) => (m.producer.padding = "x".repeat(1024 * 1024)) }],
];
for (const [name, opts] of manifestCases) {
  test(`baseline manifest refuses ${name}`, async () => {
    const f = world(opts);
    await refuses(f);
  });
}

test("a manifest swapped for another but still self-consistent manifest is refused by the producer join", async () => {
  const f = world();
  const other = world({ files: defaultFiles().slice(0, 2) });
  // Payload carries the other manifest/files; the producer record still joins the first.
  f.payload = other.payload;
  f.selection.archiveSha256 = other.selection.archiveSha256;
  f.payloadArtifact.digest = `sha256:${f.selection.archiveSha256}`;
  f.routes[PAYLOAD_SIGNED] = () => archiveResponse(other.payload);
  await refuses(f);
});

// ----------------------------------------------------------- producer record
const producerCases = [
  ["malformed JSON", { producerBytes: Buffer.from("{nope") }],
  ["invalid UTF-8", { producerBytes: Buffer.from([0x7b, 0xff, 0x7d]) }],
  ["a non-object record", { producerBytes: Buffer.from("[]") }],
  ["a null record", { producerBytes: Buffer.from("null") }],
  ["an extra key", { producerRecord: (p) => (p.extra = true) }],
  ["a missing key", { producerRecord: (p) => delete p.manifestSha256 }],
  ["another schema", { producerRecord: (p) => (p.schema = "two.staging-baseline-producer.v2") }],
  ["promotable true", { producerRecord: (p) => (p.promotable = true) }],
  ["another scope", { producerRecord: (p) => (p.scope = "retained-bytes-only") }],
  [
    "another version",
    { producerRecord: (p) => (p.versionId = "22222222-2222-3333-4444-555555555555") },
  ],
  ["another artifact ID", { producerRecord: (p) => (p.artifactId = "601") }],
  ["a numeric artifact ID", { producerRecord: (p) => (p.artifactId = 600) }],
  ["another payload archive digest", { producerRecord: (p) => (p.archiveSha256 = wrongSha) }],
  ["another manifest digest", { producerRecord: (p) => (p.manifestSha256 = wrongSha) }],
  ["another root", { producerRecord: (p) => (p.rootSha256 = wrongSha) }],
  ["an uppercase root", { producerRecord: (p) => (p.rootSha256 = p.rootSha256.toUpperCase()) }],
  ["another source", { producerRecord: (p) => (p.producer.sourceSha = "a".repeat(40)) }],
  ["another workflow SHA", { producerRecord: (p) => (p.producer.workflowSha = "a".repeat(40)) }],
  ["another run", { producerRecord: (p) => (p.producer.runId = "501") }],
  ["another repository", { producerRecord: (p) => (p.producer.repository = "elsewhere/repo") }],
  ["another event", { producerRecord: (p) => (p.producer.event = "workflow_dispatch") }],
  ["an extra source key", { producerRecord: (p) => (p.producer.extra = "x") }],
  [
    "a candidate source",
    {
      producerRecord: (p) =>
        (p.producer = { ...p.producer, sourceSha: "a".repeat(40), workflowSha: "a".repeat(40) }),
    },
  ],
];
for (const [name, opts] of producerCases) {
  test(`baseline producer record refuses ${name}`, async () => {
    const f = world(opts);
    await refuses(f);
  });
}

test("a producer record that does not bind the payload archive digest is refused even if it is internally valid", async () => {
  const f = world();
  const stale = world({ files: defaultFiles().slice(0, 3) });
  // Producer channel from a different payload: its join names other bytes.
  f.selection.producerArchiveSha256 = stale.selection.producerArchiveSha256;
  f.producerArtifact.digest = `sha256:${stale.selection.producerArchiveSha256}`;
  f.routes[PRODUCER_SIGNED] = () => archiveResponse(stale.producerArchive);
  await refuses(f);
});

// ------------------------------------------------------------------ redaction
test("every refusal is the exact redacted error without cause or secrets", async () => {
  const f = world();
  f.routes[PAYLOAD_SIGNED] = () => {
    throw new Error(`${TOKEN} ${SAS} private upstream detail https://api.github.com sig=`);
  };
  try {
    await f.read();
    assert.fail("expected refusal");
  } catch (error) {
    assert.ok(error instanceof Error);
    redacted(error);
    assert.equal(error.message, "Candidate artifact refused: baseline-evidence");
  }
});

test("an unrouted request is a redacted refusal", async () => {
  const f = world();
  delete f.routes[PRODUCER_DETAIL];
  await refuses(f);
});

// ------------------------------------------------------------------ determinism
test("a legitimate producer record equals the shipped record builder output", async () => {
  const { baselineProducerRecord } = await import("./candidate-staging-baseline-retain.mjs");
  const f = world();
  const record = baselineProducerRecord({
    manifestBytes: f.manifestBytes,
    artifactId: "600",
    archiveSha256: sha(f.payload),
  });
  assert.deepEqual({ ...record }, f.producerRecord);
});

test("repeat reads of the same selection are independent and equal", async () => {
  const f = world();
  const first = await f.read();
  const second = await f.read();
  assert.deepEqual(second, first);
  assert.notEqual(second.files[0].bytes, first.files[0].bytes);
});
