import assert from "node:assert/strict";
import test from "node:test";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateTrafficRestorer } from "./candidate-staging-restore-traffic.mjs";

const NOW = 1793819000;
const TOKEN = "fixture-provider-bearer";
const ERROR = { message: "Candidate recovery refused: baseline traffic" };
const BASE = `https://api.cloudflare.com/client/v4/accounts/${"1".repeat(32)}/workers/scripts/two-web-next`;
const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DB = "11111111-1111-4111-8111-111111111111";
const DC = "22222222-2222-4222-8222-222222222222";
const DR = "33333333-3333-4333-8333-333333333333";
const DX = "44444444-4444-4444-8444-444444444444";

function digest(value) {
  return candidateSha256(JSON.stringify(value));
}

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
  const snapshot = {
    schema: "two.candidate-serving.v1",
    promotable: false,
    q: identity.q,
    profileSha256: digest(profile),
    deploymentId: DB,
    versionId: B,
    historySha256: "d".repeat(64),
    observedAt: NOW - 100,
  };
  return { identity: structuredClone(identity), profile, profileSha256: digest(profile), snapshot };
}

function row(id, version, time = NOW - 10) {
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

function setup({ onGuard, onCall, reply, clock = () => NOW, signal, f = fixture() } = {}) {
  const calls = [];
  const guards = [];
  const state = { deployments: [row(DC, C), row(DB, B, NOW - 100)] };
  const snapshotSha256 = digest(f.snapshot);
  const guard = (name) => async (context, deadline) => {
    assert.ok(Object.isFrozen(context));
    assert.ok(Object.isFrozen(context.baseline));
    assert.equal(context.phase, "restore-baseline-traffic");
    assert.equal(context.q, f.snapshot.q);
    assert.equal(context.profileSha256, f.snapshot.profileSha256);
    assert.equal(context.snapshotSha256, snapshotSha256);
    assert.equal(context.baseline.versionId, B);
    assert.ok(deadline instanceof AbortSignal && !deadline.aborted);
    guards.push({ name, context, deadline, calls: calls.length });
    if (onGuard) await onGuard(name, context, deadline, calls);
  };
  const options = {
    token: TOKEN,
    identity: f.identity,
    profile: f.profile,
    profileSha256: f.profileSha256,
    assertExclusive: guard("exclusive"),
    requireDirty: guard("dirty"),
    admitBaseline: guard("baseline"),
    assertSealed: guard("sealed"),
    clock,
    signal,
    fetchImpl: async (url, request) => {
      calls.push({ url, ...request });
      if (onCall) await onCall(calls, state, request);
      let value;
      if (request.method === "POST") {
        assert.equal(url, `${BASE}/deployments`);
        state.deployments.unshift(row(DR, B, NOW));
        value = state.deployments[0];
      } else if (url === `${BASE}/deployments`) value = state;
      else value = state.deployments.find((r) => url === `${BASE}/deployments/${r.id}`);
      return reply ? reply(structuredClone(value), calls, request, state) : result(value);
    },
  };
  const api = createCandidateTrafficRestorer(options);
  return {
    f,
    api,
    state,
    calls,
    guards,
    options,
    snapshotSha256,
    restore(operationSignal) {
      return api.restore(f.snapshot, snapshotSha256, operationSignal);
    },
  };
}

function writes(s) {
  return s.calls.filter((c) => c.method !== "GET");
}

test("restores only pinned B with a fresh POST, independent exact join and list/exact/list observation", async () => {
  const s = setup();
  const receipt = await s.restore();
  assert.ok(Object.isFrozen(receipt));
  assert.deepEqual(receipt, {
    schema: "two.candidate-baseline-traffic.v1",
    promotable: false,
    recoveryScope: "serving-traffic-only",
    q: s.f.identity.q,
    profileSha256: s.f.profileSha256,
    baselineServingSha256: s.snapshotSha256,
    deploymentId: DR,
    versionId: B,
    servingSha256: receipt.servingSha256,
    changed: true,
    observedAt: NOW,
  });
  assert.match(receipt.servingSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    s.calls.map((c) => [c.method, c.url]),
    [
      ["GET", `${BASE}/deployments`],
      ["GET", `${BASE}/deployments/${DC}`],
      ["GET", `${BASE}/deployments`],
      ["POST", `${BASE}/deployments`],
      ["GET", `${BASE}/deployments/${DR}`],
      ["GET", `${BASE}/deployments`],
      ["GET", `${BASE}/deployments/${DR}`],
      ["GET", `${BASE}/deployments`],
    ],
  );
  assert.deepEqual(JSON.parse(writes(s)[0].body), {
    strategy: "percentage",
    versions: [{ version_id: B, percentage: 100 }],
  });
  for (const c of s.calls) {
    assert.equal(c.redirect, "error");
    assert.ok(c.signal instanceof AbortSignal && !c.signal.aborted);
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(c.headers["Content-Type"], c.method === "POST" ? "application/json" : undefined);
    assert.equal(c.url.includes("force"), false);
    assert.ok(s.guards.some((g) => g.calls === s.calls.indexOf(c)));
    assert.ok(s.guards.some((g) => g.calls === s.calls.indexOf(c) + 1));
  }
  for (let i = 0; i < s.guards.length; i += 4) {
    assert.deepEqual(
      s.guards.slice(i, i + 4).map((g) => g.name),
      ["exclusive", "dirty", "baseline", "sealed"],
    );
  }
  assert.equal(
    /fixture-provider|secret|settings|clean|complete|smoke|nextUpload/.test(
      JSON.stringify(receipt),
    ),
    false,
  );
});

test("retry is read-only when B already serves, but independently rechecks the deployment", async () => {
  const s = setup();
  await s.restore();
  s.calls.length = 0;
  s.guards.length = 0;
  const receipt = await s.restore();
  assert.equal(receipt.changed, false);
  assert.equal(receipt.deploymentId, DR);
  assert.equal(receipt.versionId, B);
  assert.equal(s.calls.length, 6);
  assert.equal(writes(s).length, 0);
});

test("already selected original B still emits only a traffic receipt, not latest-upload recovery", async () => {
  const s = setup();
  s.state.deployments = [row(DB, B, NOW - 100)];
  const receipt = await s.restore();
  assert.equal(receipt.changed, false);
  assert.equal(receipt.deploymentId, DB);
  assert.equal(receipt.recoveryScope, "serving-traffic-only");
  assert.equal(writes(s).length, 0);
});

for (const milliseconds of [1, 500, 999]) {
  test(`fresh deployment at +${milliseconds}ms joins POST, exact GET and serving lists`, async () => {
    const s = setup({
      reply: (v, _calls, r, state) => {
        if (r.method === "POST") {
          v.created_on = new Date(NOW * 1000 + milliseconds).toISOString();
          state.deployments[0].created_on = v.created_on;
        }
        return result(v);
      },
    });
    const receipt = await s.restore();
    assert.equal(receipt.changed, true);
    assert.equal(receipt.deploymentId, DR);
    assert.equal(receipt.versionId, B);
    assert.equal(s.calls.length, 8);
    assert.equal(writes(s).length, 1);
  });
}

for (const milliseconds of [-1, 1000]) {
  test(`fresh deployment outside the current second at ${milliseconds}ms refuses`, async () => {
    const s = setup({
      reply: (v, _calls, r, state) => {
        if (r.method === "POST") {
          v.created_on = new Date(NOW * 1000 + milliseconds).toISOString();
          state.deployments[0].created_on = v.created_on;
        }
        return result(v);
      },
    });
    await assert.rejects(s.restore(), ERROR);
    assert.equal(writes(s).length, 1);
    assert.equal(s.calls.length, 4);
  });
}

test("idempotent B observation accepts the current fractional second without writing", async () => {
  const s = setup();
  s.state.deployments = [row(DR, B, NOW)];
  s.state.deployments[0].created_on = new Date(NOW * 1000 + 500).toISOString();
  const receipt = await s.restore();
  assert.equal(receipt.deploymentId, DR);
  assert.equal(receipt.changed, false);
  assert.equal(s.calls.length, 6);
  assert.equal(writes(s).length, 0);
});

for (const name of ["exclusive", "dirty", "baseline", "sealed"]) {
  for (const when of [0, 3, 4, 8]) {
    test(`refuses ${name} guard at call ${when} without retries or dirty clearing`, async () => {
      const s = setup({
        onGuard: async (n, _c, _d, calls) => {
          if (n === name && calls.length >= when)
            throw new Error(`${TOKEN}: private adapter error`);
        },
      });
      await assert.rejects(s.restore(), ERROR);
      assert.ok(writes(s).length <= 1);
      if (when <= 3) assert.equal(writes(s).length, 0);
      assert.ok(s.calls.length <= when);
    });
  }
}

for (const [name, mutate] of [
  [
    "wrong digest",
    (s) => {
      s.snapshotSha256 = "0".repeat(64);
    },
  ],
  [
    "wrong run",
    (s) => {
      s.f.snapshot.q = "0".repeat(64);
    },
  ],
  [
    "wrong profile",
    (s) => {
      s.f.snapshot.profileSha256 = "0".repeat(64);
    },
  ],
  [
    "promotable",
    (s) => {
      s.f.snapshot.promotable = true;
    },
  ],
  [
    "candidate substituted",
    (s) => {
      s.f.snapshot.versionId = C;
    },
  ],
  [
    "production alias",
    (s) => {
      s.f.snapshot.versionId = "production";
    },
  ],
  [
    "missing snapshot",
    (s) => {
      s.f.snapshot = null;
    },
  ],
  [
    "future snapshot",
    (s) => {
      s.f.snapshot.observedAt = NOW + 1;
    },
  ],
  [
    "arbitrary force field",
    (s) => {
      s.f.snapshot.force = true;
    },
  ],
]) {
  test(`refuses ${name} baseline before network use`, async () => {
    const s = setup();
    mutate(s);
    await assert.rejects(s.api.restore(s.f.snapshot, s.snapshotSha256), ERROR);
    assert.equal(s.calls.length, 0);
  });
}

for (const [name, change] of [
  [
    "different B version",
    (v) => {
      v.versions[0].version_id = C;
    },
  ],
  [
    "split B traffic",
    (v) => {
      v.versions = [
        { version_id: B, percentage: 99 },
        { version_id: C, percentage: 1 },
      ];
    },
  ],
  [
    "old deployment id",
    (v) => {
      v.id = DB;
    },
  ],
  [
    "current deployment id",
    (v) => {
      v.id = DC;
    },
  ],
  [
    "malformed id",
    (v) => {
      v.id = "latest";
    },
  ],
  [
    "stale timestamp",
    (v) => {
      v.created_on = new Date((NOW - 1) * 1000).toISOString();
    },
  ],
  [
    "future timestamp",
    (v) => {
      v.created_on = new Date((NOW + 1) * 1000).toISOString();
    },
  ],
  [
    "missing timestamp",
    (v) => {
      delete v.created_on;
    },
  ],
  [
    "unknown field",
    (v) => {
      v.extra = true;
    },
  ],
  ["provider unsuccessful", () => {}],
]) {
  test(`refuses ${name} mutation response without claiming recovery`, async () => {
    const s = setup({
      reply: (v, _calls, r) => {
        if (r.method === "POST") {
          if (name === "provider unsuccessful")
            return new Response(JSON.stringify({ success: false, errors: [], result: v }), {
              headers: { "content-type": "application/json" },
            });
          change(v);
        }
        return result(v);
      },
    });
    await assert.rejects(s.restore(), ERROR);
    assert.equal(writes(s).length, 1);
    assert.equal(s.calls.length, 4);
  });
}

for (const [name, change] of [
  [
    "version",
    (v) => {
      v.versions[0].version_id = C;
    },
  ],
  [
    "source",
    (v) => {
      v.source = "other";
    },
  ],
  [
    "time",
    (v) => {
      v.created_on = new Date((NOW - 1) * 1000).toISOString();
    },
  ],
  [
    "id",
    (v) => {
      v.id = DX;
    },
  ],
]) {
  test(`independent exact GET refuses changed POST ${name}`, async () => {
    const s = setup({
      reply: (v, calls) => {
        if (calls.length === 5) change(v);
        return result(v);
      },
    });
    await assert.rejects(s.restore(), ERROR);
    assert.equal(writes(s).length, 1);
    assert.equal(s.calls.length, 5);
  });
}

for (const when of [6, 7, 8]) {
  for (const version of [B, C]) {
    test(`detects external replacement at read ${when}, including same-version ${version === B}`, async () => {
      const s = setup({
        onCall: async (calls, state) => {
          if (calls.length === when) state.deployments.unshift(row(DX, version, NOW));
        },
      });
      await assert.rejects(s.restore(), ERROR);
      assert.equal(writes(s).length, 1);
    });
  }
}

test("idempotent branch also detects same-version replacement", async () => {
  const s = setup({
    onCall: async (calls, state) => {
      if (calls.length === 4) state.deployments.unshift(row(DX, B, NOW));
    },
  });
  s.state.deployments = [row(DB, B, NOW - 100)];
  await assert.rejects(s.restore(), ERROR);
  assert.equal(writes(s).length, 0);
});

for (const status of [201, 302, 400, 401, 403, 409, 429, 500]) {
  test(`provider mutation status ${status} refuses once, never force-retries`, async () => {
    const s = setup({
      reply: (v, _calls, r) => result(v, { status: r.method === "POST" ? status : 200 }),
    });
    await assert.rejects(s.restore(), ERROR);
    assert.equal(writes(s).length, 1);
    assert.equal(s.calls.length, 4);
  });
}

for (const [name, response] of [
  ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
  [
    "oversized body",
    () => new Response(" ".repeat(65537), { headers: { "content-type": "application/json" } }),
  ],
  [
    "incorrect content type",
    (v) => new Response(JSON.stringify({ success: true, errors: [], result: v })),
  ],
  ["null result", () => result(null)],
  ["missing body", () => new Response(null, { headers: { "content-type": "application/json" } })],
  [
    "network error",
    () => {
      throw new Error(TOKEN);
    },
  ],
]) {
  test(`${name} mutation never returns provider text or recovery evidence`, async () => {
    const s = setup({ reply: (v, _calls, r) => (r.method === "POST" ? response(v) : result(v)) });
    await assert.rejects(s.restore(), ERROR);
    assert.equal(writes(s).length, 1);
    assert.equal(s.calls.length, 4);
  });
}

for (const kind of ["parent", "operation"]) {
  for (const when of [0, 3, 4, 8]) {
    test(`${kind} cancellation at call ${when} propagates and never retries`, async () => {
      const abort = new AbortController();
      if (when === 0) abort.abort(TOKEN);
      const s = setup({
        signal: kind === "parent" ? abort.signal : undefined,
        onCall: async (calls) => {
          if (calls.length === when) abort.abort(TOKEN);
        },
      });
      await assert.rejects(s.restore(kind === "operation" ? abort.signal : undefined), ERROR);
      assert.ok(s.calls.length <= when);
      for (const c of s.calls) assert.equal(c.signal.aborted, true);
      assert.ok(writes(s).length <= 1);
    });
  }
}

for (const value of [NaN, Infinity, -1, NOW + 0.5, "clock", null, NOW - 101]) {
  test(`invalid clock ${String(value)} refuses without network`, async () => {
    const s = setup({ clock: () => value });
    await assert.rejects(s.restore(), ERROR);
    assert.equal(s.calls.length, 0);
  });
}

test("clock regression during mutation refuses without retry", async () => {
  let now = NOW;
  const s = setup({
    clock: () => now,
    onCall: async (calls) => {
      if (calls.length === 4) now -= 1;
    },
  });
  await assert.rejects(s.restore(), ERROR);
  assert.equal(writes(s).length, 1);
});

test("caller mutation cannot change pinned B or endpoint after the first await", async () => {
  let s;
  s = setup({
    onCall: async (calls) => {
      if (calls.length === 1) {
        s.f.snapshot.versionId = C;
        s.f.profile.scriptName = "two-web-next-production";
        s.f.identity.q = "0".repeat(64);
      }
    },
  });
  assert.equal((await s.restore()).versionId, B);
  assert.ok(s.calls.every((c) => c.url.startsWith(`${BASE}/`)));
});

for (const field of [
  "assertExclusive",
  "requireDirty",
  "admitBaseline",
  "assertSealed",
  "fetchImpl",
  "clock",
]) {
  test(`missing installed ${field} adapter refuses construction`, () => {
    const s = setup();
    assert.throws(() => createCandidateTrafficRestorer({ ...s.options, [field]: null }), ERROR);
    assert.equal(s.calls.length, 0);
  });
}

test("production script and mismatched independent profile pin refuse construction", () => {
  const s = setup();
  const profile = { ...s.f.profile, scriptName: "two-web-next-production" };
  assert.throws(() =>
    createCandidateTrafficRestorer({ ...s.options, profile, profileSha256: digest(profile) }),
  );
  assert.throws(() =>
    createCandidateTrafficRestorer({ ...s.options, profileSha256: "0".repeat(64) }),
  );
  assert.equal(s.calls.length, 0);
});
