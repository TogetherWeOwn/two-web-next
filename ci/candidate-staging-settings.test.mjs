import assert from "node:assert/strict";
import test from "node:test";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateSettingsReader } from "./candidate-staging-settings.mjs";

const NOW = 1793819000;
const TOKEN = "fixture-provider-bearer";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${"1".repeat(32)}/workers/scripts/two-web-next`;
const ERROR = { message: "Candidate settings refused: observation" };

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
  const bytes = Buffer.from('throw new Error("never execute candidate")');
  const profile = {
    schema: "two.candidate-upload-profile.v1",
    accountId: "1".repeat(32),
    scriptName: "two-web-next",
    bindings: [{ name: "DB", type: "hyperdrive", id: "2".repeat(32) }],
  };
  return {
    profile,
    profileSha256: candidateSha256(JSON.stringify(profile)),
    input: {
      identity: structuredClone(identity),
      bundle: {
        q: identity.q,
        build: { runId: "500", runAttempt: "1", artifactId: "600", archiveSha256: "d".repeat(64) },
        rootSha256: candidateSha256(
          JSON.stringify([["worker/worker.mjs", bytes.length, candidateSha256(bytes)]]),
        ),
        bytes: bytes.length,
        files: 1,
        entries: [{ path: "worker/worker.mjs", type: "file", bytes }],
      },
      verifier: JSON.stringify({
        schema: "two.qa.verifier.v1",
        descriptor: identity.descriptor,
        q: identity.q,
        credentialSha256: "e".repeat(64),
        issuedAt: NOW,
        notBefore: NOW,
        expiresAt: NOW + 1500,
      }),
    },
  };
}

function settings() {
  return {
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
  };
}

function result(value, init = {}) {
  return new Response(JSON.stringify({ success: true, errors: [], result: value }), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function setup({ f = fixture(), clock = () => NOW, reply, onFetch } = {}) {
  const calls = [];
  const reader = createCandidateSettingsReader({
    token: TOKEN,
    profile: f.profile,
    profileSha256: f.profileSha256,
    clock,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (onFetch) await onFetch(calls.length, f);
      const value = url.endsWith("/script-settings")
        ? settings()
        : { enabled: false, previews_enabled: false };
      return reply ? reply(value, calls.length) : result(value);
    },
  });
  return { calls, reader, f, observe: () => reader.observe(f.input) };
}

async function refused(options, expectedCalls) {
  const s = setup(options);
  await assert.rejects(s.observe(), ERROR);
  assert.equal(s.calls.length, expectedCalls);
}

test("observes only installed same-account persistent settings and disabled subdomain", async () => {
  const s = setup();
  const proof = await s.observe();
  assert.deepEqual(
    s.calls.map((c) => c.url),
    [`${BASE}/script-settings`, `${BASE}/subdomain`],
  );
  for (const c of s.calls) {
    assert.equal(c.method, "GET");
    assert.equal(c.redirect, "error");
    assert.equal("body" in c, false);
    assert.deepEqual(c.headers, { Authorization: `Bearer ${TOKEN}` });
    assert.ok(c.signal instanceof AbortSignal && !c.signal.aborted);
    assert.equal(/production|versions|deployments|secrets|routes|content/.test(c.url), false);
  }
  assert.deepEqual(
    Object.keys(proof).sort(),
    [
      "schema",
      "promotable",
      "q",
      "bundleRootSha256",
      "profileSha256",
      "readbackScope",
      "settingsSha256",
      "observedAt",
    ].sort(),
  );
  assert.equal(proof.schema, "two.candidate-settings-observation.v1");
  assert.equal(proof.promotable, false);
  assert.equal(proof.q, s.f.input.identity.q);
  assert.equal(proof.bundleRootSha256, s.f.input.bundle.rootSha256);
  assert.equal(proof.profileSha256, s.f.profileSha256);
  assert.equal(proof.readbackScope, "script-settings-and-disabled-subdomain");
  assert.match(proof.settingsSha256, /^[a-f0-9]{64}$/);
  assert.equal(proof.observedAt, NOW);
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(s.reader));
  for (const text of [TOKEN, s.f.input.verifier, "never execute candidate", BASE])
    assert.equal(JSON.stringify(proof).includes(text), false);
});

test("canonical digest is independent of provider field order and observation time", async () => {
  const first = await setup().observe();
  function reverse(value) {
    if (Array.isArray(value) || value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverse(v)]),
    );
  }
  const second = await setup({ clock: () => NOW + 1, reply: (v) => result(reverse(v)) }).observe();
  assert.equal(first.settingsSha256, second.settingsSha256);
  assert.notEqual(first.observedAt, second.observedAt);
});

test("snapshots installed profile and admitted input before the first await", async () => {
  const f = fixture();
  const q = f.input.identity.q;
  const root = f.input.bundle.rootSha256;
  const pin = f.profileSha256;
  const s = setup({
    f,
    onFetch: (n) => {
      if (n !== 1) return;
      f.profile.accountId = "3".repeat(32);
      f.profile.scriptName = "two-web-next-production";
      f.profile.bindings[0].id = "4".repeat(32);
      f.input.identity.q = "0".repeat(64);
      f.input.bundle.entries[0].bytes.fill(0);
      f.input.verifier = "replaced";
    },
  });
  const proof = await s.observe();
  assert.deepEqual(
    s.calls.map((c) => c.url),
    [`${BASE}/script-settings`, `${BASE}/subdomain`],
  );
  assert.equal(proof.q, q);
  assert.equal(proof.bundleRootSha256, root);
  assert.equal(proof.profileSha256, pin);
});

for (const [label, mutate] of [
  [
    "wrong profile pin",
    (f) => {
      f.profileSha256 = "0".repeat(64);
    },
  ],
  [
    "production script",
    (f) => {
      f.profile.scriptName = "two-web-next-production";
      f.profileSha256 = candidateSha256(JSON.stringify(f.profile));
    },
  ],
  [
    "endpoint override",
    (f) => {
      f.input.url = "https://example.com";
    },
  ],
  [
    "profile override",
    (f) => {
      f.input.profile = f.profile;
    },
  ],
  [
    "clock override",
    (f) => {
      f.input.clock = () => NOW;
    },
  ],
  [
    "verifier q drift",
    (f) => {
      const v = JSON.parse(f.input.verifier);
      v.q = "0".repeat(64);
      f.input.verifier = JSON.stringify(v);
    },
  ],
  [
    "bundle drift",
    (f) => {
      f.input.bundle.entries[0].bytes.fill(0);
    },
  ],
  [
    "identity drift",
    (f) => {
      f.input.identity.descriptor[4] = "5".repeat(40);
    },
  ],
  [
    "credential lifetime extension",
    (f) => {
      const v = JSON.parse(f.input.verifier);
      v.expiresAt++;
      f.input.verifier = JSON.stringify(v);
    },
  ],
])
  test(`refuses ${label} before any provider request`, async () => {
    const f = fixture();
    mutate(f);
    await refused({ f }, 0);
  });

for (const [label, mutate] of [
  [
    "logpush",
    (v) => {
      v.logpush = true;
    },
  ],
  [
    "missing logpush",
    (v) => {
      delete v.logpush;
    },
  ],
  [
    "tagged state",
    (v) => {
      v.tags = ["other"];
    },
  ],
  [
    "tail consumer",
    (v) => {
      v.tail_consumers = [{ service: "other" }];
    },
  ],
  [
    "null tail consumers",
    (v) => {
      v.tail_consumers = null;
    },
  ],
  [
    "missing tail consumers",
    (v) => {
      delete v.tail_consumers;
    },
  ],
  [
    "streaming tail field",
    (v) => {
      v.streaming_tail_consumers = [];
    },
  ],
  [
    "unknown property",
    (v) => {
      v.extra = false;
    },
  ],
  [
    "observability enabled",
    (v) => {
      v.observability.enabled = true;
    },
  ],
  [
    "observability missing",
    (v) => {
      delete v.observability;
    },
  ],
  [
    "observability null",
    (v) => {
      v.observability = null;
    },
  ],
  [
    "observability extra",
    (v) => {
      v.observability.traces = { enabled: false };
    },
  ],
  [
    "nonzero observation sampling",
    (v) => {
      v.observability.head_sampling_rate = 1;
    },
  ],
  [
    "missing observation sampling",
    (v) => {
      delete v.observability.head_sampling_rate;
    },
  ],
  [
    "logs enabled",
    (v) => {
      v.observability.logs.enabled = true;
    },
  ],
  [
    "logs null",
    (v) => {
      v.observability.logs = null;
    },
  ],
  [
    "logs missing",
    (v) => {
      delete v.observability.logs;
    },
  ],
  [
    "logs extra",
    (v) => {
      v.observability.logs.extra = false;
    },
  ],
  [
    "logs sampling",
    (v) => {
      v.observability.logs.head_sampling_rate = 0.1;
    },
  ],
  [
    "logs invocation",
    (v) => {
      v.observability.logs.invocation_logs = true;
    },
  ],
  [
    "logs persist",
    (v) => {
      v.observability.logs.persist = true;
    },
  ],
  [
    "logs destination",
    (v) => {
      v.observability.logs.destinations = ["other"];
    },
  ],
  [
    "logs destinations missing",
    (v) => {
      delete v.observability.logs.destinations;
    },
  ],
  [
    "false-like logpush",
    (v) => {
      v.logpush = 0;
    },
  ],
  [
    "false-like logs",
    (v) => {
      v.observability.logs.enabled = "false";
    },
  ],
])
  test(`refuses persistent settings ${label}`, async () => {
    await refused(
      {
        reply: (v) => {
          mutate(v);
          return result(v);
        },
      },
      1,
    );
  });

for (const [label, mutate] of [
  [
    "workers.dev enabled",
    (v) => {
      v.enabled = true;
    },
  ],
  [
    "preview enabled",
    (v) => {
      v.previews_enabled = true;
    },
  ],
  [
    "missing preview flag",
    (v) => {
      delete v.previews_enabled;
    },
  ],
  [
    "null preview flag",
    (v) => {
      v.previews_enabled = null;
    },
  ],
  [
    "false-like preview flag",
    (v) => {
      v.previews_enabled = 0;
    },
  ],
  [
    "unknown route state",
    (v) => {
      v.route = "other";
    },
  ],
])
  test(`refuses subdomain ${label}`, async () => {
    await refused(
      {
        reply: (v, n) => {
          if (n === 2) mutate(v);
          return result(v);
        },
      },
      2,
    );
  });

const LIMIT = 64 * 1024;
const jsonHeaders = { "content-type": "application/json" };
for (const phase of [1, 2]) {
  for (const [label, response] of [
    ["forbidden", () => result(settings(), { status: 403 })],
    ["redirect status", () => new Response("{}", { status: 302, headers: jsonHeaders })],
    [
      "redirect flag",
      () => {
        const r = result(settings());
        Object.defineProperty(r, "redirected", { value: true });
        return r;
      },
    ],
    [
      "foreign final URL",
      () => {
        const r = result(settings());
        Object.defineProperty(r, "url", { value: "https://example.com" });
        return r;
      },
    ],
    ["missing body", () => new Response(null, { headers: jsonHeaders })],
    ["missing content type", () => new Response(new Uint8Array([123, 125]))],
    ["wrong content type", () => new Response("{}", { headers: { "content-type": "text/plain" } })],
    [
      "oversize length",
      () =>
        new Response("{}", { headers: { ...jsonHeaders, "content-length": String(LIMIT + 1) } }),
    ],
    [
      "noncanonical length",
      () => new Response("{}", { headers: { ...jsonHeaders, "content-length": "01" } }),
    ],
    [
      "stream beyond length",
      () =>
        new Response(" ".repeat(LIMIT + 1), { headers: { ...jsonHeaders, "content-length": "1" } }),
    ],
    ["oversize stream", () => new Response(" ".repeat(LIMIT + 1), { headers: jsonHeaders })],
    ["invalid UTF-8", () => new Response(new Uint8Array([0xff]), { headers: jsonHeaders })],
    ["invalid JSON", () => new Response("{", { headers: jsonHeaders })],
    [
      "provider failure",
      () =>
        new Response(JSON.stringify({ success: false, errors: [], result: {} }), {
          headers: jsonHeaders,
        }),
    ],
    [
      "provider errors",
      () =>
        new Response(JSON.stringify({ success: true, errors: [{ message: TOKEN }], result: {} }), {
          headers: jsonHeaders,
        }),
    ],
    [
      "missing errors",
      () => new Response(JSON.stringify({ success: true, result: {} }), { headers: jsonHeaders }),
    ],
    ["array result", () => result([])],
    ["null result", () => result(null)],
    [
      "transport throw",
      () => {
        throw new Error(TOKEN);
      },
    ],
    [
      "body throw",
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error(TOKEN));
            },
          }),
          { headers: jsonHeaders },
        ),
    ],
  ])
    test(`refuses phase ${phase} ${label} without a partial receipt`, async () => {
      await refused({ reply: (v, n) => (n === phase ? response() : result(v)) }, phase);
    });
}

for (const time of [NOW - 1, NOW + 1470, NOW + 1500, NaN, "1793819000"])
  test(`refuses invalid initial clock ${String(time)}`, async () => {
    await refused({ clock: () => time }, 0);
  });

for (const phase of [1, 2])
  for (const [label, value] of [
    ["backwards", NOW - 1],
    ["cutoff", NOW + 1470],
    ["noninteger", NOW + 0.5],
  ])
    test(`refuses phase ${phase} clock ${label}`, async () => {
      let now = NOW;
      await refused(
        {
          clock: () => now,
          onFetch: (n) => {
            if (n === phase) now = value;
          },
        },
        phase,
      );
    });

test("deadline signals bound each request and the entire observation", async (t) => {
  const original = AbortSignal.timeout;
  const bounds = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    bounds.push(ms);
    return original(ms);
  });
  await setup().observe();
  assert.deepEqual(bounds, [30_000, 10_000, 10_000]);
});

test("crossing the overall deadline suppresses a receipt even after successful GETs", async (t) => {
  const original = AbortSignal.timeout;
  const overall = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms) => (ms === 30_000 ? overall.signal : original(ms)));
  await refused(
    {
      onFetch: (n) => {
        if (n === 2) overall.abort(new Error(TOKEN));
      },
    },
    2,
  );
});

for (const token of ["", "a b", "a\nb", "a".repeat(4097), null])
  test("refuses malformed bearer at construction", () => {
    assert.throws(() => createCandidateSettingsReader({ token }), ERROR);
  });

test("cancels and unlocks a refused response stream", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(Buffer.alloc(LIMIT + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await refused({ reply: () => new Response(body, { headers: jsonHeaders }) }, 1);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
