import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import {
  attestorSourceHash,
  finishAttestation,
  observeAttestationSubject,
  prepareAttestation,
} from "./candidate-staging-attestor.mjs";

// Every value below is synthetic. The record hashes are repeated characters; they
// identify nothing and authenticate nothing. The suite only checks that the module
// refuses malformed input and never claims operational admission.
const REFUSED = "Staging attestation refused";
const REPOSITORY = "TogetherWeOwn/two-web-next";
const WORKFLOW = ".github/workflows/ci.yml";
const REF = "refs/heads/feat/attestor-fixture";
const NOW = Date.parse("2030-01-01T00:00:10.000Z");
const SUBJECT = "s".repeat(40);
const ACCOUNT = "a".repeat(32);
const SUBJECT_ID = "5".repeat(32);
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/verify`;

// The module must never reach a provider on its own.
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls += 1;
  throw new Error("network is forbidden in fixtures");
};
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(fetchCalls, 0);
});

function resolution() {
  return {
    epoch: "1".repeat(64),
    from: "2030-01-01T00:00:00.000Z",
    until: "2030-01-01T00:10:00.000Z",
    entryCreatedAt: "2029-12-31T23:00:00.000Z",
    entryUpdatedAt: "2029-12-31T23:30:00.000Z",
    evidenceHash: "2".repeat(64),
    writerCoverageHash: "3".repeat(64),
    auditHash: "4".repeat(64),
    unresolvedPaths: [],
    mutations: 0,
    entryContinuous: true,
    precedenceExclusive: true,
    protectedInjection: true,
  };
}

function envelope() {
  return {
    schema: "two.staging-attestor-envelope.v1",
    invocation: {
      repositoryId: "123456",
      controlSha: "b".repeat(40),
      ref: REF,
      runId: "777",
      runAttempt: "1",
      job: "staging-principal-attest",
      closureHash: "c".repeat(64),
      useGrantHash: "d".repeat(64),
      queuedAt: "2030-01-01T00:00:05.000Z",
      expiresAt: "2030-01-01T00:01:00.000Z",
    },
    resolution: resolution(),
    audience: {
      family: "account",
      accountId: ACCOUNT,
      familyEvidenceHash: "e".repeat(64),
      readerIdentity: "6".repeat(32),
      readerGrantHash: "f".repeat(64),
    },
  };
}

function context() {
  const pin = envelope().invocation;
  return {
    repository: REPOSITORY,
    repositoryId: pin.repositoryId,
    event: "workflow_dispatch",
    ref: pin.ref,
    sha: pin.controlSha,
    workflowSha: pin.controlSha,
    workflowRef: `${REPOSITORY}/${WORKFLOW}@${pin.ref}`,
    runId: pin.runId,
    runAttempt: pin.runAttempt,
    job: pin.job,
    checkoutSha: pin.controlSha,
  };
}

function mutated(make, fn) {
  const value = make();
  fn(value);
  return value;
}

function prepare(envelopeValue = envelope(), contextValue = context(), now = NOW) {
  return prepareAttestation(JSON.stringify(envelopeValue), JSON.stringify(contextValue), now);
}

function stream(chunks, hooks = {}) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      hooks.onPull?.(controller);
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
    cancel() {
      hooks.onCancel?.();
    },
  });
}

function providerBody(overrides = {}) {
  return JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: { id: SUBJECT_ID, status: "active", ...overrides },
  });
}

function jsonResponse(text, init = {}) {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}

function transportOf(response) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, options });
    return typeof response === "function" ? response(url, options) : response;
  };
  return { calls, transport };
}

async function observe(handle, transport, extra = {}) {
  return observeAttestationSubject(handle, {
    subject: SUBJECT,
    transport,
    signal: new AbortController().signal,
    now: () => NOW + 1000,
    ...extra,
  });
}

async function observed() {
  const handle = prepare();
  const { transport } = transportOf(() => jsonResponse(providerBody()));
  const observation = await observe(handle, transport);
  return { handle, observation };
}

function assertRefused(fn) {
  return assert.rejects(Promise.resolve().then(fn), (error) => {
    assert.equal(error.message, REFUSED);
    assert.ok(!String(error.stack).includes(SUBJECT));
    return true;
  });
}

function assertThrowsRefused(fn) {
  assert.throws(fn, (error) => {
    assert.equal(error.message, REFUSED);
    return true;
  });
}

test("prepareAttestation returns a frozen structural handle that grants nothing", () => {
  const handle = prepare();
  assert.deepEqual(
    { ...handle },
    {
      scope: "structural-preflight-only",
      operationalAdmission: false,
    },
  );
  assert.ok(Object.isFrozen(handle));
  assert.equal(JSON.stringify(handle).includes("accountId"), false);
});

test("prepareAttestation refuses malformed raw inputs", () => {
  const e = JSON.stringify(envelope());
  const c = JSON.stringify(context());
  for (const bad of [undefined, null, 1, {}, [], "", "{", "null", "[]", "1", '"x"']) {
    assertThrowsRefused(() => prepareAttestation(bad, c, NOW));
    assertThrowsRefused(() => prepareAttestation(e, bad, NOW));
  }
});

test("prepareAttestation enforces the 16384 byte bound exactly", () => {
  const e = JSON.stringify(envelope());
  const c = JSON.stringify(context());
  const exact = e + " ".repeat(16_384 - Buffer.byteLength(e));
  assert.equal(Buffer.byteLength(exact), 16_384);
  assert.doesNotThrow(() => prepareAttestation(exact, c, NOW));
  assertThrowsRefused(() => prepareAttestation(`${exact} `, c, NOW));
  const cExact = c + " ".repeat(16_384 - Buffer.byteLength(c));
  assert.doesNotThrow(() => prepareAttestation(e, cExact, NOW));
  assertThrowsRefused(() => prepareAttestation(e, `${cExact} `, NOW));
});

test("prepareAttestation counts bytes, not characters", () => {
  const e = JSON.stringify(envelope());
  const c = JSON.stringify(context());
  // 9000 two-byte characters exceed the byte
  // bound while staying below the character bound.
  const wide = JSON.stringify({ pad: "é".repeat(9000) });
  assert.ok(wide.length < 16_384 && Buffer.byteLength(wide) > 16_384);
  assertThrowsRefused(() => prepareAttestation(wide, c, NOW));
  assertThrowsRefused(() => prepareAttestation(e, wide, NOW));
});

test("prepareAttestation refuses non-integer or unsafe clocks", () => {
  for (const bad of [Number.NaN, Infinity, 1.5, "1", null, 2 ** 60]) {
    assertThrowsRefused(() => prepare(envelope(), context(), bad));
  }
});

test("prepareAttestation refuses missing, extra and reshaped envelope keys", () => {
  const paths = [
    (v) => delete v.schema,
    (v) => delete v.invocation,
    (v) => delete v.resolution,
    (v) => delete v.audience,
    (v) => (v.extra = true),
    (v) => (v.schema = "two.staging-attestor-envelope.v2"),
    (v) => (v.invocation = []),
    (v) => (v.invocation = null),
    (v) => (v.resolution = "x"),
    (v) => (v.audience = [v.audience]),
    (v) => delete v.invocation.closureHash,
    (v) => (v.invocation.extra = "x"),
    (v) => delete v.audience.readerGrantHash,
    (v) => (v.audience.extra = "x"),
    (v) => delete v.resolution.auditHash,
    (v) => (v.resolution.extra = "x"),
  ];
  for (const fn of paths) assertThrowsRefused(() => prepare(mutated(envelope, fn)));
});

test("prepareAttestation refuses missing, extra and reshaped context keys", () => {
  const paths = [
    (v) => delete v.checkoutSha,
    (v) => delete v.workflowSha,
    (v) => delete v.job,
    (v) => (v.extra = "x"),
  ];
  for (const fn of paths) assertThrowsRefused(() => prepare(envelope(), mutated(context, fn)));
});

test("prepareAttestation refuses invocation field shape violations", () => {
  const bad = [
    ["repositoryId", "0"],
    ["repositoryId", "01"],
    ["repositoryId", 123456],
    ["repositoryId", "1".repeat(17)],
    ["controlSha", "B".repeat(40)],
    ["controlSha", "b".repeat(39)],
    ["controlSha", "b".repeat(64)],
    ["ref", "refs/heads/main"],
    ["ref", "refs/tags/v1"],
    ["ref", "refs/heads/"],
    ["ref", "refs/heads/a//b"],
    ["ref", "refs/heads/a b"],
    ["ref", "refs/heads/a/../b"],
    ["ref", "refs/heads/a\n"],
    ["ref", "main"],
    ["runId", "0"],
    ["runId", "-1"],
    ["runId", 777],
    ["runAttempt", "2"],
    ["runAttempt", 1],
    ["job", "other"],
    ["closureHash", "C".repeat(64)],
    ["closureHash", "c".repeat(63)],
    ["useGrantHash", "d".repeat(65)],
  ];
  for (const [key, value] of bad) {
    // Keep the context aligned so only the invocation shape is at fault.
    const env = mutated(envelope, (v) => (v.invocation[key] = value));
    const ctx = mutated(context, (v) => {
      const map = {
        repositoryId: "repositoryId",
        controlSha: "sha",
        ref: "ref",
        runId: "runId",
        runAttempt: "runAttempt",
        job: "job",
      };
      if (map[key]) v[map[key]] = value;
      if (key === "controlSha") {
        v.workflowSha = value;
        v.checkoutSha = value;
      }
      if (key === "ref") v.workflowRef = `${REPOSITORY}/${WORKFLOW}@${value}`;
    });
    assertThrowsRefused(() => prepare(env, ctx));
  }
});

test("prepareAttestation refuses run context mismatches", () => {
  const other = "9".repeat(40);
  const paths = [
    (v) => (v.repository = "TogetherWeOwn/other"),
    (v) => (v.repository = "togetherweown/two-web-next"),
    (v) => (v.repositoryId = "654321"),
    (v) => (v.event = "push"),
    (v) => (v.event = "pull_request"),
    (v) => (v.event = "pull_request_target"),
    (v) => (v.ref = "refs/heads/feat/other"),
    (v) => (v.ref = "refs/heads/main"),
    (v) => (v.sha = other),
    (v) => (v.workflowSha = other),
    (v) => (v.checkoutSha = other),
    (v) => (v.workflowRef = `${REPOSITORY}/.github/workflows/other.yml@${REF}`),
    (v) => (v.workflowRef = `${REPOSITORY}/${WORKFLOW}@refs/heads/main`),
    (v) => (v.workflowRef = `Other/two-web-next/${WORKFLOW}@${REF}`),
    (v) => (v.runId = "778"),
    (v) => (v.runAttempt = "2"),
    (v) => (v.job = "other-job"),
    (v) => (v.job = "staging-principal-attest "),
  ];
  for (const fn of paths) assertThrowsRefused(() => prepare(envelope(), mutated(context, fn)));
});

test("prepareAttestation refuses unknown families, grants and audience facts", () => {
  const paths = [
    (v) => (v.audience.family = "zone"),
    (v) => (v.audience.family = "user"),
    (v) => (v.audience.family = "Account"),
    (v) => (v.audience.family = ""),
    (v) => (v.audience.family = ["account"]),
    (v) => (v.audience.accountId = "A".repeat(32)),
    (v) => (v.audience.accountId = "a".repeat(31)),
    (v) => (v.audience.accountId = `${"a".repeat(31)}/`),
    (v) => (v.audience.familyEvidenceHash = "e".repeat(63)),
    (v) => (v.audience.readerIdentity = "6".repeat(33)),
    (v) => (v.audience.readerIdentity = 6),
    (v) => (v.audience.readerGrantHash = "F".repeat(64)),
    (v) => (v.audience.readerGrantHash = null),
  ];
  for (const fn of paths) assertThrowsRefused(() => prepare(mutated(envelope, fn)));
});

test("prepareAttestation refuses unresolved or unproven R facts", () => {
  const paths = [
    (v) => (v.resolution.unresolvedPaths = ["a"]),
    (v) => (v.resolution.unresolvedPaths = {}),
    (v) => (v.resolution.mutations = 1),
    (v) => (v.resolution.mutations = "0"),
    (v) => (v.resolution.entryContinuous = false),
    (v) => (v.resolution.entryContinuous = "true"),
    (v) => (v.resolution.precedenceExclusive = false),
    (v) => (v.resolution.protectedInjection = false),
    (v) => (v.resolution.protectedInjection = 1),
    (v) => (v.resolution.epoch = "1".repeat(63)),
    (v) => (v.resolution.evidenceHash = "G".repeat(64)),
    (v) => (v.resolution.writerCoverageHash = undefined),
    (v) => (v.resolution.auditHash = 4),
  ];
  for (const fn of paths) assertThrowsRefused(() => prepare(mutated(envelope, fn)));
});

test("prepareAttestation refuses malformed and misordered timestamps", () => {
  const set = (key, value) => (v) => (v.invocation[key] = value);
  const rset = (key, value) => (v) => (v.resolution[key] = value);
  const paths = [
    set("queuedAt", "2030-01-01T00:00:05Z"),
    set("queuedAt", "2030-01-01T00:00:05.000+00:00"),
    set("queuedAt", "2030-02-30T00:00:05.000Z"),
    set("queuedAt", "2030-01-01 00:00:05.000Z"),
    set("queuedAt", 1893456005000),
    set("expiresAt", "tomorrow"),
    set("queuedAt", "2029-12-31T23:59:59.999Z"), // before the resolution window
    set("queuedAt", "2030-01-01T00:00:10.001Z"), // after now
    set("expiresAt", "2030-01-01T00:00:10.000Z"), // already expired at now
    set("expiresAt", "2030-01-01T00:00:09.999Z"),
    set("expiresAt", "2030-01-01T00:02:05.001Z"), // lifetime above 120 s
    set("expiresAt", "2030-01-01T00:10:00.001Z"), // beyond the resolution window
    rset("until", "2030-01-01T00:00:00.000Z"), // empty window
    rset("until", "2029-12-31T00:00:00.000Z"),
    rset("from", "2030-01-01T00:00:06.000Z"), // starts after queueing
    rset("entryCreatedAt", "2029-12-31T23:40:00.000Z"), // created after updated
    rset("entryUpdatedAt", "2030-01-01T00:00:00.001Z"), // updated after from
    rset("entryUpdatedAt", "bad"),
  ];
  for (const fn of paths) {
    assertThrowsRefused(() => prepare(mutated(envelope, fn)));
  }
});

test("prepareAttestation accepts the lifetime and queue boundaries", () => {
  const edge = mutated(envelope, (v) => {
    v.invocation.queuedAt = "2030-01-01T00:00:10.000Z";
    v.invocation.expiresAt = "2030-01-01T00:02:10.000Z";
    v.resolution.from = "2030-01-01T00:00:10.000Z";
  });
  assert.doesNotThrow(() => prepare(edge));
  const over = mutated(envelope, (v) => {
    v.invocation.queuedAt = "2030-01-01T00:00:10.000Z";
    v.invocation.expiresAt = "2030-01-01T00:02:10.001Z";
    v.resolution.from = "2030-01-01T00:00:10.000Z";
  });
  assertThrowsRefused(() => prepare(over));
});

test("observeAttestationSubject performs one fixed account-only GET through the injected transport", async () => {
  const handle = prepare();
  const { calls, transport } = transportOf(() => jsonResponse(providerBody()));
  const observation = await observe(handle, transport);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  const options = calls[0].options;
  assert.equal(options.method, "GET");
  assert.deepEqual(Object.keys(options).sort(), [
    "cache",
    "credentials",
    "headers",
    "method",
    "redirect",
    "signal",
  ]);
  assert.deepEqual(options.headers, {
    authorization: `Bearer ${SUBJECT}`,
    accept: "application/json",
  });
  assert.equal(options.redirect, "manual");
  assert.equal(options.credentials, "omit");
  assert.equal(options.cache, "no-store");
  assert.ok(options.signal instanceof AbortSignal);
  assert.ok(!("body" in options));
  assert.deepEqual({ ...observation }, { id: SUBJECT_ID, status: "active" });
  assert.ok(Object.isFrozen(observation));
  assert.equal(fetchCalls, 0);
});

test("observeAttestationSubject exposes only the selected nonsecret fields", async () => {
  const handle = prepare();
  const extra = JSON.stringify({
    success: true,
    errors: [],
    messages: [{ code: 1, message: SUBJECT }],
    result: {
      id: SUBJECT_ID,
      status: "active",
      secret: "x".repeat(40),
      policies: [{ id: "p" }],
      expires_on: "2031-01-01T00:00:00Z",
    },
  });
  const { transport } = transportOf(() => jsonResponse(extra));
  const observation = await observe(handle, transport);
  assert.deepEqual(Object.keys(observation), ["id", "status"]);
  assert.ok(!JSON.stringify(observation).includes("x".repeat(40)));
  assert.ok(!JSON.stringify(observation).includes(SUBJECT));
});

test("observeAttestationSubject never calls a provider without a transport or valid input", async () => {
  const cases = [
    { subject: SUBJECT },
    { subject: SUBJECT, transport: "fetch" },
    { subject: SUBJECT, transport: null },
    { subject: SUBJECT, transport: () => jsonResponse(providerBody()), now: "now" },
  ];
  for (const extra of cases) {
    const handle = prepare();
    await assertRefused(() =>
      observeAttestationSubject(handle, {
        signal: new AbortController().signal,
        now: () => NOW + 1000,
        ...extra,
      }),
    );
  }
  const badSubjects = [
    undefined,
    null,
    5,
    "",
    "s".repeat(19),
    "s".repeat(257),
    `${"s".repeat(30)} `,
    `${"s".repeat(30)}\n`,
    `${"s".repeat(30)}.`,
    "é".repeat(30),
    `${"s".repeat(30)}\u0000`,
  ];
  for (const subject of badSubjects) {
    const handle = prepare();
    const { calls, transport } = transportOf(() => jsonResponse(providerBody()));
    await assertRefused(() => observe(handle, transport, { subject }));
    assert.equal(calls.length, 0);
  }
  for (const signal of [undefined, null, {}, { aborted: false, throwIfAborted() {} }]) {
    const handle = prepare();
    const { calls, transport } = transportOf(() => jsonResponse(providerBody()));
    await assertRefused(() => observe(handle, transport, { signal }));
    assert.equal(calls.length, 0);
  }
  await assertRefused(() => observeAttestationSubject(undefined));
  await assertRefused(() => observeAttestationSubject(prepare(), undefined));
  assert.equal(fetchCalls, 0);
});

test("observeAttestationSubject accepts the subject length boundaries", async () => {
  for (const subject of ["s".repeat(20), "S".repeat(256)]) {
    const handle = prepare();
    const { transport } = transportOf(() => jsonResponse(providerBody()));
    const observation = await observe(handle, transport, { subject });
    assert.equal(observation.id, SUBJECT_ID);
  }
});

test("a handle is single use, including after denial", async () => {
  const handle = prepare();
  const denied = transportOf(() => jsonResponse(providerBody(), { status: 403 }));
  await assertRefused(() => observe(handle, denied.transport));
  assert.equal(denied.calls.length, 1);
  const retry = transportOf(() => jsonResponse(providerBody()));
  await assertRefused(() => observe(handle, retry.transport));
  assert.equal(retry.calls.length, 0);

  const missing = prepare();
  await assertRefused(() =>
    observeAttestationSubject(missing, { subject: SUBJECT, signal: new AbortController().signal }),
  );
  const next = transportOf(() => jsonResponse(providerBody()));
  await assertRefused(() => observe(missing, next.transport));
  assert.equal(next.calls.length, 0);

  const good = prepare();
  const ok = transportOf(() => jsonResponse(providerBody()));
  await observe(good, ok.transport);
  await assertRefused(() => observe(good, ok.transport));
  assert.equal(ok.calls.length, 1);
});

test("observeAttestationSubject rejects forged and foreign handles", async () => {
  const forged = Object.freeze({ scope: "structural-preflight-only", operationalAdmission: false });
  const { calls, transport } = transportOf(() => jsonResponse(providerBody()));
  for (const handle of [forged, { ...prepare() }, Object.create(prepare()), {}, null, "handle"]) {
    await assertRefused(() => observe(handle, transport));
  }
  assert.equal(calls.length, 0);
});

test("observeAttestationSubject refuses status denials and malformed HTTP responses", async () => {
  const cases = [
    () => jsonResponse(providerBody(), { status: 201 }),
    () => jsonResponse(providerBody(), { status: 401 }),
    () => jsonResponse(providerBody(), { status: 403 }),
    () => jsonResponse(providerBody(), { status: 404 }),
    () => jsonResponse(providerBody(), { status: 429 }),
    () => jsonResponse(providerBody(), { status: 500 }),
    () => new Response(null, { status: 204, headers: { "content-type": "application/json" } }),
    () =>
      jsonResponse(providerBody(), {
        status: 302,
        headers: { "content-type": "application/json", location: "https://example.invalid/" },
      }),
    () => new Response(providerBody(), { status: 200 }),
    () => new Response(providerBody(), { status: 200, headers: { "content-type": "text/html" } }),
    () =>
      new Response(providerBody(), {
        status: 200,
        headers: { "content-type": "application/jsonp" },
      }),
    () =>
      new Response(providerBody(), {
        status: 200,
        headers: { "content-type": "text/plain; application/json" },
      }),
    () => new Response(null, { status: 200, headers: { "content-type": "application/json" } }),
    () => ({
      status: 200,
      redirected: true,
      headers: new Headers({ "content-type": "application/json" }),
      body: stream([Buffer.from(providerBody())]),
    }),
    () => ({
      status: 200,
      redirected: false,
      headers: new Headers({ "content-type": "application/json" }),
      body: {},
    }),
    () => ({
      status: 200,
      redirected: false,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
    }),
    () => undefined,
    () => null,
    () => "ok",
  ];
  for (const make of cases) {
    const handle = prepare();
    const { calls, transport } = transportOf(make);
    await assertRefused(() => observe(handle, transport));
    assert.equal(calls.length, 1);
  }
});

test("observeAttestationSubject accepts a json content type with parameters in any case", async () => {
  for (const type of [
    "application/json",
    "Application/JSON; charset=utf-8",
    "application/json ;charset=utf-8",
  ]) {
    const handle = prepare();
    const { transport } = transportOf(
      () => new Response(providerBody(), { status: 200, headers: { "content-type": type } }),
    );
    assert.equal((await observe(handle, transport)).id, SUBJECT_ID);
  }
});

test("observeAttestationSubject refuses malformed bodies", async () => {
  const bodies = [
    "",
    "not json",
    "{",
    "null",
    "[]",
    '"x"',
    JSON.stringify({}),
    JSON.stringify({ success: false, errors: [], result: { id: SUBJECT_ID, status: "active" } }),
    JSON.stringify({ success: "true", errors: [], result: { id: SUBJECT_ID, status: "active" } }),
    JSON.stringify({
      success: true,
      errors: [{ code: 1 }],
      result: { id: SUBJECT_ID, status: "active" },
    }),
    JSON.stringify({ success: true, errors: null, result: { id: SUBJECT_ID, status: "active" } }),
    JSON.stringify({ success: true, errors: [] }),
    JSON.stringify({ success: true, errors: [], result: null }),
    JSON.stringify({ success: true, errors: [], result: [] }),
    providerBody({ status: "disabled" }),
    providerBody({ status: "expired" }),
    providerBody({ status: "ACTIVE" }),
    providerBody({ status: undefined }),
    providerBody({ id: "A".repeat(32) }),
    providerBody({ id: "5".repeat(31) }),
    providerBody({ id: 5 }),
    providerBody({ id: undefined }),
  ];
  for (const text of bodies) {
    const handle = prepare();
    const { transport } = transportOf(() => jsonResponse(text));
    await assertRefused(() => observe(handle, transport));
  }
});

test("observeAttestationSubject refuses invalid UTF-8 and non-byte chunks", async () => {
  const invalid = [
    Uint8Array.from([0xff, 0xfe, 0x7b, 0x7d]),
    Uint8Array.from([0xc3, 0x28]),
    Buffer.concat([
      Buffer.from('{"success":true,"x":"'),
      Uint8Array.from([0xe2, 0x82]),
      Buffer.from('"}'),
    ]),
  ];
  for (const bytes of invalid) {
    const handle = prepare();
    const { transport } = transportOf(() => jsonResponse(bytes));
    await assertRefused(() => observe(handle, transport));
  }
  for (const chunk of ["string chunk", 7, { length: 2 }, [1, 2]]) {
    const handle = prepare();
    const { transport } = transportOf(() => ({
      status: 200,
      redirected: false,
      headers: new Headers({ "content-type": "application/json" }),
      body: stream([chunk]),
    }));
    await assertRefused(() => observe(handle, transport));
  }
});

test("observeAttestationSubject enforces the response size bound exactly and cancels the stream", async () => {
  const base = providerBody();
  const pad = (size) => `${base}${" ".repeat(size - Buffer.byteLength(base))}`;
  const okHandle = prepare();
  const exact = transportOf(() => jsonResponse(pad(16_384)));
  assert.equal((await observe(okHandle, exact.transport)).id, SUBJECT_ID);

  const handle = prepare();
  const { transport } = transportOf(() => jsonResponse(pad(16_385)));
  await assertRefused(() => observe(handle, transport));

  let cancelled = 0;
  let pulls = 0;
  const infinite = prepare();
  const endless = transportOf(() => ({
    status: 200,
    redirected: false,
    headers: new Headers({ "content-type": "application/json" }),
    body: new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4096));
      },
      cancel() {
        cancelled += 1;
      },
    }),
  }));
  await assertRefused(() => observe(infinite, endless.transport));
  assert.equal(cancelled, 1);
  assert.ok(pulls <= 8);
});

test("observeAttestationSubject refuses cancellation before the request", async () => {
  const controller = new AbortController();
  controller.abort(new Error(`aborted ${SUBJECT}`));
  const handle = prepare();
  const { calls, transport } = transportOf(() => jsonResponse(providerBody()));
  await assert.rejects(observe(handle, transport, { signal: controller.signal }), (error) => {
    assert.equal(error.message, REFUSED);
    assert.ok(!String(error.stack).includes(SUBJECT));
    return true;
  });
  assert.equal(calls.length, 0);
  await assertRefused(() => observe(handle, transport));
});

test("observeAttestationSubject refuses cancellation while the request is in flight", async () => {
  const controller = new AbortController();
  const handle = prepare();
  const { calls, transport } = transportOf(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
        queueMicrotask(() => controller.abort(new Error(SUBJECT)));
      }),
  );
  await assertRefused(() => observe(handle, transport, { signal: controller.signal }));
  assert.equal(calls.length, 1);
});

test("observeAttestationSubject refuses a response that arrives after cancellation", async () => {
  const controller = new AbortController();
  const handle = prepare();
  const { transport } = transportOf(() => {
    controller.abort();
    return jsonResponse(providerBody());
  });
  await assertRefused(() => observe(handle, transport, { signal: controller.signal }));
});

test("observeAttestationSubject cancels the body stream when aborted mid-read", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const handle = prepare();
  const { transport } = transportOf(() => ({
    status: 200,
    redirected: false,
    headers: new Headers({ "content-type": "application/json" }),
    body: stream([Buffer.from(providerBody())], {
      onPull: () => controller.abort(),
      onCancel: () => (cancelled += 1),
    }),
  }));
  await assertRefused(() => observe(handle, transport, { signal: controller.signal }));
  assert.equal(cancelled, 1);
});

test("observeAttestationSubject refuses when the clock passes expiry or runs backwards", async () => {
  const expiry = Date.parse("2030-01-01T00:01:00.000Z");
  for (const [start, jump] of [
    [NOW + 1000, expiry],
    [NOW + 1000, expiry + 1],
    [NOW + 1000, NOW - 1],
  ]) {
    let t = start;
    const handle = prepare();
    const { transport } = transportOf(() => {
      t = jump;
      return jsonResponse(providerBody());
    });
    await assertRefused(() => observe(handle, transport, { now: () => t }));
  }
  for (const t of [expiry, expiry + 1, NOW - 1, Number.NaN, 1.5]) {
    const handle = prepare();
    const { calls, transport } = transportOf(() => jsonResponse(providerBody()));
    await assertRefused(() => observe(handle, transport, { now: () => t }));
    assert.equal(calls.length, 0);
  }
});

test("observeAttestationSubject maps transport failures to a generic refusal without secrets", async () => {
  const handle = prepare();
  const { transport } = transportOf(() => {
    throw new Error(`socket failed for Bearer ${SUBJECT}`);
  });
  await assert.rejects(observe(handle, transport), (error) => {
    assert.equal(error.message, REFUSED);
    assert.equal(error.cause, undefined);
    assert.ok(!String(error.stack).includes(SUBJECT));
    return true;
  });
});

test("finishAttestation emits a receipt that denies admission, qualification and promotion", async () => {
  const { handle, observation } = await observed();
  const closing = { ...resolution(), evidenceHash: "7".repeat(64), auditHash: "8".repeat(64) };
  const receipt = finishAttestation(handle, observation, JSON.stringify(closing), NOW + 2000);
  assert.ok(Object.isFrozen(receipt));
  assert.equal(receipt.operationalAdmission, false);
  assert.equal(receipt.qualification, false);
  assert.equal(receipt.promotable, false);
  assert.equal(receipt.requiresIndependentResolutionAcceptance, true);
  assert.equal(receipt.requiresSeparateSameIdPolicy, true);
  assert.equal(receipt.schema, "two.staging-subject-observation.v1");
  assert.equal(receipt.scope, "subject-id-and-supplied-resolution-records-only");
  assert.equal(receipt.secretReference, "staging/CLOUDFLARE_API_TOKEN");
  assert.equal(receipt.repository, REPOSITORY);
  assert.equal(receipt.workflow, WORKFLOW);
  assert.equal(receipt.controlSha, "b".repeat(40));
  assert.equal(receipt.ref, REF);
  assert.equal(receipt.runId, "777");
  assert.equal(receipt.runAttempt, "1");
  assert.equal(receipt.job, "staging-principal-attest");
  assert.equal(receipt.accountId, ACCOUNT);
  assert.equal(receipt.subjectId, SUBJECT_ID);
  assert.equal(receipt.status, "active");
  assert.equal(receipt.openingEvidenceHash, "2".repeat(64));
  assert.equal(receipt.closingEvidenceHash, "7".repeat(64));
  assert.equal(receipt.closingAuditHash, "8".repeat(64));
  assert.equal(receipt.observedAt, new Date(NOW + 1000).toISOString());
  assert.equal(receipt.completedAt, new Date(NOW + 2000).toISOString());
  const text = JSON.stringify(receipt);
  assert.ok(!text.includes(SUBJECT));
  assert.ok(
    !/bearer|authorization|signal|capability|transport|readerGrantHash|readerIdentity/i.test(text),
  );
});

test("finishAttestation refuses changed-back, unresolved or malformed closing evidence", async () => {
  const bad = [
    (v) => (v.epoch = "9".repeat(64)),
    (v) => (v.from = "2030-01-01T00:00:01.000Z"),
    (v) => (v.until = "2030-01-01T00:09:00.000Z"),
    (v) => (v.entryCreatedAt = "2029-12-31T22:00:00.000Z"),
    (v) => (v.entryUpdatedAt = "2029-12-31T23:31:00.000Z"),
    (v) => (v.writerCoverageHash = "9".repeat(64)),
    (v) => (v.unresolvedPaths = ["changed"]),
    (v) => (v.mutations = 1),
    (v) => (v.entryContinuous = false),
    (v) => (v.precedenceExclusive = false),
    (v) => (v.protectedInjection = false),
    (v) => (v.evidenceHash = "short"),
    (v) => (v.auditHash = null),
    (v) => (v.extra = "x"),
    (v) => delete v.auditHash,
  ];
  for (const fn of bad) {
    const { handle, observation } = await observed();
    assertThrowsRefused(() =>
      finishAttestation(handle, observation, JSON.stringify(mutated(resolution, fn)), NOW + 2000),
    );
  }
  for (const raw of [
    undefined,
    null,
    5,
    "",
    "{",
    "null",
    "[]",
    JSON.stringify(resolution()) + " ".repeat(16_384),
  ]) {
    const { handle, observation } = await observed();
    assertThrowsRefused(() => finishAttestation(handle, observation, raw, NOW + 2000));
  }
});

test("finishAttestation refuses completion outside the reconciled window", async () => {
  const until = Date.parse("2030-01-01T00:10:00.000Z");
  for (const now of [until, until + 1, NOW + 999, Number.NaN, 1.5, "later", null]) {
    const { handle, observation } = await observed();
    assertThrowsRefused(() =>
      finishAttestation(handle, observation, JSON.stringify(resolution()), now),
    );
  }
  const { handle, observation } = await observed();
  assert.doesNotThrow(() =>
    finishAttestation(handle, observation, JSON.stringify(resolution()), NOW + 1000),
  );
  void handle;
});

test("finishAttestation rejects forged, cross-handle and replayed observations", async () => {
  const closing = JSON.stringify(resolution());
  const first = await observed();
  const second = await observed();
  const forged = Object.freeze({ id: SUBJECT_ID, status: "active" });

  assertThrowsRefused(() => finishAttestation(first.handle, forged, closing, NOW + 2000));
  assertThrowsRefused(() =>
    finishAttestation(first.handle, { ...first.observation }, closing, NOW + 2000),
  );
  assertThrowsRefused(() =>
    finishAttestation(first.handle, Object.create(first.observation), closing, NOW + 2000),
  );
  assertThrowsRefused(() =>
    finishAttestation(first.handle, second.observation, closing, NOW + 2000),
  );
  assertThrowsRefused(() =>
    finishAttestation(second.handle, first.observation, closing, NOW + 2000),
  );
  assertThrowsRefused(() => finishAttestation(forged, first.observation, closing, NOW + 2000));
  assertThrowsRefused(() =>
    finishAttestation({ ...first.handle }, first.observation, closing, NOW + 2000),
  );
  assertThrowsRefused(() => finishAttestation(undefined, undefined, closing, NOW + 2000));

  // Forged or wrong-handle attempts never consume the genuine pair.
  const receipt = finishAttestation(first.handle, first.observation, closing, NOW + 2000);
  assert.equal(receipt.subjectId, SUBJECT_ID);
  // Replay of the same observation cannot emit a second receipt.
  assertThrowsRefused(() =>
    finishAttestation(first.handle, first.observation, closing, NOW + 2000),
  );
  assertThrowsRefused(() =>
    finishAttestation(first.handle, first.observation, closing, NOW + 3000),
  );
});

test("finishAttestation refuses a handle whose observation was denied", async () => {
  const handle = prepare();
  const { transport } = transportOf(() => jsonResponse(providerBody(), { status: 403 }));
  await assertRefused(() => observe(handle, transport));
  const fake = Object.freeze({ id: SUBJECT_ID, status: "active" });
  assertThrowsRefused(() =>
    finishAttestation(handle, fake, JSON.stringify(resolution()), NOW + 2000),
  );
});

test("finishAttestation errors carry no evidence, token or raw response", async () => {
  const { handle, observation } = await observed();
  try {
    finishAttestation(
      handle,
      observation,
      JSON.stringify({ ...resolution(), mutations: SUBJECT }),
      NOW + 2000,
    );
    assert.fail("expected refusal");
  } catch (error) {
    assert.equal(error.message, REFUSED);
    assert.ok(!String(error.stack).includes(SUBJECT));
    assert.ok(!String(error.stack).includes("1".repeat(64)));
  }
});

test("a bad real closing record is terminal for the genuine observation", async () => {
  const bad = [
    { ...resolution(), mutations: 1 },
    { ...resolution(), epoch: "9".repeat(64) },
    { ...resolution(), extra: "x" },
  ];
  for (const closing of bad) {
    const { handle, observation } = await observed();
    assertThrowsRefused(() =>
      finishAttestation(handle, observation, JSON.stringify(closing), NOW + 2000),
    );
    // The genuine observation is spent; a corrected closing record cannot revive it.
    assertThrowsRefused(() =>
      finishAttestation(handle, observation, JSON.stringify(resolution()), NOW + 2000),
    );
  }
  for (const raw of ["{", undefined, "null"]) {
    const { handle, observation } = await observed();
    assertThrowsRefused(() => finishAttestation(handle, observation, raw, NOW + 2000));
    assertThrowsRefused(() =>
      finishAttestation(handle, observation, JSON.stringify(resolution()), NOW + 2000),
    );
  }
  // A completion time outside the window is also terminal.
  const late = await observed();
  assertThrowsRefused(() =>
    finishAttestation(late.handle, late.observation, JSON.stringify(resolution()), NOW + 999),
  );
  assertThrowsRefused(() =>
    finishAttestation(late.handle, late.observation, JSON.stringify(resolution()), NOW + 2000),
  );
});

test("equal opening and closing audit or evidence hashes are not a defect", async () => {
  const { handle, observation } = await observed();
  const receipt = finishAttestation(handle, observation, JSON.stringify(resolution()), NOW + 2000);
  assert.equal(receipt.openingEvidenceHash, receipt.closingEvidenceHash);
  assert.equal(receipt.closingAuditHash, "4".repeat(64));
  // Equality proves nothing about provenance or freshness.
  assert.equal(receipt.operationalAdmission, false);
  assert.equal(receipt.qualification, false);
});

test("prepareAttestation refuses non-string values that coerce to valid strings", () => {
  const hash = (c) => [c.repeat(64)];
  const envelopePaths = [
    (v) => (v.invocation.repositoryId = ["123456"]),
    (v) => (v.invocation.controlSha = ["b".repeat(40)]),
    (v) => (v.invocation.runId = ["777"]),
    (v) => (v.invocation.closureHash = hash("c")),
    (v) => (v.invocation.useGrantHash = hash("d")),
    (v) => (v.invocation.ref = [REF]),
    (v) => (v.invocation.queuedAt = ["2030-01-01T00:00:05.000Z"]),
    (v) => (v.invocation.expiresAt = ["2030-01-01T00:01:00.000Z"]),
    (v) => (v.audience.accountId = [ACCOUNT]),
    (v) => (v.audience.familyEvidenceHash = hash("e")),
    (v) => (v.audience.readerIdentity = ["6".repeat(32)]),
    (v) => (v.audience.readerGrantHash = hash("f")),
    (v) => (v.audience.family = ["account"]),
    (v) => (v.resolution.epoch = hash("1")),
    (v) => (v.resolution.evidenceHash = hash("2")),
    (v) => (v.resolution.writerCoverageHash = hash("3")),
    (v) => (v.resolution.auditHash = hash("4")),
    (v) => (v.resolution.from = ["2030-01-01T00:00:00.000Z"]),
  ];
  for (const fn of envelopePaths) {
    // Align the context so only the envelope field type is at fault.
    const env = mutated(envelope, fn);
    const ctx = context();
    assertThrowsRefused(() => prepare(env, ctx));
  }
  const contextPaths = [
    (v) => (v.repositoryId = ["123456"]),
    (v) => (v.sha = ["b".repeat(40)]),
    (v) => (v.runId = ["777"]),
    (v) => (v.ref = [REF]),
    (v) => (v.repository = [REPOSITORY]),
  ];
  for (const fn of contextPaths)
    assertThrowsRefused(() => prepare(envelope(), mutated(context, fn)));
});

test("finishAttestation refuses non-string closing fields that coerce to valid strings", async () => {
  const wrap = (key) => (v) => (v[key] = [v[key]]);
  for (const key of [
    "epoch",
    "evidenceHash",
    "writerCoverageHash",
    "auditHash",
    "from",
    "until",
    "entryCreatedAt",
    "entryUpdatedAt",
  ]) {
    const { handle, observation } = await observed();
    assertThrowsRefused(() =>
      finishAttestation(
        handle,
        observation,
        JSON.stringify(mutated(resolution, wrap(key))),
        NOW + 2000,
      ),
    );
  }
});

test("observeAttestationSubject refuses an array that coerces to a valid subject id", async () => {
  for (const id of [[SUBJECT_ID], { toString: () => SUBJECT_ID }]) {
    const handle = prepare();
    const { transport } = transportOf(() =>
      jsonResponse(JSON.stringify({ success: true, errors: [], result: { id, status: "active" } })),
    );
    await assertRefused(() => observe(handle, transport));
  }
});

test("observeAttestationSubject refuses a subject that appears in the serialized envelope", async () => {
  const candidates = [
    "a".repeat(32), // account id
    "6".repeat(32), // reader identity
    "c".repeat(64), // closure hash
    "staging-principal-attest", // job name
    "b".repeat(40), // control sha
    "e".repeat(20), // slice of a hash
  ];
  for (const subject of candidates) {
    const handle = prepare();
    const { calls, transport } = transportOf(() => jsonResponse(providerBody()));
    await assertRefused(() => observe(handle, transport, { subject }));
    assert.equal(calls.length, 0);
  }
});

test("observeAttestationSubject refuses a returned id equal to the subject", async () => {
  const subject = "9".repeat(32);
  const handle = prepare();
  const { calls, transport } = transportOf(() => jsonResponse(providerBody({ id: subject })));
  await assertRefused(() => observe(handle, transport, { subject }));
  assert.equal(calls.length, 1);
  // The same subject with a distinct returned id is accepted.
  const next = prepare();
  const ok = transportOf(() => jsonResponse(providerBody()));
  assert.equal((await observe(next, ok.transport, { subject })).id, SUBJECT_ID);
});

test("observeAttestationSubject re-checks liveness after the final read", async () => {
  const expiry = Date.parse("2030-01-01T00:01:00.000Z");
  let total = 0;
  {
    const handle = prepare();
    const { transport } = transportOf(() => jsonResponse(providerBody()));
    await observe(handle, transport, {
      now: () => {
        total += 1;
        return NOW + 1000;
      },
    });
  }
  assert.ok(total >= 3);
  // Expiring on any single clock read, including the last one, must refuse.
  for (let n = 1; n <= total; n += 1) {
    let calls = 0;
    const handle = prepare();
    const { transport } = transportOf(() => jsonResponse(providerBody()));
    await assertRefused(() =>
      observe(handle, transport, {
        now: () => {
          calls += 1;
          return calls === n ? expiry : NOW + 1000;
        },
      }),
    );
  }
});

const NEVER = () => new Promise(() => {});
const JSON_HEADERS = () => new Headers({ "content-type": "application/json" });

test("observeAttestationSubject refuses when a transport that ignores the signal never settles", {
  timeout: 2000,
}, async () => {
  const controller = new AbortController();
  const handle = prepare();
  let entered = 0;
  const { transport } = transportOf(() => {
    entered += 1;
    queueMicrotask(() => controller.abort(new Error(SUBJECT)));
    return NEVER();
  });
  await assertRefused(() => observe(handle, transport, { signal: controller.signal }));
  assert.equal(entered, 1);
});

test("observeAttestationSubject refuses when abort lands while reader.read is pending", {
  timeout: 2000,
}, async () => {
  const controller = new AbortController();
  const handle = prepare();
  let cancelled = 0;
  let reading = 0;
  const { transport } = transportOf(() => ({
    status: 200,
    redirected: false,
    headers: JSON_HEADERS(),
    // highWaterMark 0 means pull runs only once reader.read is awaiting.
    body: new ReadableStream(
      {
        pull() {
          reading += 1;
          queueMicrotask(() => controller.abort(new Error(SUBJECT)));
          return NEVER();
        },
        cancel() {
          cancelled += 1;
        },
      },
      { highWaterMark: 0 },
    ),
  }));
  await assertRefused(() => observe(handle, transport, { signal: controller.signal }));
  assert.equal(reading, 1);
  assert.equal(cancelled, 1);
});

test("observeAttestationSubject refuses when stream cancel never settles after abort", {
  timeout: 2000,
}, async () => {
  const controller = new AbortController();
  const handle = prepare();
  let cancelEntered = 0;
  const { transport } = transportOf(() => ({
    status: 200,
    redirected: false,
    headers: JSON_HEADERS(),
    // An oversize chunk forces cleanup while the stream is still open.
    body: new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(20_000));
      },
      cancel() {
        cancelEntered += 1;
        queueMicrotask(() => controller.abort(new Error(SUBJECT)));
        return NEVER();
      },
    }),
  }));
  await assertRefused(() => observe(handle, transport, { signal: controller.signal }));
  assert.equal(cancelEntered, 1);
});

test("observeAttestationSubject refuses when reader.cancel hangs at the end of a finished read", {
  timeout: 2000,
}, async () => {
  const controller = new AbortController();
  const handle = prepare();
  let cancelEntered = 0;
  const { transport } = transportOf(() => ({
    status: 200,
    redirected: false,
    headers: JSON_HEADERS(),
    body: {
      getReader: () => ({
        read: async () => ({ done: true }),
        cancel() {
          cancelEntered += 1;
          queueMicrotask(() => controller.abort(new Error(SUBJECT)));
          return NEVER();
        },
        releaseLock() {},
      }),
    },
  }));
  await assertRefused(() => observe(handle, transport, { signal: controller.signal }));
  assert.equal(cancelEntered, 1);
});

test("observeAttestationSubject refuses when body cancel hangs on a denied response", {
  timeout: 2000,
}, async () => {
  const controller = new AbortController();
  const handle = prepare();
  let cancelEntered = 0;
  const { transport } = transportOf(() => ({
    status: 500,
    redirected: false,
    headers: JSON_HEADERS(),
    body: {
      getReader: () => {
        throw new Error("must not read a denied response");
      },
      cancel() {
        cancelEntered += 1;
        queueMicrotask(() => controller.abort(new Error(SUBJECT)));
        return NEVER();
      },
    },
  }));
  await assertRefused(() => observe(handle, transport, { signal: controller.signal }));
  assert.equal(cancelEntered, 1);
});

test("attestorSourceHash hashes bounded byte arrays only", () => {
  assert.equal(attestorSourceHash(new Uint8Array()), createHash("sha256").update("").digest("hex"));
  assert.equal(
    attestorSourceHash(new Uint8Array()),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  const bytes = Buffer.from("fixture source");
  assert.equal(attestorSourceHash(bytes), createHash("sha256").update(bytes).digest("hex"));
  assert.match(attestorSourceHash(bytes), /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => attestorSourceHash(new Uint8Array(200_000)));
  for (const bad of [
    new Uint8Array(200_001),
    "text",
    null,
    undefined,
    5,
    [1, 2],
    {},
    new ArrayBuffer(4),
    new DataView(new ArrayBuffer(4)),
  ]) {
    assert.throws(
      () => attestorSourceHash(bad),
      (error) => error.message === REFUSED,
    );
  }
});
