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

function setup({ f = fixture(), uploadReply, readReply, clock = () => NOW, onFetch } = {}) {
  const calls = [];
  let metadata;
  const uploader = createCandidateVersionUploader({
    token: TOKEN,
    profile: f.profile,
    profileSha256: f.profileSha256,
    clock,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (onFetch) await onFetch(calls.length, f);
      if (url.endsWith("/assets-upload-session")) {
        const manifest = JSON.parse(options.body).manifest;
        return result({ jwt: TICKET, buckets: [Object.values(manifest).map((v) => v.hash)] });
      }
      if (url.includes("/assets/upload")) return result({ jwt: TICKET });
      if (options.method === "POST") {
        metadata = JSON.parse(options.body.get("metadata"));
        const value = { id: VERSION, resources: { script: { etag: ETAG } } };
        return uploadReply ? uploadReply(value) : result(value);
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
  return { calls, f, upload: () => uploader.upload(f.input) };
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
    assert.equal(s.calls.length, assets ? 4 : 2);
    const [post, get] = s.calls.slice(-2);
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
    assert.equal(proof.schema, "two.candidate-version-upload.v1");
    assert.equal(proof.promotable, false);
    assert.equal(proof.versionId, VERSION);
    assert.equal(proof.etag, ETAG);
    assert.equal(proof.q, s.f.input.identity.q);
    assert.equal(proof.bundleRootSha256, s.f.input.bundle.rootSha256);
    assert.equal(proof.readbackScope, "version-bindings-and-runtime-only");
    assert.match(proof.readbackSha256, /^[a-f0-9]{64}$/);
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
  const post = s.calls.at(-2);
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

for (const stage of ["uploadReply", "readReply"])
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
        result({}, { headers: { "content-type": "application/json", "content-length": "65537" } }),
    ],
    [
      "oversize stream",
      () => new Response(" ".repeat(65537), { headers: { "content-type": "application/json" } }),
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
      await refused({ [stage]: response }, stage === "uploadReply" ? 1 : 2);
    });

for (const stage of [1, 2])
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
