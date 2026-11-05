import assert from "node:assert/strict";
import test from "node:test";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateRecoveryComponentGuard } from "./candidate-staging-recovery-components.mjs";
import { createCandidateStagingJournal } from "./candidate-staging-occupancy.mjs";
import { createCandidateTrafficSettingsRecovery } from "./candidate-staging-recovery.mjs";
import { createCandidateSettingsLifecycle } from "./candidate-staging-settings-lifecycle.mjs";

const ERROR = "Candidate recovery refused: component ownership";
const LIFECYCLE_ERROR = "Candidate settings refused: lifecycle";
const JOURNAL_TOKEN = "fixture-journal-bearer";
const PROVIDER_TOKEN = "fixture-provider-bearer";
const GITHUB = "https://api.github.com/repos/TogetherWeOwn/two-web-next";
const ENVIRONMENT = "candidate-staging-occupancy";
const VERSION = "11111111-2222-3333-4444-555555555555";
const OTHER_VERSION = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const T0 = 1793830000;
const CREATED = T0 + 100;
const NOW = T0 + 200;
const EXPIRES = CREATED + 15 * 86400;
const PHASES = [
  "restore-baseline-assets",
  "restore-baseline-version",
  "seal",
  "restore",
  "unchanged",
  "restore-baseline-traffic",
];
const hash = (value) => candidateSha256(JSON.stringify(value));
const sort = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const iso = (seconds) => new Date(seconds * 1000).toISOString();

function refusal(error) {
  assert.ok(error instanceof Error);
  assert.equal(error.message, ERROR);
  assert.equal(error.cause, undefined);
  assert.equal(error.message.includes(JOURNAL_TOKEN), false);
  return true;
}

function makeIdentity(headSha = "a".repeat(40)) {
  return candidateIdentity(
    { prNumber: "42", headSha, ciRunId: "100", ciRunAttempt: "1" },
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

function makeRow(id, payload) {
  return {
    id,
    creator: { id: 7 },
    performed_via_github_app: { id: 8 },
    environment: ENVIRONMENT,
    task: "candidate-staging-occupancy-v1",
    ref: payload.controllerSha,
    sha: payload.controllerSha,
    production_environment: false,
    transient_environment: false,
    payload,
  };
}

function makeStatus(state = "success", id = 10) {
  return {
    id,
    creator: { id: 7 },
    performed_via_github_app: { id: 8 },
    environment: ENVIRONMENT,
    state,
    description: state === "success" ? `two.restore.v1:${"f".repeat(64)}` : "pending",
  };
}

// The state digest is computed here from the documented field order, never by
// the module under test, and is held in the independent expectedPayload.
function stateDigest(state) {
  return hash({
    schema: state.schema,
    promotable: false,
    scope: state.scope,
    q: state.q,
    profileSha256: state.profileSha256,
    baselineSha256: state.baselineSha256,
    settingsSha256: state.settingsSha256,
    servingSha256: state.servingSha256,
  });
}

function setup({ assets = true } = {}) {
  const identity = makeIdentity();
  const files = [
    { path: "index.js", kind: "module", bytes: Buffer.from('throw new Error("do not execute B")') },
    { path: "chunks/app.js", kind: "module", bytes: Buffer.from("export const value = 1") },
    ...(assets ? [{ path: "_app/app.css", kind: "asset", bytes: Buffer.from("body{}") }] : []),
  ];
  const bindings = [
    { name: "APP_URL", type: "plain_text", text: "https://next.togetherweown.com" },
    { name: "SESSION_SECRET", type: "secret_text" },
    { name: "DISCORD_CLIENT_SECRET", type: "secret_text" },
    { name: "QA_AUTH_TOKEN", type: "secret_text" },
    { name: "SIGNING_KEY", type: "secret_key" },
    { name: "DB", type: "hyperdrive", id: "2".repeat(32) },
    { name: "BOT_DB", type: "hyperdrive", id: "3".repeat(32) },
    { name: "SYNC_EVENT_QUEUE", type: "queue", queue_name: "two-sync-event" },
    { name: "INTERNAL_ACTION_QUEUE", type: "queue", queue_name: "two-internal-action" },
    { name: "CF_VERSION_METADATA", type: "version_metadata" },
    ...(assets ? [{ name: "ASSETS", type: "assets" }] : []),
  ].sort((a, b) => sort(a.name, b.name));
  const profile = {
    schema: "two.candidate-upload-profile.v1",
    accountId: "1".repeat(32),
    scriptName: "two-web-next",
    bindings: bindings.filter((item) => item.type === "hyperdrive"),
  };
  const profileSha256 = hash(profile);
  const baseline = {
    schema: "two.candidate-baseline-web.v1",
    promotable: false,
    q: identity.q,
    profileSha256,
    versionId: VERSION,
    capturedAt: T0,
    mainModule: "index.js",
    compatibilityDate: "2026-09-29",
    compatibilityFlags: ["nodejs_compat"],
    placement: { mode: "targeted", region: "aws:us-east-1" },
    annotations: { "workers/tag": "d".repeat(40) },
    assets: assets ? { run_worker_first: true } : null,
    bindings,
    files: files
      .map((f) => ({
        path: f.path,
        kind: f.kind,
        contentType: f.kind === "asset" ? null : "application/javascript+module",
        size: f.bytes.length,
        sha256: candidateSha256(f.bytes),
      }))
      .sort((a, b) => sort(`${a.kind}:${a.path}`, `${b.kind}:${b.path}`)),
  };
  const settings = {
    schema: "two.candidate-settings-snapshot.v1",
    promotable: false,
    q: identity.q,
    profileSha256,
    capturedAt: T0 + 10,
    settings: {
      logpush: true,
      tags: [],
      tail_consumers: [{ service: "two-web-next-alerts" }],
      observability: {
        enabled: true,
        head_sampling_rate: 0.25,
        logs: {
          enabled: true,
          head_sampling_rate: 0.5,
          invocation_logs: true,
          persist: true,
          destinations: [],
        },
      },
    },
    subdomain: { enabled: true, previews_enabled: false },
  };
  const serving = {
    schema: "two.candidate-serving.v1",
    promotable: false,
    q: identity.q,
    profileSha256,
    deploymentId: D1,
    versionId: VERSION,
    historySha256: "d".repeat(64),
    observedAt: T0 + 20,
  };
  const state = {
    schema: "two.candidate-recovery-components.v1",
    promotable: false,
    scope: "web-settings-and-serving-pins-only",
    q: identity.q,
    profileSha256,
    baselineSha256: "",
    settingsSha256: "",
    servingSha256: "",
  };
  const expectedPayload = {
    schema: "two.candidate-occupancy.v1",
    q: identity.q,
    controllerSha: identity.descriptor[5],
    headSha: identity.descriptor[4],
    runId: identity.descriptor[7],
    runAttempt: identity.descriptor[8],
    createdAt: iso(CREATED),
    baseline: {
      artifactId: "456",
      archiveSha256: "d".repeat(64),
      stateSha256: "",
      expiresAt: iso(EXPIRES),
    },
  };
  const row = makeRow(1, structuredClone(expectedPayload));
  const net = { rows: [row], statuses: new Map(), calls: [], onRead: null, respond: null };
  const touched = [];
  const real = createCandidateStagingJournal({
    token: JOURNAL_TOKEN,
    creatorId: "7",
    appId: "8",
    fetchImpl: async (url, request) => {
      net.calls.push({ url, ...request });
      if (net.onRead) await net.onRead(net.calls.length, url);
      if (net.respond) return net.respond(url);
      const match = /\/deployments\/(\d+)\/statuses\?/.exec(url);
      return Response.json(match ? (net.statuses.get(Number(match[1])) ?? []) : net.rows);
    },
  });
  const s = {
    identity,
    files,
    profile,
    profileSha256,
    baseline,
    settings,
    serving,
    state,
    expectedPayload,
    row,
    net,
    touched,
    now: NOW,
    clockCalls: 0,
    onClock: null,
    // Any journal member other than bindRecovery (notably markRestored) is a failure.
    journal: new Proxy(real, {
      get(target, key) {
        touched.push(key);
        return target[key];
      },
    }),
    clock() {
      s.clockCalls++;
      if (s.onClock) s.onClock(s.clockCalls);
      return s.now;
    },
    pinState() {
      s.expectedPayload.baseline.stateSha256 = stateDigest(s.state);
      s.row.payload = structuredClone(s.expectedPayload);
    },
    rebind() {
      s.state.baselineSha256 = hash(s.baseline);
      s.state.settingsSha256 = hash(s.settings);
      s.state.servingSha256 = hash(s.serving);
      s.pinState();
    },
  };
  s.rebind();
  return s;
}

function makeGuard(s, overrides = {}) {
  return createCandidateRecoveryComponentGuard({
    journal: s.journal,
    deploymentId: "1",
    identity: s.identity,
    profile: s.profile,
    profileSha256: s.profileSha256,
    expectedPayload: s.expectedPayload,
    state: s.state,
    baseline: s.baseline,
    files: s.files,
    settings: s.settings,
    serving: s.serving,
    clock: () => s.clock(),
    ...overrides,
  });
}

function ctx(s, phase) {
  const base = { phase, q: s.identity.q, profileSha256: s.profileSha256 };
  const assets = s.baseline.files.filter((f) => f.kind === "asset");
  switch (phase) {
    case "restore-baseline-assets":
      return { ...base, baselineSha256: s.state.baselineSha256, assetRootSha256: hash(assets) };
    case "restore-baseline-version":
      return {
        ...ctx(s, "restore-baseline-assets"),
        phase,
        baselineVersionId: s.baseline.versionId,
      };
    case "seal":
    case "restore":
      return { ...base, snapshotSha256: s.state.settingsSha256 };
    case "unchanged":
      return { ...base, snapshotSha256: s.state.servingSha256, restoreDeploymentId: null };
    case "restore-baseline-traffic":
      return {
        ...base,
        snapshotSha256: s.state.servingSha256,
        baseline: structuredClone(s.serving),
      };
    default:
      throw new Error("fixture phase");
  }
}

function listReads(s) {
  return s.net.calls.filter((call) => !call.url.includes("/statuses?")).length;
}

function assertReadOnlyJournal(s) {
  assert.ok(s.net.calls.length > 0);
  for (const call of s.net.calls) {
    assert.equal(call.method, "GET");
    assert.equal("body" in call, false);
    assert.equal(call.headers.Authorization, `Bearer ${JOURNAL_TOKEN}`);
    assert.equal(call.redirect, "error");
    assert.ok(call.url.startsWith(`${GITHUB}/deployments`));
    assert.ok(call.signal instanceof AbortSignal);
  }
  assert.ok(s.touched.every((key) => key === "bindRecovery"));
}

function refusesConstruction(s, overrides) {
  assert.throws(() => makeGuard(s, overrides), refusal);
  assert.equal(s.net.calls.length, 0);
}

async function refusesBeforeJournal(s, guard, context, signal) {
  await assert.rejects(guard(context, signal), refusal);
  assert.equal(s.net.calls.length, 0);
}

// ---- positive phases ----

for (const phase of PHASES) {
  test(`${phase} joins pinned components to sole authenticated dirty ownership`, async () => {
    const s = setup();
    const guard = makeGuard(s);
    assert.equal(s.net.calls.length, 0);
    const owner = await guard(ctx(s, phase), new AbortController().signal);
    assert.ok(Object.isFrozen(owner));
    assert.deepEqual(owner, {
      schema: "two.candidate-recovery-component-owner.v1",
      promotable: false,
      scope: "web-settings-and-serving-pins-only",
      q: s.identity.q,
      deploymentId: "1",
      stateSha256: s.expectedPayload.baseline.stateSha256,
    });
    assert.equal(owner.stateSha256, stateDigest(s.state));
    assert.equal(JSON.stringify(owner).includes(JOURNAL_TOKEN), false);
    assert.equal(s.net.calls.length, 2);
    assert.ok(s.net.calls[0].url.startsWith(`${GITHUB}/deployments?`));
    assert.ok(s.net.calls[1].url.startsWith(`${GITHUB}/deployments/1/statuses?`));
    assertReadOnlyJournal(s);
  });
}

test("a restore-baseline assets context for a baseline without assets uses the empty root", async () => {
  const s = setup({ assets: false });
  const guard = makeGuard(s);
  const context = ctx(s, "restore-baseline-version");
  assert.equal(context.assetRootSha256, hash([]));
  assert.equal((await guard(context)).deploymentId, "1");
  assert.equal((await guard(ctx(s, "restore-baseline-assets"))).deploymentId, "1");
  assertReadOnlyJournal(s);
});

test("an in-progress status is still dirty and every repeat call is re-read", async () => {
  const s = setup();
  s.net.statuses.set(1, [makeStatus("in_progress", 11), makeStatus("failure", 10)]);
  const guard = makeGuard(s);
  await guard(ctx(s, "seal"));
  await guard(ctx(s, "restore"));
  assert.equal(listReads(s), 2);
  assert.equal(s.net.calls.length, 4);
  assertReadOnlyJournal(s);
});

test("another run's clean row does not compete for ownership", async () => {
  const s = setup();
  const payload = structuredClone(s.expectedPayload);
  payload.q = "9".repeat(64);
  payload.runId = "300";
  s.net.rows.push(makeRow(2, payload));
  s.net.statuses.set(2, [makeStatus("success", 20)]);
  const guard = makeGuard(s);
  assert.equal((await guard(ctx(s, "seal"))).deploymentId, "1");
  assertReadOnlyJournal(s);
});

test("clock and time boundaries accept exact creation and the last second before expiry", async () => {
  for (const now of [CREATED, EXPIRES - 1]) {
    const s = setup();
    s.now = now;
    assert.equal((await makeGuard(s)(ctx(s, "seal"))).deploymentId, "1");
  }
  const s = setup();
  s.serving.observedAt = CREATED;
  s.settings.capturedAt = CREATED;
  s.baseline.capturedAt = CREATED;
  s.rebind();
  s.now = CREATED;
  assert.equal((await makeGuard(s)(ctx(s, "unchanged"))).deploymentId, "1");
});

test("a non-aborted caller signal is accepted and an absent one uses only the bounded deadline", async () => {
  const s = setup();
  const guard = makeGuard(s);
  await guard(ctx(s, "seal"), new AbortController().signal);
  await guard(ctx(s, "seal"), undefined);
  assert.equal(listReads(s), 2);
});

test("construction copies every mutable caller input and later mutation changes nothing", async () => {
  const s = setup();
  const guard = makeGuard(s);
  const contexts = PHASES.map((phase) => ctx(s, phase));
  s.state.baselineSha256 = "0".repeat(64);
  s.state.q = "0".repeat(64);
  s.baseline.versionId = OTHER_VERSION;
  s.baseline.placement.region = "foreign";
  s.baseline.files[0].sha256 = "0".repeat(64);
  for (const file of s.files) file.bytes.fill(0);
  s.files.length = 0;
  s.settings.settings.logpush = false;
  s.settings.subdomain.enabled = false;
  s.serving.versionId = OTHER_VERSION;
  s.serving.deploymentId = D2;
  s.profile.accountId = "9".repeat(32);
  s.expectedPayload.baseline.stateSha256 = "0".repeat(64);
  s.expectedPayload.q = "0".repeat(64);
  s.expectedPayload.createdAt = iso(NOW + 1000);
  s.expectedPayload.baseline.expiresAt = iso(NOW - 1000);
  for (const context of contexts) assert.equal((await guard(context)).deploymentId, "1");
  assert.equal(s.net.calls.length, PHASES.length * 2);
  assertReadOnlyJournal(s);
});

test("a context mutated after admission cannot change what the journal owner sees", async () => {
  const s = setup();
  const guard = makeGuard(s);
  const context = ctx(s, "seal");
  const pending = guard(context);
  context.snapshotSha256 = "0".repeat(64);
  context.phase = "restored";
  assert.equal((await pending).deploymentId, "1");
});

// ---- construction refusals ----

for (const [name, journal] of [
  ["missing", undefined],
  ["null", null],
  ["empty", {}],
  ["non-function", { bindRecovery: "yes" }],
]) {
  test(`construction refuses a ${name} journal`, () => {
    const s = setup();
    assert.throws(() => makeGuard(s, { journal }), refusal);
  });
}

test("construction refuses an absent argument object", () => {
  assert.throws(() => createCandidateRecoveryComponentGuard(), refusal);
});

for (const deploymentId of [undefined, 1, "0", "01", "1 ", "abc", "", "1".repeat(21)]) {
  test(`construction refuses deployment id ${JSON.stringify(deploymentId)}`, () => {
    const s = setup();
    refusesConstruction(s, { deploymentId });
  });
}

for (const [name, mutate] of [
  ["schema", (st) => (st.schema = "two.candidate-recovery-components.v2")],
  ["promotable", (st) => (st.promotable = true)],
  ["scope", (st) => (st.scope = "complete-recovery")],
  ["q", (st) => (st.q = "0".repeat(64))],
  ["profileSha256", (st) => (st.profileSha256 = "0".repeat(64))],
  ["extra field", (st) => (st.extra = "x")],
  ["missing baselineSha256", (st) => delete st.baselineSha256],
  ["missing settingsSha256", (st) => delete st.settingsSha256],
  ["missing servingSha256", (st) => delete st.servingSha256],
  ["malformed baselineSha256", (st) => (st.baselineSha256 = "xyz")],
  ["malformed settingsSha256", (st) => (st.settingsSha256 = "xyz")],
  ["malformed servingSha256", (st) => (st.servingSha256 = "xyz")],
  ["foreign baselineSha256", (st) => (st.baselineSha256 = "e".repeat(64))],
  ["foreign settingsSha256", (st) => (st.settingsSha256 = "e".repeat(64))],
  ["foreign servingSha256", (st) => (st.servingSha256 = "e".repeat(64))],
]) {
  test(`construction refuses state ${name} even when the caller repins the payload`, () => {
    const s = setup();
    mutate(s.state);
    s.pinState();
    refusesConstruction(s);
  });
  test(`construction refuses state ${name} against the independently held payload`, () => {
    const s = setup();
    mutate(s.state);
    refusesConstruction(s);
  });
}

test("construction refuses a state that is not an object", () => {
  for (const value of [undefined, null, "state", [], 7]) {
    const s = setup();
    refusesConstruction(s, { state: value });
  }
});

for (const [name, mutate] of [
  ["state digest", (p) => (p.baseline.stateSha256 = "0".repeat(64))],
  ["state digest type", (p) => (p.baseline.stateSha256 = 7)],
  ["q", (p) => (p.q = "0".repeat(64))],
  ["head", (p) => (p.headSha = "e".repeat(40))],
  ["controller", (p) => (p.controllerSha = "e".repeat(40))],
  ["run id", (p) => (p.runId = "999")],
  ["run attempt", (p) => (p.runAttempt = "2")],
  ["schema", (p) => (p.schema = "two.candidate-occupancy.v2")],
  ["extra field", (p) => (p.extra = "x")],
  ["missing baseline", (p) => delete p.baseline],
  ["creation time format", (p) => (p.createdAt = "not-a-time")],
  ["creation time non-canonical", (p) => (p.createdAt = iso(CREATED).replace("Z", "+00:00"))],
  ["expiry format", (p) => (p.baseline.expiresAt = "not-a-time")],
  ["created after the clock", (p) => (p.createdAt = iso(NOW + 1))],
  ["expired at the clock", (p) => (p.baseline.expiresAt = iso(NOW))],
  ["expired before the clock", (p) => (p.baseline.expiresAt = iso(NOW - 1))],
  ["created before baseline capture", (p) => (p.createdAt = iso(T0 - 1))],
]) {
  test(`construction refuses expected payload ${name}`, () => {
    const s = setup();
    mutate(s.expectedPayload);
    refusesConstruction(s);
  });
}

test("construction refuses an absent or non-object expected payload", () => {
  for (const value of [undefined, null, "payload", []]) {
    const s = setup();
    refusesConstruction(s, { expectedPayload: value });
  }
});

test("construction refuses an identity from another run even with matching pinned data", () => {
  const s = setup();
  refusesConstruction(s, { identity: makeIdentity("e".repeat(40)) });
  for (const identity of [undefined, null, {}, "identity"]) refusesConstruction(s, { identity });
});

test("construction refuses profile tampering and a re-hashed foreign profile", () => {
  const tampered = setup();
  tampered.profile.accountId = "9".repeat(32);
  refusesConstruction(tampered);
  const malformed = setup();
  refusesConstruction(malformed, { profileSha256: "xyz" });
  const foreign = setup();
  foreign.profile.bindings = [];
  refusesConstruction(foreign, { profileSha256: hash(foreign.profile) });
  const missing = setup();
  refusesConstruction(missing, { profile: undefined });
});

for (const [name, mutate] of [
  ["schema", (b) => (b.schema = "two.candidate-baseline-web.v2")],
  ["promotable", (b) => (b.promotable = true)],
  ["q", (b) => (b.q = "0".repeat(64))],
  ["profileSha256", (b) => (b.profileSha256 = "0".repeat(64))],
  ["malformed version", (b) => (b.versionId = "latest")],
  ["version not served", (b) => (b.versionId = OTHER_VERSION)],
  ["negative capture time", (b) => (b.capturedAt = -1)],
  ["fractional capture time", (b) => (b.capturedAt = T0 + 0.5)],
  ["capture after creation", (b) => (b.capturedAt = CREATED + 1)],
  ["missing main module", (b) => (b.mainModule = "missing.js")],
  ["compatibility date", (b) => (b.compatibilityDate = "2026-01-01")],
  ["compatibility flags", (b) => (b.compatibilityFlags = [])],
  ["placement", (b) => (b.placement.region = "aws:eu-west-1")],
  ["annotation", (b) => (b.annotations["workers/tag"] = "xyz")],
  ["assets config", (b) => (b.assets = { run_worker_first: false })],
  ["extra field", (b) => (b.token = "x")],
  ["missing field", (b) => delete b.placement],
  ["binding dropped", (b) => (b.bindings = b.bindings.filter((item) => item.name !== "ASSETS"))],
  ["file size", (b) => (b.files[0].size += 1)],
  ["file digest", (b) => (b.files[0].sha256 = "0".repeat(64))],
  ["file kind", (b) => (b.files[0].kind = "other")],
  ["file path traversal", (b) => (b.files[1].path = "../index.js")],
  ["duplicate file record", (b) => b.files.push(structuredClone(b.files[0]))],
  ["file record removed", (b) => b.files.splice(0, 1)],
  ["file record extra field", (b) => (b.files[0].mode = 0o777)],
]) {
  test(`construction refuses baseline ${name} even when every pin is recomputed`, () => {
    const s = setup();
    mutate(s.baseline);
    s.rebind();
    refusesConstruction(s);
  });
}

test("construction refuses a baseline changed without its pin or not an object", () => {
  const stale = setup();
  stale.baseline.placement.region = "aws:eu-west-1";
  refusesConstruction(stale);
  for (const baseline of [undefined, null, "baseline", []]) {
    const s = setup();
    refusesConstruction(s, { baseline });
  }
});

for (const [name, mutate] of [
  ["altered module byte", (f) => (f[0].bytes[0] ^= 1)],
  ["altered asset byte", (f) => (f[2].bytes[0] ^= 1)],
  ["truncated bytes", (f) => (f[1].bytes = f[1].bytes.subarray(1))],
  ["appended bytes", (f) => (f[1].bytes = Buffer.concat([f[1].bytes, Buffer.from(" ")]))],
  ["string bytes", (f) => (f[1].bytes = "export const value = 1")],
  ["Uint8Array bytes", (f) => (f[1].bytes = new Uint8Array(f[1].bytes))],
  ["missing file", (f) => f.splice(2, 1)],
  ["extra file", (f) => f.push({ path: "extra.js", kind: "module", bytes: Buffer.from("x") })],
  ["duplicate file", (f) => f.splice(2, 1, structuredClone(f[0]))],
  ["swapped kind", (f) => (f[2].kind = "module")],
  ["extra field", (f) => (f[0].mode = 0o777)],
  ["traversal path", (f) => (f[0].path = "../index.js")],
]) {
  test(`construction refuses supplied files with ${name}`, () => {
    const s = setup();
    mutate(s.files);
    refusesConstruction(s);
  });
}

test("construction refuses files that are absent or not a list", () => {
  for (const files of [undefined, null, "files", {}]) {
    const s = setup();
    refusesConstruction(s, { files });
  }
});

for (const [name, mutate] of [
  ["schema", (v) => (v.schema = "two.candidate-settings-snapshot.v2")],
  ["promotable", (v) => (v.promotable = true)],
  ["q", (v) => (v.q = "0".repeat(64))],
  ["profileSha256", (v) => (v.profileSha256 = "0".repeat(64))],
  ["negative capture time", (v) => (v.capturedAt = -1)],
  ["fractional capture time", (v) => (v.capturedAt = T0 + 10.5)],
  ["capture after creation", (v) => (v.capturedAt = CREATED + 1)],
  ["extra field", (v) => (v.token = "x")],
  ["missing subdomain", (v) => delete v.subdomain],
  ["logpush type", (v) => (v.settings.logpush = "yes")],
  ["foreign tail consumer", (v) => (v.settings.tail_consumers = [{ service: "other" }])],
  ["tags", (v) => (v.settings.tags = ["x"])],
  ["destinations", (v) => (v.settings.observability.logs.destinations = ["x"])],
  ["sampling rate", (v) => (v.settings.observability.head_sampling_rate = 2)],
  ["settings extra field", (v) => (v.settings.extra = true)],
  ["subdomain extra field", (v) => (v.subdomain.extra = true)],
  ["subdomain type", (v) => (v.subdomain.enabled = "yes")],
]) {
  test(`construction refuses settings ${name} even when every pin is recomputed`, () => {
    const s = setup();
    mutate(s.settings);
    s.rebind();
    refusesConstruction(s);
  });
}

test("construction refuses settings changed without a pin or not an object", () => {
  const stale = setup();
  stale.settings.settings.logpush = false;
  refusesConstruction(stale);
  for (const settings of [undefined, null, "settings", []]) {
    const s = setup();
    refusesConstruction(s, { settings });
  }
});

for (const [name, mutate] of [
  ["schema", (v) => (v.schema = "two.candidate-serving.v2")],
  ["promotable", (v) => (v.promotable = true)],
  ["q", (v) => (v.q = "0".repeat(64))],
  ["profileSha256", (v) => (v.profileSha256 = "0".repeat(64))],
  ["malformed deployment", (v) => (v.deploymentId = "latest")],
  ["malformed version", (v) => (v.versionId = "latest")],
  ["version differs from baseline", (v) => (v.versionId = OTHER_VERSION)],
  ["malformed history", (v) => (v.historySha256 = "xyz")],
  ["negative observation", (v) => (v.observedAt = -1)],
  ["fractional observation", (v) => (v.observedAt = T0 + 20.5)],
  ["observation after creation", (v) => (v.observedAt = CREATED + 1)],
  ["extra field", (v) => (v.token = "x")],
  ["missing field", (v) => delete v.historySha256],
]) {
  test(`construction refuses serving ${name} even when every pin is recomputed`, () => {
    const s = setup();
    mutate(s.serving);
    s.rebind();
    refusesConstruction(s);
  });
}

test("construction refuses serving changed without a pin or not an object", () => {
  const stale = setup();
  stale.serving.observedAt += 1;
  refusesConstruction(stale);
  for (const serving of [undefined, null, "serving", []]) {
    const s = setup();
    refusesConstruction(s, { serving });
  }
});

for (const [name, value] of [
  ["null", null],
  ["string", "clock"],
  ["NaN", () => Number.NaN],
  ["negative", () => -1],
  ["fractional", () => NOW + 0.5],
  ["too large", () => 253402300800],
  ["string value", () => String(NOW)],
  ["before creation", () => CREATED - 1],
  ["at expiry", () => EXPIRES],
  ["after expiry", () => EXPIRES + 1],
  [
    "throwing",
    () => {
      throw new Error("private-clock-detail");
    },
  ],
]) {
  test(`construction refuses a ${name} clock`, () => {
    const s = setup();
    refusesConstruction(s, { clock: value });
  });
}

test("construction refuses a clock whose initial reading is invalid", () => {
  for (const initial of [Number.NaN, -1, 253402300800]) {
    const s = setup();
    let count = 0;
    refusesConstruction(s, { clock: () => (count++ === 0 ? initial : NOW) });
  }
});

test("construction refuses a clock that moves backwards before admission completes", () => {
  const s = setup();
  let count = 0;
  refusesConstruction(s, { clock: () => (count++ === 0 ? NOW : NOW - 1) });
});

// ---- context refusals ----

for (const [name, value] of [
  ["undefined", undefined],
  ["null", null],
  ["string", "seal"],
  ["number", 7],
  ["array", []],
]) {
  test(`a ${name} context is refused before the journal`, async () => {
    const s = setup();
    await refusesBeforeJournal(s, makeGuard(s), value);
  });
}

for (const phase of [
  "restored",
  "restore-new-deployment",
  "restore-baseline-version-b-prime",
  "snapshot",
  "unchanged-restored",
  "clean",
  "",
  7,
  null,
  undefined,
]) {
  test(`phase ${JSON.stringify(phase) ?? "undefined"} is refused before the journal`, async () => {
    const s = setup();
    await refusesBeforeJournal(s, makeGuard(s), { ...ctx(s, "seal"), phase });
  });
}

for (const phase of PHASES) {
  const fields = Object.keys(ctx(setup(), phase)).filter((key) => key !== "phase");
  for (const field of fields) {
    test(`${phase} refuses a missing ${field} before the journal`, async () => {
      const s = setup();
      const context = ctx(s, phase);
      delete context[field];
      await refusesBeforeJournal(s, makeGuard(s), context);
    });
    for (const value of [
      "0".repeat(64),
      D2,
      OTHER_VERSION,
      undefined,
      "",
      0,
      {},
      [],
      field === "restoreDeploymentId" ? D1 : "x",
    ]) {
      test(`${phase} refuses ${field}=${JSON.stringify(value) ?? "undefined"} before the journal`, async () => {
        const s = setup();
        const context = ctx(s, phase);
        context[field] = value;
        await refusesBeforeJournal(s, makeGuard(s), context);
      });
    }
  }
  test(`${phase} refuses extra fields before the journal`, async () => {
    const s = setup();
    await refusesBeforeJournal(s, makeGuard(s), { ...ctx(s, phase), extra: true });
    await refusesBeforeJournal(s, makeGuard(s), {
      ...ctx(s, phase),
      restoreDeploymentId: D2,
      baselineVersionId: OTHER_VERSION,
    });
  });
}

test("phases do not accept another phase's digest", async () => {
  const s = setup();
  const guard = makeGuard(s);
  await refusesBeforeJournal(s, guard, {
    ...ctx(s, "seal"),
    snapshotSha256: s.state.servingSha256,
  });
  await refusesBeforeJournal(s, guard, {
    ...ctx(s, "restore"),
    snapshotSha256: s.state.baselineSha256,
  });
  await refusesBeforeJournal(s, guard, {
    ...ctx(s, "unchanged"),
    snapshotSha256: s.state.settingsSha256,
  });
  await refusesBeforeJournal(s, guard, {
    ...ctx(s, "restore-baseline-traffic"),
    snapshotSha256: s.state.settingsSha256,
  });
  await refusesBeforeJournal(s, guard, {
    ...ctx(s, "restore-baseline-assets"),
    baselineSha256: s.state.settingsSha256,
  });
});

test("restore after a new deployment or with a restore deployment id is refused", async () => {
  const s = setup();
  const guard = makeGuard(s);
  await refusesBeforeJournal(s, guard, { ...ctx(s, "unchanged"), restoreDeploymentId: D2 });
  await refusesBeforeJournal(s, guard, { ...ctx(s, "unchanged"), restoreDeploymentId: D1 });
  await refusesBeforeJournal(s, guard, {
    ...ctx(s, "restore-baseline-traffic"),
    restoreDeploymentId: null,
  });
  await refusesBeforeJournal(s, guard, { ...ctx(s, "seal"), restoreDeploymentId: null });
  await refusesBeforeJournal(s, guard, {
    ...ctx(s, "seal"),
    phase: "restored",
    restoreDeploymentId: D2,
  });
});

test("traffic context must carry the exact pinned original-B serving snapshot", async () => {
  const s = setup();
  const guard = makeGuard(s);
  const other = { ...structuredClone(s.serving), deploymentId: D2 };
  const consistent = {
    ...other,
    versionId: OTHER_VERSION,
  };
  for (const baseline of [
    other,
    consistent,
    { ...structuredClone(s.serving), extra: true },
    { ...structuredClone(s.serving), observedAt: s.serving.observedAt + 1 },
    { ...structuredClone(s.serving), q: "0".repeat(64) },
    { ...structuredClone(s.serving), promotable: true },
    s.baseline,
    s.settings,
    null,
  ]) {
    await refusesBeforeJournal(s, guard, { ...ctx(s, "restore-baseline-traffic"), baseline });
  }
  // A self-consistent but unpinned serving snapshot has its own valid digest.
  await refusesBeforeJournal(s, guard, {
    ...ctx(s, "restore-baseline-traffic"),
    snapshotSha256: hash(consistent),
    baseline: consistent,
  });
});

test("a context cannot select the pins it is checked against", async () => {
  const s = setup();
  const guard = makeGuard(s);
  const foreign = { ...structuredClone(s.settings), capturedAt: s.settings.capturedAt + 1 };
  await refusesBeforeJournal(s, guard, { ...ctx(s, "seal"), snapshotSha256: hash(foreign) });
  await refusesBeforeJournal(s, guard, { ...ctx(s, "seal"), q: makeIdentity("e".repeat(40)).q });
  await refusesBeforeJournal(s, guard, { ...ctx(s, "seal"), profileSha256: hash({ other: 1 }) });
});

// ---- signal, clock and cancellation after construction ----

test("a non-AbortSignal second argument is refused before the journal", async () => {
  const s = setup();
  const guard = makeGuard(s);
  for (const signal of [null, "signal", {}, 7, { aborted: false }]) {
    await refusesBeforeJournal(s, guard, ctx(s, "seal"), signal);
  }
});

test("an already aborted signal is refused before the journal", async () => {
  const s = setup();
  const controller = new AbortController();
  controller.abort();
  await refusesBeforeJournal(s, makeGuard(s), ctx(s, "seal"), controller.signal);
});

for (const at of [1, 2]) {
  test(`cancellation during journal read ${at} is refused with the fixed message`, async () => {
    const s = setup();
    const controller = new AbortController();
    s.net.onRead = (count) => {
      if (count === at) controller.abort();
    };
    await assert.rejects(makeGuard(s)(ctx(s, "seal"), controller.signal), refusal);
    assert.ok(s.net.calls.length >= at);
  });
}

test("cancellation at the pre-owner clock check is refused before any journal read", async () => {
  const s = setup();
  const controller = new AbortController();
  const guard = makeGuard(s);
  const admitted = s.clockCalls;
  s.onClock = (count) => {
    if (count === admitted + 1) controller.abort();
  };
  await refusesBeforeJournal(s, guard, ctx(s, "seal"), controller.signal);
});

test("cancellation during the final ownership clock check withholds the receipt", async () => {
  const s = setup();
  const controller = new AbortController();
  const guard = makeGuard(s);
  const admitted = s.clockCalls;
  s.onClock = (count) => {
    if (count === admitted + 2) controller.abort();
  };
  await assert.rejects(guard(ctx(s, "seal"), controller.signal), refusal);
  assert.equal(s.net.calls.length, 2);
});

for (const [name, value] of [
  ["rollback", NOW - 1],
  ["expiry", EXPIRES],
  ["past expiry", EXPIRES + 1],
  ["NaN", Number.NaN],
  ["negative", -1],
  ["fractional", NOW + 0.5],
  ["too large", 253402300800],
  ["string", String(NOW)],
]) {
  test(`clock ${name} before the guard is refused before the journal`, async () => {
    const s = setup();
    const guard = makeGuard(s);
    s.now = value;
    await refusesBeforeJournal(s, guard, ctx(s, "seal"));
  });
  test(`clock ${name} during the guard is refused after the owner check`, async () => {
    const s = setup();
    const guard = makeGuard(s);
    s.net.onRead = (count) => {
      if (count === 2) s.now = value;
    };
    await assert.rejects(guard(ctx(s, "seal")), refusal);
    assert.equal(s.net.calls.length, 2);
  });
}

test("a thrown clock is refused with the fixed message before and after the guard", async () => {
  const before = setup();
  const guardBefore = makeGuard(before);
  before.onClock = () => {
    throw new Error("private-clock-detail");
  };
  await refusesBeforeJournal(before, guardBefore, ctx(before, "seal"));
  const after = setup();
  const guardAfter = makeGuard(after);
  after.net.onRead = (count) => {
    if (count === 2)
      after.onClock = () => {
        throw new Error("private-clock-detail");
      };
  };
  await assert.rejects(guardAfter(ctx(after, "seal")), refusal);
});

test("the clock stays monotonic across calls and a rollback is refused without reads", async () => {
  const s = setup();
  const guard = makeGuard(s);
  s.now = NOW + 50;
  await guard(ctx(s, "seal"));
  s.now = NOW + 10;
  const reads = s.net.calls.length;
  await assert.rejects(guard(ctx(s, "seal")), refusal);
  assert.equal(s.net.calls.length, reads);
  s.now = NOW + 60;
  await guard(ctx(s, "seal"));
});

// ---- journal-backed ownership refusals ----

test("a clean journal row is not recoverable ownership", async () => {
  const s = setup();
  s.net.statuses.set(1, [makeStatus("success", 10)]);
  await assert.rejects(makeGuard(s)(ctx(s, "seal")), refusal);
  assert.equal(listReads(s), 1);
  assertReadOnlyJournal(s);
});

test("an absent journal row is not recoverable ownership", async () => {
  const s = setup();
  s.net.rows.length = 0;
  await assert.rejects(makeGuard(s)(ctx(s, "seal")), refusal);
  assertReadOnlyJournal(s);
});

test("a competing dirty row withholds ownership", async () => {
  const s = setup();
  const payload = structuredClone(s.expectedPayload);
  payload.q = "9".repeat(64);
  payload.runId = "300";
  s.net.rows.push(makeRow(2, payload));
  await assert.rejects(makeGuard(s)(ctx(s, "seal")), refusal);
  assertReadOnlyJournal(s);
});

test("a competing dirty row that appears between calls withholds later ownership", async () => {
  const s = setup();
  const guard = makeGuard(s);
  await guard(ctx(s, "seal"));
  const payload = structuredClone(s.expectedPayload);
  payload.q = "9".repeat(64);
  payload.runId = "300";
  s.net.rows.push(makeRow(2, payload));
  await assert.rejects(guard(ctx(s, "restore")), refusal);
});

test("binding a different deployment id than the sole dirty row is refused", async () => {
  const s = setup();
  await assert.rejects(makeGuard(s, { deploymentId: "2" })(ctx(s, "seal")), refusal);
  assertReadOnlyJournal(s);
});

for (const [name, mutate] of [
  ["artifact id", (p) => (p.baseline.artifactId = "999")],
  ["archive digest", (p) => (p.baseline.archiveSha256 = "0".repeat(64))],
  ["state digest", (p) => (p.baseline.stateSha256 = "0".repeat(64))],
  ["expiry", (p) => (p.baseline.expiresAt = iso(EXPIRES + 86400))],
  ["creation time", (p) => (p.createdAt = iso(CREATED + 1))],
  ["run id", (p) => (p.runId = "999")],
  ["head", (p) => (p.headSha = "e".repeat(40))],
  ["q", (p) => (p.q = "0".repeat(64))],
]) {
  test(`a journal row with a replaced ${name} is refused`, async () => {
    const s = setup();
    const guard = makeGuard(s);
    mutate(s.row.payload);
    await assert.rejects(guard(ctx(s, "seal")), refusal);
    assertReadOnlyJournal(s);
  });
  test(`a journal row replaced after a successful call (${name}) refuses the next call`, async () => {
    const s = setup();
    const guard = makeGuard(s);
    await guard(ctx(s, "seal"));
    mutate(s.row.payload);
    await assert.rejects(guard(ctx(s, "restore")), refusal);
  });
}

test("a journal row from another writer or environment is refused", async () => {
  for (const mutate of [
    (row) => (row.creator.id = 9),
    (row) => (row.performed_via_github_app.id = 9),
    (row) => (row.environment = "production"),
    (row) => (row.task = "other"),
    (row) => (row.production_environment = true),
    (row) => (row.sha = "e".repeat(40)),
  ]) {
    const s = setup();
    mutate(s.row);
    await assert.rejects(makeGuard(s)(ctx(s, "seal")), refusal);
  }
});

test("journal transport failures never leak provider or token detail", async () => {
  const thrown = setup();
  thrown.net.onRead = () => {
    throw new Error(`private-journal-detail ${JOURNAL_TOKEN}`);
  };
  await assert.rejects(makeGuard(thrown)(ctx(thrown, "seal")), refusal);
  const status = setup();
  status.net.respond = () => Response.json({ message: "private-body" }, { status: 500 });
  await assert.rejects(makeGuard(status)(ctx(status, "seal")), refusal);
  const malformed = setup();
  malformed.net.respond = () =>
    new Response("not json", { headers: { "content-type": "application/json" } });
  await assert.rejects(makeGuard(malformed)(ctx(malformed, "seal")), refusal);
});

// ---- real journal-bound guard inside the actual settings lifecycle ----

function lifecycleFixture(s, guard) {
  const provider = {
    settings: structuredClone(s.settings.settings),
    subdomain: structuredClone(s.settings.subdomain),
    calls: [],
  };
  const original = structuredClone({ settings: provider.settings, subdomain: provider.subdomain });
  const api = createCandidateSettingsLifecycle({
    token: PROVIDER_TOKEN,
    identity: s.identity,
    profile: s.profile,
    profileSha256: s.profileSha256,
    assertExclusive: async () => {},
    requireDirty: guard,
    assertBaselineServing: async () => {},
    clock: () => s.clock(),
    fetchImpl: async (url, options) => {
      provider.calls.push({ url, method: options.method });
      const key = url.endsWith("/script-settings") ? "settings" : "subdomain";
      if (options.method !== "GET") provider[key] = JSON.parse(options.body);
      return new Response(
        JSON.stringify({ success: true, errors: [], result: structuredClone(provider[key]) }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  return { api, provider, original };
}

test("the settings lifecycle seals and restores through the real journal-bound guard", async () => {
  const s = setup();
  const { api, provider, original } = lifecycleFixture(s, makeGuard(s));
  const sealed = await api.seal(s.settings, s.state.settingsSha256);
  assert.equal(sealed.phase, "seal");
  assert.equal(provider.settings.logpush, false);
  assert.equal(provider.subdomain.enabled, false);
  const restored = await api.restore(s.settings, s.state.settingsSha256);
  assert.equal(restored.phase, "restore");
  assert.deepEqual({ settings: provider.settings, subdomain: provider.subdomain }, original);
  assert.ok(provider.calls.some((call) => call.method === "PATCH"));
  // Every provider write was preceded by a fresh journal read.
  assert.ok(listReads(s) > provider.calls.length);
  assertReadOnlyJournal(s);
});

for (const [kind, replace] of [
  [
    "a replaced artifact",
    (s) => {
      s.row.payload.baseline.archiveSha256 = "0".repeat(64);
    },
  ],
  [
    "a competing dirty row",
    (s) => {
      const payload = structuredClone(s.expectedPayload);
      payload.q = "9".repeat(64);
      payload.runId = "300";
      s.net.rows.push(makeRow(2, payload));
    },
  ],
  [
    "a clean receipt",
    (s) => {
      s.net.statuses.set(1, [makeStatus("success", 10)]);
    },
  ],
]) {
  for (const [at, writes] of [
    [1, 0],
    [3, 1],
    [5, 2],
  ]) {
    test(`the settings lifecycle refuses ${kind} at journal read ${at} before any write`, async () => {
      const s = setup();
      const { api, provider, original } = lifecycleFixture(s, makeGuard(s));
      let lists = 0;
      s.net.onRead = (_count, url) => {
        if (!url.includes("/statuses?") && ++lists === at) replace(s);
      };
      await assert.rejects(api.seal(s.settings, s.state.settingsSha256), {
        message: LIFECYCLE_ERROR,
      });
      assert.equal(provider.calls.length, writes);
      assert.ok(provider.calls.every((call) => call.method === "GET"));
      assert.deepEqual({ settings: provider.settings, subdomain: provider.subdomain }, original);
      assertReadOnlyJournal(s);
    });
  }
}

test("the settings lifecycle refuses restore with replaced ownership before the first write", async () => {
  const s = setup();
  const { api, provider } = lifecycleFixture(s, makeGuard(s));
  await api.seal(s.settings, s.state.settingsSha256);
  const writes = provider.calls.filter((call) => call.method !== "GET").length;
  s.row.payload.baseline.artifactId = "999";
  const calls = provider.calls.length;
  await assert.rejects(api.restore(s.settings, s.state.settingsSha256), {
    message: LIFECYCLE_ERROR,
  });
  assert.equal(provider.calls.length, calls);
  assert.equal(provider.calls.filter((call) => call.method !== "GET").length, writes);
  assertReadOnlyJournal(s);
});

test("the settings lifecycle supplies a context the guard refuses when the pin differs", async () => {
  const s = setup();
  const { api, provider } = lifecycleFixture(s, makeGuard(s));
  const foreign = { ...structuredClone(s.settings), capturedAt: s.settings.capturedAt + 1 };
  await assert.rejects(api.seal(foreign, hash(foreign)), { message: LIFECYCLE_ERROR });
  assert.equal(provider.calls.length, 0);
  assert.equal(s.net.calls.length, 0);
});

// ---- traffic and settings recovery over the real guard, restorer and lifecycle ----

const TS_ERROR = "Candidate recovery refused: traffic and settings";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${"1".repeat(32)}/workers/scripts/two-web-next`;
const DC = "55555555-5555-4555-8555-555555555555";
const DR = "33333333-3333-4333-8333-333333333333";
const DX = "44444444-4444-4444-8444-444444444444";

function tsRefusal(error) {
  assert.ok(error instanceof Error);
  assert.equal(error.message, TS_ERROR);
  assert.equal(error.cause, undefined);
  for (const secret of [JOURNAL_TOKEN, PROVIDER_TOKEN, "private"]) {
    assert.equal(error.message.includes(secret), false);
  }
  return true;
}

function dep(id, version, time) {
  return {
    id,
    created_on: iso(time),
    source: "api",
    strategy: "percentage",
    versions: [{ version_id: version, percentage: 100 }],
  };
}

function providerResult(value, init = {}) {
  return new Response(JSON.stringify({ success: true, errors: [], result: value }), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

// Independent copy of the sealed (disabled) sinks the recovery requires.
function sealedState() {
  return {
    settings: {
      logpush: false,
      tags: [],
      tail_consumers: [],
      observability: {
        enabled: false,
        head_sampling_rate: 0,
        logs: {
          enabled: false,
          head_sampling_rate: 0,
          invocation_logs: false,
          persist: false,
          destinations: [],
        },
      },
    },
    subdomain: { enabled: false, previews_enabled: false },
  };
}

// Provider mock: B-prime (DC) is selected on top of original B (D1), sinks sealed.
function providerFixture() {
  const sealed = sealedState();
  const p = {
    calls: [],
    settings: sealed.settings,
    subdomain: sealed.subdomain,
    deployments: [dep(DC, OTHER_VERSION, T0 + 150), dep(D1, VERSION, T0 + 20)],
    triggers: [],
    reply: null,
    when(when, action) {
      p.triggers.push({ when, action, done: false });
    },
    posts() {
      return p.calls.filter((call) => call.key === "POST deployments");
    },
    writes() {
      return p.calls.filter((call) => call.method !== "GET");
    },
    sinkWrites() {
      return p.writes().filter((call) => call.key !== "POST deployments");
    },
    indexOf(key) {
      return p.calls.findIndex((call) => call.key === key);
    },
    async fetch(url, request) {
      assert.ok(url.startsWith(`${BASE}/`));
      const path = url.slice(BASE.length + 1);
      const call = {
        n: p.calls.length + 1,
        url,
        path,
        method: request.method,
        key: `${request.method} ${path}`,
        body: request.body,
        request,
      };
      p.calls.push(call);
      for (const trigger of p.triggers) {
        if (!trigger.done && trigger.when(call)) {
          trigger.done = true;
          await trigger.action(call);
        }
      }
      let value;
      if (path === "deployments") {
        if (request.method === "POST") {
          p.deployments.unshift(dep(DR, JSON.parse(request.body).versions[0].version_id, NOW));
          value = p.deployments[0];
        } else value = { deployments: p.deployments };
      } else if (path.startsWith("deployments/")) {
        value = p.deployments.find((row) => path === `deployments/${row.id}`);
      } else if (path === "script-settings") {
        if (request.method === "PATCH") p.settings = JSON.parse(request.body);
        value = p.settings;
      } else if (path === "subdomain") {
        if (request.method === "POST") p.subdomain = JSON.parse(request.body);
        value = p.subdomain;
      } else throw new Error("unexpected path");
      return p.reply?.(call, structuredClone(value)) ?? providerResult(structuredClone(value));
    },
  };
  return p;
}

function recoveryFixture(over = {}, shared = {}) {
  const s = shared.s ?? setup();
  const p = shared.p ?? providerFixture();
  const g = { exclusive: [], baseline: [], onExclusive: null, onBaseline: null };
  const options = {
    journal: s.journal,
    deploymentId: "1",
    identity: s.identity,
    profile: s.profile,
    profileSha256: s.profileSha256,
    expectedPayload: s.expectedPayload,
    state: s.state,
    baseline: s.baseline,
    files: s.files,
    settings: s.settings,
    serving: s.serving,
    clock: () => s.clock(),
    token: PROVIDER_TOKEN,
    assertExclusive: async (context, signal) => {
      assert.ok(signal instanceof AbortSignal);
      g.exclusive.push({ ...context });
      if (g.onExclusive) await g.onExclusive(context, g.exclusive.length);
    },
    admitBaseline: async (context, signal) => {
      assert.ok(signal instanceof AbortSignal);
      g.baseline.push({ ...context });
      if (g.onBaseline) await g.onBaseline(context, g.baseline.length);
    },
    fetchImpl: (url, request) => p.fetch(url, request),
    ...over,
  };
  return {
    s,
    p,
    g,
    options,
    // Wrapped so a constructor refusal and a restore refusal are both rejections.
    async run(signal) {
      return createCandidateTrafficSettingsRecovery(options).restore(signal);
    },
  };
}

function originalSinks(s) {
  return { settings: s.settings.settings, subdomain: s.settings.subdomain };
}

function replaceJournalArtifact(s) {
  s.row.payload.baseline.archiveSha256 = "0".repeat(64);
}

test("recovery restores original B traffic then original settings through real guards", async () => {
  const f = recoveryFixture();
  const api = createCandidateTrafficSettingsRecovery(f.options);
  assert.ok(Object.isFrozen(api));
  assert.deepEqual(Object.keys(api), ["restore"]);
  assert.equal(f.p.calls.length, 0);
  assert.equal(f.s.net.calls.length, 0);
  const receipt = await api.restore(new AbortController().signal);
  assert.ok(Object.isFrozen(receipt));
  const { servingSha256 } = receipt;
  assert.match(servingSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(servingSha256, f.s.state.servingSha256);
  assert.deepEqual(receipt, {
    schema: "two.candidate-traffic-settings-recovery.v1",
    promotable: false,
    scope: "baseline-traffic-and-settings-only",
    q: f.s.identity.q,
    profileSha256: f.s.profileSha256,
    baselineSha256: f.s.state.baselineSha256,
    baselineServingSha256: f.s.state.servingSha256,
    settingsSha256: f.s.state.settingsSha256,
    deploymentId: DR,
    versionId: VERSION,
    servingSha256,
    settingsStateSha256: hash(originalSinks(f.s)),
    observedAt: NOW,
  });
  const text = JSON.stringify(receipt);
  for (const secret of [JOURNAL_TOKEN, PROVIDER_TOKEN]) assert.equal(text.includes(secret), false);

  // Original B traffic is restored by exactly one fixed POST; nothing else is written.
  assert.equal(f.p.posts().length, 1);
  assert.deepEqual(JSON.parse(f.p.posts()[0].body), {
    strategy: "percentage",
    versions: [{ version_id: VERSION, percentage: 100 }],
  });
  assert.deepEqual(
    f.p.writes().map((call) => call.key),
    ["POST deployments", "PATCH script-settings", "POST subdomain"],
  );
  assert.deepEqual(f.p.settings, f.s.settings.settings);
  assert.deepEqual(f.p.subdomain, f.s.settings.subdomain);
  for (const call of f.p.calls) {
    assert.equal(call.request.redirect, "error");
    assert.equal(call.request.headers.Authorization, `Bearer ${PROVIDER_TOKEN}`);
    assert.ok(call.request.signal instanceof AbortSignal);
    assert.equal(call.url.includes("force"), false);
    assert.equal(/assets|versions|upload|secrets/.test(call.path), false);
  }

  // Traffic before sinks: the exact restored deployment is independently listed and
  // read back before the first sink write, and sinks are read before any mutation.
  const post = f.p.indexOf("POST deployments");
  const patch = f.p.indexOf("PATCH script-settings");
  const subdomainPost = f.p.indexOf("POST subdomain");
  assert.ok(post > 0 && post < patch && patch < subdomainPost);
  const before = f.p.calls.slice(0, post).map((call) => call.key);
  assert.ok(before.includes("GET script-settings") && before.includes("GET subdomain"));
  const between = f.p.calls.slice(post + 1, patch).map((call) => call.key);
  assert.ok(between.includes(`GET deployments/${DR}`));
  assert.ok(between.includes("GET deployments"));
  // Final bracketing readback of serving and both sinks after the last write.
  const after = f.p.calls.slice(subdomainPost + 1).map((call) => call.key);
  for (const key of ["GET script-settings", "GET subdomain", "GET deployments"]) {
    assert.ok(after.includes(key), key);
  }
  assert.equal(f.p.calls.at(-1).method, "GET");

  // The caller guards ran for the traffic and settings phases, and the journal was
  // only ever read through the real guard.
  const phases = new Set(f.g.exclusive.map((context) => context.phase));
  assert.ok(phases.has("restore-baseline-traffic") && phases.has("restore"));
  assert.ok(f.g.baseline.some((context) => context.phase === "restore-baseline-traffic"));
  for (const context of [...f.g.exclusive, ...f.g.baseline]) {
    assert.equal(context.q, f.s.identity.q);
    assert.equal(context.profileSha256, f.s.profileSha256);
  }
  assertReadOnlyJournal(f.s);
});

test("recovery bounds journal scans independently of nested provider readbacks", async () => {
  const f = recoveryFixture();
  await f.run();
  // Entry, before/after each of three mutations, post-traffic and completion.
  // More nested serving/settings reads must not multiply full-history scans.
  assert.equal(listReads(f.s), 9);
});

test("oversized journal read cost refuses recovery at entry without provider mutation", async () => {
  const f = recoveryFixture({ maxReadRequests: 3006 });
  for (let id = 2; id <= 65; id++) {
    f.s.net.rows.push(makeRow(id, structuredClone(f.s.expectedPayload)));
    f.s.net.statuses.set(id, [makeStatus("success", id * 10)]);
  }
  await assert.rejects(f.run(), tsRefusal);
  assert.equal(f.s.net.calls.length, 64);
  assert.equal(f.p.calls.length, 0);
});

test("a component ownership budget refuses incomplete status pagination", async () => {
  const s = setup();
  s.net.statuses.set(
    1,
    Array.from({ length: 100 }, (_, i) => makeStatus("pending", 200 - i)),
  );
  const guard = makeGuard(s, { maxReadRequests: 2 });
  await assert.rejects(guard(ctx(s, "restore-baseline-traffic")), refusal);
  assert.equal(s.net.calls.length, 2);
});

for (const maxReadRequests of [null, 0, -1, 1.5, "64", 3007]) {
  test(`invalid component read budget ${JSON.stringify(maxReadRequests)} refuses construction`, () => {
    refusesConstruction(setup(), { maxReadRequests });
  });
}

test("replacement at the final ownership checkpoint withholds completed recovery evidence", async () => {
  const f = recoveryFixture();
  let scans = 0;
  f.s.net.onRead = async (_count, url) => {
    if (!url.includes("/statuses?") && ++scans === 9) replaceJournalArtifact(f.s);
  };
  await assert.rejects(f.run(), tsRefusal);
  assert.equal(scans, 9);
  assert.equal(f.p.writes().length, 3);
  assertReadOnlyJournal(f.s);
});

test("recovery never repairs assets, completes the baseline or clears the journal", async () => {
  const f = recoveryFixture();
  await f.run();
  assert.equal(
    f.s.touched.every((key) => key === "bindRecovery"),
    true,
  );
  assert.equal(
    f.p.calls.every((call) => /^(deployments|script-settings|subdomain)/.test(call.path)),
    true,
  );
  assert.equal(
    f.g.exclusive.some((context) => /clean|clear|complete/.test(context.phase)),
    false,
  );
});

test("a retry after traffic was already restored writes no second deployment", async () => {
  const f = recoveryFixture();
  f.p.when(
    (call) => call.key === "PATCH script-settings",
    () => {
      throw new Error(`private-provider-detail ${PROVIDER_TOKEN}`);
    },
  );
  await assert.rejects(f.run(), tsRefusal);
  assert.equal(f.p.posts().length, 1);
  assert.equal(f.p.sinkWrites().length, 1);
  assert.deepEqual(f.p.settings, sealedState().settings);
  // A fresh recovery observes B already serving as the earlier deployment.
  f.p.calls.length = 0;
  const receipt = await recoveryFixture({}, { s: f.s, p: f.p }).run();
  assert.equal(f.p.posts().length, 0);
  assert.equal(receipt.deploymentId, DR);
  assert.equal(receipt.versionId, VERSION);
  assert.deepEqual(
    f.p.writes().map((call) => call.key),
    ["PATCH script-settings", "POST subdomain"],
  );
  assert.deepEqual(f.p.settings, f.s.settings.settings);
});

test("original B already serving restores sinks without any traffic write", async () => {
  const f = recoveryFixture();
  f.p.deployments = [dep(D1, VERSION, T0 + 20)];
  const receipt = await f.run();
  assert.equal(receipt.deploymentId, D1);
  assert.equal(f.p.posts().length, 0);
  assert.equal(f.p.sinkWrites().length, 2);
});

test("overlapping restore calls on one recovery refuse the second without extra writes", async () => {
  const f = recoveryFixture();
  const api = createCandidateTrafficSettingsRecovery(f.options);
  const first = api.restore();
  await assert.rejects(api.restore(), tsRefusal);
  assert.equal((await first).deploymentId, DR);
  assert.equal(f.p.posts().length, 1);
  assert.equal(f.p.sinkWrites().length, 2);
});

test("a second recovery on restored enabled sinks is refused without writes", async () => {
  const f = recoveryFixture();
  await f.run();
  const writes = f.p.writes().length;
  await assert.rejects(recoveryFixture({}, { s: f.s, p: f.p }).run(), tsRefusal);
  assert.equal(f.p.writes().length, writes);
});

// ---- initially enabled or non-canonical sinks ----

for (const [name, mutate] of [
  ["logpush", (p) => (p.settings.logpush = true)],
  ["global observability", (p) => (p.settings.observability.enabled = true)],
  ["global sampling rate", (p) => (p.settings.observability.head_sampling_rate = 0.5)],
  ["logs enabled", (p) => (p.settings.observability.logs.enabled = true)],
  ["logs sampling rate", (p) => (p.settings.observability.logs.head_sampling_rate = 0.5)],
  ["invocation logs", (p) => (p.settings.observability.logs.invocation_logs = true)],
  ["logs persistence", (p) => (p.settings.observability.logs.persist = true)],
  ["tail consumer", (p) => (p.settings.tail_consumers = [{ service: "two-web-next-alerts" }])],
  ["workers.dev subdomain", (p) => (p.subdomain.enabled = true)],
  ["preview subdomain", (p) => (p.subdomain.previews_enabled = true)],
  ["unexpected settings field", (p) => (p.settings.extra = true)],
]) {
  test(`an initially non-sealed ${name} sink is refused before any mutation`, async () => {
    const f = recoveryFixture();
    mutate(f.p);
    await assert.rejects(f.run(), tsRefusal);
    assert.equal(f.p.writes().length, 0);
  });
}

// ---- dirty journal ownership ----

for (const [kind, replace] of [
  ["a replaced artifact", replaceJournalArtifact],
  [
    "a clean receipt",
    (s) => {
      s.net.statuses.set(1, [makeStatus("success", 10)]);
    },
  ],
  [
    "a competing dirty row",
    (s) => {
      const payload = structuredClone(s.expectedPayload);
      payload.q = "9".repeat(64);
      payload.runId = "300";
      s.net.rows.push(makeRow(2, payload));
    },
  ],
  [
    "a missing row",
    (s) => {
      s.net.rows.length = 0;
    },
  ],
]) {
  test(`${kind} before recovery refuses without any provider write`, async () => {
    const f = recoveryFixture();
    replace(f.s);
    await assert.rejects(f.run(), tsRefusal);
    assert.equal(f.p.writes().length, 0);
  });
  test(`${kind} after the traffic write refuses before any sink write`, async () => {
    const f = recoveryFixture();
    f.p.when(
      (call) => call.key === `GET deployments/${DR}`,
      () => replace(f.s),
    );
    await assert.rejects(f.run(), tsRefusal);
    assert.equal(f.p.posts().length, 1);
    assert.equal(f.p.sinkWrites().length, 0);
  });
  test(`${kind} between sink writes refuses the second sink write`, async () => {
    const f = recoveryFixture();
    f.p.when(
      (call) => call.key === "PATCH script-settings",
      () => replace(f.s),
    );
    await assert.rejects(f.run(), tsRefusal);
    assert.equal(f.p.writes().filter((call) => call.key === "POST subdomain").length, 0);
    assert.equal(f.p.posts().length, 1);
  });
}

test("a mismatched journal deployment id refuses without any provider write", async () => {
  const f = recoveryFixture({ deploymentId: "2" });
  await assert.rejects(f.run(), tsRefusal);
  assert.equal(f.p.writes().length, 0);
});

test("a caller cannot substitute permissive dirty, sealed or serving adapters", async () => {
  const permissive = async () => {};
  const extras = {
    requireDirty: permissive,
    assertSealed: permissive,
    assertBaselineServing: permissive,
  };
  const dirty = recoveryFixture(extras);
  replaceJournalArtifact(dirty.s);
  await assert.rejects(dirty.run(), tsRefusal);
  assert.equal(dirty.p.writes().length, 0);
  const serving = recoveryFixture(extras);
  serving.p.when(
    (call) => call.key === `GET deployments/${DR}`,
    () => serving.p.deployments.unshift(dep(DX, OTHER_VERSION, NOW)),
  );
  await assert.rejects(serving.run(), tsRefusal);
  assert.equal(serving.p.sinkWrites().length, 0);
});

// ---- provider version replacement ----

for (const version of [OTHER_VERSION, VERSION]) {
  const label = version === VERSION ? "same-version" : "foreign-version";
  test(`a ${label} replacement before the sinks are restored refuses without sink writes`, async () => {
    const f = recoveryFixture();
    f.p.when(
      (call) => call.key === `GET deployments/${DR}`,
      () => f.p.deployments.unshift(dep(DX, version, NOW)),
    );
    await assert.rejects(f.run(), tsRefusal);
    assert.equal(f.p.posts().length, 1);
    assert.equal(f.p.sinkWrites().length, 0);
  });
  test(`a ${label} replacement during the sink restore stops later writes and cleans nothing`, async () => {
    const f = recoveryFixture();
    f.p.when(
      (call) => call.key === "PATCH script-settings",
      () => f.p.deployments.unshift(dep(DX, version, NOW)),
    );
    await assert.rejects(f.run(), tsRefusal);
    assert.deepEqual(
      f.p.writes().map((call) => call.key),
      ["POST deployments", "PATCH script-settings"],
    );
  });
  test(`a ${label} replacement after the last sink write withholds the receipt`, async () => {
    const f = recoveryFixture();
    f.p.when(
      (call) => f.p.calls.slice(0, -1).some((earlier) => earlier.key === "POST subdomain"),
      () => f.p.deployments.unshift(dep(DX, version, NOW)),
    );
    await assert.rejects(f.run(), tsRefusal);
    assert.deepEqual(
      f.p.writes().map((call) => call.key),
      ["POST deployments", "PATCH script-settings", "POST subdomain"],
    );
  });
}

test("a settings drift seen by the final readback withholds the receipt", async () => {
  const f = recoveryFixture();
  f.p.when(
    (call) => f.p.calls.slice(0, -1).some((earlier) => earlier.key === "POST subdomain"),
    () => (f.p.settings.logpush = false),
  );
  await assert.rejects(f.run(), tsRefusal);
  assert.equal(f.p.writes().length, 3);
});

// ---- uncertain writes: no retry, no rollback, no cleanup ----

test("an uncertain traffic write is never retried and no sink is written", async () => {
  const f = recoveryFixture();
  f.p.reply = (call, value) =>
    call.key === "POST deployments" ? providerResult(value, { status: 500 }) : undefined;
  await assert.rejects(f.run(), tsRefusal);
  assert.equal(f.p.posts().length, 1);
  assert.equal(f.p.sinkWrites().length, 0);
});

test("a thrown traffic write never retries and leaks no provider text", async () => {
  const f = recoveryFixture();
  f.p.when(
    (call) => call.key === "POST deployments",
    () => {
      throw new Error(`private-provider-detail ${PROVIDER_TOKEN}`);
    },
  );
  await assert.rejects(f.run(), tsRefusal);
  assert.deepEqual(
    f.p.writes().map((call) => call.key),
    ["POST deployments"],
  );
});

test("an uncertain settings write is neither retried nor rolled back to sealed sinks", async () => {
  const f = recoveryFixture();
  f.p.reply = (call, value) =>
    call.key === "PATCH script-settings" ? providerResult(value, { status: 500 }) : undefined;
  await assert.rejects(f.run(), tsRefusal);
  assert.deepEqual(
    f.p.writes().map((call) => call.key),
    ["POST deployments", "PATCH script-settings"],
  );
  assert.deepEqual(f.p.settings, f.s.settings.settings);
});

test("an uncertain subdomain write is neither retried nor rolled back", async () => {
  const f = recoveryFixture();
  f.p.reply = (call, value) =>
    call.key === "POST subdomain" ? providerResult(value, { status: 500 }) : undefined;
  await assert.rejects(f.run(), tsRefusal);
  assert.equal(f.p.writes().length, 3);
});

// ---- caller guards, cancellation and signals ----

for (const [name, phase] of [
  ["exclusion", "restore-baseline-traffic"],
  ["exclusion", "restore"],
  ["baseline admission", "restore-baseline-traffic"],
  ["baseline admission", "restore"],
]) {
  test(`${name} rejection in the ${phase} phase refuses with the uniform error`, async () => {
    const f = recoveryFixture();
    const hook = async (context) => {
      if (context.phase === phase) throw new Error(`private-adapter ${PROVIDER_TOKEN}`);
    };
    if (name === "exclusion") f.g.onExclusive = hook;
    else f.g.onBaseline = hook;
    await assert.rejects(f.run(), tsRefusal);
    if (phase === "restore") {
      assert.equal(f.p.sinkWrites().length, 0);
    } else {
      assert.equal(f.p.writes().length, 0);
    }
    assert.ok(f.p.writes().length <= 1);
  });
}

test("a pre-aborted operation signal refuses before any provider write", async () => {
  const f = recoveryFixture();
  const controller = new AbortController();
  controller.abort("private-reason");
  await assert.rejects(f.run(controller.signal), tsRefusal);
  assert.equal(f.p.writes().length, 0);
});

test("cancellation after the traffic write stops before the sinks and never retries", async () => {
  const f = recoveryFixture();
  const controller = new AbortController();
  f.p.when(
    (call) => call.key === "POST deployments",
    () => controller.abort("private-reason"),
  );
  await assert.rejects(f.run(controller.signal), tsRefusal);
  assert.equal(f.p.posts().length, 1);
  assert.equal(f.p.sinkWrites().length, 0);
});

test("cancellation of the constructor signal during the sink restore stops later writes", async () => {
  const controller = new AbortController();
  const f = recoveryFixture({ signal: controller.signal });
  f.p.when(
    (call) => call.key === "PATCH script-settings",
    () => controller.abort(),
  );
  await assert.rejects(f.run(), tsRefusal);
  assert.equal(f.p.writes().filter((call) => call.key === "POST subdomain").length, 0);
});

test("a non-AbortSignal operation argument is refused before any provider write", async () => {
  for (const value of [null, "signal", {}, 7]) {
    const f = recoveryFixture();
    await assert.rejects(f.run(value), tsRefusal);
    assert.equal(f.p.writes().length, 0);
  }
});

// ---- foreign inputs ----

for (const [name, over] of [
  ["identity from another run", () => ({ identity: makeIdentity("e".repeat(40)) })],
  ["missing token", () => ({ token: undefined })],
  ["empty token", () => ({ token: "" })],
  ["whitespace token", () => ({ token: "bad token" })],
  ["missing exclusion adapter", () => ({ assertExclusive: undefined })],
  ["non-function exclusion adapter", () => ({ assertExclusive: "yes" })],
  ["missing baseline adapter", () => ({ admitBaseline: undefined })],
  ["non-function fetch", () => ({ fetchImpl: null })],
  ["non-signal constructor signal", () => ({ signal: {} })],
  ["missing journal", () => ({ journal: undefined })],
  ["bad deployment id", () => ({ deploymentId: "01" })],
  [
    "production script profile",
    () => ({ profile: { ...setup().profile, scriptName: "two-web-next-production" } }),
  ],
]) {
  test(`foreign ${name} refuses before any journal or provider use`, async () => {
    const f = recoveryFixture(over());
    await assert.rejects(f.run(), tsRefusal);
    assert.equal(f.p.calls.length, 0);
    assert.equal(f.s.net.calls.length, 0);
  });
}

test("unpinned or tampered recovery components refuse before any provider use", async () => {
  const state = recoveryFixture();
  state.s.state.settingsSha256 = "e".repeat(64);
  const settings = recoveryFixture();
  settings.s.settings.settings.logpush = false;
  const serving = recoveryFixture();
  serving.s.serving.deploymentId = D2;
  const baseline = recoveryFixture();
  baseline.s.baseline.versionId = OTHER_VERSION;
  const files = recoveryFixture();
  files.s.files[0].bytes[0] ^= 1;
  const payload = recoveryFixture();
  payload.s.expectedPayload.baseline.stateSha256 = "0".repeat(64);
  for (const f of [state, settings, serving, baseline, files, payload]) {
    await assert.rejects(f.run(), tsRefusal);
    assert.equal(f.p.calls.length, 0);
    assert.equal(f.s.net.calls.length, 0);
  }
});

test("restore takes no caller-selected version, deployment or settings", async () => {
  const f = recoveryFixture();
  const api = createCandidateTrafficSettingsRecovery(f.options);
  const forged = { versionId: OTHER_VERSION, deploymentId: DX, settings: sealedState() };
  await assert.rejects(api.restore(forged), tsRefusal);
  assert.equal(f.p.writes().length, 0);
});

test("construction copies caller inputs so later mutation changes nothing", async () => {
  const f = recoveryFixture();
  const api = createCandidateTrafficSettingsRecovery(f.options);
  f.s.state.servingSha256 = "0".repeat(64);
  f.s.serving.versionId = OTHER_VERSION;
  f.s.settings.settings.logpush = false;
  f.s.baseline.versionId = OTHER_VERSION;
  f.s.profile.scriptName = "two-web-next-production";
  f.s.expectedPayload.baseline.stateSha256 = "0".repeat(64);
  const receipt = await api.restore();
  assert.equal(receipt.versionId, VERSION);
  assert.ok(f.p.calls.every((call) => call.url.startsWith(`${BASE}/`)));
});
