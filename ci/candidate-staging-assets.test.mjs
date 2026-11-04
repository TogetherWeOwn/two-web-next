import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { createCandidateAssetUploader } from "./candidate-staging-assets.mjs";
import { prepareCandidateWebUpload } from "./candidate-staging-upload.mjs";

const NOW = 1793819000;
const TOKEN = "fixture-provider-bearer";
const ERROR = { message: "Candidate assets refused: transport" };
const BASE = `https://api.cloudflare.com/client/v4/accounts/${"1".repeat(32)}`;
const require = createRequire(import.meta.url);
const { hash } = createRequire(require.resolve("wrangler/package.json"))("blake3-wasm");

function jwt(extra = {}) {
  return `fixture.${Buffer.from(JSON.stringify({ exp: NOW + 1800, ...extra })).toString("base64url")}.signature`;
}
const SESSION = jwt();
const COMPLETE = jwt({ complete: true });

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
  const entries = [
    { path: "assets/app.css", type: "file", bytes: Buffer.from("body{}") },
    { path: "assets/logo.bin", type: "file", bytes: Buffer.from([0, 1, 254, 255]) },
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
    bindings: [],
  };
  const value = {
    identity,
    bundle: {
      q: identity.q,
      build: { runId: "500", runAttempt: "1", artifactId: "600", archiveSha256: "d".repeat(64) },
      rootSha256: "",
      bytes: 0,
      files: 0,
      entries,
    },
    profile,
    profileSha256: candidateSha256(JSON.stringify(profile)),
    verifier: JSON.stringify({
      schema: "two.qa.verifier.v1",
      descriptor: identity.descriptor,
      q: identity.q,
      credentialSha256: "e".repeat(64),
      issuedAt: NOW,
      notBefore: NOW,
      expiresAt: NOW + 1500,
    }),
  };
  rehash(value);
  return value;
}

function rehash(value) {
  value.bundle.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  value.bundle.rootSha256 = candidateSha256(
    JSON.stringify(
      value.bundle.entries.map((e) => [e.path, e.bytes.length, candidateSha256(e.bytes)]),
    ),
  );
  value.bundle.bytes = value.bundle.entries.reduce((n, e) => n + e.bytes.length, 0);
  value.bundle.files = value.bundle.entries.length;
}

function result(value, init = {}) {
  return new Response(JSON.stringify({ success: true, errors: [], result: value }), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function setup({ input = fixture(), session, replies = [], clock = () => NOW, onFetch } = {}) {
  const calls = [];
  const uploader = createCandidateAssetUploader({
    token: TOKEN,
    clock,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (onFetch) await onFetch(calls.length, input);
      if (calls.length === 1) {
        const manifest = JSON.parse(options.body).manifest;
        return session
          ? session(manifest)
          : result({ jwt: SESSION, buckets: [Object.values(manifest).map((v) => v.hash)] });
      }
      const reply = replies[calls.length - 2];
      return typeof reply === "function" ? reply() : (reply ?? result({ jwt: COMPLETE }));
    },
  });
  return { calls, input, upload: () => uploader.upload(input) };
}

async function refused(options, expectedCalls) {
  const f = setup(options);
  await assert.rejects(f.upload(), ERROR);
  if (expectedCalls !== undefined) assert.equal(f.calls.length, expectedCalls);
}

test("accepts a full-cardinality session requesting every admitted asset", async () => {
  const input = fixture();
  input.bundle.entries = [
    input.bundle.entries[2],
    ...Array.from({ length: 4095 }, (_, i) => ({
      path: `assets/file-${i}.txt`,
      type: "file",
      bytes: Buffer.from(String(i)),
    })),
  ];
  rehash(input);
  let responseBytes = 0;
  const f = setup({
    input,
    session: (manifest) => {
      const response = result({
        jwt: SESSION,
        buckets: [Object.values(manifest).map((v) => v.hash)],
      });
      responseBytes = Buffer.byteLength(
        JSON.stringify({ jwt: SESSION, buckets: [Object.values(manifest).map((v) => v.hash)] }),
      );
      return response;
    },
  });
  const ticket = await f.upload();
  assert.ok(responseBytes > 128 * 1024);
  assert.equal(ticket.bundleRootSha256, input.bundle.rootSha256);
  assert.equal(f.calls.length, 2);
  assert.equal([...f.calls[1].body.keys()].length, 4095);
});

for (const single of [false, true])
  test(`preserves UTF-8 text metadata and bytes in ${single ? "single" : "bulk"} mode`, async () => {
    const input = fixture();
    input.bundle.entries[0] = {
      path: "assets/index.html",
      type: "file",
      bytes: Buffer.from("<p>café</p>"),
    };
    rehash(input);
    const sessionJwt = jwt({ wrangler_single_asset_uploads: single });
    const f = setup({
      input,
      session: (manifest) =>
        result({ jwt: sessionJwt, buckets: [Object.values(manifest).map((v) => v.hash)] }),
    });
    await f.upload();
    if (single) {
      assert.equal(f.calls[1].headers["Content-Type"], "text/html; charset=utf-8");
      assert.deepEqual(
        Buffer.from(await f.calls[1].body.arrayBuffer()),
        input.bundle.entries[0].bytes,
      );
    } else {
      const part = [...f.calls[1].body.values()][0];
      assert.equal(part.type, "text/html; charset=utf-8");
      assert.deepEqual(Buffer.from(await part.text(), "base64"), input.bundle.entries[0].bytes);
    }
  });

test("uploads copied inert assets with fixed endpoints and separate capability, joining the version constructor", async () => {
  const f = setup();
  const ticket = await f.upload();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, `${BASE}/workers/scripts/two-web-next/assets-upload-session`);
  assert.equal(f.calls[0].method, "POST");
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls[0].headers["Content-Type"], "application/json");
  const manifest = JSON.parse(f.calls[0].body).manifest;
  assert.deepEqual(manifest, {
    "/app.css": {
      hash: hash(Buffer.from("body{}").toString("base64") + "css")
        .toString("hex")
        .slice(0, 32),
      size: 6,
    },
    "/logo.bin": {
      hash: hash(Buffer.from([0, 1, 254, 255]).toString("base64") + "bin")
        .toString("hex")
        .slice(0, 32),
      size: 4,
    },
  });
  assert.equal(f.calls[1].url, `${BASE}/workers/assets/upload?base64=true`);
  assert.deepEqual(f.calls[1].headers, { Authorization: `Bearer ${SESSION}` });
  assert.equal(f.calls[1].headers.Authorization.includes(TOKEN), false);
  for (const [index, value] of Object.values(manifest).entries()) {
    const file = f.calls[1].body.get(value.hash);
    assert.equal(file.name, value.hash);
    assert.equal(file.type, index === 0 ? "text/css; charset=utf-8" : "application/octet-stream");
    assert.deepEqual(Buffer.from(await file.text(), "base64"), f.input.bundle.entries[index].bytes);
  }
  for (const request of f.calls) {
    assert.equal(request.redirect, "error");
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.signal.aborted, false);
    assert.equal(JSON.stringify(request.headers).includes(f.input.verifier), false);
  }
  assert.deepEqual(Object.keys(ticket).sort(), ["assetRootSha256", "bundleRootSha256", "jwt", "q"]);
  assert.equal(ticket.q, f.input.identity.q);
  assert.equal(ticket.bundleRootSha256, f.input.bundle.rootSha256);
  assert.equal(ticket.jwt, COMPLETE);
  assert.ok(Object.isFrozen(ticket));
  const version = prepareCandidateWebUpload({ ...f.input, assetsTicket: ticket, now: NOW });
  assert.equal(JSON.parse(version.form.get("metadata")).assets.jwt, COMPLETE);
  assert.equal(JSON.stringify(version.proof).includes(COMPLETE), false);
});

test("supports provider-selected single uploads using raw binary and only the session bearer", async () => {
  const sessionJwt = jwt({ wrangler_single_asset_uploads: true });
  const f = setup({
    session: (manifest) =>
      result({ jwt: sessionJwt, buckets: [Object.values(manifest).map((v) => v.hash)] }),
    replies: [result({}), result({ jwt: COMPLETE })],
  });
  assert.equal((await f.upload()).jwt, COMPLETE);
  assert.equal(f.calls.length, 3);
  const manifest = JSON.parse(f.calls[0].body).manifest;
  for (const [i, entry] of Object.values(manifest).entries()) {
    assert.equal(f.calls[i + 1].url, `${BASE}/workers/assets/upload/${entry.hash}`);
    assert.equal(f.calls[i + 1].headers.Authorization, `Bearer ${sessionJwt}`);
    assert.deepEqual(
      Buffer.from(await f.calls[i + 1].body.arrayBuffer()),
      f.input.bundle.entries[i].bytes,
    );
  }
});

test("deduplicates equal hash inputs while retaining both manifest paths", async () => {
  const input = fixture();
  input.bundle.entries.push({ ...input.bundle.entries[0], path: "assets/copy.css" });
  rehash(input);
  const f = setup({
    input,
    session: (manifest) =>
      result({ jwt: SESSION, buckets: [[...new Set(Object.values(manifest).map((v) => v.hash))]] }),
  });
  await f.upload();
  assert.equal(Object.keys(JSON.parse(f.calls[0].body).manifest).length, 3);
  assert.equal([...f.calls[1].body.keys()].length, 2);
});

test("already-present assets require no bucket writes", async () => {
  const f = setup({ session: () => result({ jwt: COMPLETE, buckets: [] }) });
  assert.equal((await f.upload()).jwt, COMPLETE);
  assert.equal(f.calls.length, 1);
});

test("module-only bundles never create an asset session", async () => {
  const input = fixture();
  input.bundle.entries = input.bundle.entries.filter((e) => e.path.startsWith("worker/"));
  rehash(input);
  const f = setup({ input });
  assert.equal(await f.upload(), null);
  assert.equal(f.calls.length, 0);
});

test("caller mutation during session read cannot substitute bytes, paths or root", async () => {
  const input = fixture();
  const original = Buffer.from(input.bundle.entries[0].bytes);
  const root = input.bundle.rootSha256;
  const f = setup({
    input,
    onFetch: (n) => {
      if (n === 1) {
        input.bundle.entries[0].bytes.fill(0);
        input.bundle.entries[0].path = "assets/replaced.css";
        input.bundle.rootSha256 = "f".repeat(64);
        input.profile.accountId = "f".repeat(32);
        input.identity = { ...input.identity, q: "f".repeat(64) };
      }
    },
  });
  assert.equal((await f.upload()).bundleRootSha256, root);
  const part = [...f.calls[1].body.values()][0];
  assert.deepEqual(Buffer.from(await part.text(), "base64"), original);
  assert.ok(f.calls.every((c) => c.url.startsWith(`${BASE}/`)));
});

for (const [name, mutate] of [
  ["changed bytes", (v) => v.bundle.entries[0].bytes.fill(0)],
  [
    "changed bundle root",
    (v) => {
      v.bundle.rootSha256 = "f".repeat(64);
    },
  ],
  [
    "wrong Q",
    (v) => {
      v.bundle.q = "f".repeat(64);
    },
  ],
  [
    "changed profile",
    (v) => {
      v.profile.accountId = "f".repeat(32);
    },
  ],
  [
    "production target even repinned",
    (v) => {
      v.profile.scriptName = "two-web-next-production";
      v.profileSha256 = candidateSha256(JSON.stringify(v.profile));
    },
  ],
  [
    "expired verifier",
    (v) => {
      const r = JSON.parse(v.verifier);
      r.issuedAt -= 1500;
      r.notBefore -= 1500;
      r.expiresAt -= 1500;
      v.verifier = JSON.stringify(r);
    },
  ],
  [
    "caller URL",
    (v) => {
      v.url = "https://example.invalid";
    },
  ],
  [
    "caller clock",
    (v) => {
      v.now = NOW;
    },
  ],
  [
    "caller ticket",
    (v) => {
      v.assetsTicket = COMPLETE;
    },
  ],
])
  test(`refuses ${name} before any provider call`, async () => {
    const input = fixture();
    mutate(input);
    await refused({ input }, 0);
  });

for (const name of ["_worker.js", "_headers", "_redirects", "nested/_worker.js/source.mjs"])
  test(`refuses asset control path ${name} before provider calls`, async () => {
    const input = fixture();
    input.bundle.entries[0].path = `assets/${name}`;
    rehash(input);
    await refused({ input }, 0);
  });

for (const [name, make] of [
  ["unknown hash", () => [["f".repeat(32)]]],
  ["duplicate hash", (h) => [[h[0]], [h[0]]]],
  ["empty bucket", () => [[]]],
  ["non-array bucket", () => ["x"]],
  ["non-array buckets", () => ({})],
  ["too many buckets", (h) => [[h[0]], [h[1]], [h[0]]]],
  ["invalid hash", () => [["x\n"]]],
])
  test(`refuses provider ${name} without any bucket write`, async () => {
    await refused(
      {
        session: (manifest) =>
          result({ jwt: SESSION, buckets: make(Object.values(manifest).map((v) => v.hash)) }),
      },
      1,
    );
  });

for (const value of [
  null,
  "",
  "fixture.bad.signature",
  jwt({ exp: NOW + 30 }),
  jwt({ exp: 1.2 }),
  jwt({ exp: "future" }),
  jwt({ exp: 253402300800 }),
  jwt({ wrangler_single_asset_uploads: "true" }),
  "a".repeat(8193),
])
  test(`refuses malformed or expired session capability ${String(value).slice(0, 22)}`, async () => {
    await refused({ session: () => result({ jwt: value, buckets: [] }) }, 1);
  });

for (const [name, response] of [
  ["HTTP failure", () => result({}, { status: 403 })],
  ["redirect status", () => result({}, { status: 302 })],
  [
    "redirect followed",
    () => {
      const r = result({});
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
  ],
  ["wrong content type", () => new Response("{}")],
  [
    "oversized declaration",
    () =>
      result({}, { headers: { "content-type": "application/json", "content-length": "176129" } }),
  ],
  [
    "oversized stream",
    () => new Response(" ".repeat(176129), { headers: { "content-type": "application/json" } }),
  ],
  [
    "invalid utf8",
    () => new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
  ],
  ["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
  [
    "failed envelope",
    () =>
      new Response(JSON.stringify({ success: false, errors: [], result: {} }), {
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "nonempty errors",
    () =>
      new Response(JSON.stringify({ success: true, errors: ["secret-marker"], result: {} }), {
        headers: { "content-type": "application/json" },
      }),
  ],
  ["no result", () => result(null)],
])
  test(`rejects and sanitizes provider ${name}`, async () => {
    await refused({ session: response }, 1);
  });

test("missing completion refuses even after successful bucket transport", async () => {
  await refused({ replies: [result({})] }, 2);
});
test("expired completion refuses", async () => {
  await refused({ replies: [result({ jwt: jwt({ exp: NOW }) })] }, 2);
});
test("bucket error is not retried and cannot leak provider content", async () => {
  await refused(
    {
      replies: [
        () => {
          throw new Error(`secret-marker ${TOKEN} ${SESSION}`);
        },
      ],
    },
    2,
  );
});
test("multiple buckets must all complete before a ticket is returned", async () => {
  const f = setup({
    session: (manifest) =>
      result({ jwt: SESSION, buckets: Object.values(manifest).map((v) => [v.hash]) }),
    replies: [result({ jwt: COMPLETE }), result({}, { status: 500 })],
  });
  await assert.rejects(f.upload(), ERROR);
  assert.equal(f.calls.length, 3);
});
test("clock expiry after session prevents bucket write", async () => {
  let time = NOW;
  await refused(
    {
      clock: () => time,
      onFetch: () => {
        time = NOW + 1470;
      },
    },
    1,
  );
});
test("clock rollback after session prevents bucket write", async () => {
  let time = NOW;
  await refused(
    {
      clock: () => time,
      onFetch: () => {
        time--;
      },
    },
    1,
  );
});
test("invalid initial clock refuses before provider calls", async () => {
  await refused({ clock: () => NaN }, 0);
});
test("clock expiry during bucket response prevents a completion ticket", async () => {
  let time = NOW;
  await refused(
    {
      clock: () => time,
      onFetch: (n) => {
        if (n === 2) time = NOW + 1470;
      },
    },
    2,
  );
});
