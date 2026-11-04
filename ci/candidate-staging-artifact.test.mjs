import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateArtifactReader } from "./candidate-staging-artifact.mjs";

const BASE = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
// Synthetic values; neither may ever appear in a diagnostic or a result.
const TOKEN = "fixture-token-not-a-secret";
const SAS = "sig-fixture-not-a-secret";
const SIGNED = `https://productionresultssa7.blob.core.windows.net/actions-results/abc/def.zip?sig=${SAS}%2Bx&se=2026-11-04T00%3A00%3A00Z`;
const REFUSED = "Candidate artifact refused: evidence";
const HEAD = "a".repeat(40);
const CONTROLLER = "b".repeat(40);
const LIST = "/actions/runs/500/artifacts?per_page=100&page=1";
const DETAIL = "/actions/artifacts/600";
const ZIP = "/actions/artifacts/600/zip";
const MAX = 16 * 1024 * 1024;
const SENTINEL = "globalThis.__candidateArtifactExecuted = true;\nthrow new Error('executed');\n";

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

function defaultFiles() {
  return [
    { path: "worker/worker.mjs", bytes: Buffer.from(SENTINEL) },
    { path: "worker/chunks/chunk-A1_b.mjs", bytes: Buffer.from("export const chunk = 1;\n") },
    { path: "assets/app.css", bytes: Buffer.from("body{margin:0}\n"), method: 0 },
    { path: "assets/big.txt", bytes: Buffer.from("a".repeat(5000)) },
  ];
}

function records(files) {
  return files
    .map((file) => ({
      path: file.path,
      size: (file.bytes ?? Buffer.from("x")).length,
      sha256: candidateSha256(file.bytes ?? Buffer.from("x")),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

// ------------------------------------------------------------------- fixtures
function world({ files = defaultFiles(), archive = zip(files), producerEdit } = {}) {
  const selection = { prNumber: "42", headSha: HEAD, ciRunId: "100", ciRunAttempt: "1" };
  const launcher = {
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
  };
  const identity = candidateIdentity(selection, launcher);
  const repository = {
    id: 1234,
    full_name: launcher.repository,
    fork: false,
    archived: false,
  };
  const pull = {
    number: 42,
    state: "open",
    merged: false,
    base: { ref: "main", repo: structuredClone(repository) },
    head: { sha: HEAD, repo: structuredClone(repository) },
  };
  const digest = candidateSha256(archive);
  const build = { runId: "500", runAttempt: "1", artifactId: "600", archiveSha256: digest };
  const artifact = {
    id: 600,
    expired: false,
    digest: `sha256:${digest}`,
    workflow_run: { id: 500, repository_id: 1234, head_repository_id: 1234, head_sha: HEAD },
  };
  const declared = records(files);
  const producer = {
    schema: "two.candidate-build.v1",
    q: identity.q,
    ciRunId: "100",
    ciRunAttempt: "1",
    buildRunId: "500",
    buildRunAttempt: "1",
    artifactId: "600",
    archiveSha256: digest,
    files: declared,
    rootSha256: candidateSha256(
      JSON.stringify(declared.map((file) => [file.path, file.size, file.sha256])),
    ),
  };
  producerEdit?.(producer);
  return { identity, repository, pull, artifact, build, producer, archive, files };
}

function json(body, headers = { "content-type": "application/json; charset=utf-8" }) {
  return new Response(JSON.stringify(body), { status: 200, headers });
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

// Every request is recorded. A route is a body, a Response, or a function of the
// per-key call index and the request init. Anything unrouted fails.
function network(w, overrides = {}) {
  const routes = {
    "": () => w.repository,
    "/pulls/42": () => w.pull,
    [LIST]: () => ({ total_count: 1, artifacts: [w.artifact] }),
    [DETAIL]: () => w.artifact,
    [ZIP]: () => redirect(SIGNED),
    [SIGNED]: () => archiveResponse(w.archive),
    ...overrides,
  };
  const calls = [];
  const counts = new Map();
  async function fetchImpl(url, init) {
    const key = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    calls.push({ key, url, init });
    if (!Object.hasOwn(routes, key)) throw new Error(`unrouted ${key} ${TOKEN} ${SAS}`);
    const route = typeof routes[key] === "function" ? routes[key](index, init) : routes[key];
    const value = await route;
    return value instanceof Response || typeof value?.status === "number" ? value : json(value);
  }
  return { fetchImpl, calls, keys: () => calls.map((call) => call.key) };
}

const HAPPY = ["", "/pulls/42", LIST, DETAIL, ZIP, SIGNED, LIST, DETAIL, "", "/pulls/42"];
const THROUGH_BLOB = HAPPY.slice(0, 6);
const THROUGH_ZIP = HAPPY.slice(0, 5);
const THROUGH_DETAIL = HAPPY.slice(0, 4);

function read(w, net, options, parts = {}) {
  return createCandidateArtifactReader({ token: TOKEN, fetchImpl: net.fetchImpl }).readBundle(
    Object.hasOwn(parts, "identity") ? parts.identity : w.identity,
    Object.hasOwn(parts, "build") ? parts.build : w.build,
    Object.hasOwn(parts, "producer") ? parts.producer : w.producer,
    options,
  );
}

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
  ]) {
    assert.ok(!text.includes(secret), `diagnostic leaks ${secret}`);
  }
  return true;
}

async function refuses(w, net, expectedKeys, options, parts) {
  await assert.rejects(read(w, net, options, parts), redacted);
  if (expectedKeys) assert.deepEqual(net.keys(), expectedKeys);
}

// --------------------------------------------------------------------- tokens
test("artifact reader refuses unusable tokens before any request", () => {
  for (const token of [undefined, "", 7, "a b", "a\nb", "a\x7fb", "x".repeat(4097)]) {
    assert.throws(
      () => createCandidateArtifactReader({ token, fetchImpl: () => assert.fail() }),
      /Candidate artifact refused: read-token/,
    );
  }
  assert.throws(() => createCandidateArtifactReader(), /read-token/);
});

// ---------------------------------------------------------------- happy path
test("happy path rechecks PR and artifact, downloads once and returns inert bytes", async () => {
  const w = world();
  const net = network(w);
  const before = JSON.stringify([w.identity, w.build, w.producer]);
  const result = await read(w, net);
  assert.deepEqual(net.keys(), HAPPY);
  assert.equal(JSON.stringify([w.identity, w.build, w.producer]), before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.build), true);
  assert.deepEqual(result.build, w.build);
  assert.notEqual(result.build, w.build);
  assert.equal(result.q, w.identity.q);
  assert.equal(result.rootSha256, w.producer.rootSha256);
  assert.equal(result.files, w.files.length);
  assert.equal(
    result.bytes,
    w.files.reduce((sum, file) => sum + file.bytes.length, 0),
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.path).sort(),
    w.files.map((file) => file.path).sort(),
  );
  for (const entry of result.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["bytes", "path", "type"]);
    assert.equal(entry.type, "file");
    assert.ok(Buffer.isBuffer(entry.bytes));
    const source = w.files.find((file) => file.path === entry.path);
    assert.deepEqual(entry.bytes, source.bytes);
  }
  // Candidate worker bytes are data only: nothing ran, imported or evaluated.
  assert.equal(globalThis.__candidateArtifactExecuted, undefined);
  const text = JSON.stringify(result);
  assert.ok(!text.includes(SAS) && !text.includes("blob.core.windows.net"));
});

test("API requests carry the fixed origin, bearer, version, manual redirect and a deadline", async (t) => {
  const timers = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    timers.push(ms);
    return new AbortController().signal;
  });
  const w = world();
  const net = network(w);
  await read(w, net);
  assert.equal(timers.filter((ms) => ms === 60_000).length, 1);
  assert.equal(timers.filter((ms) => ms === 10_000).length, net.calls.length);
  for (const { url, init } of net.calls.slice(0, 5)) {
    assert.ok(url.startsWith(`${BASE}`));
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.Accept, "application/vnd.github+json");
    assert.equal(init.headers["X-GitHub-Api-Version"], "2026-03-10");
    assert.ok(init.signal instanceof AbortSignal);
  }
  const [first, second, ...rest] = net.calls.slice(0, 5);
  assert.equal(first.init.redirect, "error");
  assert.equal(second.init.redirect, "error");
  for (const call of rest.slice(0, 2)) assert.equal(call.init.redirect, "error");
  const zipCall = net.calls[4];
  assert.equal(zipCall.url, `${BASE}${ZIP}`);
  assert.equal(zipCall.init.redirect, "manual");
  assert.equal(zipCall.init.credentials, "omit");
  assert.equal(zipCall.init.cache, "no-store");
  assert.deepEqual(Object.keys(zipCall.init.headers).sort(), [
    "Accept",
    "Authorization",
    "X-GitHub-Api-Version",
  ]);
});

test("signed blob request is a fresh unauthenticated, cookie-less, referrer-less GET", async () => {
  const w = world();
  const net = network(w);
  await read(w, net);
  const blob = net.calls[5];
  assert.equal(blob.url, new URL(SIGNED).href);
  assert.equal(blob.init.method, "GET");
  assert.equal(blob.init.redirect, "error");
  assert.equal(blob.init.credentials, "omit");
  assert.equal(blob.init.referrerPolicy, "no-referrer");
  assert.equal(blob.init.cache, "no-store");
  assert.deepEqual(Object.keys(blob.init.headers), ["Accept"]);
  assert.equal(blob.init.headers.Accept, "application/zip, application/octet-stream");
  const lowered = Object.keys(blob.init.headers).map((name) => name.toLowerCase());
  for (const name of ["authorization", "cookie", "referer", "x-github-api-version"]) {
    assert.ok(!lowered.includes(name), name);
  }
  assert.ok(!JSON.stringify(blob.init).includes(TOKEN));
  // No credentialed request ever leaves api.github.com.
  for (const call of net.calls.filter((c) => !c.url.startsWith(BASE))) {
    assert.equal(call.init.headers.Authorization, undefined);
  }
});

test("pipelines.actions.githubusercontent.com is an accepted storage origin", async () => {
  const location = "https://pipelines.actions.githubusercontent.com/abc/def?sig=1";
  const w = world();
  const net = network(w, {
    [ZIP]: () => redirect(location),
    [location]: () => archiveResponse(w.archive),
  });
  const result = await read(w, net);
  assert.equal(result.files, w.files.length);
  assert.equal(net.calls[5].url, location);
});

test("a content type with parameters or case and octet-stream are accepted", async () => {
  for (const type of ["application/octet-stream", "Application/ZIP; charset=binary"]) {
    const w = world();
    const net = network(w, {
      [SIGNED]: () => archiveResponse(w.archive, { "content-type": type }),
    });
    await read(w, net);
    assert.equal(net.calls.length, HAPPY.length, type);
  }
});

test("a body without a content length is accepted when the digest matches", async () => {
  const w = world();
  const net = network(w, {
    [SIGNED]: () =>
      new Response(w.archive, { status: 200, headers: { "content-type": "application/zip" } }),
  });
  await read(w, net);
});

// ------------------------------------------------------- input snapshotting
test("inputs are cloned synchronously before any async work", async () => {
  const w = world();
  const identity = structuredClone(w.identity);
  const build = { ...w.build };
  const producer = structuredClone(w.producer);
  const originals = structuredClone({ identity, build, producer });
  const net = network(w, {
    [SIGNED]: () => {
      // A mid-flight mutation must not influence the still-pending read either.
      build.artifactId = "601";
      producer.rootSha256 = "0".repeat(64);
      identity.descriptor[3] = "43";
      return archiveResponse(w.archive);
    },
  });
  const pending = read(w, net, undefined, { identity, build, producer });
  identity.descriptor[4] = "e".repeat(40);
  identity.q = "0".repeat(64);
  build.archiveSha256 = "0".repeat(64);
  producer.files.length = 0;
  producer.q = "0".repeat(64);
  const result = await pending;
  assert.deepEqual(net.keys(), HAPPY);
  assert.deepEqual(result.build, originals.build);
  assert.equal(result.q, originals.identity.q);
  assert.equal(result.rootSha256, originals.producer.rootSha256);
});

test("accessor properties are read once and uncloneable inputs fail before a request", async () => {
  const w = world();
  let reads = 0;
  const build = {
    ...w.build,
    get artifactId() {
      reads++;
      return reads === 1 ? "600" : "601";
    },
  };
  const net = network(w);
  await read(w, net, undefined, { build });
  assert.equal(reads, 1);
  assert.equal(net.calls[4].url, `${BASE}${ZIP}`);
  for (const parts of [
    { build: { ...w.build, fn() {} } },
    { producer: { ...w.producer, fn() {} } },
    { identity: { ...w.identity, fn() {} } },
  ]) {
    const quiet = network(w);
    await refuses(w, quiet, [], undefined, parts);
  }
});

// ------------------------------------------------------ identity/build/producer
test("malformed identity fails closed before any request", async () => {
  const w = world();
  const wrongPr = structuredClone(w.identity);
  wrongPr.descriptor[3] = "43";
  const shortDescriptor = structuredClone(w.identity);
  shortDescriptor.descriptor.pop();
  for (const identity of [
    undefined,
    null,
    {},
    wrongPr,
    shortDescriptor,
    { ...structuredClone(w.identity), q: "0".repeat(64) },
    { ...structuredClone(w.identity), ciRunId: 100 },
    { ...structuredClone(w.identity), ciRunAttempt: "0" },
    { ...structuredClone(w.identity), extra: true },
  ]) {
    await refuses(w, network(w), [], undefined, { identity });
  }
});

test("malformed build selection fails closed before any request", async () => {
  const w = world();
  for (const build of [
    undefined,
    null,
    { ...w.build, runId: 500 },
    { ...w.build, artifactId: "0600" },
    { ...w.build, runAttempt: "0" },
    { ...w.build, artifactId: "600/../1" },
    { ...w.build, archiveSha256: w.build.archiveSha256.toUpperCase() },
    { ...w.build, archiveSha256: "d".repeat(63) },
    { ...w.build, url: SIGNED },
    (({ runAttempt, ...rest }) => rest)(w.build),
  ]) {
    await refuses(w, network(w), [], undefined, { build });
  }
});

test("producer provenance that differs from the selected build fails before any request", async () => {
  const w = world();
  const edits = {
    schema: "two.candidate-build.v2",
    q: "0".repeat(64),
    ciRunId: "101",
    ciRunAttempt: "2",
    buildRunId: "501",
    buildRunAttempt: "2",
    artifactId: "601",
    archiveSha256: "e".repeat(64),
    rootSha256: "E".repeat(64),
    files: [],
  };
  for (const [field, value] of Object.entries(edits)) {
    await refuses(w, network(w), [], undefined, { producer: { ...w.producer, [field]: value } });
  }
  for (const producer of [
    undefined,
    null,
    { ...w.producer, extra: true },
    (({ files, ...rest }) => rest)(w.producer),
    { ...w.producer, files: Array.from({ length: 4097 }, () => w.producer.files[0]) },
    {
      ...w.producer,
      files: [{ path: "assets/x", size: 1, sha256: "e".repeat(64), pad: "y".repeat(1024 * 1024) }],
    },
  ]) {
    await refuses(w, network(w), [], undefined, { producer });
  }
});

test("a producer receipt that disagrees with the archive contents fails after download", async () => {
  const cases = {
    "altered file digest": (p) => {
      p.files[0] = { ...p.files[0], sha256: "e".repeat(64) };
    },
    "altered file size": (p) => {
      p.files[0] = { ...p.files[0], size: p.files[0].size + 1 };
    },
    "swapped order": (p) => {
      p.files.reverse();
    },
    "missing file": (p) => {
      p.files.pop();
    },
    "extra file": (p) => {
      p.files.push({ path: "assets/extra.txt", size: 1, sha256: "e".repeat(64) });
    },
    "unknown receipt field": (p) => {
      p.files[0] = { ...p.files[0], mode: "100644" };
    },
    "wrong root": (p) => {
      p.rootSha256 = "e".repeat(64);
    },
  };
  for (const [label, producerEdit] of Object.entries(cases)) {
    const w = world({ producerEdit });
    await refuses(w, network(w), THROUGH_BLOB);
    assert.equal(globalThis.__candidateArtifactExecuted, undefined, label);
  }
});

test("a producer that is not derived from this archive cannot be satisfied by archive bytes", async () => {
  // The same producer joined to a different but individually valid archive.
  const other = world({ files: [{ path: "worker/worker.mjs", bytes: Buffer.from("other") }] });
  const w = world();
  const parts = { producer: other.producer };
  await refuses(w, network(w), [], undefined, parts);
});

// ------------------------------------------------------------ pre-download
test("a closed PR or moved head stops before the artifact is read", async () => {
  for (const edit of [
    (w) => {
      w.pull.state = "closed";
    },
    (w) => {
      w.pull.head.sha = "e".repeat(40);
    },
    (w) => {
      w.pull.head.repo.id = 1235;
    },
  ]) {
    const w = world();
    edit(w);
    await refuses(w, network(w), ["", "/pulls/42"]);
  }
});

test("a missing, expired or mismatching artifact stops before the ZIP request", async () => {
  const cases = {
    missing: [
      (w) => ({ [LIST]: () => ({ total_count: 0, artifacts: [] }) }),
      THROUGH_DETAIL.slice(0, 3),
    ],
    expired: [(w) => ({ [DETAIL]: () => ({ ...w.artifact, expired: true }) }), THROUGH_DETAIL],
    "digest mismatch": [
      (w) => ({ [DETAIL]: () => ({ ...w.artifact, digest: `sha256:${"e".repeat(64)}` }) }),
      THROUGH_DETAIL,
    ],
    "other head": [
      (w) => ({
        [DETAIL]: () => ({
          ...w.artifact,
          workflow_run: { ...w.artifact.workflow_run, head_sha: "e".repeat(40) },
        }),
      }),
      THROUGH_DETAIL,
    ],
    "detail 404": [
      (w) => ({ [DETAIL]: () => new Response("{}", { status: 404 }) }),
      THROUGH_DETAIL,
    ],
    "detail 410": [
      (w) => ({ [DETAIL]: () => new Response("{}", { status: 410 }) }),
      THROUGH_DETAIL,
    ],
  };
  for (const [label, [make, keys]] of Object.entries(cases)) {
    const w = world();
    await refuses(w, network(w, make(w)), keys);
    assert.ok(!keys.includes(ZIP), label);
  }
});

// ---------------------------------------------------------- redirect handling
test("API ZIP responses other than a 302 are refused without contacting storage", async () => {
  for (const status of [
    200, 201, 301, 303, 304, 307, 308, 400, 401, 403, 404, 410, 429, 500, 503,
  ]) {
    const w = world();
    const net = network(w, {
      [ZIP]: () =>
        status === 200
          ? archiveResponse(w.archive, { location: SIGNED })
          : redirect(SIGNED, status),
    });
    await refuses(w, net, THROUGH_ZIP);
  }
});

test("a network failure or redirected API response is refused with a redacted error", async () => {
  const w = world();
  await refuses(
    w,
    network(w, { [ZIP]: () => Promise.reject(new Error(`boom ${TOKEN} ${SIGNED}`)) }),
    THROUGH_ZIP,
  );
  const followed = {
    status: 302,
    redirected: true,
    headers: new Headers({ location: SIGNED }),
    body: null,
  };
  await refuses(w, network(w, { [ZIP]: () => followed }), THROUGH_ZIP);
});

test("only allow-listed https storage origins are followed", async () => {
  const pad = "x".repeat(8200);
  const locations = {
    missing: null,
    empty: "",
    relative: "/actions-results/abc",
    "scheme-relative": "//productionresultssa7.blob.core.windows.net/a",
    "not a URL": "not a url",
    http: "http://productionresultssa7.blob.core.windows.net/a?sig=1",
    ftp: "ftp://productionresultssa7.blob.core.windows.net/a",
    "api origin": `${BASE}/actions/artifacts/600/zip`,
    "other azure tenant": "https://attacker.blob.core.windows.net/a?sig=1",
    "non-numeric account": "https://productionresultssa.blob.core.windows.net/a",
    "letter account": "https://productionresultssaX.blob.core.windows.net/a",
    "suffix lookalike": "https://productionresultssa7.blob.core.windows.net.example.invalid/a",
    "prefix lookalike": "https://evilproductionresultssa7.blob.core.windows.net/a",
    "trailing dot": "https://productionresultssa7.blob.core.windows.net./a",
    "extra label": "https://x.productionresultssa7.blob.core.windows.net/a",
    "other github host": "https://objects.githubusercontent.com/a",
    "pipelines lookalike": "https://pipelines.actions.githubusercontent.com.example.invalid/a",
    "pipelines subdomain": "https://x.pipelines.actions.githubusercontent.com/a",
    port: "https://productionresultssa7.blob.core.windows.net:8443/a",
    userinfo: "https://user:pw@productionresultssa7.blob.core.windows.net/a",
    "userinfo host trick": "https://productionresultssa7.blob.core.windows.net@example.invalid/a",
    "backslash host trick":
      "https://example.invalid\\@productionresultssa7.blob.core.windows.net/a",
    fragment: "https://productionresultssa7.blob.core.windows.net/a#frag",
    localhost: "https://localhost/a",
    "ip literal": "https://127.0.0.1/a",
    "data URL": "data:application/zip;base64,AAAA",
    oversize: `${SIGNED}&pad=${pad}`,
  };
  for (const [label, location] of Object.entries(locations)) {
    const w = world();
    const net = network(w, { [ZIP]: () => redirect(location) });
    await refuses(w, net, THROUGH_ZIP);
    assert.ok(
      net.calls.every((call) => call.url.startsWith(BASE)),
      label,
    );
  }
});

test("a refused or accepted redirect body is cancelled and never read to the end", async () => {
  const chunk = new Uint8Array(1024).fill(0x20);
  for (const location of ["https://example.invalid/a", SIGNED]) {
    const state = { cancelled: false };
    const w = world();
    const net = network(w, {
      [ZIP]: () => new Response(openStream(chunk, state), { status: 302, headers: { location } }),
    });
    if (location === SIGNED) await read(w, net);
    else await refuses(w, net, THROUGH_ZIP);
    assert.equal(state.cancelled, true, location);
  }
});

// ------------------------------------------------------------ storage response
test("storage responses that are not a plain 200 ZIP are refused", async () => {
  const cases = {
    "206 partial": (w) =>
      new Response(w.archive, { status: 206, headers: { "content-type": "application/zip" } }),
    "302 again": () => redirect("https://productionresultssa7.blob.core.windows.net/b"),
    "403 expired SAS": () =>
      new Response("<Error/>", { status: 403, headers: { "content-type": "application/xml" } }),
    "404 deleted": () => new Response("", { status: 404 }),
    "410 gone": () => new Response("", { status: 410 }),
    500: () => new Response("", { status: 500 }),
    204: () => new Response(null, { status: 204 }),
    "followed redirect": (w) => ({
      status: 200,
      redirected: true,
      headers: new Headers({ "content-type": "application/zip" }),
      body: new Response(w.archive).body,
    }),
    "body-less 200": () => ({
      status: 200,
      redirected: false,
      headers: new Headers({ "content-type": "application/zip" }),
      body: null,
    }),
    "empty body": () => archiveResponse(Buffer.alloc(0), { "content-length": "0" }),
    "empty body without length": () =>
      new Response(Buffer.alloc(0), {
        status: 200,
        headers: { "content-type": "application/zip" },
      }),
  };
  for (const [label, make] of Object.entries(cases)) {
    const w = world();
    await refuses(w, network(w, { [SIGNED]: () => make(w) }), THROUGH_BLOB);
    assert.deepEqual(w.pull.head.sha, HEAD, label);
  }
});

test("storage content types other than ZIP or octet-stream are refused and cancelled", async () => {
  const types = [
    "text/html",
    "application/json",
    "application/xml",
    "application/zipx",
    "application/x-zip-compressed",
    "application/octet-stream2",
    "",
  ];
  for (const type of types) {
    const state = { cancelled: false };
    const w = world();
    const net = network(w, {
      [SIGNED]: () =>
        new Response(openStream(new Uint8Array(1024), state), {
          status: 200,
          headers: type ? { "content-type": type } : {},
        }),
    });
    await refuses(w, net, THROUGH_BLOB);
    assert.equal(state.cancelled, true, type);
  }
  const w = world();
  const missing = network(w, {
    [SIGNED]: () => new Response(w.archive, { status: 200, headers: {} }),
  });
  await refuses(w, missing, THROUGH_BLOB);
});

test("declared and streamed sizes are bounded and refused streams are cancelled", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(0x50);
  const cases = {
    "declared above limit": (state, w) =>
      new Response(openStream(chunk, state), {
        status: 200,
        headers: { "content-type": "application/zip", "content-length": String(MAX + 1) },
      }),
    "non-numeric length": (state) =>
      new Response(openStream(chunk, state), {
        status: 200,
        headers: { "content-type": "application/zip", "content-length": "x" },
      }),
    "zero length": (state) =>
      new Response(openStream(chunk, state), {
        status: 200,
        headers: { "content-type": "application/zip", "content-length": "0" },
      }),
    "leading-zero length": (state) =>
      new Response(openStream(chunk, state), {
        status: 200,
        headers: { "content-type": "application/zip", "content-length": "01024" },
      }),
    "undeclared overflow": (state) =>
      new Response(openStream(chunk, state), {
        status: 200,
        headers: { "content-type": "application/zip" },
      }),
    "declared small, streamed large": (state) =>
      new Response(openStream(chunk, state), {
        status: 200,
        headers: { "content-type": "application/zip", "content-length": String(MAX) },
      }),
  };
  for (const [label, make] of Object.entries(cases)) {
    const state = { cancelled: false };
    const w = world();
    await refuses(w, network(w, { [SIGNED]: () => make(state, w) }), THROUGH_BLOB);
    assert.equal(state.cancelled, true, label);
  }
});

test("a body exactly at the size limit is read fully but then fails the digest", async () => {
  const w = world();
  const filler = Buffer.alloc(MAX, 0x41);
  await refuses(w, network(w, { [SIGNED]: () => archiveResponse(filler) }), THROUGH_BLOB);
});

test("truncated, extended and substituted bodies are refused before admission", async () => {
  const w = world();
  const half = w.archive.subarray(0, w.archive.length >> 1);
  const cases = {
    "declared length longer than body": () =>
      archiveResponse(half, { "content-length": String(w.archive.length) }),
    "declared length shorter than body": () =>
      archiveResponse(w.archive, { "content-length": String(w.archive.length - 1) }),
    "short body with honest length": () => archiveResponse(half),
    "short body without length": () =>
      new Response(half, { status: 200, headers: { "content-type": "application/zip" } }),
    "one byte missing": () => archiveResponse(w.archive.subarray(0, -1)),
    "one extra byte": () => archiveResponse(Buffer.concat([w.archive, Buffer.from([0])])),
    "flipped byte": () => {
      const copy = Buffer.from(w.archive);
      copy[10] ^= 1;
      return archiveResponse(copy);
    },
    "different valid ZIP": () =>
      archiveResponse(zip([{ path: "worker/worker.mjs", bytes: Buffer.from("other") }])),
    "stream error part way": () => {
      let sent = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent) controller.error(new Error(`reset ${TOKEN} ${SIGNED}`));
            else controller.enqueue(half);
            sent = true;
          },
        }),
        { status: 200, headers: { "content-type": "application/zip" } },
      );
    },
  };
  for (const [label, make] of Object.entries(cases)) {
    await refuses(w, network(w, { [SIGNED]: make }), THROUGH_BLOB);
    assert.equal(globalThis.__candidateArtifactExecuted, undefined, label);
  }
});

// ---------------------------------------------------- archive profile failures
// For each, build and artifact digests are made to agree with the bad ZIP, so
// only the decoder/admission, not the digest gate, can refuse.
test("archives that match their digest but break the profile are refused", async () => {
  const worker = { path: "worker/worker.mjs", bytes: Buffer.from(SENTINEL) };
  const withWorker = (...rest) => [worker, ...rest];
  const cases = {
    "wrong CRC (deflate)": withWorker({
      path: "assets/a.txt",
      bytes: Buffer.from("abc"),
      crcDelta: 1,
    }),
    "wrong CRC (stored)": withWorker({
      path: "assets/a.txt",
      bytes: Buffer.from("abc"),
      method: 0,
      crcDelta: 1,
    }),
    "parent traversal": withWorker({ path: "../evil.mjs" }),
    "embedded traversal": withWorker({ path: "assets/../../evil.mjs" }),
    "absolute path": withWorker({ path: "/assets/a.txt" }),
    "backslash path": withWorker({ path: "assets\\a.txt" }),
    "drive letter": withWorker({ path: "C:/assets/a.txt" }),
    "hidden asset": withWorker({ path: "assets/.env" }),
    "outside allow-list": withWorker({ path: "src/index.mjs" }),
    "dotted chunk": withWorker({ path: "worker/chunks/a.b.mjs" }),
    "directory entry": withWorker({ path: "assets/" }),
    "non-ASCII name": withWorker({
      path: "assets/\u00e9.txt",
      name: Buffer.from("assets/\u00e9.txt"),
    }),
    "NUL in name": withWorker({ path: "assets/a\0.txt", name: Buffer.from("assets/a\0.txt") }),
    "case collision": withWorker({ path: "assets/A.txt" }, { path: "assets/a.txt" }),
    "duplicate path": withWorker({ path: "assets/a.txt" }, { path: "assets/a.txt" }),
    "symlink entry": withWorker({ path: "assets/link", mode: 0o120777 }),
    "missing worker": [{ path: "assets/a.txt" }],
    "worker is not first or only": [{ path: "assets/a.txt" }, { path: "worker/other.mjs" }],
  };
  for (const [label, entries] of Object.entries(cases)) {
    // The receipt describes exactly these entries, so a lenient decoder or
    // admission step would succeed; only the archive profile can refuse.
    const w = world({ archive: zip(entries), files: entries });
    await refuses(w, network(w), THROUGH_BLOB);
    assert.equal(globalThis.__candidateArtifactExecuted, undefined, label);
  }
});

test("a non-ZIP, truncated ZIP or ZIP with trailing data is refused even with a matching digest", async () => {
  const good = zip(defaultFiles());
  const cases = {
    "plain text": Buffer.from("not a zip file at all, just twenty-two bytes or more"),
    "truncated tail": good.subarray(0, good.length - 5),
    "truncated head": good.subarray(5),
    "trailing data": Buffer.concat([good, Buffer.from("tail")]),
    tiny: Buffer.from("PK"),
  };
  for (const [label, archive] of Object.entries(cases)) {
    const w = world({ archive, files: defaultFiles() });
    await refuses(w, network(w), THROUGH_BLOB);
    assert.equal(globalThis.__candidateArtifactExecuted, undefined, label);
  }
});

// ----------------------------------------------------- mid-download movement
test("a head that moves during the download is refused at the final PR recheck", async () => {
  const w = world();
  const net = network(w, {
    [SIGNED]: () => {
      w.pull.head.sha = "e".repeat(40);
      return archiveResponse(w.archive);
    },
  });
  await refuses(w, net, HAPPY);
  assert.equal(net.keys().at(-1), "/pulls/42");
});

test("a PR that closes, merges or changes repository during the download is refused", async () => {
  for (const edit of [
    (pull) => {
      pull.state = "closed";
    },
    (pull) => {
      pull.merged = true;
    },
    (pull) => {
      pull.head.repo.id = 1235;
    },
    (pull) => {
      pull.base.ref = "release";
    },
  ]) {
    const w = world();
    const net = network(w, {
      "/pulls/42": (n) => {
        if (n === 1) edit(w.pull);
        return w.pull;
      },
    });
    await refuses(w, net, HAPPY);
  }
});

test("an artifact that expires, disappears or changes during the download is refused", async () => {
  const cases = {
    "detail expired": {
      [DETAIL]: (n) => (n ? { ...w0().artifact, expired: true } : w0().artifact),
    },
    "detail 404": { [DETAIL]: (n) => (n ? new Response("{}", { status: 404 }) : w0().artifact) },
    "detail 410": { [DETAIL]: (n) => (n ? new Response("{}", { status: 410 }) : w0().artifact) },
    "detail digest changed": {
      [DETAIL]: (n) =>
        n ? { ...w0().artifact, digest: `sha256:${"e".repeat(64)}` } : w0().artifact,
    },
    "detail other run": {
      [DETAIL]: (n) =>
        n
          ? { ...w0().artifact, workflow_run: { ...w0().artifact.workflow_run, id: 501 } }
          : w0().artifact,
    },
    "list lost artifact": {
      [LIST]: (n) =>
        n ? { total_count: 0, artifacts: [] } : { total_count: 1, artifacts: [w0().artifact] },
    },
    "list expired": {
      [LIST]: (n) =>
        n
          ? { total_count: 1, artifacts: [{ ...w0().artifact, expired: true }] }
          : { total_count: 1, artifacts: [w0().artifact] },
    },
    "list duplicated": {
      [LIST]: (n) =>
        n
          ? { total_count: 2, artifacts: [w0().artifact, { ...w0().artifact }] }
          : { total_count: 1, artifacts: [w0().artifact] },
    },
  };
  let current;
  function w0() {
    return current;
  }
  for (const [label, routes] of Object.entries(cases)) {
    current = world();
    const net = network(current, routes);
    await assert.rejects(read(current, net), redacted, label);
    // The recheck came after the download, so the final PR read never happens.
    assert.deepEqual(net.keys().slice(0, 6), THROUGH_BLOB, label);
    assert.ok(net.keys().length < HAPPY.length, label);
    assert.equal(net.keys().filter((key) => key === "/pulls/42").length, 1, label);
  }
});

test("the artifact is re-read after the download and before the final PR read", async () => {
  const w = world();
  const net = network(w);
  await read(w, net);
  assert.ok(net.keys().indexOf(SIGNED) < net.keys().lastIndexOf(LIST));
  assert.ok(net.keys().lastIndexOf(DETAIL) < net.keys().lastIndexOf("/pulls/42"));
});

// ---------------------------------------------------- redaction and cancellation
test("all failure paths share one redacted message with no cause or secrets", async () => {
  const w = world();
  const boom = () => Promise.reject(new Error(`boom ${TOKEN} ${SAS} ${SIGNED} ${BASE}`));
  for (const key of ["", "/pulls/42", LIST, DETAIL, ZIP, SIGNED]) {
    await refuses(w, network(w, { [key]: boom }), undefined);
  }
});

test("a caller signal that is already aborted makes no request", async () => {
  const w = world();
  const net = network(w);
  const controller = new AbortController();
  controller.abort(new Error(`stop ${TOKEN}`));
  await refuses(w, net, [], { signal: controller.signal });
});

test("caller cancellation during the ZIP API request propagates to fetch and stops", async () => {
  const w = world();
  const controller = new AbortController();
  let seen;
  const net = network(w, {
    [ZIP]: (_n, init) =>
      new Promise((_resolve, reject) => {
        seen = init.signal;
        init.signal.addEventListener("abort", () => reject(new Error(`aborted ${TOKEN}`)));
        controller.abort();
      }),
  });
  await refuses(w, net, THROUGH_ZIP, { signal: controller.signal });
  assert.equal(seen.aborted, true);
});

function hangingBody(init, state) {
  return new ReadableStream({
    start(controller) {
      init.signal.addEventListener("abort", () =>
        controller.error(new Error(`aborted ${TOKEN} ${SIGNED}`)),
      );
      controller.enqueue(new Uint8Array(16));
    },
    pull: () => new Promise(() => {}),
    cancel() {
      state.cancelled = true;
    },
  });
}

test("caller cancellation while the archive body streams rejects without further requests", async () => {
  const w = world();
  const controller = new AbortController();
  const state = { cancelled: false };
  let reached;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const net = network(w, {
    [SIGNED]: (_n, init) => {
      reached();
      return new Response(hangingBody(init, state), {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    },
  });
  const pending = read(w, net, { signal: controller.signal });
  await entered;
  controller.abort(new Error("caller stop"));
  await assert.rejects(pending, redacted);
  assert.deepEqual(net.keys(), THROUGH_BLOB);
  assert.equal(net.calls[5].init.signal.aborted, true);
});

test("the 60 second operation deadline aborts an in-flight download", async (t) => {
  const timers = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    const controller = new AbortController();
    timers.push({ ms, controller });
    return controller.signal;
  });
  const w = world();
  const state = { cancelled: false };
  let reached;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const net = network(w, {
    [SIGNED]: (_n, init) => {
      reached();
      return new Response(hangingBody(init, state), {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    },
  });
  const pending = read(w, net);
  await entered;
  const deadline = timers.filter((timer) => timer.ms === 60_000);
  assert.equal(deadline.length, 1);
  deadline[0].controller.abort(new Error("deadline"));
  await assert.rejects(pending, redacted);
  assert.deepEqual(net.keys(), THROUGH_BLOB);
});

test("a live caller signal cannot replace the operation deadline", async (t) => {
  const timers = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    const controller = new AbortController();
    timers.push({ ms, controller });
    return controller.signal;
  });
  const w = world();
  const caller = new AbortController();
  const net = network(w, {
    [ZIP]: (_n, init) => {
      timers.find((timer) => timer.ms === 60_000).controller.abort();
      // Observe the composite before simulating fetch's abort rejection. This
      // fails deterministically rather than hanging if a mutant drops it.
      assert.equal(init.signal.aborted, true);
      return redirect(SIGNED);
    },
  });
  await refuses(w, net, THROUGH_ZIP, { signal: caller.signal });
  assert.equal(caller.signal.aborted, false);
  assert.equal(net.calls.at(-1).init.signal.aborted, true);
});

test("the per-request 10 second timeout aborts the ZIP API request", async (t) => {
  const timers = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    const controller = new AbortController();
    timers.push({ ms, controller });
    return controller.signal;
  });
  const w = world();
  const net = network(w, {
    [ZIP]: (_n, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error(`timeout ${TOKEN}`)));
        timers.at(-1).controller.abort();
      }),
  });
  await refuses(w, net, THROUGH_ZIP);
  assert.equal(timers.at(-1).ms, 10_000);
});

test("caller cancellation after the last request still withholds the bundle", async () => {
  const w = world();
  const controller = new AbortController();
  const net = network(w, {
    "/pulls/42": (n) => {
      if (n === 1) controller.abort();
      return w.pull;
    },
  });
  await refuses(w, net, HAPPY, { signal: controller.signal });
});

test("no module-level state leaks between reads", async () => {
  const w = world();
  const reader = createCandidateArtifactReader({ token: TOKEN, fetchImpl: network(w).fetchImpl });
  const first = await reader.readBundle(w.identity, w.build, w.producer);
  const second = await reader.readBundle(w.identity, w.build, w.producer);
  assert.notEqual(first.entries, second.entries);
  assert.equal(first.rootSha256, second.rootSha256);
  assert.equal(Object.isFrozen(reader), true);
});
