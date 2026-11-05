import assert from "node:assert/strict";
import test from "node:test";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateSettingsLifecycle } from "./candidate-staging-settings-lifecycle.mjs";

const NOW = 1793819000;
const TOKEN = "fixture-provider-bearer";
const ERROR = { message: "Candidate settings refused: lifecycle" };
const BASE = `https://api.cloudflare.com/client/v4/accounts/${"1".repeat(32)}/workers/scripts/two-web-next`;

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

function settings() {
  return {
    logpush: true,
    tags: [],
    tail_consumers: [],
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
  };
}

function result(value, init = {}) {
  return new Response(JSON.stringify({ success: true, errors: [], result: value }), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function setup({
  f = fixture(),
  onCall,
  onGuard,
  reply,
  clock = () => NOW,
  signal,
  baselineSettings = settings(),
} = {}) {
  const calls = [];
  const guards = [];
  const state = {
    settings: baselineSettings,
    subdomain: { enabled: true, previews_enabled: true },
  };
  let bound;
  let serving = true;
  const guard = (name) => async (context, deadline) => {
    guards.push({ name, context, deadline, calls: calls.length });
    assert.ok(Object.isFrozen(context));
    assert.ok(deadline instanceof AbortSignal);
    assert.equal(context.q, f.identity.q);
    assert.equal(context.profileSha256, f.profileSha256);
    if (name === "dirty") {
      assert.equal(context.snapshotSha256, bound);
      assert.notEqual(bound, undefined);
    }
    if (name === "serving") assert.equal(serving, true);
    if (onGuard) await onGuard(name, context, guards.length);
  };
  const api = createCandidateSettingsLifecycle({
    ...f,
    token: TOKEN,
    signal,
    clock,
    assertExclusive: guard("exclusive"),
    requireDirty: guard("dirty"),
    assertBaselineServing: guard("serving"),
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (onCall) await onCall(calls.length, state, options, f);
      const key = url.endsWith("/script-settings") ? "settings" : "subdomain";
      if (options.method !== "GET") state[key] = JSON.parse(options.body);
      return reply ? reply(structuredClone(state[key]), calls.length, options) : result(state[key]);
    },
  });
  return {
    f,
    api,
    calls,
    guards,
    state,
    setServing(value) {
      serving = value;
    },
    bind(value) {
      bound = value;
    },
    async capture() {
      const captured = await api.snapshot();
      bound = captured.snapshotSha256;
      return captured;
    },
  };
}

function deepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) deepFrozen(child);
}

test("snapshots the bounded baseline without writes and freezes a canonical run/profile join", async () => {
  const s = setup();
  const captured = await s.capture();
  assert.deepEqual(
    s.calls.map((c) => [c.url, c.method]),
    [
      [`${BASE}/script-settings`, "GET"],
      [`${BASE}/subdomain`, "GET"],
    ],
  );
  assert.deepEqual(captured.snapshot.settings, settings());
  assert.deepEqual(captured.snapshot.subdomain, { enabled: true, previews_enabled: true });
  assert.equal(captured.snapshot.schema, "two.candidate-settings-snapshot.v1");
  assert.equal(captured.snapshot.q, s.f.identity.q);
  assert.equal(captured.snapshot.profileSha256, s.f.profileSha256);
  assert.equal(captured.snapshot.capturedAt, NOW);
  assert.equal(captured.snapshot.promotable, false);
  assert.equal(captured.snapshotSha256, candidateSha256(JSON.stringify(captured.snapshot)));
  assert.deepEqual(
    s.guards.map((g) => g.name),
    Array(5).fill("exclusive"),
  );
  deepFrozen(captured);
  for (const c of s.calls) {
    assert.deepEqual(c.headers, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(c.redirect, "error");
    assert.equal("body" in c, false);
    assert.ok(c.signal instanceof AbortSignal && !c.signal.aborted);
  }
  assert.equal(JSON.stringify(captured).includes(TOKEN), false);
});

test("seals explicit sinks and flags with fixed requests, response checks and independent readback", async () => {
  const s = setup();
  const b = await s.capture();
  const sealed = await s.api.seal(b.snapshot, b.snapshotSha256);
  const calls = s.calls.slice(2);
  assert.deepEqual(
    calls.map((c) => [c.url.replace(BASE, ""), c.method]),
    [
      ["/script-settings", "GET"],
      ["/subdomain", "GET"],
      ["/script-settings", "PATCH"],
      ["/script-settings", "GET"],
      ["/subdomain", "POST"],
      ["/script-settings", "GET"],
      ["/subdomain", "GET"],
    ],
  );
  assert.deepEqual(s.state, {
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
  });
  assert.equal(sealed.phase, "seal");
  assert.equal(sealed.promotable, false);
  assert.equal(sealed.snapshotSha256, b.snapshotSha256);
  assert.equal(sealed.stateSha256, candidateSha256(JSON.stringify(s.state)));
  assert.equal(
    s.guards.some((g) => g.name === "serving"),
    false,
  );
  for (const c of calls) {
    assert.equal(/versions|deployments|production|secrets|routes|content/.test(c.url), false);
    assert.equal(c.redirect, "error");
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
    if (c.method !== "GET") assert.equal(c.headers["Content-Type"], "application/json");
  }
  for (let n = 2; n < s.calls.length; n++) {
    assert.ok(s.guards.some((g) => g.calls === n && g.name === "dirty"));
  }
  deepFrozen(sealed);
});

test("restores the exact baseline only with independently asserted B serving and remains idempotent", async () => {
  const s = setup();
  const b = await s.capture();
  await s.api.seal(b.snapshot, b.snapshotSha256);
  const start = s.calls.length;
  const restored = await s.api.restore(b.snapshot, b.snapshotSha256);
  assert.deepEqual(s.state.settings, settings());
  assert.deepEqual(s.state.subdomain, b.snapshot.subdomain);
  assert.equal(restored.phase, "restore");
  assert.equal(restored.promotable, false);
  assert.equal(restored.snapshotSha256, b.snapshotSha256);
  assert.equal(restored.stateSha256, candidateSha256(JSON.stringify(s.state)));
  for (let n = start; n <= s.calls.length; n++) {
    assert.ok(s.guards.some((g) => g.calls === n && g.name === "serving"));
  }
  const again = await s.api.restore(b.snapshot, b.snapshotSha256);
  assert.deepEqual(again, restored);
  deepFrozen(restored);
});

test("candidate still serving refuses before re-enabling any B sink", async () => {
  const s = setup();
  const b = await s.capture();
  await s.api.seal(b.snapshot, b.snapshotSha256);
  const count = s.calls.length;
  s.setServing(false);
  await assert.rejects(s.api.restore(b.snapshot, b.snapshotSha256), ERROR);
  assert.equal(s.calls.length, count);
  assert.equal(s.state.settings.logpush, false);
});

function tailedSettings() {
  return { ...settings(), tail_consumers: [{ service: "two-web-next-alerts" }] };
}

test("snapshots, seals and restores only the exact installed staging tail without extending recovery authority", async () => {
  const original = tailedSettings();
  const s = setup({ baselineSettings: original });
  const b = await s.capture();
  assert.deepEqual(b.snapshot.settings, original);
  deepFrozen(b);
  original.tail_consumers[0].service = "mutated-after-capture";
  assert.deepEqual(b.snapshot.settings.tail_consumers, [{ service: "two-web-next-alerts" }]);
  original.tail_consumers[0].service = "two-web-next-alerts";
  await s.api.seal(b.snapshot, b.snapshotSha256);
  assert.deepEqual(s.state.settings.tail_consumers, []);
  const count = s.calls.length;
  s.setServing(false);
  await assert.rejects(s.api.restore(b.snapshot, b.snapshotSha256), ERROR);
  assert.equal(s.calls.length, count);
  assert.deepEqual(s.state.settings.tail_consumers, []);
  s.setServing(true);
  const restored = await s.api.restore(b.snapshot, b.snapshotSha256);
  assert.deepEqual(s.state.settings, tailedSettings());
  assert.equal(restored.promotable, false);
  assert.equal(restored.phase, "restore");
  assert.equal(restored.snapshotSha256, b.snapshotSha256);
  assert.equal(restored.stateSha256, candidateSha256(JSON.stringify(s.state)));
  assert.equal(JSON.stringify(restored).includes("two-web-next-alerts"), false);
  for (let n = count; n <= s.calls.length; n++) {
    assert.ok(s.guards.some((g) => g.calls === n && g.name === "serving"));
    assert.ok(s.guards.some((g) => g.calls === n && g.name === "dirty"));
  }
  assert.deepEqual(await s.api.restore(b.snapshot, b.snapshotSha256), restored);
});

test("tail changes after the independently pinned snapshot refuse sealing before mutation", async () => {
  const s = setup({ baselineSettings: tailedSettings() });
  const b = await s.capture();
  s.state.settings.tail_consumers = [];
  await assert.rejects(s.api.seal(b.snapshot, b.snapshotSha256), ERROR);
  assert.ok(s.calls.every((c) => c.method === "GET"));
});

for (const phase of ["seal", "restore"])
  for (const index of phase === "seal" ? [5, 6, 8] : [3, 4, 6])
    test(`${phase} refuses a lost or retained tail at response ${index} with no later mutation`, async () => {
      const s = setup({
        baselineSettings: tailedSettings(),
        reply: (v, n) => {
          if (n === index)
            v.tail_consumers = phase === "seal" ? [{ service: "two-web-next-alerts" }] : [];
          return result(v);
        },
      });
      const b = await s.capture();
      await assert.rejects(s.api[phase](b.snapshot, b.snapshotSha256), ERROR);
      const finalSettings = phase === "seal" ? 8 : 6;
      assert.equal(s.calls.length, index === finalSettings ? index + 1 : index);
      assert.ok(s.calls.slice(index).every((c) => c.method === "GET"));
    });

for (const bad of [
  null,
  {},
  [null],
  Array(1),
  [{ service: "two-web-next-alerts-production" }],
  [{ service: "two-web-next-alerts", environment: "production" }],
  [{ service: "two-web-next-alerts", environment: "" }],
  [{ service: "two-web-next-alerts", namespace: "staging" }],
  [{ service: "two-web-next-alerts", namespace: null }],
  [{ service: "two-web-next-alerts", extra: true }],
  [{ service: "TWO-WEB-NEXT-ALERTS" }],
  [{ service: "two-web-next-alerts/" }],
  [{ service: "two-web-next-alerts​" }],
  [{ service: "two-web-next-alerts" }, { service: "two-web-next-alerts" }],
]) {
  test(`snapshot refuses unadmitted tail ${JSON.stringify(bad)}`, async () => {
    const s = setup({ baselineSettings: { ...settings(), tail_consumers: bad } });
    await assert.rejects(s.capture(), ERROR);
    assert.equal(s.calls.length, 1);
  });
  for (const phase of ["seal", "restore"])
    test(`${phase} refuses unadmitted tail ${JSON.stringify(bad)} even with a recomputed pin`, async () => {
      const s = setup();
      const b = await s.capture();
      const changed = structuredClone(b.snapshot);
      changed.settings.tail_consumers = bad;
      const pin = candidateSha256(JSON.stringify(changed));
      s.bind(pin);
      await assert.rejects(s.api[phase](changed, pin), ERROR);
      assert.equal(s.calls.length, 2);
    });
}

test("baseline drift between snapshot and seal refuses without mutation", async () => {
  const s = setup();
  const b = await s.capture();
  s.state.settings.observability.logs.head_sampling_rate = 0.3;
  await assert.rejects(s.api.seal(b.snapshot, b.snapshotSha256), ERROR);
  assert.equal(s.calls.length, 4);
  assert.ok(s.calls.every((c) => c.method === "GET"));
});

test("recovery does not depend on a still-live QA credential or reset its lifetime", async () => {
  let now = NOW;
  const s = setup({ clock: () => now });
  const b = await s.capture();
  await s.api.seal(b.snapshot, b.snapshotSha256);
  now += 86400;
  assert.equal((await s.api.restore(b.snapshot, b.snapshotSha256)).observedAt, now);
  assert.equal(JSON.stringify(s.calls).includes("verifier"), false);
});

for (const [label, mutate] of [
  [
    "schema",
    (s) => {
      s.schema += ".bad";
    },
  ],
  [
    "promotable",
    (s) => {
      s.promotable = true;
    },
  ],
  [
    "cross run",
    (s) => {
      s.q = "0".repeat(64);
    },
  ],
  [
    "profile pin",
    (s) => {
      s.profileSha256 = "0".repeat(64);
    },
  ],
  [
    "capture time future",
    (s) => {
      s.capturedAt = NOW + 1;
    },
  ],
  [
    "capture time missing",
    (s) => {
      delete s.capturedAt;
    },
  ],
  [
    "injected endpoint",
    (s) => {
      s.url = "https://example.com";
    },
  ],
  [
    "injected binding",
    (s) => {
      s.settings.bindings = [{ type: "secret_text", text: TOKEN }];
    },
  ],
  [
    "unknown streaming tails",
    (s) => {
      s.settings.streaming_tail_consumers = [];
    },
  ],
  [
    "missing logs",
    (s) => {
      delete s.settings.observability.logs;
    },
  ],
  [
    "unknown traces",
    (s) => {
      s.settings.observability.traces = {};
    },
  ],
  [
    "external tail",
    (s) => {
      s.settings.tail_consumers = [{ service: "unqualified" }];
    },
  ],
  [
    "external log destination",
    (s) => {
      s.settings.observability.logs.destinations = ["unqualified"];
    },
  ],
  [
    "nonempty tags",
    (s) => {
      s.settings.tags = ["unqualified"];
    },
  ],
  [
    "logpush string",
    (s) => {
      s.settings.logpush = "false";
    },
  ],
  [
    "subdomain unknown",
    (s) => {
      s.subdomain.url = "https://example.com";
    },
  ],
  [
    "subdomain missing",
    (s) => {
      delete s.subdomain.previews_enabled;
    },
  ],
  [
    "subdomain coerced",
    (s) => {
      s.subdomain.enabled = 0;
    },
  ],
])
  for (const phase of ["seal", "restore"])
    test(`${phase} refuses ${label}, even with a recomputed caller hash`, async () => {
      const s = setup();
      const b = await s.capture();
      const bad = structuredClone(b.snapshot);
      mutate(bad);
      const pin = candidateSha256(JSON.stringify(bad));
      s.bind(pin);
      await assert.rejects(s.api[phase](bad, pin), ERROR);
      assert.equal(s.calls.length, 2);
    });

for (const phase of ["seal", "restore"])
  test(`${phase} rejects a snapshot that does not match the independent pin`, async () => {
    const s = setup();
    const b = await s.capture();
    const bad = structuredClone(b.snapshot);
    bad.settings.logpush = false;
    await assert.rejects(s.api[phase](bad, b.snapshotSha256), ERROR);
    await assert.rejects(s.api[phase](b.snapshot, "0".repeat(64)), ERROR);
    s.bind("0".repeat(64));
    await assert.rejects(s.api[phase](b.snapshot, b.snapshotSha256), ERROR);
    assert.equal(s.calls.length, 2);
  });

for (const [label, mutate] of [
  [
    "missing field",
    (v) => {
      delete v.logpush;
    },
  ],
  [
    "null logs",
    (v) => {
      v.observability.logs = null;
    },
  ],
  [
    "unknown field",
    (v) => {
      v.extra = true;
    },
  ],
  [
    "tags",
    (v) => {
      v.tags = ["x"];
    },
  ],
  [
    "tail",
    (v) => {
      v.tail_consumers = [{}];
    },
  ],
  [
    "sampling underflow",
    (v) => {
      v.observability.head_sampling_rate = -0.1;
    },
  ],
  [
    "sampling overflow",
    (v) => {
      v.observability.logs.head_sampling_rate = 1.1;
    },
  ],
  [
    "sampling null",
    (v) => {
      v.observability.head_sampling_rate = null;
    },
  ],
  [
    "persist coerced",
    (v) => {
      v.observability.logs.persist = "false";
    },
  ],
  [
    "destinations",
    (v) => {
      v.observability.logs.destinations = ["x"];
    },
  ],
])
  test(`snapshot refuses unsupported provider ${label}`, async () => {
    const s = setup({
      reply: (v, n) => {
        if (n === 1) mutate(v);
        return result(v);
      },
    });
    await assert.rejects(s.capture(), ERROR);
    assert.equal(s.calls.length, 1);
  });

for (const phase of ["snapshot", "seal", "restore"])
  for (const [label, reply] of [
    ["401", () => result({}, { status: 401 })],
    ["redirect", () => result({}, { status: 302 })],
    ["wrong media", () => new Response("{}", { headers: { "content-type": "text/html" } })],
    [
      "length bound",
      () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": "65537" },
        }),
    ],
    [
      "stream bound",
      () => new Response(" ".repeat(65537), { headers: { "content-type": "application/json" } }),
    ],
    ["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    [
      "failed envelope",
      () =>
        new Response('{"success":false,"errors":[],"result":{}}', {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "nonempty errors",
      () =>
        new Response('{"success":true,"errors":["bad"],"result":{}}', {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "fetch exception",
      () => {
        throw new Error(`${TOKEN}: private provider error`);
      },
    ],
  ])
    test(`${phase} refuses ${label} without retry or error-body disclosure`, async () => {
      let fail = phase === "snapshot";
      const s = setup({ reply: (v) => (fail ? reply() : result(v)) });
      const b = phase === "snapshot" ? null : await s.capture();
      fail = true;
      const before = s.calls.length;
      await assert.rejects(
        phase === "snapshot" ? s.capture() : s.api[phase](b.snapshot, b.snapshotSha256),
        ERROR,
      );
      assert.equal(s.calls.length, before + 1);
    });

for (const phase of ["seal", "restore"]) {
  const count = phase === "seal" ? 7 : 5;
  for (let index = 1; index <= count; index++)
    test(`${phase} retains failure at provider request ${index} with no retry or later mutation`, async () => {
      const s = setup({
        reply: (v, n) => (n === index + 2 ? result({}, { status: 500 }) : result(v)),
      });
      const b = await s.capture();
      await assert.rejects(s.api[phase](b.snapshot, b.snapshotSha256), ERROR);
      assert.equal(s.calls.length, index + 2);
    });
  for (const name of ["exclusive", "dirty", ...(phase === "restore" ? ["serving"] : [])])
    for (const when of ["before", "after"])
      test(`${phase} rechecks ${name} ${when} provider mutation`, async () => {
        let active = false;
        let count = 0;
        const s = setup({
          onGuard: (n) => {
            if (active && n === name && ++count === (when === "before" ? 1 : 2))
              throw new Error(TOKEN);
          },
        });
        const b = await s.capture();
        active = true;
        await assert.rejects(s.api[phase](b.snapshot, b.snapshotSha256), ERROR);
        assert.equal(s.calls.length, when === "before" ? 2 : 3);
      });
}

test("rejects a successful mutation response that does not echo its requested state", async () => {
  const s = setup({
    reply: (v, n) => {
      if (n === 5) v.logpush = true;
      return result(v);
    },
  });
  const b = await s.capture();
  await assert.rejects(s.api.seal(b.snapshot, b.snapshotSha256), ERROR);
  assert.equal(s.calls.length, 5);
});

test("rejects final settings drift instead of accepting two independently shaped responses", async () => {
  const s = setup({
    onCall: (n, state) => {
      if (n === 8) state.settings.logpush = true;
    },
  });
  const b = await s.capture();
  await assert.rejects(s.api.seal(b.snapshot, b.snapshotSha256), ERROR);
  assert.equal(s.calls.length, 9);
});

test("snapshots all admitted data before awaiting guards; later caller mutation cannot redirect recovery", async () => {
  const f = fixture();
  const original = structuredClone(f);
  let active = false;
  let b;
  const s = setup({
    f,
    onGuard: () => {
      if (!active) return;
      b.snapshot.settings.logpush = false;
      b.snapshot.subdomain.enabled = false;
    },
  });
  // Constructor copied the identity/profile; the fixture guards intentionally
  // still compare with the original fixture and are not candidate authority.
  f.profile.accountId = "3".repeat(32);
  f.profile.scriptName = "two-web-next-production";
  const captured = await s.capture();
  b = structuredClone(captured);
  active = true;
  await s.api.restore(b.snapshot, b.snapshotSha256);
  assert.equal(s.state.settings.logpush, true);
  assert.equal(s.state.subdomain.enabled, true);
  assert.ok(s.calls.every((c) => c.url.startsWith(BASE)));
  assert.equal(captured.snapshot.profileSha256, original.profileSha256);
});

for (const phase of ["snapshot", "seal", "restore"])
  test(`${phase} honors cancellation and monotonic clocks`, async () => {
    const abort = new AbortController();
    let now = NOW;
    const s = setup({ signal: abort.signal, clock: () => now });
    const b = await s.capture();
    abort.abort();
    await assert.rejects(
      phase === "snapshot" ? s.capture() : s.api[phase](b.snapshot, b.snapshotSha256),
      ERROR,
    );
    assert.equal(s.calls.length, 2);
    const r = setup({
      clock: () => now,
      onCall: () => {
        now--;
      },
    });
    await assert.rejects(r.capture(), ERROR);
    assert.equal(r.calls.length, 1);
  });

for (const field of ["assertExclusive", "requireDirty", "assertBaselineServing"])
  test(`requires installed ${field} rather than an optional authorization hook`, () => {
    const f = fixture();
    assert.throws(
      () =>
        createCandidateSettingsLifecycle({
          ...f,
          token: TOKEN,
          assertExclusive: async () => {},
          requireDirty: async () => {},
          assertBaselineServing: async () => {},
          [field]: undefined,
        }),
      ERROR,
    );
  });

test("refuses production/unknown profile and malformed identity before provider access", () => {
  const f = fixture();
  const options = {
    ...f,
    token: TOKEN,
    assertExclusive: async () => {},
    requireDirty: async () => {},
    assertBaselineServing: async () => {},
  };
  f.profile.scriptName = "two-web-next-production";
  options.profileSha256 = candidateSha256(JSON.stringify(f.profile));
  assert.throws(() => createCandidateSettingsLifecycle(options), /refused/);
  const fresh = fixture();
  fresh.identity.q = "0".repeat(64);
  assert.throws(() => createCandidateSettingsLifecycle({ ...options, ...fresh }), /refused/);
});
