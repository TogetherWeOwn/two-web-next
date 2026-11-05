import assert from "node:assert/strict";
import test from "node:test";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateServingReader } from "./candidate-staging-serving.mjs";
import { createCandidateSettingsLifecycle } from "./candidate-staging-settings-lifecycle.mjs";

const NOW = 1793819000;
const TOKEN = "fixture-provider-bearer";
const ERROR = { message: "Candidate serving refused: observation" };
const BASE = `https://api.cloudflare.com/client/v4/accounts/${"1".repeat(32)}/workers/scripts/two-web-next`;
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const V1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const V2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function fixture() {
  const identity = candidateIdentity(
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
  const profile = {
    schema: "two.candidate-upload-profile.v1",
    accountId: "1".repeat(32),
    scriptName: "two-web-next",
    bindings: [{ name: "DB", type: "hyperdrive", id: "2".repeat(32) }],
  };
  return {
    identity: structuredClone(identity),
    profile,
    profileSha256: candidateSha256(JSON.stringify(profile)),
  };
}

function row(id = D1, version = V1, time = NOW - 100) {
  return {
    id,
    created_on: new Date(time * 1000).toISOString(),
    source: "api",
    strategy: "percentage",
    versions: [{ version_id: version, percentage: 100 }],
  };
}

function result(value, init = {}) {
  return new Response(JSON.stringify({ success: true, errors: [], result: value }), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function setup({ f = fixture(), onCall, onGuard, reply, clock = () => NOW, signal } = {}) {
  const calls = [];
  const guards = [];
  const state = { deployments: [row()] };
  let bound;
  const guard = (name) => async (context, deadline) => {
    guards.push({ name, context, deadline, calls: calls.length });
    assert.ok(Object.isFrozen(context));
    assert.ok(deadline instanceof AbortSignal);
    assert.equal(context.q, f.identity.q);
    assert.equal(context.profileSha256, f.profileSha256);
    if (name === "dirty") assert.equal(context.snapshotSha256, bound);
    if (onGuard) await onGuard(name, context, calls.length);
  };
  const options = {
    ...f,
    token: TOKEN,
    signal,
    clock,
    assertExclusive: guard("exclusive"),
    requireDirty: guard("dirty"),
    fetchImpl: async (url, request) => {
      calls.push({ url, ...request });
      if (onCall) await onCall(calls.length, state, request);
      assert.ok(url === `${BASE}/deployments` || url.startsWith(`${BASE}/deployments/`));
      const value =
        url === `${BASE}/deployments` ? state : state.deployments.find((r) => url.endsWith(r.id));
      return reply ? reply(structuredClone(value), calls.length) : result(value);
    },
  };
  const api = createCandidateServingReader(options);
  return {
    f,
    api,
    calls,
    guards,
    state,
    options,
    bind(value) {
      bound = value;
    },
    async capture() {
      const c = await api.capture();
      bound = c.snapshotSha256;
      return c;
    },
  };
}

function deepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) deepFrozen(child);
}

test("capture joins list/exact/list without selecting traffic or exposing provider text", async () => {
  const s = setup();
  s.state.deployments[0].author_email = "fixture@example.invalid";
  s.state.deployments[0].annotations = { "workers/message": "untrusted provider text" };
  const c = await s.capture();
  deepFrozen(c);
  assert.equal(c.snapshot.schema, "two.candidate-serving.v1");
  assert.equal(c.snapshot.promotable, false);
  assert.equal(c.snapshot.q, s.f.identity.q);
  assert.equal(c.snapshot.profileSha256, s.f.profileSha256);
  assert.equal(c.snapshot.deploymentId, D1);
  assert.equal(c.snapshot.versionId, V1);
  assert.equal(c.snapshot.observedAt, NOW);
  assert.equal(c.snapshotSha256, candidateSha256(JSON.stringify(c.snapshot)));
  assert.equal(/example|untrusted|source|author|annotations/.test(JSON.stringify(c)), false);
  assert.deepEqual(
    s.calls.map((c) => c.url),
    [`${BASE}/deployments`, `${BASE}/deployments/${D1}`, `${BASE}/deployments`],
  );
  for (const c of s.calls) {
    assert.equal(c.method, "GET");
    assert.equal(c.body, undefined);
    assert.equal(c.redirect, "error");
    assert.deepEqual(c.headers, { Authorization: `Bearer ${TOKEN}` });
    assert.ok(c.signal instanceof AbortSignal && !c.signal.aborted);
  }
  assert.equal(s.guards.length, 7);
  assert.ok(s.guards.every((g) => g.name === "exclusive"));
});

test("unchanged observation validates dirty ownership before and after each request", async () => {
  const s = setup();
  const c = await s.capture();
  s.guards.length = 0;
  const again = await s.api.assertUnchanged(c.snapshot, c.snapshotSha256);
  assert.deepEqual(again, c);
  assert.deepEqual(
    s.guards.map((g) => g.name),
    Array(7).fill(["exclusive", "dirty"]).flat(),
  );
});

test("same version redeployed under another deployment ID is not unchanged", async () => {
  const s = setup();
  const c = await s.capture();
  s.state.deployments.unshift(row(D2, V1, NOW - 10));
  await assert.rejects(s.api.assertUnchanged(c.snapshot, c.snapshotSha256), ERROR);
});

test("recovered serving admits only the baseline version and controller-pinned restore deployment", async () => {
  const s = setup();
  const c = await s.capture();
  s.state.deployments.unshift(row(D2, V1, NOW - 10));
  const restored = await s.api.assertRestored(c.snapshot, c.snapshotSha256, D2);
  assert.equal(restored.snapshot.deploymentId, D2);
  assert.equal(restored.snapshot.versionId, V1);
  assert.notEqual(restored.snapshot.historySha256, c.snapshot.historySha256);
  assert.ok(s.guards.some((g) => g.name === "dirty" && g.context.restoreDeploymentId === D2));
  await assert.rejects(s.api.assertRestored(c.snapshot, c.snapshotSha256, D1), ERROR);
  s.state.deployments[0].versions[0].version_id = V2;
  await assert.rejects(s.api.assertRestored(c.snapshot, c.snapshotSha256, D2), ERROR);
});

test("older split traffic is canonicalized without treating it as the current serving selection", async () => {
  const s = setup();
  const previous = row(D2, V2, NOW - 200);
  previous.versions = [
    { version_id: V2, percentage: 50 },
    { version_id: V1, percentage: 50 },
  ];
  s.state.deployments.push(previous);
  const c = await s.capture();
  previous.versions.reverse();
  assert.deepEqual(await s.api.assertUnchanged(c.snapshot, c.snapshotSha256), c);
});

for (const created_on of [
  new Date((NOW - 100) * 1000).toISOString(),
  new Date((NOW - 100) * 1000).toISOString().replace(".000", ""),
]) {
  test(`accepts canonical provider UTC timestamp ${created_on}`, async () => {
    const s = setup();
    s.state.deployments[0].created_on = created_on;
    assert.equal((await s.capture()).snapshot.versionId, V1);
  });
}

for (const [name, change] of [
  [
    "empty",
    (s) => {
      s.deployments = [];
    },
  ],
  [
    "missing deployments",
    (s) => {
      delete s.deployments;
    },
  ],
  [
    "unknown list field",
    (s) => {
      s.extra = true;
    },
  ],
  [
    "duplicate deployment",
    (s) => {
      s.deployments.push(row());
    },
  ],
  [
    "not newest first",
    (s) => {
      s.deployments.push(row(D2, V2, NOW - 10));
    },
  ],
  [
    "unbounded history",
    (s) => {
      s.deployments = Array(101).fill(row());
    },
  ],
  [
    "split active traffic",
    (s) => {
      s.deployments[0].versions = [
        { version_id: V1, percentage: 99 },
        { version_id: V2, percentage: 1 },
      ];
    },
  ],
  [
    "zero-weight extra active version",
    (s) => {
      s.deployments[0].versions.push({ version_id: V2, percentage: 0 });
    },
  ],
]) {
  test(`refuses ${name}`, async () => {
    const s = setup();
    change(s.state);
    await assert.rejects(s.capture(), ERROR);
    assert.equal(s.calls.length, 1);
  });
}

for (const [field, values] of [
  [
    "id",
    [undefined, null, "latest", "abc", D1.toUpperCase().replace("1", "A"), `${D1}/content`, 12],
  ],
  [
    "created_on",
    [
      null,
      "yesterday",
      "2026-02-30T00:00:00.000Z",
      "2026-11-04T12:00:00+00:00",
      new Date((NOW + 1) * 1000).toISOString(),
    ],
  ],
  ["source", [null, "", "x".repeat(129), "api\n"]],
  ["strategy", [null, "random", "Percentage"]],
  [
    "versions",
    [null, [], [null], [row().versions[0], row().versions[0]], Array(3).fill(row().versions[0])],
  ],
  ["annotations", [null, [], { unknown: "x" }, { "workers/message": "\n" }]],
  ["author_email", [null, 1, "x".repeat(321), "a\nb"]],
]) {
  for (const [index, value] of values.entries()) {
    test(`refuses malformed deployment ${field} case ${index}`, async () => {
      const s = setup();
      s.state.deployments[0][field] = value;
      await assert.rejects(s.capture(), ERROR);
    });
  }
}

for (const [name, change] of [
  [
    "missing percentage",
    (v) => {
      delete v.percentage;
    },
  ],
  [
    "string percentage",
    (v) => {
      v.percentage = "100";
    },
  ],
  [
    "negative percentage",
    (v) => {
      v.percentage = -1;
    },
  ],
  [
    "non-finite percentage",
    (v) => {
      v.percentage = Infinity;
    },
  ],
  [
    "percentage overflow",
    (v) => {
      v.percentage = 101;
    },
  ],
  [
    "percentage total",
    (v) => {
      v.percentage = 99;
    },
  ],
  [
    "version alias",
    (v) => {
      v.version_id = "latest";
    },
  ],
  [
    "missing version",
    (v) => {
      delete v.version_id;
    },
  ],
  [
    "unexpected version property",
    (v) => {
      v.extra = true;
    },
  ],
]) {
  test(`refuses ${name}`, async () => {
    const s = setup();
    change(s.state.deployments[0].versions[0]);
    await assert.rejects(s.capture(), ERROR);
  });
}

for (const step of [2, 3]) {
  test(`replacement during request ${step} refuses even if replacement serves same version`, async () => {
    const s = setup({
      onCall(n, state) {
        if (n === step) state.deployments.unshift(row(D2, V1, NOW - 10));
      },
    });
    await assert.rejects(s.capture(), ERROR);
  });
}

test("exact deployment GET cannot relabel a different version under the list's ID", async () => {
  const s = setup({
    reply(value, n) {
      if (n === 2) value.versions[0].version_id = V2;
      return result(value);
    },
  });
  await assert.rejects(s.capture(), ERROR);
  assert.equal(s.calls.length, 2);
});

test("same active deployment with changed retained history refuses as drift", async () => {
  const s = setup();
  const c = await s.capture();
  s.state.deployments.push(row(D2, V2, NOW - 200));
  await assert.rejects(s.api.assertUnchanged(c.snapshot, c.snapshotSha256), ERROR);
});

for (const [field, value] of [
  ["schema", "two.production.v1"],
  ["promotable", true],
  ["q", "0".repeat(64)],
  ["profileSha256", "0".repeat(64)],
  ["deploymentId", D2],
  ["versionId", V2],
  ["historySha256", "0".repeat(64)],
  ["observedAt", NOW + 1],
  ["extra", true],
]) {
  test(`snapshot ${field} substitution refuses before requests`, async () => {
    const s = setup();
    const c = await s.capture();
    const forged = { ...c.snapshot, [field]: value };
    await assert.rejects(s.api.assertUnchanged(forged, c.snapshotSha256), ERROR);
    assert.equal(s.calls.length, 3);
  });
}

for (const bad of [null, "", "0".repeat(64), "A".repeat(64)]) {
  test(`snapshot digest ${JSON.stringify(bad)} is independently pinned`, async () => {
    const s = setup();
    const c = await s.capture();
    await assert.rejects(s.api.assertUnchanged(c.snapshot, bad), ERROR);
    assert.equal(s.calls.length, 3);
  });
}

for (const bad of [undefined, null, "latest", `${D2}/x`, V1.toUpperCase()]) {
  test(`restore deployment pin ${JSON.stringify(bad)} refuses before requests`, async () => {
    const s = setup();
    const c = await s.capture();
    await assert.rejects(s.api.assertRestored(c.snapshot, c.snapshotSha256, bad), ERROR);
    assert.equal(s.calls.length, 3);
  });
}

for (const name of ["exclusive", "dirty"]) {
  for (const at of [0, 1, 2, 3]) {
    test(`lost ${name} at request boundary ${at} prevents acceptance`, async () => {
      let fail = false;
      const s = setup({
        onGuard(n, _context, calls) {
          if (fail && n === name && calls === at + 3) throw new Error(TOKEN);
        },
      });
      const c = await s.capture();
      fail = true;
      await assert.rejects(s.api.assertUnchanged(c.snapshot, c.snapshotSha256), ERROR);
      assert.equal(s.calls.length, at + 3);
    });
  }
}

for (const at of [0, 1, 2, 3]) {
  test(`parent cancellation at request boundary ${at} prevents further requests`, async () => {
    const controller = new AbortController();
    const s = setup({
      signal: controller.signal,
      onCall(n) {
        if (n === at) controller.abort(TOKEN);
      },
    });
    if (at === 0) controller.abort(TOKEN);
    await assert.rejects(s.capture(), ERROR);
    assert.equal(s.calls.length, at);
  });
}

for (const clock of [
  () => NaN,
  () => -1,
  () => 1.1,
  (() => {
    let n = NOW + 100;
    return () => n--;
  })(),
]) {
  test("invalid or reversing clock refuses", async () => {
    const s = setup({ clock });
    await assert.rejects(s.capture(), ERROR);
    assert.equal(s.calls.length, 0);
  });
}

for (const [name, reply] of [
  ["status", (v) => result(v, { status: 403 })],
  [
    "redirect",
    (v) => {
      const r = result(v);
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
  ],
  [
    "response URL",
    (v) => {
      const r = result(v);
      Object.defineProperty(r, "url", { value: "https://example.invalid" });
      return r;
    },
  ],
  ["media type", (v) => result(v, { headers: { "content-type": "text/plain" } })],
  [
    "content length",
    (v) =>
      result(v, { headers: { "content-type": "application/json", "content-length": "65537" } }),
  ],
  [
    "body size",
    () => new Response(" ".repeat(65537), { headers: { "content-type": "application/json" } }),
  ],
  ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
  [
    "invalid UTF8",
    () => new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
  ],
  ["no body", () => new Response(null, { headers: { "content-type": "application/json" } })],
  [
    "failed envelope",
    (v) => {
      const r = { success: false, errors: [], result: v };
      return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
    },
  ],
  [
    "provider errors",
    (v) => {
      const r = { success: true, errors: [{ message: TOKEN }], result: v };
      return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
    },
  ],
  [
    "fetch rejection",
    () => {
      throw new Error(TOKEN);
    },
  ],
]) {
  test(`untrusted HTTP ${name} refuses without retry or secret-bearing errors`, async () => {
    const s = setup({ reply });
    await assert.rejects(s.capture(), ERROR);
    assert.equal(s.calls.length, 1);
  });
}

for (const [name, change] of [
  [
    "production script",
    (o) => {
      o.profile.scriptName = "two-web";
      o.profileSha256 = candidateSha256(JSON.stringify(o.profile));
    },
  ],
  [
    "profile pin",
    (o) => {
      o.profileSha256 = "0".repeat(64);
    },
  ],
  [
    "identity",
    (o) => {
      o.identity.q = "0".repeat(64);
    },
  ],
  [
    "bearer whitespace",
    (o) => {
      o.token = "x y";
    },
  ],
  [
    "missing exclusion",
    (o) => {
      delete o.assertExclusive;
    },
  ],
  [
    "missing dirty ownership",
    (o) => {
      delete o.requireDirty;
    },
  ],
  [
    "invalid signal",
    (o) => {
      o.signal = {};
    },
  ],
]) {
  test(`constructor refuses ${name}`, () => {
    const s = setup();
    const options = { ...s.options, ...structuredClone(s.f) };
    change(options);
    assert.throws(() => createCandidateServingReader(options));
    assert.equal(s.calls.length, 0);
  });
}

for (const method of ["capture", "unchanged", "restored"]) {
  for (const at of [0, 1, 2, 3]) {
    test(`${method} propagates the enclosing operation cancellation at boundary ${at}`, async () => {
      const controller = new AbortController();
      let start = Infinity;
      const s = setup({
        onCall(n, _state, request) {
          if (n === start + at) {
            controller.abort(TOKEN);
            assert.equal(request.signal.aborted, true);
          }
        },
      });
      const c = await s.capture();
      start = s.calls.length;
      if (at === 0) controller.abort(TOKEN);
      const operation =
        method === "capture"
          ? s.api.capture(controller.signal)
          : method === "unchanged"
            ? s.api.assertUnchanged(c.snapshot, c.snapshotSha256, controller.signal)
            : s.api.assertRestored(c.snapshot, c.snapshotSha256, D1, controller.signal);
      await assert.rejects(operation, ERROR);
      assert.equal(s.calls.length, start + at);
    });
  }
}

test("operation signals are validated before any provider request", async () => {
  const s = setup();
  const c = await s.capture();
  await assert.rejects(s.api.capture({}), ERROR);
  await assert.rejects(s.api.assertUnchanged(c.snapshot, c.snapshotSha256, {}), ERROR);
  await assert.rejects(s.api.assertRestored(c.snapshot, c.snapshotSha256, D1, {}), ERROR);
  assert.equal(s.calls.length, 3);
});

test("profile and identity mutations after construction cannot redirect the reader", async () => {
  const s = setup();
  const f = fixture();
  const q = f.identity.q;
  const assertExclusive = async () => {};
  const isolated = createCandidateServingReader({ ...s.options, ...f, assertExclusive });
  f.profile.accountId = "3".repeat(32);
  f.profile.scriptName = "two-web";
  f.identity.q = "0".repeat(64);
  assert.equal((await isolated.capture()).snapshot.q, q);
  assert.ok(s.calls.every((c) => c.url.startsWith(`${BASE}/`)));
});

test("settings restore invokes independent serving reader before enabling any sink", async () => {
  const s = setup();
  const b = await s.capture();
  let writes = 0;
  const settings = {
    logpush: true,
    tags: [],
    tail_consumers: [{ service: "two-web-next-alerts" }],
    observability: {
      enabled: true,
      head_sampling_rate: 1,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        invocation_logs: true,
        persist: true,
        destinations: [],
      },
    },
  };
  const state = { settings, subdomain: { enabled: true, previews_enabled: true } };
  const lifecycle = createCandidateSettingsLifecycle({
    ...s.f,
    token: TOKEN,
    clock: () => NOW,
    assertExclusive: async () => {},
    requireDirty: async () => {},
    assertBaselineServing: async (_context, signal) => {
      assert.equal(signal.aborted, false);
      await s.api.assertRestored(b.snapshot, b.snapshotSha256, D2, signal);
    },
    fetchImpl: async (url, request) => {
      const key = url.endsWith("script-settings") ? "settings" : "subdomain";
      if (request.method !== "GET") {
        writes++;
        state[key] = JSON.parse(request.body);
      }
      return result(state[key]);
    },
  });
  const captured = await lifecycle.snapshot();
  await lifecycle.seal(captured.snapshot, captured.snapshotSha256);
  assert.equal(writes, 2);
  assert.deepEqual(state.settings.tail_consumers, []);
  s.state.deployments.unshift(row(D2, V2, NOW - 10));
  await assert.rejects(lifecycle.restore(captured.snapshot, captured.snapshotSha256), {
    message: "Candidate settings refused: lifecycle",
  });
  assert.equal(writes, 2);
  assert.deepEqual(state.settings.tail_consumers, []);
  s.state.deployments[0].versions[0].version_id = V1;
  await lifecycle.restore(captured.snapshot, captured.snapshotSha256);
  assert.equal(writes, 4);
  assert.deepEqual(state.settings.tail_consumers, [{ service: "two-web-next-alerts" }]);
});
