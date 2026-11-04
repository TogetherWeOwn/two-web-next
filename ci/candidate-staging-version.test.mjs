import assert from "node:assert/strict";
import test from "node:test";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateVersionUploader } from "./candidate-staging-version.mjs";

const NOW = 1793819000;
const TOKEN = "fixture-provider-bearer";
const VERSION = "12345678-1234-1234-1234-123456789abc";
const ETAG = "f".repeat(32);
const BASE = `https://api.cloudflare.com/client/v4/accounts/${"1".repeat(32)}/workers/scripts/two-web-next`;
const ERROR = { message: "Candidate version refused: transport" };
const TICKET = `fixture.${Buffer.from(JSON.stringify({ exp: NOW + 1800 })).toString("base64url")}.signature`;

function fixture({ assets = false } = {}) {
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
  const entries = [
    ...(assets ? [{ path: "assets/app.css", type: "file", bytes: Buffer.from("body{}") }] : []),
    {
      path: "worker/worker.mjs",
      type: "file",
      bytes: Buffer.from('throw new Error("never execute candidate")'),
    },
  ];
  const profile = {
    schema: "two.candidate-upload-profile.v1",
    accountId: "1".repeat(32),
    scriptName: "two-web-next",
    bindings: [
      { name: "DB", type: "hyperdrive", id: "2".repeat(32) },
      { name: "DISCORD_CLIENT_ID", type: "plain_text", text: "1234" },
    ],
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
          JSON.stringify(entries.map((e) => [e.path, e.bytes.length, candidateSha256(e.bytes)])),
        ),
        bytes: entries.reduce((n, e) => n + e.bytes.length, 0),
        files: entries.length,
        entries,
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

function result(value, init = {}) {
  return new Response(JSON.stringify({ success: true, errors: [], result: value }), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function setup({
  f = fixture(),
  uploadReply,
  readReply,
  contentReply,
  settingsReply,
  clock = () => NOW,
  onFetch,
  onSettingsFetch,
} = {}) {
  // Retain phase-local counters for the existing asset/version refusal cases;
  // trace records the full ordering, including every settings GET.
  const calls = [];
  const settingsCalls = [];
  const trace = [];
  let metadata;
  let versionForm;
  const uploader = createCandidateVersionUploader({
    token: TOKEN,
    profile: f.profile,
    profileSha256: f.profileSha256,
    clock,
    fetchImpl: async (url, options) => {
      trace.push({ url, ...options });
      if (url.endsWith("/script-settings") || url.endsWith("/subdomain")) {
        settingsCalls.push({ url, ...options });
        if (onSettingsFetch) await onSettingsFetch(settingsCalls.length, f);
        const value = url.endsWith("/script-settings")
          ? {
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
            }
          : { enabled: false, previews_enabled: false };
        return settingsReply ? settingsReply(value, settingsCalls.length) : result(value);
      }
      calls.push({ url, ...options });
      if (onFetch) await onFetch(calls.length, f);
      if (url.endsWith("/assets-upload-session")) {
        const manifest = JSON.parse(options.body).manifest;
        return result({ jwt: TICKET, buckets: [Object.values(manifest).map((v) => v.hash)] });
      }
      if (url.includes("/assets/upload")) return result({ jwt: TICKET });
      if (options.method === "POST") {
        versionForm = options.body;
        metadata = JSON.parse(versionForm.get("metadata"));
        const value = { id: VERSION, resources: { script: { etag: ETAG } } };
        return uploadReply ? uploadReply(value) : result(value);
      }
      if (url.includes("?include=modules")) {
        const value = {
          id: VERSION,
          number: 42,
          urls: [],
          created_on: new Date(NOW * 1000).toISOString(),
          annotations: structuredClone(metadata.annotations),
          main_module: metadata.main_module,
          compatibility_date: metadata.compatibility_date,
          compatibility_flags: [...metadata.compatibility_flags],
          bindings: structuredClone(metadata.bindings),
          ...(metadata.assets
            ? { assets: { config: structuredClone(metadata.assets.config) } }
            : {}),
          modules: [...versionForm]
            .filter(([name]) => name !== "metadata")
            .map(([name, blob]) => ({
              name,
              content_type: blob.type,
              content_base64: "",
            })),
        };
        for (const module of value.modules) {
          module.content_base64 = Buffer.from(
            await versionForm.get(module.name).arrayBuffer(),
          ).toString("base64");
        }
        return contentReply ? contentReply(value) : result(value);
      }
      const value = {
        id: VERSION,
        annotations: metadata.annotations,
        resources: {
          script: { etag: ETAG },
          script_runtime: {
            compatibility_date: metadata.compatibility_date,
            compatibility_flags: metadata.compatibility_flags,
          },
          bindings: metadata.bindings,
        },
      };
      return readReply ? readReply(value) : result(value);
    },
  });
  return { calls, settingsCalls, trace, f, upload: () => uploader.upload(f.input) };
}

async function refused(options, expectedCalls) {
  const f = setup(options);
  await assert.rejects(f.upload(), ERROR);
  if (expectedCalls !== undefined) assert.equal(f.calls.length, expectedCalls);
}

for (const assets of [false, true])
  test(`creates and independently reads only the exact version (${assets ? "with assets" : "module-only"})`, async () => {
    const s = setup({ f: fixture({ assets }) });
    const proof = await s.upload();
    assert.equal(s.calls.length, assets ? 5 : 3);
    assert.equal(s.settingsCalls.length, 4);
    assert.equal(s.trace.length, s.calls.length + 4);
    assert.deepEqual(
      s.trace.slice(0, 2).map((c) => c.url),
      [`${BASE}/script-settings`, `${BASE}/subdomain`],
    );
    assert.deepEqual(
      s.trace.slice(-2).map((c) => c.url),
      [`${BASE}/script-settings`, `${BASE}/subdomain`],
    );
    for (const call of s.settingsCalls) {
      assert.equal(call.method, "GET");
      assert.equal(call.redirect, "error");
      assert.deepEqual(call.headers, { Authorization: `Bearer ${TOKEN}` });
      assert.equal("body" in call, false);
      assert.ok(call.signal instanceof AbortSignal && !call.signal.aborted);
    }
    const [post, get, content] = s.calls.slice(-3);
    assert.equal(
      content.url,
      `${BASE.replace("/workers/scripts/", "/workers/workers/")}/versions/${VERSION}?include=modules`,
    );
    assert.equal(content.method, "GET");
    assert.equal("body" in content, false);
    assert.equal(post.url, `${BASE}/versions?bindings_inherit=strict`);
    assert.equal(post.method, "POST");
    assert.equal(get.url, `${BASE}/versions/${VERSION}`);
    assert.equal(get.method, "GET");
    assert.equal("body" in get, false);
    for (const call of s.calls) {
      assert.equal(call.redirect, "error");
      assert.ok(call.signal instanceof AbortSignal);
      assert.equal(call.signal.aborted, false);
      const bucket = call.url.includes("/assets/upload");
      assert.deepEqual(call.headers, {
        Authorization: `Bearer ${bucket ? TICKET : TOKEN}`,
        ...(call.url.endsWith("/assets-upload-session")
          ? { "Content-Type": "application/json" }
          : {}),
      });
      assert.equal(/deployments|settings|subdomain|production/.test(call.url), false);
    }
    const metadata = JSON.parse(post.body.get("metadata"));
    assert.deepEqual(metadata.keep_bindings, []);
    assert.equal(metadata.keep_assets, false);
    assert.equal(
      metadata.bindings.some((b) => b.type === "secret_text"),
      false,
    );
    assert.equal(metadata.bindings.find((b) => b.name === "QA_RUN_AUTH").text, s.f.input.verifier);
    assert.deepEqual(
      Buffer.from(await post.body.get("worker/worker.mjs").arrayBuffer()),
      s.f.input.bundle.entries.at(-1).bytes,
    );
    assert.equal(proof.schema, "two.candidate-version-upload.v3");
    assert.equal(proof.promotable, false);
    assert.equal(proof.versionId, VERSION);
    assert.equal(proof.etag, ETAG);
    assert.equal(proof.q, s.f.input.identity.q);
    assert.equal(proof.bundleRootSha256, s.f.input.bundle.rootSha256);
    assert.equal(
      proof.readbackScope,
      "version-modules-bindings-runtime-assets-and-persistent-settings",
    );
    assert.match(proof.readbackSha256, /^[a-f0-9]{64}$/);
    assert.match(proof.contentSha256, /^[a-f0-9]{64}$/);
    assert.match(proof.settingsSha256, /^[a-f0-9]{64}$/);
    assert.equal(proof.settingsObservedBeforeAt, NOW);
    assert.equal(proof.settingsObservedAfterAt, NOW);
    assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.build));
    for (const sensitive of [TOKEN, TICKET, s.f.input.verifier, "never execute candidate"])
      assert.equal(JSON.stringify(proof).includes(sensitive), false);
    assert.equal("url" in proof, false);
  });

test("compares bindings without relying on response order", async () => {
  const s = setup({
    readReply: (v) => {
      v.resources.bindings.reverse();
      return result(v);
    },
  });
  assert.equal((await s.upload()).versionId, VERSION);
});

test("snapshots installed profile and invocation bytes before any await", async () => {
  const f = fixture({ assets: true });
  const expectedBytes = Buffer.from(f.input.bundle.entries.at(-1).bytes);
  const expectedVerifier = f.input.verifier;
  const expectedRoot = f.input.bundle.rootSha256;
  const s = setup({
    f,
    onFetch: (n) => {
      if (n !== 1) return;
      f.profile.accountId = "3".repeat(32);
      f.profile.bindings[0].id = "4".repeat(32);
      f.input.identity.descriptor[4] = "5".repeat(40);
      f.input.bundle.entries.at(-1).bytes.fill(0);
      f.input.bundle.build.runAttempt = "2";
      f.input.verifier = "replaced";
    },
  });
  const proof = await s.upload();
  const post = s.calls.at(-3);
  assert.equal(post.url, `${BASE}/versions?bindings_inherit=strict`);
  assert.deepEqual(
    Buffer.from(await post.body.get("worker/worker.mjs").arrayBuffer()),
    expectedBytes,
  );
  const metadata = JSON.parse(post.body.get("metadata"));
  assert.equal(metadata.bindings.find((b) => b.name === "QA_RUN_AUTH").text, expectedVerifier);
  assert.equal(metadata.bindings.find((b) => b.name === "DB").id, "2".repeat(32));
  assert.equal(proof.bundleRootSha256, expectedRoot);
  assert.equal(proof.build.runAttempt, "1");
});

for (const [label, mutate] of [
  [
    "profile override",
    (f) => {
      f.input.profile = f.profile;
    },
  ],
  [
    "profile pin override",
    (f) => {
      f.input.profileSha256 = f.profileSha256;
    },
  ],
  [
    "clock override",
    (f) => {
      f.input.now = NOW;
    },
  ],
  [
    "URL override",
    (f) => {
      f.input.url = "https://example.com";
    },
  ],
  [
    "prepared request",
    (f) => {
      f.input.form = new FormData();
    },
  ],
  [
    "asset ticket",
    (f) => {
      f.input.assetsTicket = { jwt: TICKET };
    },
  ],
  [
    "changed bytes",
    (f) => {
      f.input.bundle.entries[0].bytes.fill(0);
    },
  ],
  [
    "head drift",
    (f) => {
      f.input.identity.descriptor[4] = "9".repeat(40);
    },
  ],
  [
    "stale pin",
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
    "foreign verifier",
    (f) => {
      const v = JSON.parse(f.input.verifier);
      v.q = "0".repeat(64);
      f.input.verifier = JSON.stringify(v);
    },
  ],
])
  test(`refuses ${label} before any provider call`, async () => {
    const f = fixture();
    mutate(f);
    await refused({ f }, 0);
  });

for (const [label, mutate] of [
  [
    "missing version",
    (v) => {
      delete v.id;
    },
  ],
  [
    "URL version",
    (v) => {
      v.id = "https://example.com/secret";
    },
  ],
  [
    "path version",
    (v) => {
      v.id = "../../production";
    },
  ],
  [
    "uppercase version",
    (v) => {
      v.id = VERSION.toUpperCase();
    },
  ],
  [
    "missing etag",
    (v) => {
      delete v.resources;
    },
  ],
  [
    "invalid etag",
    (v) => {
      v.resources.script.etag = "binding-secret";
    },
  ],
])
  test(`refuses upload response ${label} without readback or retry`, async () => {
    await refused(
      {
        uploadReply: (v) => {
          mutate(v);
          return result(v);
        },
      },
      1,
    );
  });

for (const [label, mutate] of [
  [
    "wrong version",
    (v) => {
      v.id = "0".repeat(8) + VERSION.slice(8);
    },
  ],
  [
    "wrong etag",
    (v) => {
      v.resources.script.etag = "1".repeat(32);
    },
  ],
  [
    "wrong tag",
    (v) => {
      v.annotations["workers/tag"] = "other-run";
    },
  ],
  [
    "missing annotations",
    (v) => {
      delete v.annotations;
    },
  ],
  [
    "missing resources",
    (v) => {
      delete v.resources;
    },
  ],
  [
    "extra resource",
    (v) => {
      v.resources.unknown = {};
    },
  ],
  [
    "missing binding",
    (v) => {
      v.resources.bindings.pop();
    },
  ],
  [
    "duplicate binding",
    (v) => {
      v.resources.bindings.push(v.resources.bindings[0]);
    },
  ],
  [
    "retained secret",
    (v) => {
      v.resources.bindings.push({ name: "SESSION_SECRET", type: "secret_text" });
    },
  ],
  [
    "inherit binding",
    (v) => {
      v.resources.bindings[0].type = "inherit";
    },
  ],
  [
    "changed origin",
    (v) => {
      v.resources.bindings[0].text = "https://togetherweown.com";
    },
  ],
  [
    "changed verifier",
    (v) => {
      v.resources.bindings[1].text = "different-verifier";
    },
  ],
  [
    "changed DB",
    (v) => {
      v.resources.bindings.find((b) => b.name === "DB").id = "9".repeat(32);
    },
  ],
  [
    "extra binding field",
    (v) => {
      v.resources.bindings[0].extra = "retained";
    },
  ],
  [
    "wrong compatibility date",
    (v) => {
      v.resources.script_runtime.compatibility_date = "2020-01-01";
    },
  ],
  [
    "extra compatibility flag",
    (v) => {
      v.resources.script_runtime.compatibility_flags.push("other_flag");
    },
  ],
  [
    "extra runtime resource",
    (v) => {
      v.resources.script_runtime.containers = [{}];
    },
  ],
  [
    "absent runtime",
    (v) => {
      delete v.resources.script_runtime;
    },
  ],
])
  test(`refuses readback ${label} without receipt or retry`, async () => {
    await refused(
      {
        readReply: (v) => {
          mutate(v);
          return result(v);
        },
      },
      2,
    );
  });

for (const stage of ["uploadReply", "readReply", "contentReply"])
  for (const [label, response] of [
    [
      "provider failure",
      () =>
        new Response('{"success":false,"errors":[{"message":"sensitive"}]}', {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "nonempty errors",
      () =>
        new Response('{"success":true,"errors":[{"message":"sensitive"}],"result":{}}', {
          headers: { "content-type": "application/json" },
        }),
    ],
    ["bad HTTP", () => result({}, { status: 403 })],
    [
      "redirect",
      () => {
        const r = result({});
        Object.defineProperty(r, "redirected", { value: true });
        return r;
      },
    ],
    [
      "wrong final URL",
      () => {
        const r = result({});
        Object.defineProperty(r, "url", { value: "https://example.com" });
        return r;
      },
    ],
    ["wrong MIME", () => result({}, { headers: { "content-type": "text/html" } })],
    [
      "oversize length",
      () =>
        result(
          {},
          {
            headers: {
              "content-type": "application/json",
              "content-length": String((stage === "contentReply" ? 24 * 1024 * 1024 : 65536) + 1),
            },
          },
        ),
    ],
    [
      "oversize stream",
      () =>
        new Response(" ".repeat((stage === "contentReply" ? 24 * 1024 * 1024 : 65536) + 1), {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "invalid UTF-8",
      () => new Response(Buffer.from([255]), { headers: { "content-type": "application/json" } }),
    ],
    [
      "invalid JSON",
      () => new Response("sensitive", { headers: { "content-type": "application/json" } }),
    ],
    [
      "body failure",
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error(TOKEN));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ],
    [
      "network failure",
      () => {
        throw new Error(TOKEN);
      },
    ],
    [
      "abort",
      () => {
        throw new DOMException(TOKEN, "AbortError");
      },
    ],
  ])
    test(`redacts and refuses ${stage} ${label}`, async () => {
      await refused(
        { [stage]: response },
        { uploadReply: 1, readReply: 2, contentReply: 3 }[stage],
      );
    });

for (const stage of [1, 2, 3])
  for (const [label, time] of [
    ["expired", NOW + 1470],
    ["backward clock", NOW - 1],
    ["invalid clock", NaN],
  ])
    test(`refuses ${label} after provider call ${stage}`, async () => {
      let now = NOW;
      await refused(
        {
          clock: () => now,
          onFetch: (n) => {
            if (n === stage) now = time;
          },
        },
        stage,
      );
    });

function addChunk(f) {
  f.input.bundle.entries.push({
    path: "worker/chunks/chunk.mjs",
    type: "file",
    bytes: Buffer.from("export const n = 42;"),
  });
  f.input.bundle.entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  f.input.bundle.rootSha256 = candidateSha256(
    JSON.stringify(
      f.input.bundle.entries.map((e) => [e.path, e.bytes.length, candidateSha256(e.bytes)]),
    ),
  );
  f.input.bundle.files = f.input.bundle.entries.length;
  f.input.bundle.bytes = f.input.bundle.entries.reduce((n, e) => n + e.bytes.length, 0);
}

for (const [label, mutate] of [
  [
    "wrong UUID",
    (v) => {
      v.id = "0".repeat(8) + VERSION.slice(8);
    },
  ],
  [
    "missing modules",
    (v) => {
      delete v.modules;
    },
  ],
  [
    "missing module",
    (v) => {
      v.modules.pop();
    },
  ],
  [
    "extra module",
    (v) => {
      v.modules.push({ ...v.modules[0], name: "worker/extra.mjs" });
    },
  ],
  [
    "duplicate module",
    (v) => {
      v.modules[1] = v.modules[0];
    },
  ],
  [
    "wrong bytes with unchanged etag",
    (v) => {
      v.modules[0].content_base64 = Buffer.from("altered module bytes").toString("base64");
    },
  ],
  [
    "wrong chunk bytes",
    (v) => {
      v.modules.find((m) => m.name.includes("chunks/")).content_base64 =
        Buffer.from("export const n = 43;").toString("base64");
    },
  ],
  [
    "wrong entrypoint",
    (v) => {
      v.main_module = "worker/chunks/chunk.mjs";
    },
  ],
  [
    "current-script entrypoint",
    (v) => {
      v.main_module = "index.js";
    },
  ],
  [
    "path alias",
    (v) => {
      v.modules[0].name = "worker/../worker/worker.mjs";
    },
  ],
  [
    "case alias",
    (v) => {
      v.modules[0].name = v.modules[0].name.toUpperCase();
    },
  ],
  [
    "string modules",
    (v) => {
      v.modules = "not modules";
    },
  ],
  [
    "null module",
    (v) => {
      v.modules[0] = null;
    },
  ],
  [
    "wrong MIME",
    (v) => {
      v.modules[0].content_type = "text/plain";
    },
  ],
  [
    "extra module property",
    (v) => {
      v.modules[0].content_sha256 = "f".repeat(64);
    },
  ],
  [
    "missing module bytes",
    (v) => {
      delete v.modules[0].content_base64;
    },
  ],
  [
    "permissive base64 whitespace",
    (v) => {
      v.modules[0].content_base64 += "\n";
    },
  ],
  [
    "base64 garbage",
    (v) => {
      v.modules[0].content_base64 = "!!!!";
    },
  ],
  [
    "oversize base64",
    (v) => {
      v.modules[0].content_base64 = "A".repeat(4 * Math.ceil((16 * 1024 * 1024) / 3) + 4);
    },
  ],
  [
    "retained secret",
    (v) => {
      v.bindings.push({ name: "SECRET", type: "secret_text" });
    },
  ],
  [
    "different verifier",
    (v) => {
      v.bindings.find((b) => b.name === "QA_RUN_AUTH").text = "other";
    },
  ],
  [
    "different DB",
    (v) => {
      v.bindings.find((b) => b.name === "DB").id = "9".repeat(32);
    },
  ],
  [
    "wrong runtime",
    (v) => {
      v.compatibility_date = "2000-01-01";
    },
  ],
  [
    "wrong flags",
    (v) => {
      v.compatibility_flags.push("another_flag");
    },
  ],
  [
    "wrong tag",
    (v) => {
      v.annotations["workers/tag"] = "candidate-other";
    },
  ],
  [
    "other annotation",
    (v) => {
      v.annotations["workers/message"] = "other";
    },
  ],
  [
    "other trigger",
    (v) => {
      v.annotations["workers/triggered_by"] = "rollback";
    },
  ],
  [
    "preview URL",
    (v) => {
      v.urls.push("https://example.workers.dev");
    },
  ],
  [
    "missing URL state",
    (v) => {
      delete v.urls;
    },
  ],
  [
    "invalid creation",
    (v) => {
      v.created_on = "not a date";
    },
  ],
  [
    "invalid sequence",
    (v) => {
      v.number = 0;
    },
  ],
  [
    "unrequested assets",
    (v) => {
      v.assets = { config: { run_worker_first: true } };
    },
  ],
  [
    "unrequested limits",
    (v) => {
      v.limits = { cpu_ms: 50 };
    },
  ],
  [
    "unrequested placement",
    (v) => {
      v.placement = { mode: "smart" };
    },
  ],
  [
    "container",
    (v) => {
      v.containers = [{ class_name: "App" }];
    },
  ],
  [
    "migration",
    (v) => {
      v.migrations = { new_tag: "v1" };
    },
  ],
  [
    "migration tag",
    (v) => {
      v.migration_tag = "v1";
    },
  ],
  [
    "tail consumer",
    (v) => {
      v.tail_consumers = [{ service: "other" }];
    },
  ],
  [
    "streaming tail",
    (v) => {
      v.streaming_tail_consumers = [{ service: "other" }];
    },
  ],
  [
    "cache enabled",
    (v) => {
      v.exports = { default: { type: "worker", cache: { enabled: true } } };
    },
  ],
  [
    "named export",
    (v) => {
      v.exports = { other: { type: "worker", cache: { enabled: false } } };
    },
  ],
  [
    "package dependencies",
    (v) => {
      v.package_dependencies = [];
    },
  ],
  [
    "unknown top-level field",
    (v) => {
      v.unknown = "not ignored";
    },
  ],
])
  test(`refuses immutable content ${label}`, async () => {
    const f = fixture();
    addChunk(f);
    await refused(
      {
        f,
        contentReply: (v) => {
          mutate(v);
          return result(v);
        },
      },
      3,
    );
  });

for (const [label, mutate] of [
  [
    "missing assets",
    (v) => {
      delete v.assets;
    },
  ],
  [
    "missing config",
    (v) => {
      delete v.assets.config;
    },
  ],
  [
    "asset-first routing",
    (v) => {
      v.assets.config.run_worker_first = false;
    },
  ],
  [
    "redirect config",
    (v) => {
      v.assets.config._redirects = "/ /other 302";
    },
  ],
  [
    "HTML handling",
    (v) => {
      v.assets.config.html_handling = "auto-trailing-slash";
    },
  ],
  [
    "unknown asset field",
    (v) => {
      v.assets.other = "not ignored";
    },
  ],
  [
    "other ticket",
    (v) => {
      v.assets.jwt = "other.ticket.value";
    },
  ],
])
  test(`refuses immutable content ${label} with assets`, async () => {
    await refused(
      {
        f: fixture({ assets: true }),
        contentReply: (v) => {
          mutate(v);
          return result(v);
        },
      },
      5,
    );
  });

test("admits remote modules in any order, optional inert provider defaults and matching asset ticket", async () => {
  const f = fixture({ assets: true });
  addChunk(f);
  const s = setup({
    f,
    contentReply: (v) => {
      v.modules.reverse();
      v.bindings.reverse();
      v.annotations["workers/triggered_by"] = "upload";
      v.assets.jwt = TICKET;
      v.containers = [];
      v.usage_model = "standard";
      v.exports = { default: { type: "worker", cache: { enabled: false } } };
      v.author_email = "fixture@example.com";
      v.author_id = "fixture-author";
      v.source = "api";
      v.startup_time_ms = 1;
      return result(v);
    },
  });
  const proof = await s.upload();
  assert.equal(s.calls.length, 5);
  assert.equal(proof.promotable, false);
  assert.match(proof.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(proof).includes(TICKET), false);
  assert.equal(JSON.stringify(proof).includes("fixture-author"), false);
});

for (const [label, encoded] of [
  ["noncanonical pad bits", "/x=="],
  ["alternate alphabet", "_w=="],
])
  test(`refuses immutable module ${label} even when decoded bytes match`, async () => {
    const f = fixture();
    f.input.bundle.entries[0].bytes = Buffer.from([255]);
    addChunk(f);
    assert.deepEqual(Buffer.from(encoded, "base64"), Buffer.from([255]));
    await refused(
      {
        f,
        contentReply: (v) => {
          v.modules.find((m) => m.name === "worker/worker.mjs").content_base64 = encoded;
          return result(v);
        },
      },
      3,
    );
  });

test("content hash is deterministic across remote ordering and rejects changed bytes under the same etag", async () => {
  const f = fixture({ assets: true });
  addChunk(f);
  const first = await setup({ f }).upload();
  const second = await setup({
    f,
    contentReply: (v) => {
      v.modules.reverse();
      v.bindings.reverse();
      return result(v);
    },
  }).upload();
  assert.equal(first.contentSha256, second.contentSha256);
  assert.equal(first.etag, second.etag);
  const changed = setup({
    f,
    contentReply: (v) => {
      const module = v.modules.find((m) => m.name === "worker/worker.mjs");
      const bytes = Buffer.from(module.content_base64, "base64");
      bytes[0] ^= 1;
      module.content_base64 = bytes.toString("base64");
      return result(v);
    },
  });
  await assert.rejects(changed.upload(), ERROR);
  assert.equal(changed.calls.length, 5);
});

test("a valid content response larger than the narrow projection cap is admitted", async () => {
  const f = fixture();
  f.input.bundle.entries[0].bytes = Buffer.alloc(100_000, "x");
  addChunk(f);
  const s = setup({ f });
  const proof = await s.upload();
  assert.match(proof.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(s.calls.length, 3);
});

test("asset transport failure never reaches version creation", async () => {
  const s = setup({
    f: fixture({ assets: true }),
    onFetch: (n) => {
      if (n === 2) throw new Error(TICKET);
    },
  });
  await assert.rejects(s.upload(), ERROR);
  assert.equal(s.calls.length, 2);
  assert.ok(s.calls.every((c) => !c.url.includes("/versions")));
});

test("original deadline is shared with assets and cannot restart at version upload", async () => {
  let now = NOW;
  await refused(
    {
      f: fixture({ assets: true }),
      clock: () => now,
      onFetch: (n) => {
        if (n === 2) now = NOW + 1470;
      },
    },
    2,
  );
});

for (const assets of [false, true])
  for (const [label, phase, mutate] of [
    [
      "initial Logpush sink",
      1,
      (v) => {
        v.logpush = true;
      },
    ],
    [
      "initial preview enabled",
      2,
      (v) => {
        v.previews_enabled = true;
      },
    ],
    [
      "post-upload Logpush drift",
      3,
      (v) => {
        v.logpush = true;
      },
    ],
    [
      "post-upload tail drift",
      3,
      (v) => {
        v.tail_consumers = [{ service: "other" }];
      },
    ],
    [
      "post-upload preview drift",
      4,
      (v) => {
        v.previews_enabled = true;
      },
    ],
    [
      "post-upload unknown state",
      4,
      (v) => {
        v.other = false;
      },
    ],
  ])
    test(`refuses ${label} (${assets ? "assets" : "module-only"})`, async () => {
      const s = setup({
        f: fixture({ assets }),
        settingsReply: (v, n) => {
          if (n === phase) mutate(v);
          return result(v);
        },
      });
      await assert.rejects(s.upload(), ERROR);
      assert.equal(s.settingsCalls.length, phase);
      assert.equal(s.calls.length, phase <= 2 ? 0 : assets ? 5 : 3);
      assert.equal(
        s.trace.some((c) => /deployments|production/.test(c.url)),
        false,
      );
    });

for (const phase of [1, 2, 3, 4])
  test(`settings transport failure in phase ${phase} never returns version evidence`, async () => {
    const s = setup({
      settingsReply: (v, n) => {
        if (n === phase) throw new Error(TOKEN);
        return result(v);
      },
    });
    await assert.rejects(s.upload(), ERROR);
    assert.equal(s.settingsCalls.length, phase);
    assert.equal(s.calls.length, phase <= 2 ? 0 : 3);
  });

test("input is snapshotted before pre-upload settings observation", async () => {
  const f = fixture({ assets: true });
  const original = Buffer.from(f.input.bundle.entries.at(-1).bytes);
  const q = f.input.identity.q;
  const root = f.input.bundle.rootSha256;
  const s = setup({
    f,
    onSettingsFetch: (n) => {
      if (n !== 1) return;
      f.profile.accountId = "3".repeat(32);
      f.input.bundle.entries.at(-1).bytes.fill(0);
      f.input.bundle.build.runAttempt = "2";
      f.input.identity.q = "0".repeat(64);
      f.input.verifier = "replaced";
    },
  });
  const proof = await s.upload();
  assert.equal(proof.q, q);
  assert.equal(proof.bundleRootSha256, root);
  assert.equal(proof.build.runAttempt, "1");
  assert.equal(s.settingsCalls.length, 4);
  assert.deepEqual(
    Buffer.from(await s.calls.at(-3).body.get("worker/worker.mjs").arrayBuffer()),
    original,
  );
  assert.ok(s.settingsCalls.every((c) => c.url.startsWith(BASE)));
});

for (const phase of [2, 4])
  test(`settings phase ${phase} cannot restart the original credential lifetime`, async () => {
    let now = NOW;
    const s = setup({
      clock: () => now,
      onSettingsFetch: (n) => {
        if (n === phase) now = NOW + 1470;
      },
    });
    await assert.rejects(s.upload(), ERROR);
    assert.equal(s.settingsCalls.length, phase);
    assert.equal(s.calls.length, phase === 2 ? 0 : 3);
  });

for (const phase of [1, 2, 3, 4])
  test(`uploader deadline aborts a pending settings request in phase ${phase}`, async (t) => {
    const original = AbortSignal.timeout;
    const overall = new AbortController();
    t.mock.method(AbortSignal, "timeout", (ms) => (ms === 180_000 ? overall.signal : original(ms)));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let response;
    const s = setup({
      settingsReply: (v, n) => {
        if (n !== phase) return result(v);
        response = result(v);
        entered.resolve(s.settingsCalls.at(-1).signal);
        return release.promise;
      },
    });
    const pending = s.upload();
    const signal = await Promise.race([
      entered.promise,
      pending.then(
        () => {
          throw new Error("Settings phase was not reached");
        },
        () => {
          throw new Error("Settings phase was not reached");
        },
      ),
    ]);
    assert.equal(signal.aborted, false);
    overall.abort(new Error(TOKEN));
    const abortedDuringRequest = signal.aborted;
    // Always release the mock so a failing assertion cannot strand the test.
    release.resolve(response);
    await assert.rejects(pending, ERROR);
    assert.equal(abortedDuringRequest, true);
    assert.equal(s.settingsCalls.length, phase);
  });

test("final settings observation cannot outlive the uploader's shared deadline", async (t) => {
  const original = AbortSignal.timeout;
  const overall = new AbortController();
  const bounds = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    bounds.push(ms);
    return ms === 180_000 ? overall.signal : original(ms);
  });
  const s = setup({
    onSettingsFetch: (n) => {
      if (n === 4) overall.abort(new Error(TOKEN));
    },
  });
  await assert.rejects(s.upload(), ERROR);
  assert.equal(s.settingsCalls.length, 4);
  assert.equal(s.calls.length, 3);
  assert.equal(bounds.filter((ms) => ms === 180_000).length, 1);
  assert.equal(bounds.filter((ms) => ms === 30_000).length, 2);
});
