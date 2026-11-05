import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateArtifactReader } from "./candidate-staging-artifact.mjs";
import { createCandidateBaselineProviderReader } from "./candidate-staging-baseline-provider.mjs";
import {
  prepareCandidateBaselineAssetInput,
  prepareCandidateBaselineUpload,
} from "./candidate-staging-baseline-upload.mjs";

// Synthetic values; none may ever appear in a diagnostic or a result.
const CF_TOKEN = "fixture-cloudflare-bearer-not-a-secret";
const GH_TOKEN = "fixture-github-bearer-not-a-secret";
const SAS = "sig-fixture-not-a-secret";
const REFUSED = "Candidate baseline refused: provider-evidence";
const CONTROLLER = "b".repeat(40);
const VERSION = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-9999-4999-8999-999999999999";
const D1 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const D2 = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
const D3 = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3";
const NOW = 1793819000;
const ACCOUNT = "1".repeat(32);
const HYPERDRIVE = "2".repeat(32);
const WORKFLOW = ".github/workflows/deploy.yml";
const GH = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
const SCRIPT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/two-web-next`;
const VERSION_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/workers/two-web-next/versions/${VERSION}?include=modules`;
const PAYLOAD_SIGNED = `https://productionresultssa7.blob.core.windows.net/actions-results/600/payload.zip?sig=${SAS}%2Bx&se=2026-11-04T00%3A00%3A00Z`;
const PRODUCER_SIGNED = `https://productionresultssa8.blob.core.windows.net/actions-results/601/producer.zip?sig=${SAS}%2By&se=2026-11-04T00%3A00%3A00Z`;
const SENTINEL = "globalThis.__providerExecuted = true;\nthrow new Error('executed');\n";
const MAP = '{"version":3}'; // 13 bytes: base64 has "==" padding and spare bits
const ORIGIN = "https://next.togetherweown.com";
const LISTS = ["cf-list", "cf-exact", "cf-list", "cf-version", "cf-list", "cf-exact", "cf-list"];
const EXPECTED_GUARDS = 19; // 5 provider guards + 2 serving captures of 7 guards

const enc = (text) => new TextEncoder().encode(text);
const iso = (time) => new Date(time * 1000).toISOString();
const keyOf = (file) => `${file.kind}:${file.path}`;
const sortFiles = (files) =>
  [...files].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));

// ---------------------------------------------------------------- ZIP builder
// Minimal writer for the narrow profile the artifact reader accepts: deflate,
// UTF-8 flag, no descriptors or extras, unix regular-file attributes.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const data = deflateRawSync(entry.bytes);
    const crc = crc32(entry.bytes) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
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

function files(withAsset = false) {
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
      bytes: Buffer.from(MAP),
    },
    ...(withAsset
      ? [
          {
            kind: "asset",
            path: "app.css",
            contentType: null,
            bytes: Buffer.from("body{margin:0}\n"),
          },
        ]
      : []),
  ];
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function result(value, init = {}) {
  return new Response(JSON.stringify({ success: true, errors: [], result: value }), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function row(id = D1, version = VERSION, time = NOW - 100) {
  return {
    id,
    created_on: iso(time),
    source: "api",
    strategy: "percentage",
    versions: [{ version_id: version, percentage: 100 }],
  };
}

function artifactRow(id, name, digest) {
  return {
    id,
    name,
    expired: false,
    digest: `sha256:${digest}`,
    workflow_run: { id: 500, repository_id: 1234, head_repository_id: 1234, head_sha: CONTROLLER },
  };
}

function openStream(state, chunk = enc("{")) {
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

// ---------------------------------------------------------------- the world
// One in-memory GitHub (artifact protocol), storage and Cloudflare. Nothing in
// it hands the reader a pre-admitted receipt: the real reader runs end to end.
function build({ withAsset = false, fileSet } = {}) {
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
  const trees = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];
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
  const ordered = sortFiles(fileSet ?? files(withAsset));
  const records = ordered.map((file, index) => ({
    kind: file.kind,
    path: file.path,
    contentType: file.contentType,
    size: file.bytes.length,
    sha256: candidateSha256(file.bytes),
    entry: `file-${String(index).padStart(4, "0")}`,
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
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const payload = zip([
    { path: "baseline.json", bytes: manifestBytes },
    ...ordered.map((file, index) => ({ path: records[index].entry, bytes: file.bytes })),
  ]);
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
  const producerArchive = zip([
    { path: "producer.json", bytes: Buffer.from(JSON.stringify(producerRecord)) },
  ]);
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
  const redirect = (location) => new Response(null, { status: 302, headers: { location } });
  const archive = (bytes) =>
    new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/zip", "content-length": String(bytes.length) },
    });
  const routes = {
    [`/git/commits/${CONTROLLER}`]: { sha: CONTROLLER, tree: { sha: trees[0] } },
    [`/git/trees/${trees[0]}`]: {
      sha: trees[0],
      truncated: false,
      tree: [{ path: ".github", type: "tree", mode: "040000", sha: trees[1] }],
    },
    [`/git/trees/${trees[1]}`]: {
      sha: trees[1],
      truncated: false,
      tree: [{ path: "workflows", type: "tree", mode: "040000", sha: trees[2] }],
    },
    [`/git/trees/${trees[2]}`]: {
      sha: trees[2],
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
    "/actions/runs/500": run,
    "/actions/runs/500/attempts/1": run,
    "/actions/runs/500/attempts/1/jobs?per_page=100&page=1": { total_count: 1, jobs: [job] },
    "/actions/runs/500/artifacts?per_page=100&page=1": {
      total_count: 2,
      artifacts: [payloadArtifact, producerArtifact],
    },
    "/actions/artifacts/600": payloadArtifact,
    "/actions/artifacts/601": producerArtifact,
    "/actions/artifacts/600/zip": () => redirect(PAYLOAD_SIGNED),
    "/actions/artifacts/601/zip": () => redirect(PRODUCER_SIGNED),
    [PAYLOAD_SIGNED]: () => archive(payload),
    [PRODUCER_SIGNED]: () => archive(producerArchive),
  };

  const profile = {
    schema: "two.candidate-upload-profile.v1",
    accountId: ACCOUNT,
    scriptName: "two-web-next",
    bindings: [
      { name: "DB", type: "hyperdrive", id: HYPERDRIVE },
      { name: "DISCORD_CLIENT_ID", type: "plain_text", text: "123456789012345678" },
    ],
  };
  // Deliberately unsorted: the reader canonicalizes binding order.
  const version = {
    id: VERSION,
    number: 3,
    created_on: iso(NOW - 100),
    main_module: "_worker.js",
    modules: ordered
      .filter((file) => file.kind === "module")
      .map((file) => ({
        name: file.path,
        content_type: file.contentType,
        content_base64: file.bytes.toString("base64"),
      })),
    bindings: [
      { name: "DB", type: "hyperdrive", id: HYPERDRIVE },
      { name: "APP_URL", type: "plain_text", text: ORIGIN },
      { name: "SESSION_SECRET", type: "secret_text" },
      { name: "DISCORD_CLIENT_ID", type: "plain_text", text: "123456789012345678" },
      { name: "CF_VERSION_METADATA", type: "version_metadata" },
      ...(withAsset ? [{ name: "ASSETS", type: "assets" }] : []),
    ],
    compatibility_date: "2026-09-29",
    compatibility_flags: ["nodejs_compat"],
    placement: { mode: "targeted", region: "aws:us-east-1" },
    annotations: { "workers/tag": CONTROLLER },
    ...(withAsset ? { assets: { config: { run_worker_first: true } } } : {}),
  };

  const p = {
    identity,
    contract,
    selection,
    sourceManifest,
    profile,
    profileSha256: candidateSha256(JSON.stringify(profile)),
    ordered,
    routes,
    version,
    deployments: [row()],
    calls: [],
    cfCalls: 0,
    guards: [],
    events: [],
    onGuard: null,
    hook: null,
    versionReply: null,
    clock: () => NOW,
  };
  const classify = (url) => {
    if (url.startsWith("https://api.github.com/")) return "github";
    if (url === PAYLOAD_SIGNED || url === PRODUCER_SIGNED) return "storage";
    if (url === `${SCRIPT}/deployments`) return "cf-list";
    if (url.startsWith(`${SCRIPT}/deployments/`)) return "cf-exact";
    if (url === VERSION_URL) return "cf-version";
    return "unknown";
  };
  p.fetchImpl = async (url, init) => {
    const kind = classify(url);
    const call = { url, init, kind };
    p.calls.push(call);
    p.events.push(`fetch:${kind}`);
    if (kind === "github" || kind === "storage") {
      const key = kind === "github" ? url.slice(GH.length) : url;
      if (!Object.hasOwn(p.routes, key)) {
        throw new Error(`unrouted ${key} ${CF_TOKEN} ${GH_TOKEN} ${SAS}`);
      }
      const value = await (typeof p.routes[key] === "function" ? p.routes[key]() : p.routes[key]);
      return value instanceof Response ? value : json(value);
    }
    assert.notEqual(kind, "unknown", url);
    p.cfCalls += 1;
    let response;
    if (kind === "cf-list") response = result({ deployments: structuredClone(p.deployments) });
    else if (kind === "cf-exact") {
      const found = p.deployments.find((d) => url.endsWith(d.id));
      response = found ? result(structuredClone(found)) : new Response("{}", { status: 404 });
    } else {
      const body = structuredClone(p.version);
      response = p.versionReply ? p.versionReply(body) : result(body);
    }
    if (p.hook) p.hook(p.cfCalls, kind, p);
    return response;
  };
  p.exclusive = async (context, deadline) => {
    const n = p.guards.push({ context, deadline, calls: p.calls.length });
    p.events.push(`guard:${context.phase}`);
    assert.ok(Object.isFrozen(context));
    assert.ok(deadline instanceof AbortSignal);
    if (p.onGuard) await p.onGuard(n, context, deadline);
  };
  p.options = (extra = {}) => ({
    token: CF_TOKEN,
    githubToken: GH_TOKEN,
    identity: p.identity,
    profile: p.profile,
    profileSha256: p.profileSha256,
    installedContract: p.contract,
    sourceManifestBytes: p.sourceManifest,
    assertExclusive: p.exclusive,
    fetchImpl: p.fetchImpl,
    clock: p.clock,
    ...extra,
  });
  p.reader = (extra) => createCandidateBaselineProviderReader(p.options(extra));
  p.observe = (extra, operation) => p.reader(extra).observe(p.selection, operation);
  p.kinds = () => p.calls.map((c) => c.kind);
  p.cf = () => p.calls.filter((c) => c.kind.startsWith("cf-"));
  return p;
}

function redacted(error, label = "") {
  assert.ok(error instanceof Error, label);
  assert.equal(error.message, REFUSED, label);
  assert.equal(error.cause, undefined, label);
  const text = `${error.stack}${JSON.stringify(Object.getOwnPropertyNames(error))}`;
  for (const secret of [
    CF_TOKEN,
    GH_TOKEN,
    SAS,
    "blob.core.windows.net",
    "api.github.com",
    "api.cloudflare.com",
    "sig=",
    "executed",
    "private upstream",
    HYPERDRIVE,
    "123456789012345678",
  ]) {
    assert.ok(!text.includes(secret), `${label}: diagnostic leaks ${secret}`);
  }
  return true;
}

// Resolves to the (redacted) error so callers can add extra assertions.
async function refuses(p, label, extra, operation) {
  let error;
  try {
    await p.observe(extra, operation);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${label}: expected a refusal`);
  redacted(error, label);
  return error;
}

function noCloudflare(p, label) {
  assert.deepEqual(p.cf(), [], `${label}: no Cloudflare request expected`);
}

// ------------------------------------------------------------- construction
test("reader refuses unusable options before any request", () => {
  const p = build();
  const bad = (extra, label) =>
    assert.throws(
      () => createCandidateBaselineProviderReader(p.options(extra)),
      /^Error: Candidate (baseline|upload|artifact) refused: /,
      label,
    );
  for (const token of [undefined, null, "", 7, "a b", "a\nb", "a\x7fb", "x".repeat(4097)]) {
    bad({ token }, `token ${String(token).slice(0, 8)}`);
    bad({ githubToken: token }, `githubToken ${String(token).slice(0, 8)}`);
  }
  for (const name of ["assertExclusive", "fetchImpl", "clock"]) {
    for (const value of [undefined, null, 7, "x"]) {
      // Omitted fetch/clock use defaults, without issuing a constructor request.
      if (["fetchImpl", "clock"].includes(name) && value === undefined) {
        assert.doesNotThrow(() => p.reader({ [name]: value }));
        continue;
      }
      bad({ [name]: value }, `${name} ${String(value)}`);
    }
  }
  bad({ signal: {} }, "signal object");
  bad({ signal: "x" }, "signal string");
  bad({ sourceManifestBytes: new Uint8Array(p.sourceManifest) }, "Uint8Array manifest");
  bad({ sourceManifestBytes: p.sourceManifest.toString() }, "string manifest");
  bad({ sourceManifestBytes: undefined }, "missing manifest");
  bad({ identity: null }, "null identity");
  bad({ profileSha256: "0".repeat(64) }, "wrong profile digest");
  bad({ profileSha256: undefined }, "missing profile digest");
  bad({ profile: { ...p.profile, extra: true } }, "extra profile field");
  bad({ profile: { ...p.profile, scriptName: "other" } }, "foreign script");
  const tampered = structuredClone(p.identity);
  tampered.descriptor[2] = "elsewhere/repo";
  bad({ identity: tampered }, "foreign identity");
  assert.throws(
    () => createCandidateBaselineProviderReader(),
    /^Error: Candidate baseline refused: /,
  );
  assert.deepEqual(p.calls, []);
});

test("reader is frozen and never stores or exposes either token", () => {
  const p = build();
  const reader = p.reader();
  assert.equal(Object.isFrozen(reader), true);
  assert.deepEqual(Object.keys(reader), ["observe"]);
  const text = JSON.stringify(reader) + String(reader.observe) + Object.getOwnPropertyNames(reader);
  assert.ok(!text.includes(CF_TOKEN) && !text.includes(GH_TOKEN));
  assert.deepEqual(p.calls, []);
});

// ---------------------------------------------------------------- happy path
test("observe joins independently downloaded bytes to immutable provider state and serving", async () => {
  const p = build();
  const result = await p.observe();

  // Independent retained-byte read through the unmodified artifact reader.
  const q = build();
  const independent = await createCandidateArtifactReader({
    token: GH_TOKEN,
    fetchImpl: q.fetchImpl,
  }).readBaseline(q.identity, q.contract, q.selection, q.sourceManifest);

  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Object.keys(result).sort(), [
    "baseline",
    "baselineSha256",
    "files",
    "observedAt",
    "profileSha256",
    "promotable",
    "provenance",
    "q",
    "schema",
    "scope",
    "serving",
    "servingSha256",
  ]);
  assert.equal(result.schema, "two.candidate-baseline-provider.v1");
  assert.equal(result.promotable, false);
  assert.equal(result.scope, "immutable-code-config-and-serving-only");
  assert.equal(result.q, p.identity.q);
  assert.equal(result.profileSha256, p.profileSha256);
  assert.equal(result.observedAt, NOW);
  assert.deepEqual(result.provenance, independent.observation);
  assert.equal(result.provenance.controllerSha, CONTROLLER);
  for (const [key, value] of Object.entries(p.selection)) {
    assert.equal(result.provenance[key], value, key);
  }
  assert.deepEqual(
    result.files.map((f) => [f.kind, f.path]),
    [
      ["module", "_worker.js"],
      ["module", "_worker.js.map"],
    ],
  );
  assert.deepEqual(
    result.files,
    independent.files.map(({ path, kind, bytes }) => ({ path, kind, bytes })),
  );
  for (const [index, file] of result.files.entries()) {
    assert.deepEqual(Object.keys(file).sort(), ["bytes", "kind", "path"]);
    assert.ok(Buffer.isBuffer(file.bytes));
    assert.deepEqual(file.bytes, p.ordered[index].bytes);
  }
  assert.deepEqual(result.baseline, {
    schema: "two.candidate-baseline-web.v1",
    promotable: false,
    q: p.identity.q,
    profileSha256: p.profileSha256,
    versionId: VERSION,
    capturedAt: NOW,
    mainModule: "_worker.js",
    compatibilityDate: "2026-09-29",
    compatibilityFlags: ["nodejs_compat"],
    placement: { mode: "targeted", region: "aws:us-east-1" },
    annotations: { "workers/tag": CONTROLLER },
    assets: null,
    bindings: [
      { name: "APP_URL", type: "plain_text", text: ORIGIN },
      { name: "CF_VERSION_METADATA", type: "version_metadata" },
      { name: "DB", type: "hyperdrive", id: HYPERDRIVE },
      { name: "DISCORD_CLIENT_ID", type: "plain_text", text: "123456789012345678" },
      { name: "SESSION_SECRET", type: "secret_text" },
    ],
    files: p.ordered.map((file) => ({
      path: file.path,
      kind: file.kind,
      contentType: file.contentType,
      size: file.bytes.length,
      sha256: candidateSha256(file.bytes),
    })),
  });
  assert.equal(result.baselineSha256, candidateSha256(JSON.stringify(result.baseline)));
  assert.equal(result.serving.schema, "two.candidate-serving.v1");
  assert.equal(result.serving.promotable, false);
  assert.equal(result.serving.deploymentId, D1);
  assert.equal(result.serving.versionId, VERSION);
  assert.equal(result.serving.q, p.identity.q);
  assert.equal(result.serving.profileSha256, p.profileSha256);
  assert.equal(result.servingSha256, candidateSha256(JSON.stringify(result.serving)));
  // Retained worker bytes are data only: nothing ran, imported or evaluated.
  assert.equal(globalThis.__providerExecuted, undefined);
  const text = JSON.stringify(result);
  for (const secret of [CF_TOKEN, GH_TOKEN, SAS, "blob.core.windows.net", "api.github.com"]) {
    assert.ok(!text.includes(secret), secret);
  }
});

test("observe orders artifact reads, serving capture, immutable GET, serving capture", async () => {
  const p = build();
  await p.observe();
  const kinds = p.kinds();
  const firstCf = kinds.findIndex((k) => k.startsWith("cf-"));
  assert.ok(firstCf > 0);
  assert.ok(kinds.slice(0, firstCf).every((k) => k === "github" || k === "storage"));
  assert.ok(kinds.slice(0, firstCf).includes("storage"));
  assert.deepEqual(kinds.slice(firstCf), LISTS);
  assert.deepEqual(
    p.cf().map((c) => c.url),
    [
      `${SCRIPT}/deployments`,
      `${SCRIPT}/deployments/${D1}`,
      `${SCRIPT}/deployments`,
      VERSION_URL,
      `${SCRIPT}/deployments`,
      `${SCRIPT}/deployments/${D1}`,
      `${SCRIPT}/deployments`,
    ],
  );
  assert.equal(p.cf().filter((c) => c.url === VERSION_URL).length, 1);
});

test("exclusion is asserted before the first request and around every Cloudflare request", async () => {
  const p = build();
  await p.observe();
  assert.equal(p.guards.length, EXPECTED_GUARDS);
  assert.equal(p.guards[0].calls, 0);
  assert.equal(p.events[0], "guard:baseline-provider");
  assert.equal(p.events.at(-1).startsWith("guard:"), true);
  assert.equal(p.events.filter((e) => e === "guard:baseline-provider").length, 5);
  assert.equal(p.events.filter((e) => e === "guard:capture").length, 14);
  for (const [index, event] of p.events.entries()) {
    if (event.startsWith("fetch:cf-")) {
      assert.ok(p.events[index - 1].startsWith("guard:"), `before ${index}`);
      assert.ok(p.events[index + 1].startsWith("guard:"), `after ${index}`);
    }
  }
  // Exclusion happens between artifact reading and the first serving capture.
  const lastStorage = p.events.lastIndexOf("fetch:storage");
  const firstCf = p.events.findIndex((e) => e.startsWith("fetch:cf-"));
  assert.ok(p.events.slice(lastStorage, firstCf).some((e) => e.startsWith("guard:")));
  for (const g of p.guards) {
    assert.equal(g.context.q, p.identity.q);
    assert.equal(g.context.profileSha256, p.profileSha256);
    assert.ok(["baseline-provider", "capture"].includes(g.context.phase));
  }
});

test("Cloudflare requests use the fixed staging URLs and only the Cloudflare bearer", async () => {
  const p = build();
  await p.observe();
  for (const call of p.cf()) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.body, undefined);
    assert.equal(call.init.redirect, "error");
    assert.ok(call.init.signal instanceof AbortSignal && !call.init.signal.aborted);
    assert.ok(!JSON.stringify(call.init).includes(GH_TOKEN));
    if (call.kind === "cf-version") {
      assert.equal(call.url, VERSION_URL);
      assert.equal(call.init.credentials, "omit");
      assert.equal(call.init.cache, "no-store");
      assert.deepEqual(call.init.headers, {
        Authorization: `Bearer ${CF_TOKEN}`,
        Accept: "application/json",
      });
    } else {
      assert.ok(call.url.startsWith(`${SCRIPT}/deployments`));
      assert.deepEqual(call.init.headers, { Authorization: `Bearer ${CF_TOKEN}` });
    }
  }
  const github = p.calls.filter((c) => c.kind === "github");
  assert.ok(github.length > 0);
  for (const call of github) {
    assert.equal(call.init.headers.Authorization, `Bearer ${GH_TOKEN}`);
    assert.ok(!JSON.stringify(call.init).includes(CF_TOKEN));
  }
  for (const call of p.calls.filter((c) => c.kind === "storage")) {
    const text = JSON.stringify(call.init);
    assert.ok(!text.includes(CF_TOKEN) && !text.includes(GH_TOKEN));
    assert.equal(call.init.headers.Authorization, undefined);
  }
  for (const call of p.calls) {
    const host = new URL(call.url).hostname;
    assert.ok(
      ["api.github.com", "api.cloudflare.com"].includes(host) ||
        host.endsWith(".blob.core.windows.net"),
      host,
    );
  }
});

test("the recovery constructor accepts the result and carries the source map byte for byte", async () => {
  const p = build();
  const r = await p.observe();
  const request = prepareCandidateBaselineUpload({
    identity: p.identity,
    profile: p.profile,
    profileSha256: p.profileSha256,
    baseline: r.baseline,
    baselineSha256: r.baselineSha256,
    files: r.files,
    assetsTicket: null,
    now: NOW,
  });
  const body = JSON.parse(request.body);
  assert.deepEqual(
    body.modules.map((m) => [m.name, m.content_type]),
    [
      ["_worker.js", "application/javascript+module"],
      ["_worker.js.map", "application/source-map"],
    ],
  );
  assert.equal(Buffer.from(body.modules[1].content_base64, "base64").toString(), MAP);
  assert.equal(Buffer.from(body.modules[0].content_base64, "base64").toString(), SENTINEL);
  assert.equal(request.proof.baselineVersionId, VERSION);
  assert.equal(request.proof.baselineSha256, r.baselineSha256);
  assert.ok(!("assets" in body));
  assert.deepEqual(
    body.bindings.find((b) => b.name === "SESSION_SECRET"),
    {
      name: "SESSION_SECRET",
      type: "inherit",
      version_id: VERSION,
    },
  );
});

test("an asset baseline binds run-worker-first assets and the retained asset bytes", async () => {
  const p = build({ withAsset: true });
  const r = await p.observe();
  assert.deepEqual(r.baseline.assets, { run_worker_first: true });
  assert.ok(r.baseline.bindings.some((b) => b.name === "ASSETS" && b.type === "assets"));
  assert.deepEqual(
    r.files.map((f) => [f.kind, f.path]),
    [
      ["asset", "app.css"],
      ["module", "_worker.js"],
      ["module", "_worker.js.map"],
    ],
  );
  assert.deepEqual(r.baseline.files[0], {
    path: "app.css",
    kind: "asset",
    contentType: null,
    size: 15,
    sha256: candidateSha256(Buffer.from("body{margin:0}\n")),
  });
  const input = prepareCandidateBaselineAssetInput({
    identity: p.identity,
    profile: p.profile,
    profileSha256: p.profileSha256,
    baseline: r.baseline,
    baselineSha256: r.baselineSha256,
    files: r.files,
    now: NOW,
  });
  assert.deepEqual(
    input.entries.map((e) => e.path),
    ["assets/app.css"],
  );
  assert.equal(input.entries[0].bytes.toString(), "body{margin:0}\n");
});

test("provider binding property order does not change canonical admission", async () => {
  const reference = await build().observe();
  const p = build();
  // Same bindings, same values, but every object's keys in reverse order.
  p.version.bindings = p.version.bindings.map((binding) =>
    Object.fromEntries(Object.entries(binding).reverse()),
  );
  assert.equal(Object.keys(p.version.bindings[0])[0], "id");
  assert.ok(p.version.bindings.some((b) => Object.keys(b)[0] === "type"));
  const r = await p.observe();
  assert.equal(JSON.stringify(r.baseline), JSON.stringify(reference.baseline));
  assert.equal(r.baselineSha256, reference.baselineSha256);
  assert.equal(r.baselineSha256, candidateSha256(JSON.stringify(r.baseline)));
  assert.equal(r.servingSha256, reference.servingSha256);
});

test("optional provider metadata is accepted but never copied into the baseline", async () => {
  const p = build();
  Object.assign(p.version, {
    source: "api",
    author_email: "someone@example.invalid",
    author_id: "abc123",
    usage_model: "standard",
    urls: [],
    startup_time_ms: 12,
    containers: [],
    exports: { default: { type: "worker", cache: { enabled: false } } },
  });
  p.version.annotations["workers/triggered_by"] = "upload";
  const r = await p.observe();
  assert.deepEqual(r.baseline.annotations, { "workers/tag": CONTROLLER });
  assert.ok(!/example|someone|author|startup|usage/.test(JSON.stringify(r)));
});

test("a monotonic advancing clock is accepted and stamps the baseline and receipt", async () => {
  const p = build();
  let t = NOW;
  const r = await p.observe({ clock: () => t++ });
  assert.ok(r.baseline.capturedAt >= NOW);
  assert.ok(r.observedAt >= r.baseline.capturedAt);
  assert.ok(r.serving.observedAt <= r.observedAt);
});

// -------------------------------------------------- snapshots and caller input
test("input mutation after construction or during observation cannot change the join", async () => {
  const p = build();
  const reference = await build().observe();
  const callerIdentity = structuredClone(p.identity);
  const reader = p.reader({ identity: callerIdentity });
  p.profile.accountId = "3".repeat(32);
  p.profile.scriptName = "elsewhere";
  p.profile.bindings.length = 0;
  callerIdentity.q = "mutated";
  callerIdentity.descriptor[2] = "elsewhere/repo";
  p.contract.job = "foreign-job";
  p.contract.path = ".github/workflows/foreign.yml";
  p.sourceManifest.fill(0);
  const selection = structuredClone(p.selection);
  let mutated = false;
  p.hook = (n, kind) => {
    if (!mutated) {
      mutated = true;
      selection.versionId = OTHER;
    }
  };
  p.onGuard = (n) => {
    if (n === 2) selection.runId = "999";
  };
  const r = await reader.observe(selection);
  assert.equal(r.baselineSha256, reference.baselineSha256);
  assert.equal(r.servingSha256, reference.servingSha256);
  assert.deepEqual(r.provenance, reference.provenance);
  assert.ok(p.cf().every((c) => c.url.startsWith(SCRIPT) || c.url === VERSION_URL));
});

test("mutating the returned result cannot reach retained state or a later observation", async () => {
  const p = build();
  const reader = p.reader();
  const first = await reader.observe(p.selection);
  first.files[0].bytes.fill(0);
  assert.throws(() => {
    first.files.length = 0;
  }, TypeError);
  assert.throws(() => {
    "use strict";
    first.q = "mutated";
  }, TypeError);
  const second = await reader.observe(p.selection);
  assert.equal(second.files.length, 2);
  assert.equal(second.files[0].bytes.toString(), SENTINEL);
  assert.equal(second.q, p.identity.q);
});

test("selection and options must be well formed before any Cloudflare request", async () => {
  const cases = [
    ["null selection", null],
    ["array selection", [1, 2]],
    ["string selection", "x"],
    ["uncloneable selection", { fn() {} }],
  ];
  for (const [label, selection] of cases) {
    const p = build();
    let error;
    try {
      await p.reader().observe(selection);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, label);
    redacted(error, label);
    noCloudflare(p, label);
  }
  for (const mutate of [
    (s) => delete s.producerArtifactId,
    (s) => (s.extra = "https://example.invalid"),
    (s) => (s.producerArtifactId = s.artifactId),
    (s) => delete s.versionId,
  ]) {
    const p = build();
    mutate(p.selection);
    await refuses(p, "selection");
    noCloudflare(p, "selection");
  }
  const p = build();
  await assert.rejects(p.reader().observe(p.selection, { signal: {} }), (e) => redacted(e));
  noCloudflare(p, "operation signal");
  p.contract.sourceManifestSha256 = "0".repeat(64);
  await refuses(p, "contract pin");
  noCloudflare(p, "contract pin");
});

// -------------------------------------------------------- retained artifacts
test("retained artifact failures never reach Cloudflare and never leak a capability", async () => {
  const cases = [
    ["wrong archive digest", (p) => (p.selection.archiveSha256 = "0".repeat(64))],
    ["wrong producer digest", (p) => (p.selection.producerArchiveSha256 = "0".repeat(64))],
    [
      "unauthorized GitHub",
      (p) => (p.routes["/actions/runs/500"] = () => new Response("{}", { status: 401 })),
    ],
    [
      "storage failure",
      (p) =>
        (p.routes[PAYLOAD_SIGNED] = () => {
          throw new Error(`private upstream ${SAS}`);
        }),
    ],
    [
      "tampered payload",
      (p) =>
        (p.routes[PAYLOAD_SIGNED] = () =>
          new Response(Buffer.from("PK-not-a-zip"), {
            status: 200,
            headers: { "content-type": "application/zip" },
          })),
    ],
  ];
  for (const [label, mutate] of cases) {
    const p = build();
    mutate(p);
    await refuses(p, label);
    noCloudflare(p, label);
  }
});

test("a retained manifest version that serving does not show is refused before the immutable GET", async () => {
  const p = build();
  p.deployments[0].versions[0].version_id = OTHER;
  await refuses(p, "serving shows another version");
  assert.equal(p.cf().filter((c) => c.kind === "cf-version").length, 0);
  assert.equal(p.cf().length, 3);
});

// ----------------------------------------------------------- version content
const REQUIRED = [
  "id",
  "number",
  "created_on",
  "main_module",
  "modules",
  "bindings",
  "compatibility_date",
  "compatibility_flags",
  "placement",
  "annotations",
];

test("version metadata with unknown, missing or changed fields is refused", async () => {
  const cases = [
    ["unknown top-level field", (v) => (v.extra = true)],
    ["unknown deployment field", (v) => (v.deployment_id = D1)],
    ["unknown limits field", (v) => (v.limits = { cpu_ms: 50 })],
    ["id differs", (v) => (v.id = OTHER)],
    ["number zero", (v) => (v.number = 0)],
    ["number fraction", (v) => (v.number = 1.5)],
    ["number string", (v) => (v.number = "3")],
    ["created in the future", (v) => (v.created_on = iso(NOW + 5))],
    ["created unparsable", (v) => (v.created_on = "yesterday")],
    ["created oversized", (v) => (v.created_on = `${iso(NOW - 100)}${" ".repeat(40)}`)],
    ["main module differs", (v) => (v.main_module = "other.js")],
    ["compatibility date", (v) => (v.compatibility_date = "2026-09-28")],
    ["flags empty", (v) => (v.compatibility_flags = [])],
    [
      "flags extra",
      (v) => (v.compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]),
    ],
    ["flags other", (v) => (v.compatibility_flags = ["other"])],
    ["flags string", (v) => (v.compatibility_flags = "nodejs_compat")],
    ["placement smart", (v) => (v.placement = { mode: "smart", region: "aws:us-east-1" })],
    ["placement region", (v) => (v.placement.region = "aws:eu-west-1")],
    ["placement extra key", (v) => (v.placement.host = "x")],
    ["placement no region", (v) => delete v.placement.region],
    ["placement null", (v) => (v.placement = null)],
    ["tag differs", (v) => (v.annotations["workers/tag"] = "d".repeat(40))],
    ["tag uppercase", (v) => (v.annotations["workers/tag"] = CONTROLLER.toUpperCase())],
    ["tag missing", (v) => (v.annotations = {})],
    ["annotation extra", (v) => (v.annotations["workers/message"] = "x")],
    ["triggered_by other", (v) => (v.annotations["workers/triggered_by"] = "dash")],
    ["usage model", (v) => (v.usage_model = "bundled")],
    ["urls present", (v) => (v.urls = ["https://example.invalid"])],
    ["containers present", (v) => (v.containers = [{}])],
    ["startup negative", (v) => (v.startup_time_ms = -1)],
    ["source non-string", (v) => (v.source = 7)],
    ["author oversized", (v) => (v.author_email = "a".repeat(321))],
    [
      "exports cache enabled",
      (v) => (v.exports = { default: { type: "worker", cache: { enabled: true } } }),
    ],
    [
      "exports extra key",
      (v) => (v.exports = { default: { type: "worker", cache: { enabled: false } }, other: 1 }),
    ],
    [
      "exports type",
      (v) => (v.exports = { default: { type: "durable", cache: { enabled: false } } }),
    ],
    ...REQUIRED.map((name) => [`missing ${name}`, (v) => delete v[name]]),
  ];
  for (const [label, mutate] of cases) {
    const p = build();
    mutate(p.version);
    await refuses(p, label);
    assert.equal(p.cf().filter((c) => c.kind === "cf-version").length, 1, label);
  }
});

test("assets metadata must match the retained bytes exactly", async () => {
  const cases = [
    ["retained assets but version has none", { withAsset: true }, (v) => delete v.assets],
    [
      "version assets but nothing retained",
      {},
      (v) => (v.assets = { config: { run_worker_first: true } }),
    ],
    [
      "run worker first false",
      { withAsset: true },
      (v) => (v.assets.config.run_worker_first = false),
    ],
    [
      "assets config extra key",
      { withAsset: true },
      (v) => (v.assets.config.html_handling = "none"),
    ],
    ["assets extra key", { withAsset: true }, (v) => (v.assets.jwt = "a.b.c")],
    ["assets config missing", { withAsset: true }, (v) => (v.assets = {})],
    [
      "retained assets but no ASSETS binding",
      { withAsset: true },
      (v) => (v.bindings = v.bindings.filter((b) => b.name !== "ASSETS")),
    ],
    [
      "ASSETS binding without retained assets",
      {},
      (v) => v.bindings.push({ name: "ASSETS", type: "assets" }),
    ],
  ];
  for (const [label, options, mutate] of cases) {
    const p = build(options);
    mutate(p.version);
    await refuses(p, label);
  }
});

test("module sets must match the retained bytes exactly", async () => {
  const flip = (m) => {
    const bytes = Buffer.from(m.content_base64, "base64");
    bytes[0] ^= 1;
    m.content_base64 = bytes.toString("base64");
  };
  const cases = [
    ["source map missing", (v) => v.modules.pop()],
    ["main module missing", (v) => v.modules.shift()],
    ["no modules", (v) => (v.modules = [])],
    [
      "extra module",
      (v) => v.modules.push({ name: "extra.js", content_type: "text/plain", content_base64: "" }),
    ],
    ["duplicate module", (v) => (v.modules[1] = structuredClone(v.modules[0]))],
    ["duplicate and extra", (v) => v.modules.push(structuredClone(v.modules[0]))],
    ["renamed module", (v) => (v.modules[1].name = "other.js.map")],
    ["case-folded module", (v) => (v.modules[0].name = "_WORKER.js")],
    ["changed main bytes", (v) => flip(v.modules[0])],
    ["changed map bytes", (v) => flip(v.modules[1])],
    [
      "truncated bytes",
      (v) => (v.modules[0].content_base64 = Buffer.from(SENTINEL.slice(0, -1)).toString("base64")),
    ],
    ["content type changed", (v) => (v.modules[0].content_type = "text/plain")],
    ["map content type changed", (v) => (v.modules[1].content_type = "application/json")],
    ["content type missing", (v) => delete v.modules[0].content_type],
    ["unknown module key", (v) => (v.modules[0].esm = true)],
    ["base64 missing", (v) => delete v.modules[0].content_base64],
    ["base64 number", (v) => (v.modules[0].content_base64 = 7)],
    ["name missing", (v) => delete v.modules[0].name],
    ["null module", (v) => (v.modules[0] = null)],
    ["array module", (v) => (v.modules[0] = [])],
    ["modules object", (v) => (v.modules = { 0: v.modules[0] })],
    ["modules null", (v) => (v.modules = null)],
  ];
  for (const [label, mutate] of cases) {
    const p = build();
    mutate(p.version);
    await refuses(p, label);
  }
});

test("noncanonical base64 for otherwise identical bytes is refused", async () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const probe = build();
  const canonical = probe.version.modules[1].content_base64;
  assert.ok(canonical.endsWith("=="), "fixture needs two padding characters");
  const index = canonical.length - 3;
  const spare = alphabet[alphabet.indexOf(canonical[index]) ^ 1];
  const spareBits = canonical.slice(0, index) + spare + "==";
  // Precondition: a lenient decoder yields the same bytes, so only the
  // canonical re-encoding check can refuse this.
  assert.deepEqual(Buffer.from(spareBits, "base64"), Buffer.from(MAP));
  assert.notEqual(spareBits, canonical);
  const main = probe.version.modules[0].content_base64;
  const cases = [
    ["nonzero spare bits", 1, spareBits],
    ["unpadded", 1, canonical.replace(/=+$/, "")],
    ["extra padding", 1, `${canonical}=`],
    ["line break", 1, `${canonical.slice(0, 4)}\n${canonical.slice(4)}`],
    ["trailing newline", 1, `${canonical}\n`],
    ["invalid character", 1, `*${canonical.slice(1)}`],
    ["url-safe alphabet", 0, main.replaceAll("+", "-").replaceAll("/", "_") + "-"],
    ["leading space", 0, ` ${main}`],
    ["empty", 1, ""],
  ];
  for (const [label, module, value] of cases) {
    const p = build();
    p.version.modules[module].content_base64 = value;
    await refuses(p, label);
  }
  // Control: the untouched canonical form is accepted.
  await build().observe();
});

test("binding disagreements with the installed profile or recovery contract are refused", async () => {
  const cases = [
    ["wrong hyperdrive id", (v) => (v.bindings.find((b) => b.name === "DB").id = "3".repeat(32))],
    ["hyperdrive missing", (v) => (v.bindings = v.bindings.filter((b) => b.name !== "DB"))],
    ["hyperdrive retyped", (v) => (v.bindings.find((b) => b.name === "DB").type = "plain_text")],
    [
      "extra hyperdrive not installed",
      (v) => v.bindings.push({ name: "BOT_DB", type: "hyperdrive", id: HYPERDRIVE }),
    ],
    ["hyperdrive renamed", (v) => (v.bindings.find((b) => b.name === "DB").name = "BOT_DB")],
    [
      "plain text differs",
      (v) => (v.bindings.find((b) => b.name === "DISCORD_CLIENT_ID").text = "42"),
    ],
    [
      "plain text missing",
      (v) => (v.bindings = v.bindings.filter((b) => b.name !== "DISCORD_CLIENT_ID")),
    ],
    ["bindings not an array", (v) => (v.bindings = { DB: {} })],
    ["bindings null", (v) => (v.bindings = null)],
    ["origin missing", (v) => (v.bindings = v.bindings.filter((b) => b.name !== "APP_URL"))],
    [
      "origin foreign",
      (v) => (v.bindings.find((b) => b.name === "APP_URL").text = "https://togetherweown.com"),
    ],
    [
      "secret value exposed",
      (v) => (v.bindings.find((b) => b.name === "SESSION_SECRET").text = "leaked"),
    ],
    [
      "duplicate binding",
      (v) => v.bindings.push({ name: "APP_URL", type: "plain_text", text: ORIGIN }),
    ],
    [
      "unknown binding type",
      (v) => v.bindings.push({ name: "CACHE", type: "kv_namespace", namespace_id: "x" }),
    ],
    ["run auth binding", (v) => v.bindings.push({ name: "QA_RUN_AUTH", type: "secret_text" })],
    ["lowercase binding name", (v) => v.bindings.push({ name: "lower", type: "secret_text" })],
    [
      "queue pointing elsewhere",
      (v) => v.bindings.push({ name: "SYNC_EVENT_QUEUE", type: "queue", queue_name: "foreign" }),
    ],
    ["null binding", (v) => v.bindings.push(null)],
    ["empty bindings", (v) => (v.bindings = [])],
  ];
  for (const [label, mutate] of cases) {
    const p = build();
    mutate(p.version);
    await refuses(p, label);
  }
});

test("installed profile bindings alone select the staging resource ids", async () => {
  const p = build();
  p.profile.bindings[0].id = "3".repeat(32);
  p.profileSha256 = candidateSha256(JSON.stringify(p.profile));
  // The provider still reports the old id: it no longer equals the installed one.
  await refuses(p, "provider id differs from installed profile");
  const q = build();
  q.version.bindings.find((b) => b.name === "DB").id = "3".repeat(32);
  q.profile.bindings[0].id = "3".repeat(32);
  q.profileSha256 = candidateSha256(JSON.stringify(q.profile));
  const r = await q.observe();
  assert.equal(r.baseline.bindings.find((b) => b.name === "DB").id, "3".repeat(32));
});

// ------------------------------------------------------ provider HTTP protocol
test("unusable provider responses for the immutable version are refused and cancel unread bodies", async () => {
  const state = { cancelled: false };
  const redirected = () => {
    const r = result({});
    Object.defineProperty(r, "redirected", { value: true });
    return r;
  };
  const foreignUrl = (body) => {
    const r = result(body);
    Object.defineProperty(r, "url", { value: "https://api.cloudflare.com/elsewhere" });
    return r;
  };
  const cases = [
    [
      "status 404",
      () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
    ],
    [
      "status 500",
      () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
    ],
    ["html", () => new Response("<html>", { headers: { "content-type": "text/html" } })],
    ["no content type", () => new Response("{}")],
    ["redirected", redirected],
    ["foreign response url", (body) => foreignUrl(body)],
    ["null body", () => new Response(null, { headers: { "content-type": "application/json" } })],
    ["success false", (body) => json({ success: false, errors: [], result: body })],
    ["errors present", (body) => json({ success: true, errors: [{ code: 1 }], result: body })],
    ["errors missing", (body) => json({ success: true, result: body })],
    ["result array", () => json({ success: true, errors: [], result: [] })],
    ["result null", () => json({ success: true, errors: [], result: null })],
    ["result string", () => json({ success: true, errors: [], result: "x" })],
    ["invalid json", () => new Response("{", { headers: { "content-type": "application/json" } })],
    [
      "invalid utf-8",
      () =>
        new Response(Buffer.from([0x7b, 0xff, 0x7d]), {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "content length mismatch",
      (body) => {
        const text = JSON.stringify({ success: true, errors: [], result: body });
        return new Response(text, {
          headers: {
            "content-type": "application/json",
            "content-length": String(text.length + 5),
          },
        });
      },
    ],
    [
      "content length malformed",
      () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": "1e3" },
        }),
    ],
    [
      "declared oversize",
      () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(24 * 1024 * 1024 + 1),
          },
        }),
    ],
    [
      "streamed oversize",
      () =>
        new Response(openStream(state, Buffer.alloc(8 * 1024 * 1024)), {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "wrong media on open stream",
      () => new Response(openStream(state), { headers: { "content-type": "text/plain" } }),
    ],
  ];
  for (const [label, reply] of cases) {
    const p = build();
    state.cancelled = false;
    p.versionReply = reply;
    await refuses(p, label);
    if (/stream|open/.test(label)) assert.equal(state.cancelled, true, `${label}: body cancelled`);
  }
});

test("a stream that fails mid-body is refused without echoing the provider error", async () => {
  const p = build();
  p.versionReply = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(enc('{"success":true,'));
        },
        pull(controller) {
          controller.error(new Error(`private upstream ${CF_TOKEN} ${HYPERDRIVE}`));
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  await refuses(p, "stream failure");
});

test("thrown fetch failures from either backend never leak diagnostics", async () => {
  for (const kind of ["cf-version", "cf-list", "cf-exact", "github", "storage"]) {
    const p = build();
    const inner = p.fetchImpl;
    const wrapped = async (url, init) => {
      if (
        (kind === "cf-version" && url === VERSION_URL) ||
        (kind === "cf-list" && url === `${SCRIPT}/deployments`) ||
        (kind === "cf-exact" && url.startsWith(`${SCRIPT}/deployments/`)) ||
        (kind === "github" && url.startsWith("https://api.github.com/") && p.calls.length > 3) ||
        (kind === "storage" && (url === PAYLOAD_SIGNED || url === PRODUCER_SIGNED))
      ) {
        throw Object.assign(new Error(`private upstream ${CF_TOKEN} ${GH_TOKEN} ${SAS}`), {
          cause: new Error("private upstream cause"),
        });
      }
      return inner(url, init);
    };
    await refuses(p, kind, { fetchImpl: wrapped });
  }
});

test("a transient provider failure is not retried", async () => {
  const p = build();
  p.versionReply = () =>
    new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
  await refuses(p, "503");
  assert.equal(p.cf().filter((c) => c.kind === "cf-version").length, 1);
  assert.equal(p.cf().length, 4);
});

// -------------------------------------------------------------- serving drift
test("serving drift between the two captures is refused wherever it lands", async () => {
  const mutations = [
    [
      "same-version replacement deployment",
      (p) => p.deployments.unshift(row(D2, VERSION, NOW - 10)),
    ],
    [
      "other-version replacement deployment",
      (p) => p.deployments.unshift(row(D2, OTHER, NOW - 10)),
    ],
    [
      "history rewritten below the active row",
      (p) => p.deployments.push(row(D3, OTHER, NOW - 500)),
    ],
    [
      "active version swapped under the same deployment",
      (p) => (p.deployments[0].versions[0].version_id = OTHER),
    ],
    [
      "active deployment split",
      (p) =>
        (p.deployments[0].versions = [
          { version_id: VERSION, percentage: 50 },
          { version_id: OTHER, percentage: 50 },
        ]),
    ],
    ["active row removed", (p) => p.deployments.splice(0, 1, row(D3, VERSION, NOW - 100))],
  ];
  for (const [label, mutate] of mutations) {
    // CF requests 1..6 are everything before the final list of the second capture.
    for (let at = 1; at <= 6; at++) {
      const p = build();
      p.hook = (n, kind) => {
        if (n === at) mutate(p);
      };
      await refuses(p, `${label} after Cloudflare request ${at}`);
    }
  }
});

test("serving ids and shape are strictly validated", async () => {
  const cases = [
    ["uppercase deployment id", (p) => (p.deployments[0].id = D1.toUpperCase())],
    ["short deployment id", (p) => (p.deployments[0].id = "d1")],
    ["non-uuid version", (p) => (p.deployments[0].versions[0].version_id = "latest")],
    ["unknown deployment field", (p) => (p.deployments[0].extra = true)],
    ["strategy changed", (p) => (p.deployments[0].strategy = "gradual")],
    ["future deployment", (p) => (p.deployments[0].created_on = iso(NOW + 60))],
    ["not newest first", (p) => p.deployments.push(row(D2, OTHER, NOW - 50))],
    ["duplicate deployment", (p) => p.deployments.push(row(D1, VERSION, NOW - 200))],
    ["empty history", (p) => (p.deployments = [])],
  ];
  for (const [label, mutate] of cases) {
    const p = build();
    mutate(p);
    await refuses(p, label);
    assert.equal(p.cf().filter((c) => c.kind === "cf-version").length, 0, label);
  }
});

test("older history reordering inside canonical traffic does not break the join", async () => {
  const p = build();
  const older = row(D2, OTHER, NOW - 400);
  older.versions = [
    { version_id: OTHER, percentage: 50 },
    { version_id: VERSION, percentage: 50 },
  ];
  p.deployments.push(older);
  p.hook = (n) => {
    if (n === 4) older.versions.reverse();
  };
  const r = await p.observe();
  assert.equal(r.serving.deploymentId, D1);
});

// ------------------------------------------------------------------ exclusion
test("an exclusion failure at any guard stops all further requests", async () => {
  for (let at = 1; at <= EXPECTED_GUARDS; at++) {
    for (const mode of ["throw", "reject"]) {
      const p = build();
      let seen;
      p.onGuard = (n) => {
        if (n !== at) return undefined;
        seen = p.calls.length;
        const error = new Error(`private upstream ${CF_TOKEN}`);
        if (mode === "throw") throw error;
        return Promise.reject(error);
      };
      await refuses(p, `guard ${at} ${mode}`);
      assert.equal(p.calls.length, seen, `guard ${at} ${mode}: no request after failure`);
      assert.equal(p.guards.length, at, `guard ${at} ${mode}`);
    }
  }
});

test("cancelling the operation at any guard refuses and stops further requests", async () => {
  for (let at = 1; at <= EXPECTED_GUARDS; at++) {
    const p = build();
    const controller = new AbortController();
    let seen;
    p.onGuard = (n) => {
      if (n === at) {
        seen = p.calls.length;
        controller.abort();
      }
    };
    await refuses(p, `cancel at guard ${at}`, undefined, { signal: controller.signal });
    assert.equal(p.calls.length, seen, `cancel at guard ${at}`);
  }
});

test("cancelling the constructor signal during a hung exclusion check refuses", async () => {
  const p = build();
  const controller = new AbortController();
  p.onGuard = (n, context, deadline) => {
    if (n !== 3) return undefined;
    setImmediate(() => controller.abort());
    return new Promise((resolve, reject) => {
      deadline.addEventListener("abort", () => reject(new Error(`private upstream ${GH_TOKEN}`)), {
        once: true,
      });
    });
  };
  await refuses(p, "hung exclusion", { signal: controller.signal });
});

test("a pre-aborted signal refuses before any exclusion check or request", async () => {
  for (const where of ["constructor", "operation"]) {
    const p = build();
    const controller = new AbortController();
    controller.abort();
    if (where === "constructor") await refuses(p, where, { signal: controller.signal });
    else await refuses(p, where, undefined, { signal: controller.signal });
    assert.deepEqual(p.calls, [], where);
    assert.deepEqual(p.guards, [], where);
  }
});

test("a completed cancellation inside an in-flight Cloudflare request refuses", async () => {
  const p = build();
  const controller = new AbortController();
  p.versionReply = (body) => {
    controller.abort();
    return result(body);
  };
  await refuses(p, "abort during version GET", undefined, { signal: controller.signal });
  assert.equal(p.cf().filter((c) => c.kind === "cf-list").length, 2);
  assert.equal(p.cf().length, 4);
});

// ---------------------------------------------------------------------- clock
test("a clock that rolls back at any sampled call is refused", async () => {
  const counter = build();
  let total = 0;
  await counter.observe({ clock: () => (total++, NOW) });
  assert.ok(total > 20, `expected many clock reads, saw ${total}`);
  for (const at of [2, 3, 4, 5, 8, 13, 21, Math.floor(total / 2), total - 1, total]) {
    const p = build();
    let n = 0;
    await refuses(p, `rollback at clock read ${at}`, { clock: () => (++n === at ? NOW - 1 : NOW) });
  }
});

test("invalid clock values are refused at the first and later reads", async () => {
  const values = [Number.NaN, -1, NOW + 0.5, "1793819000", null, undefined, 253402300800, Infinity];
  for (const value of values) {
    for (const at of [1, 2, 9]) {
      const p = build();
      let n = 0;
      await refuses(p, `clock ${String(value)} at ${at}`, {
        clock: () => (++n === at ? value : NOW),
      });
    }
  }
  const p = build();
  await refuses(p, "clock throws", {
    clock: () => {
      throw new Error(`private upstream ${CF_TOKEN}`);
    },
  });
  noCloudflare(p, "clock throws");
});

test("provider objects dated after the observation clock are refused", async () => {
  const p = build();
  await refuses(p, "clock before the immutable version", { clock: () => NOW - 101 });
  const q = build();
  q.deployments[0].created_on = iso(NOW + 1);
  await refuses(q, "clock before the deployment");
});

// ------------------------------------------------------------------ redaction
test("every refusal carries one fixed message and no cause", async () => {
  const p = build();
  p.version.extra = `private upstream ${CF_TOKEN}`;
  p.version.bindings.push({ name: "X", type: "secret_text", text: `private upstream ${GH_TOKEN}` });
  const error = await refuses(p, "dirty provider body");
  assert.equal(Object.getOwnPropertyNames(error).includes("cause"), false);
  assert.equal(Object.keys(error).length, 0);
});
