import assert from "node:assert/strict";
import test from "node:test";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { prepareCandidateWebUpload } from "./candidate-staging-upload.mjs";

function fixture({ assets = true } = {}) {
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
    { path: "worker/chunks/app.mjs", type: "file", bytes: Buffer.from("export const value = 1") },
    {
      path: "worker/worker.mjs",
      type: "file",
      bytes: Buffer.from('throw new Error("candidate module must never execute")'),
    },
  ];
  const records = entries.map((entry) => [
    entry.path,
    entry.bytes.length,
    candidateSha256(entry.bytes),
  ]);
  const root = candidateSha256(JSON.stringify(records));
  const assetRoot = candidateSha256(
    JSON.stringify(records.filter(([path]) => path.startsWith("assets/"))),
  );
  const profile = {
    schema: "two.candidate-upload-profile.v1",
    accountId: "1".repeat(32),
    scriptName: "two-web-next",
    bindings: [
      { name: "DB", type: "hyperdrive", id: "2".repeat(32) },
      { name: "BOT_DB", type: "hyperdrive", id: "3".repeat(32) },
      { name: "DISCORD_CLIENT_ID", type: "plain_text", text: "1234" },
      { name: "DISCORD_GUILD_ID", type: "plain_text", text: "5678" },
    ],
  };
  const now = 1793819000;
  return {
    identity,
    bundle: {
      q: identity.q,
      build: { runId: "500", runAttempt: "1", artifactId: "600", archiveSha256: "d".repeat(64) },
      rootSha256: root,
      files: entries.length,
      bytes: entries.reduce((size, entry) => size + entry.bytes.length, 0),
      entries,
    },
    profile,
    profileSha256: candidateSha256(JSON.stringify(profile)),
    verifier: JSON.stringify({
      schema: "two.qa.verifier.v1",
      descriptor: identity.descriptor,
      q: identity.q,
      credentialSha256: "e".repeat(64),
      issuedAt: now,
      notBefore: now,
      expiresAt: now + 1500,
    }),
    assetsTicket: assets
      ? {
          q: identity.q,
          bundleRootSha256: root,
          assetRootSha256: assetRoot,
          jwt: "fixture.session.ticket",
        }
      : null,
    now,
  };
}

function repin(input) {
  input.profileSha256 = candidateSha256(JSON.stringify(input.profile));
}

function changeVerifier(input, mutate) {
  const value = JSON.parse(input.verifier);
  mutate(value);
  input.verifier = JSON.stringify(value);
}

function refusal(input) {
  assert.throws(() => prepareCandidateWebUpload(input), {
    message: "Candidate upload refused: request",
  });
}

test("builds an explicit inert multipart web version request, not a deployment", async () => {
  const input = fixture();
  const request = prepareCandidateWebUpload(input);
  assert.equal(request.method, "POST");
  assert.equal(
    request.url,
    `https://api.cloudflare.com/client/v4/accounts/${input.profile.accountId}/workers/scripts/two-web-next/versions?bindings_inherit=strict`,
  );
  const metadata = JSON.parse(request.form.get("metadata"));
  assert.deepEqual(Object.keys(metadata).sort(), [
    "annotations",
    "assets",
    "bindings",
    "compatibility_date",
    "compatibility_flags",
    "keep_assets",
    "keep_bindings",
    "main_module",
    "streaming_tail_consumers",
    "tail_consumers",
  ]);
  assert.deepEqual(metadata.keep_bindings, []);
  assert.equal(metadata.keep_assets, false);
  assert.deepEqual(metadata.tail_consumers, []);
  assert.deepEqual(metadata.streaming_tail_consumers, []);
  assert.equal(metadata.compatibility_date, "2026-09-29");
  assert.deepEqual(metadata.compatibility_flags, ["nodejs_compat"]);
  assert.deepEqual(metadata.assets, {
    jwt: input.assetsTicket.jwt,
    config: { run_worker_first: true },
  });
  assert.deepEqual(metadata.bindings, [
    { name: "APP_URL", type: "plain_text", text: "https://next.togetherweown.com" },
    { name: "QA_RUN_AUTH", type: "plain_text", text: input.verifier },
    { name: "CF_VERSION_METADATA", type: "version_metadata" },
    ...input.profile.bindings,
    { name: "ASSETS", type: "assets" },
  ]);
  assert.equal(metadata.main_module, "worker/worker.mjs");
  assert.match(metadata.annotations["workers/tag"], /^candidate-[a-f0-9]{32}$/);
  assert.deepEqual(
    [...request.form.keys()],
    ["metadata", "worker/chunks/app.mjs", "worker/worker.mjs"],
  );
  for (const entry of input.bundle.entries.filter((entry) => entry.path.startsWith("worker/"))) {
    const part = request.form.get(entry.path);
    assert.equal(part.name, entry.path);
    assert.equal(part.type, "application/javascript+module");
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), entry.bytes);
  }
  assert.equal(request.form.has("assets/app.css"), false);
  assert.equal(request.proof.purpose, "premerge-candidate");
  assert.equal(request.proof.promotable, false);
  assert.equal(request.proof.q, input.identity.q);
  assert.equal(request.proof.headSha, input.identity.descriptor[4]);
  assert.equal(request.proof.controllerSha, input.identity.descriptor[5]);
  assert.deepEqual(request.proof.build, input.bundle.build);
  assert.equal(request.proof.metadataSha256, candidateSha256(request.form.get("metadata")));
  assert.equal(JSON.stringify(request.proof).includes(input.assetsTicket.jwt), false);
  assert.equal(JSON.stringify(request.proof).includes(input.verifier), false);
  assert.ok(
    Object.isFrozen(request) &&
      Object.isFrozen(request.proof) &&
      Object.isFrozen(request.proof.build),
  );
});

test("does not implicitly keep a baseline's assets for a module-only bundle", () => {
  const request = prepareCandidateWebUpload(fixture({ assets: false }));
  const metadata = JSON.parse(request.form.get("metadata"));
  assert.equal(metadata.assets, undefined);
  assert.equal(metadata.keep_assets, false);
  assert.equal(
    metadata.bindings.some((binding) => binding.name === "ASSETS"),
    false,
  );
});

test("snapshots bytes and metadata; caller mutation cannot change prepared parts or proof", async () => {
  const input = fixture();
  const request = prepareCandidateWebUpload(input);
  const encoded = request.form.get("metadata");
  const proof = JSON.stringify(request.proof);
  const original = Buffer.from(input.bundle.entries[2].bytes);
  input.bundle.entries[2].bytes.fill(0);
  input.profile.bindings[0].id = "f".repeat(32);
  input.bundle.build.runAttempt = "2";
  input.assetsTicket.jwt = "other.session.ticket";
  input.verifier = "replaced";
  assert.equal(request.form.get("metadata"), encoded);
  assert.equal(JSON.stringify(request.proof), proof);
  assert.deepEqual(
    Buffer.from(await request.form.get("worker/worker.mjs").arrayBuffer()),
    original,
  );
});

const badProfiles = [
  [
    "production target",
    (v) => {
      v.scriptName = "two-web-next-production";
    },
  ],
  [
    "preview target",
    (v) => {
      v.scriptName = "two-web-next-kit-preview";
    },
  ],
  [
    "account injection",
    (v) => {
      v.accountId = "1/../production";
    },
  ],
  [
    "remote retention",
    (v) => {
      v.keep_bindings = ["secret_text"];
    },
  ],
  [
    "config injection",
    (v) => {
      v.compatibility_flags = ["nodejs_compat", "unsafe"];
    },
  ],
  [
    "secret binding",
    (v) => {
      v.bindings[0] = { name: "DB", type: "secret_text", text: "not-a-secret" };
    },
  ],
  [
    "inherit binding",
    (v) => {
      v.bindings[0] = { name: "DB", type: "inherit" };
    },
  ],
  [
    "secret store",
    (v) => {
      v.bindings[0] = { name: "DB", type: "secrets_store_secret", id: "2".repeat(32) };
    },
  ],
  [
    "service capability",
    (v) => {
      v.bindings[0] = { name: "DB", type: "service", service: "two-web-next-production" };
    },
  ],
  [
    "connection string",
    (v) => {
      v.bindings[0].connectionString = "not-a-connection-string";
    },
  ],
  [
    "duplicate binding",
    (v) => {
      v.bindings[1] = v.bindings[0];
    },
  ],
  [
    "verifier override",
    (v) => {
      v.bindings[0] = { name: "QA_RUN_AUTH", type: "plain_text", text: "override" };
    },
  ],
  [
    "legacy QA override",
    (v) => {
      v.bindings[0] = { name: "QA_AUTH_TOKEN", type: "plain_text", text: "override" };
    },
  ],
  [
    "session key",
    (v) => {
      v.bindings[0] = { name: "SESSION_SECRET", type: "plain_text", text: "override" };
    },
  ],
  [
    "public field bearer",
    (v) => {
      v.bindings[2].text = "qa1.not-an-id";
    },
  ],
  [
    "public field number",
    (v) => {
      v.bindings[2].text = 1234;
    },
  ],
  [
    "malformed resource",
    (v) => {
      v.bindings[0].id = "z".repeat(32);
    },
  ],
];
for (const [name, mutate] of badProfiles) {
  test(`refuses even a repinned profile containing ${name}`, () => {
    const input = fixture();
    mutate(input.profile);
    repin(input);
    refusal(input);
  });
}

test("requires the independent installed profile digest, not just safe-looking resource IDs", () => {
  const input = fixture();
  input.profile.bindings[0].id = "4".repeat(32);
  refusal(input);
});

const badVerifiers = [
  [
    "wrong run",
    (v) => {
      v.q = "f".repeat(64);
    },
  ],
  [
    "wrong descriptor",
    (v) => {
      v.descriptor[4] = "f".repeat(40);
    },
  ],
  [
    "wrong origin",
    (v) => {
      v.descriptor[10] = "https://togetherweown.com";
    },
  ],
  [
    "raw credential",
    (v) => {
      v.credential = "qa1.not-a-real-credential";
    },
  ],
  [
    "non-digest",
    (v) => {
      v.credentialSha256 = "fixture-not-a-digest";
    },
  ],
  [
    "extended lifetime",
    (v) => {
      v.expiresAt += 1;
    },
  ],
  [
    "replaced lifetime",
    (v) => {
      v.expiresAt -= 1;
    },
  ],
  [
    "future notBefore",
    (v) => {
      v.notBefore += 1;
    },
  ],
  [
    "fractional timestamp",
    (v) => {
      v.issuedAt += 0.1;
    },
  ],
  [
    "zero issuance",
    (v) => {
      v.issuedAt = 0;
    },
  ],
];
for (const [name, mutate] of badVerifiers) {
  test(`refuses public verifier with ${name}`, () => {
    const input = fixture();
    changeVerifier(input, mutate);
    refusal(input);
  });
}
for (const [name, mutate] of [
  [
    "noncanonical JSON",
    (i) => {
      i.verifier = ` ${i.verifier}`;
    },
  ],
  [
    "duplicate key",
    (i) => {
      assert.ok(i.verifier.startsWith("{"));
      i.verifier = '{"q":"bad",' + i.verifier.slice(1);
    },
  ],
  [
    "oversize",
    (i) => {
      i.verifier = "x".repeat(4097);
    },
  ],
  [
    "expired deadline",
    (i) => {
      i.now += 1470;
    },
  ],
  [
    "before issuance",
    (i) => {
      i.now -= 1;
    },
  ],
  [
    "nonfinite clock",
    (i) => {
      i.now = NaN;
    },
  ],
  [
    "tampered identity",
    (i) => {
      i.identity = { ...i.identity, q: "f".repeat(64) };
    },
  ],
  [
    "invalid identity audience",
    (i) => {
      i.identity = structuredClone(i.identity);
      i.identity.descriptor[9] = "production";
    },
  ],
  [
    "missing assets ticket",
    (i) => {
      i.assetsTicket = null;
    },
  ],
  [
    "foreign asset run",
    (i) => {
      i.assetsTicket.q = "f".repeat(64);
    },
  ],
  [
    "foreign asset bundle",
    (i) => {
      i.assetsTicket.bundleRootSha256 = "f".repeat(64);
    },
  ],
  [
    "foreign asset tree",
    (i) => {
      i.assetsTicket.assetRootSha256 = "f".repeat(64);
    },
  ],
  [
    "invalid ticket",
    (i) => {
      i.assetsTicket.jwt = "\r\nnot-a-ticket";
    },
  ],
  [
    "oversize ticket",
    (i) => {
      i.assetsTicket.jwt = `a.b.${"c".repeat(8192)}`;
    },
  ],
  [
    "asset config override",
    (i) => {
      i.assetsTicket.config = { run_worker_first: false };
    },
  ],
  [
    "top-level metadata injection",
    (i) => {
      i.metadata = { keep_bindings: ["secret_text"] };
    },
  ],
  [
    "changed module bytes",
    (i) => {
      i.bundle.entries[2].bytes.fill(0);
    },
  ],
  [
    "changed asset bytes",
    (i) => {
      i.bundle.entries[0].bytes.fill(0);
    },
  ],
  [
    "traversal",
    (i) => {
      i.bundle.entries[2].path = "../worker.mjs";
    },
  ],
  [
    "configuration file",
    (i) => {
      i.bundle.entries[2].path = "worker/wrangler.jsonc";
    },
  ],
  [
    "link",
    (i) => {
      i.bundle.entries[2].type = "symlink";
    },
  ],
  [
    "case collision",
    (i) => {
      i.bundle.entries[1].path = "assets/APP.css";
    },
  ],
  [
    "claimed root",
    (i) => {
      i.bundle.rootSha256 = "f".repeat(64);
    },
  ],
  [
    "claimed byte count",
    (i) => {
      i.bundle.bytes += 1;
    },
  ],
  [
    "claimed file count",
    (i) => {
      i.bundle.files += 1;
    },
  ],
  [
    "wrong bundle run",
    (i) => {
      i.bundle.q = "f".repeat(64);
    },
  ],
  [
    "malformed build attempt",
    (i) => {
      i.bundle.build.runAttempt = "01";
    },
  ],
  [
    "oversize bundle",
    (i) => {
      i.bundle.entries[2].bytes = Buffer.alloc(16 * 1024 * 1024 + 1);
    },
  ],
  [
    "empty bundle",
    (i) => {
      i.bundle.entries = [];
    },
  ],
  [
    "entry count limit",
    (i) => {
      i.bundle.entries = Array(4097).fill(i.bundle.entries[0]);
    },
  ],
]) {
  test(`refuses ${name}`, () => {
    const input = fixture();
    mutate(input);
    refusal(input);
  });
}

test("refuses an unexpected ticket on a module-only upload", () => {
  const input = fixture({ assets: false });
  input.assetsTicket = fixture().assetsTicket;
  refusal(input);
});

test("refusals never echo ticket/verifier data or parser diagnostics", () => {
  const input = fixture();
  input.verifier = "private-parser-sentinel";
  refusal(input);
  assert.throws(() => prepareCandidateWebUpload(), {
    message: "Candidate upload refused: request",
  });
});

test("deterministically binds metadata and every byte to the non-promotable request digest", () => {
  const input = fixture();
  const first = prepareCandidateWebUpload(input).proof;
  assert.deepEqual(prepareCandidateWebUpload(input).proof, first);
  input.assetsTicket.jwt = "different.session.ticket";
  const second = prepareCandidateWebUpload(input).proof;
  assert.notEqual(first.metadataSha256, second.metadataSha256);
  assert.notEqual(first.requestSha256, second.requestSha256);
  assert.equal(first.bundleRootSha256, second.bundleRootSha256);
});
