import assert from "node:assert/strict";
import test from "node:test";
import { candidateIdentity, candidateSha256 } from "./candidate-staging-admission.mjs";
import { prepareCandidateBaselineUpload } from "./candidate-staging-baseline-upload.mjs";
import { createCandidateBaselineAssetUploader } from "./candidate-staging-assets.mjs";

const VERSION = "11111111-2222-3333-4444-555555555555";
const ERROR = "Candidate recovery refused: baseline request";
const hash = (value) => candidateSha256(JSON.stringify(value));
const sort = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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
  const profile = {
    schema: "two.candidate-upload-profile.v1",
    accountId: "1".repeat(32),
    scriptName: "two-web-next",
    bindings: [],
  };
  const files = [
    { path: "index.js", kind: "module", bytes: Buffer.from('throw new Error("do not execute B")') },
    { path: "chunks/app.js", kind: "module", bytes: Buffer.from("export const value = 1") },
    ...(assets ? [{ path: "_app/app.css", kind: "asset", bytes: Buffer.from("body{}") }] : []),
  ];
  const baseline = {
    schema: "two.candidate-baseline-web.v1",
    promotable: false,
    q: identity.q,
    profileSha256: hash(profile),
    versionId: VERSION,
    capturedAt: 1793830000,
    mainModule: "index.js",
    compatibilityDate: "2026-09-29",
    compatibilityFlags: ["nodejs_compat"],
    placement: { mode: "targeted", region: "aws:us-east-1" },
    annotations: { "workers/tag": "d".repeat(40) },
    assets: assets ? { run_worker_first: true } : null,
    bindings: [
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
    ].sort((a, b) => sort(a.name, b.name)),
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
  const input = {
    identity,
    profile,
    profileSha256: hash(profile),
    baseline,
    baselineSha256: hash(baseline),
    files,
    assetsTicket: null,
    now: baseline.capturedAt + 3600,
  };
  repin(input);
  return input;
}

function repin(input) {
  input.baselineSha256 = hash(input.baseline);
  input.assetsTicket = input.baseline.assets
    ? {
        q: input.identity.q,
        baselineSha256: input.baselineSha256,
        assetRootSha256: hash(input.baseline.files.filter((f) => f.kind === "asset")),
        jwt: "fixture.baseline.ticket",
      }
    : null;
}

function binding(input, name) {
  return input.baseline.bindings.find((v) => v.name === name);
}

function refusal(input) {
  assert.throws(() => prepareCandidateBaselineUpload(input), { message: ERROR });
}

function assetSetup({
  input = fixture(),
  failGuard,
  signal,
  single = false,
  cached = false,
  onFetch,
  clock,
} = {}) {
  const { assetsTicket: _ticket, now, ...options } = input;
  const calls = [];
  const guards = [];
  const jwt = `fixture.${Buffer.from(JSON.stringify({ exp: now + 600, wrangler_single_asset_uploads: single })).toString("base64url")}.signature`;
  const guard = (name) => async (context, deadline) => {
    guards.push(name);
    assert.ok(Object.isFrozen(context));
    assert.equal(context.q, input.identity.q);
    assert.equal(context.profileSha256, input.profileSha256);
    assert.equal(context.baselineSha256, input.baselineSha256);
    assert.equal(
      context.assetRootSha256,
      hash(input.baseline.files.filter((f) => f.kind === "asset")),
    );
    assert.equal(context.phase, "restore-baseline-assets");
    assert.ok(deadline instanceof AbortSignal);
    if (failGuard?.(name, guards.length)) throw new Error("private-provider-detail");
  };
  const config = {
    token: "fixture-provider-bearer",
    clock: clock ?? (() => now),
    signal,
    assertExclusive: guard("exclusive"),
    requireDirty: guard("dirty"),
    admitBaseline: guard("baseline"),
    fetchImpl: async (url, request) => {
      calls.push({ url, ...request });
      if (onFetch) return onFetch(url, request, calls.length, jwt);
      const hashes =
        calls.length === 1
          ? Object.values(JSON.parse(request.body).manifest).map((v) => v.hash)
          : [];
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: {
            jwt,
            ...(calls.length === 1 ? { buckets: cached ? [] : [hashes] } : {}),
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  };
  return {
    input,
    options,
    config,
    calls,
    guards,
    jwt,
    upload: () => createCandidateBaselineAssetUploader(config).upload(options),
  };
}

for (const single of [false, true])
  test(`B recovery assets integrate with pinned request after QA expiry (${single ? "single" : "bulk"})`, async () => {
    const f = assetSetup({ single });
    const ticket = await f.upload();
    assert.deepEqual(Object.keys(ticket).sort(), ["assetRootSha256", "baselineSha256", "jwt", "q"]);
    assert.equal(ticket.baselineSha256, f.input.baselineSha256);
    assert.equal(ticket.jwt, f.jwt);
    assert.ok(Object.isFrozen(ticket));
    const r = prepareCandidateBaselineUpload({ ...f.input, assetsTicket: ticket });
    assert.equal(JSON.parse(r.body).assets.jwt, ticket.jwt);
    assert.equal(
      JSON.parse(r.body).bindings.find((b) => b.name === "SESSION_SECRET").version_id,
      VERSION,
    );
    assert.equal(f.calls.length, 2);
    assert.equal(
      f.calls[0].url,
      `https://api.cloudflare.com/client/v4/accounts/${"1".repeat(32)}/workers/scripts/two-web-next/assets-upload-session`,
    );
    assert.equal(f.calls[0].headers.Authorization, "Bearer fixture-provider-bearer");
    assert.equal(f.calls[1].headers.Authorization, `Bearer ${ticket.jwt}`);
    assert.equal(
      f.calls.every((c) => c.redirect === "error" && c.signal instanceof AbortSignal),
      true,
    );
    const uploaded = single
      ? Buffer.from(await f.calls[1].body.arrayBuffer())
      : Buffer.from(await [...f.calls[1].body.values()][0].text(), "base64");
    assert.deepEqual(uploaded, f.input.files.find((v) => v.kind === "asset").bytes);
    assert.deepEqual(
      f.guards,
      Array.from({ length: 4 }, () => ["exclusive", "dirty", "baseline"]).flat(),
    );
  });

for (let checkpoint = 1; checkpoint <= 12; checkpoint++)
  test(`recovery asset guard failure ${checkpoint} refuses without retry or ticket`, async () => {
    const f = assetSetup({ failGuard: (_name, n) => n === checkpoint });
    await assert.rejects(f.upload(), { message: "Candidate assets refused: transport" });
    assert.equal(f.calls.length, checkpoint <= 3 ? 0 : checkpoint <= 9 ? 1 : 2);
    assert.equal(f.guards.length, checkpoint);
  });

for (const name of ["assertExclusive", "requireDirty", "admitBaseline"])
  test(`recovery assets require installed ${name} adapter`, () => {
    const f = assetSetup();
    delete f.config[name];
    assert.throws(() => createCandidateBaselineAssetUploader(f.config), {
      message: "Candidate assets refused: transport",
    });
    assert.equal(f.calls.length, 0);
  });

test("module-only B needs no provider asset session or ticket", async () => {
  const f = assetSetup({ input: fixture({ assets: false }) });
  assert.equal(await f.upload(), null);
  assert.equal(f.calls.length, 0);
});

test("cached B assets still require post-session baseline admission", async () => {
  const f = assetSetup({ cached: true });
  assert.equal((await f.upload()).jwt, f.jwt);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.guards, ["exclusive", "dirty", "baseline", "exclusive", "dirty", "baseline"]);
});

test("pre-aborted recovery never reaches provider", async () => {
  const f = assetSetup({ signal: AbortSignal.abort("private-cancel-reason") });
  await assert.rejects(f.upload(), { message: "Candidate assets refused: transport" });
  assert.equal(f.calls.length, 0);
});

test("cancellation inside admission reaches every nested adapter and prevents request", async () => {
  const abort = new AbortController();
  const f = assetSetup({ signal: abort.signal });
  f.config.requireDirty = async (_c, signal) => {
    abort.abort();
    assert.equal(signal.aborted, true);
  };
  await assert.rejects(f.upload(), { message: "Candidate assets refused: transport" });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.guards, ["exclusive"]);
});

test("mutated baseline bytes refuse before provider or guard", async () => {
  const f = assetSetup();
  f.options.files.find((v) => v.kind === "asset").bytes[0] ^= 1;
  await assert.rejects(f.upload(), { message: "Candidate assets refused: transport" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.guards.length, 0);
});

test("expired provider asset capability refuses, independent of expired QA credential", async () => {
  const f = assetSetup({
    onFetch: (_url, _request, _n) =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: {
            jwt: `fixture.${Buffer.from(JSON.stringify({ exp: fixture().now + 30 })).toString("base64url")}.signature`,
            buckets: [],
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(f.upload(), { message: "Candidate assets refused: transport" });
  assert.equal(f.calls.length, 1);
});

for (const single of [false, true])
  for (const elapsed of [570, 601])
    test(`recovery rechecks asset capability after slow admission (${single}/${elapsed})`, async () => {
      let time = fixture().now;
      const f = assetSetup({
        single,
        clock: () => time,
        failGuard: (_name, n) => {
          if (n === 9) time += elapsed;
          return false;
        },
      });
      await assert.rejects(f.upload(), { message: "Candidate assets refused: transport" });
      // Session creation is the only request: never send the stale capability.
      assert.equal(f.calls.length, 1);
      assert.equal(f.guards.length, 9);
    });

for (const key of ["verifier", "assetsTicket", "url", "now"])
  test(`recovery asset upload refuses caller ${key}`, async () => {
    const f = assetSetup();
    f.options[key] = "untrusted";
    await assert.rejects(f.upload(), { message: "Candidate assets refused: transport" });
    assert.equal(f.calls.length, 0);
  });

test("constructs B-prime only at the Workers endpoint with immediate deployment disabled", () => {
  const input = fixture();
  const r = prepareCandidateBaselineUpload(input);
  assert.equal(
    r.url,
    `https://api.cloudflare.com/client/v4/accounts/${input.profile.accountId}/workers/workers/two-web-next/versions?deploy=false`,
  );
  assert.equal(r.method, "POST");
  const body = JSON.parse(r.body);
  assert.deepEqual(Object.keys(body).sort(), [
    "annotations",
    "assets",
    "bindings",
    "compatibility_date",
    "compatibility_flags",
    "main_module",
    "modules",
    "placement",
  ]);
  assert.equal(body.main_module, "index.js");
  assert.equal(body.compatibility_date, "2026-09-29");
  assert.deepEqual(body.compatibility_flags, ["nodejs_compat"]);
  assert.deepEqual(body.placement, input.baseline.placement);
  assert.deepEqual(body.annotations, input.baseline.annotations);
  assert.deepEqual(body.assets, {
    jwt: input.assetsTicket.jwt,
    config: { run_worker_first: true },
  });
  assert.equal(body.modules.length, 2);
  for (const f of input.files.filter((v) => v.kind === "module")) {
    const m = body.modules.find((v) => v.name === f.path);
    assert.equal(m.content_type, "application/javascript+module");
    assert.deepEqual(Buffer.from(m.content_base64, "base64"), f.bytes);
  }
  for (const b of input.baseline.bindings) {
    const restored = body.bindings.find((v) => v.name === b.name);
    assert.deepEqual(
      restored,
      ["secret_text", "secret_key"].includes(b.type)
        ? { name: b.name, type: "inherit", version_id: VERSION }
        : b,
    );
  }
  assert.equal(body.bindings.length, input.baseline.bindings.length);
  assert.equal(
    body.bindings.some((v) => v.name === "QA_RUN_AUTH"),
    false,
  );
  assert.equal(r.body.includes('"latest"'), false);
  assert.equal(r.body.includes("keep_bindings"), false);
  assert.equal(r.body.includes("secret_text"), false);
  assert.equal(r.body.includes("secret_key"), false);
});

test("public proof has no transport capability, config values, bytes or recovery-complete authority", () => {
  const input = fixture();
  const r = prepareCandidateBaselineUpload(input);
  assert.deepEqual(r.proof, {
    schema: "two.candidate-baseline-upload-request.v1",
    promotable: false,
    recoveryScope: "inert-baseline-request-only",
    q: input.identity.q,
    profileSha256: input.profileSha256,
    baselineSha256: input.baselineSha256,
    baselineVersionId: VERSION,
    assetRootSha256: input.assetsTicket.assetRootSha256,
    requestSha256: hash([r.url, candidateSha256(r.body)]),
    preparedAt: input.now,
  });
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.proof));
  for (const forbidden of [
    input.assetsTicket.jwt,
    "SESSION_SECRET",
    "do not execute",
    "next.togetherweown.com",
  ]) {
    assert.equal(JSON.stringify(r.proof).includes(forbidden), false);
  }
});

test("recovery may prepare after candidate expiry without accepting or renewing a verifier", () => {
  const input = fixture();
  input.now += 86400;
  assert.equal(prepareCandidateBaselineUpload(input).proof.preparedAt, input.now);
  input.verifier = "new credential metadata";
  refusal(input);
});

test("module-only B has no asset ticket, implicit retention or asset binding", () => {
  const input = fixture({ assets: false });
  const r = prepareCandidateBaselineUpload(input);
  const body = JSON.parse(r.body);
  assert.equal("assets" in body, false);
  assert.equal(
    body.bindings.some((v) => v.type === "assets"),
    false,
  );
  assert.equal(r.proof.assetRootSha256, hash([]));
});

test("snapshots canonical B independent of file/binding order and copies bytes to an immutable JSON body", () => {
  const input = fixture();
  const expected = prepareCandidateBaselineUpload(input);
  input.baseline.bindings.reverse();
  input.baseline.files.reverse();
  input.files.reverse();
  const actual = prepareCandidateBaselineUpload(input);
  assert.deepEqual(actual, expected);
  input.files[0].bytes.fill(0);
  input.baseline.bindings[0].type = "bad";
  input.baseline.placement.region = "foreign";
  input.assetsTicket.jwt = "changed.ticket.value";
  assert.equal(actual.body, expected.body);
});

test("preserves additional baseline modules as inert bytes, including header controls, never executing them", () => {
  const input = fixture();
  for (const [name, type, bytes] of [
    ["_headers", "text/plain", Buffer.from("/*\n X-Test: preserved")],
    ["math.wasm", "application/wasm", Buffer.from([0, 97, 115, 109])],
  ]) {
    input.files.push({ path: name, kind: "module", bytes });
    input.baseline.files.push({
      path: name,
      kind: "module",
      contentType: type,
      size: bytes.length,
      sha256: candidateSha256(bytes),
    });
  }
  input.baseline.files.sort((a, b) => sort(`${a.kind}:${a.path}`, `${b.kind}:${b.path}`));
  repin(input);
  const body = JSON.parse(prepareCandidateBaselineUpload(input).body);
  assert.equal(body.modules.find((m) => m.name === "_headers").content_type, "text/plain");
  assert.equal(body.modules.find((m) => m.name === "math.wasm").content_base64, "AGFzbQ==");
});

for (const name of ["_worker.js.map", "renamed.map", "chunks/_worker.js.map"]) {
  test(`source-map recovery admits only the exact retained path ${name}`, () => {
    const input = fixture({ assets: false });
    const bytes = Buffer.from('{"version":3,"sources":[],"mappings":""}');
    input.files.push({ path: name, kind: "module", bytes });
    input.baseline.files.push({
      path: name,
      kind: "module",
      contentType: "application/source-map",
      size: bytes.length,
      sha256: candidateSha256(bytes),
    });
    input.baseline.files.sort((a, b) => sort(`${a.kind}:${a.path}`, `${b.kind}:${b.path}`));
    repin(input);
    if (name !== "_worker.js.map") {
      refusal(input);
    } else {
      const body = JSON.parse(prepareCandidateBaselineUpload(input).body);
      const module = body.modules.find((value) => value.name === name);
      assert.equal(module.content_type, "application/source-map");
      assert.equal(module.content_base64, bytes.toString("base64"));
      assert.equal(
        body.bindings.find((value) => value.name === "SESSION_SECRET").version_id,
        VERSION,
      );
    }
  });
}

for (const target of [
  "two-web-next-production",
  "two-web-kit-preview",
  "two-web-jobs",
  "two-web-next/../../production",
]) {
  test(`refuses non-staging target ${target} even with a replacement profile digest`, () => {
    const input = fixture();
    input.profile.scriptName = target;
    input.profileSha256 = hash(input.profile);
    input.baseline.profileSha256 = input.profileSha256;
    repin(input);
    refusal(input);
  });
}

const malformed = [
  [
    "baseline schema",
    (i) => {
      i.baseline.schema = "foreign";
    },
  ],
  [
    "promotable",
    (i) => {
      i.baseline.promotable = true;
    },
  ],
  [
    "cross run",
    (i) => {
      i.baseline.q = "f".repeat(64);
    },
  ],
  [
    "cross profile",
    (i) => {
      i.baseline.profileSha256 = "f".repeat(64);
    },
  ],
  [
    "future capture",
    (i) => {
      i.baseline.capturedAt = i.now + 1;
    },
  ],
  [
    "negative capture",
    (i) => {
      i.baseline.capturedAt = -1;
    },
  ],
  [
    "fractional time",
    (i) => {
      i.now += 0.5;
    },
  ],
  [
    "infinite time",
    (i) => {
      i.now = Infinity;
    },
  ],
  [
    "overflow time",
    (i) => {
      i.now = 253402300800;
    },
  ],
  [
    "new compatibility",
    (i) => {
      i.baseline.compatibilityDate = "2026-11-01";
    },
  ],
  [
    "extra flag",
    (i) => {
      i.baseline.compatibilityFlags.push("unsafe");
    },
  ],
  [
    "missing flag",
    (i) => {
      i.baseline.compatibilityFlags = [];
    },
  ],
  [
    "sparse flag",
    (i) => {
      i.baseline.compatibilityFlags = new Array(1);
    },
  ],
  [
    "placement foreign",
    (i) => {
      i.baseline.placement.region = "aws:eu-west-1";
    },
  ],
  [
    "placement mode",
    (i) => {
      i.baseline.placement.mode = "smart";
    },
  ],
  [
    "placement extra",
    (i) => {
      i.baseline.placement.hostname = "foreign";
    },
  ],
  [
    "annotation missing",
    (i) => {
      delete i.baseline.annotations;
    },
  ],
  [
    "candidate annotation",
    (i) => {
      i.baseline.annotations["workers/tag"] = "candidate-new";
    },
  ],
  [
    "annotation extra",
    (i) => {
      i.baseline.annotations["workers/message"] = "injection";
    },
  ],
  [
    "assets policy",
    (i) => {
      i.baseline.assets.run_worker_first = false;
    },
  ],
  [
    "assets extra policy",
    (i) => {
      i.baseline.assets.not_found_handling = "single-page-application";
    },
  ],
  [
    "assets binding missing",
    (i) => {
      i.baseline.bindings = i.baseline.bindings.filter((v) => v.name !== "ASSETS");
    },
  ],
  [
    "assets config missing",
    (i) => {
      i.baseline.assets = null;
    },
  ],
  [
    "baseline caller endpoint",
    (i) => {
      i.baseline.url = "https://foreign.example";
    },
  ],
  [
    "baseline migrations",
    (i) => {
      i.baseline.migrations = {};
    },
  ],
  [
    "baseline containers",
    (i) => {
      i.baseline.containers = [];
    },
  ],
  [
    "baseline limits",
    (i) => {
      i.baseline.limits = { cpu_ms: 1 };
    },
  ],
  [
    "missing main module",
    (i) => {
      i.baseline.mainModule = "missing.js";
    },
  ],
  [
    "file hash",
    (i) => {
      i.baseline.files[0].sha256 = "e".repeat(64);
    },
  ],
  [
    "file size",
    (i) => {
      i.baseline.files[0].size += 1;
    },
  ],
  [
    "file negative size",
    (i) => {
      i.baseline.files[0].size = -1;
    },
  ],
  [
    "file fractional size",
    (i) => {
      i.baseline.files[0].size = 0.1;
    },
  ],
  [
    "file bound",
    (i) => {
      i.baseline.files[0].size = 16 * 1024 * 1024 + 1;
    },
  ],
  [
    "file missing",
    (i) => {
      i.files.pop();
    },
  ],
  [
    "file extra",
    (i) => {
      i.files.push({ path: "extra.js", kind: "module", bytes: Buffer.from("extra") });
    },
  ],
  [
    "file replaced",
    (i) => {
      i.files[0].bytes[0] ^= 1;
    },
  ],
  [
    "file duplicate",
    (i) => {
      i.files[1] = i.files[0];
    },
  ],
  [
    "file non-buffer",
    (i) => {
      i.files[0].bytes = new Uint8Array(i.files[0].bytes);
    },
  ],
  [
    "file extra field",
    (i) => {
      i.files[0].symlink = "index.js";
    },
  ],
  [
    "file sparse",
    (i) => {
      i.files = new Array(i.files.length);
    },
  ],
  [
    "manifest sparse",
    (i) => {
      i.baseline.files = new Array(3);
    },
  ],
  [
    "manifest empty",
    (i) => {
      i.baseline.files = [];
    },
  ],
  [
    "manifest duplicate",
    (i) => {
      i.baseline.files.push(i.baseline.files[0]);
    },
  ],
  [
    "manifest case alias",
    (i) => {
      const f = { ...i.baseline.files[0] };
      f.path = f.path.toUpperCase();
      i.baseline.files.push(f);
    },
  ],
  [
    "manifest count",
    (i) => {
      i.baseline.files = new Array(4097).fill(i.baseline.files[0]);
    },
  ],
  [
    "manifest mime",
    (i) => {
      i.baseline.files.find((v) => v.kind === "module").contentType = "application/x-executable";
    },
  ],
  [
    "asset mime",
    (i) => {
      i.baseline.files[0].contentType = "text/css";
    },
  ],
  [
    "manifest symlink",
    (i) => {
      i.baseline.files[0].kind = "symlink";
    },
  ],
  [
    "binding duplicate",
    (i) => {
      i.baseline.bindings.push(binding(i, "DB"));
    },
  ],
  [
    "binding sparse",
    (i) => {
      i.baseline.bindings = new Array(1);
    },
  ],
  [
    "binding count",
    (i) => {
      i.baseline.bindings = new Array(65).fill(binding(i, "DB"));
    },
  ],
  [
    "binding empty",
    (i) => {
      i.baseline.bindings = [];
    },
  ],
  [
    "origin missing",
    (i) => {
      i.baseline.bindings = i.baseline.bindings.filter((v) => v.name !== "APP_URL");
    },
  ],
  [
    "origin production",
    (i) => {
      binding(i, "APP_URL").text = "https://togetherweown.com";
    },
  ],
  [
    "origin alias",
    (i) => {
      binding(i, "APP_URL").text += "/";
    },
  ],
  [
    "candidate verifier",
    (i) => {
      i.baseline.bindings.push({ name: "QA_RUN_AUTH", type: "plain_text", text: "{}" });
    },
  ],
  [
    "candidate secret verifier",
    (i) => {
      i.baseline.bindings.push({ name: "QA_RUN_AUTH", type: "secret_text" });
    },
  ],
  [
    "public unknown",
    (i) => {
      i.baseline.bindings.push({ name: "DATABASE_URL", type: "plain_text", text: "not-public" });
    },
  ],
  [
    "public overflow",
    (i) => {
      binding(i, "APP_URL").text = "x".repeat(4097);
    },
  ],
  [
    "secret value",
    (i) => {
      binding(i, "SESSION_SECRET").text = "must not be accepted or printed";
    },
  ],
  [
    "key data",
    (i) => {
      binding(i, "SIGNING_KEY").key_base64 = "c2VjcmV0";
    },
  ],
  [
    "secret rename",
    (i) => {
      binding(i, "SESSION_SECRET").old_name = "OTHER_SECRET";
    },
  ],
  [
    "secret source",
    (i) => {
      binding(i, "SESSION_SECRET").version_id = "latest";
    },
  ],
  [
    "caller inherit",
    (i) => {
      binding(i, "SESSION_SECRET").type = "inherit";
    },
  ],
  [
    "hyperdrive foreign name",
    (i) => {
      binding(i, "DB").name = "FOREIGN_DB";
    },
  ],
  [
    "hyperdrive credential",
    (i) => {
      binding(i, "DB").password = "never copy";
    },
  ],
  [
    "hyperdrive id",
    (i) => {
      binding(i, "DB").id = "x".repeat(32);
    },
  ],
  [
    "queue foreign",
    (i) => {
      binding(i, "SYNC_EVENT_QUEUE").queue_name += "-production";
    },
  ],
  [
    "queue unknown",
    (i) => {
      binding(i, "SYNC_EVENT_QUEUE").name = "FOREIGN_QUEUE";
    },
  ],
  [
    "queue undefined",
    (i) => {
      binding(i, "SYNC_EVENT_QUEUE").name = "FOREIGN_QUEUE";
      binding(i, "FOREIGN_QUEUE").queue_name = undefined;
    },
  ],
  [
    "service binding",
    (i) => {
      i.baseline.bindings.push({ name: "SERVICE", type: "service", service: "production" });
    },
  ],
  [
    "ticket missing",
    (i) => {
      i.assetsTicket = null;
    },
  ],
  [
    "ticket cross-run",
    (i) => {
      i.assetsTicket.q = "f".repeat(64);
    },
  ],
  [
    "ticket baseline",
    (i) => {
      i.assetsTicket.baselineSha256 = "f".repeat(64);
    },
  ],
  [
    "ticket asset root",
    (i) => {
      i.assetsTicket.assetRootSha256 = "f".repeat(64);
    },
  ],
  [
    "ticket malformed",
    (i) => {
      i.assetsTicket.jwt = "not a jwt";
    },
  ],
  [
    "ticket overflow",
    (i) => {
      i.assetsTicket.jwt = `a.b.${"c".repeat(8192)}`;
    },
  ],
  [
    "ticket extra",
    (i) => {
      i.assetsTicket.url = "https://foreign.example";
    },
  ],
  [
    "option endpoint",
    (i) => {
      i.url = "https://foreign.example";
    },
  ],
  [
    "option deploy",
    (i) => {
      i.deploy = true;
    },
  ],
];
for (const [name, mutate] of malformed) {
  test(`refuses ${name}`, () => {
    const input = fixture();
    // Exercise malformed manifests even with a caller-computed replacement pin.
    // Separate tests below retain the independent pin during shape mutations.
    if (name.startsWith("ticket")) mutate(input);
    else {
      mutate(input);
      repin(input);
    }
    refusal(input);
  });
}

for (const version of [
  "latest",
  "11111111",
  "11111111-2222-3333-4444-55555555555G",
  "11111111-2222-3333-4444-555555555555/../../",
  null,
  123,
]) {
  test(`refuses unpinned version ${version}`, () => {
    const input = fixture();
    input.baseline.versionId = version;
    repin(input);
    refusal(input);
  });
}
for (const name of [
  "../index.js",
  "./index.js",
  "/index.js",
  "chunks//app.js",
  "chunks/../app.js",
  "chunks/.hidden.js",
  "a\\b.js",
  "a%2fb.js",
  "é.js",
  "a\n.js",
  "a".repeat(241),
]) {
  test(`refuses noncanonical module path ${JSON.stringify(name)}`, () => {
    const input = fixture();
    input.baseline.files.find((v) => v.kind === "module").path = name;
    repin(input);
    refusal(input);
  });
}
for (const mutate of [
  (i) => {
    i.baselineSha256 = "0".repeat(64);
  },
  (i) => {
    i.profileSha256 = "0".repeat(64);
  },
  (i) => {
    i.baseline.bindings[0].text += "changed";
  },
  (i) => {
    i.baseline.versionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  },
  (i) => {
    i.baseline.annotations["workers/tag"] = "e".repeat(40);
  },
]) {
  test("refuses changed baseline/profile content without the independent pin", () => {
    const input = fixture();
    mutate(input);
    refusal(input);
  });
}

for (const [name, mutate] of [
  [
    "secret text",
    (i) => {
      binding(i, "SESSION_SECRET").text = "discarded secret";
    },
  ],
  [
    "key material",
    (i) => {
      binding(i, "SIGNING_KEY").key_base64 = "c2VjcmV0";
    },
  ],
  [
    "rename",
    (i) => {
      binding(i, "SESSION_SECRET").old_name = "OTHER";
    },
  ],
  [
    "source",
    (i) => {
      binding(i, "SESSION_SECRET").version_id = "latest";
    },
  ],
  [
    "provider field",
    (i) => {
      i.baseline.migrations = {};
    },
  ],
  [
    "placement field",
    (i) => {
      i.baseline.placement.hostname = "foreign";
    },
  ],
  [
    "annotation field",
    (i) => {
      i.baseline.annotations["workers/message"] = "unsupported";
    },
  ],
  [
    "file field",
    (i) => {
      i.baseline.files[0].link = "foreign";
    },
  ],
  [
    "public field",
    (i) => {
      binding(i, "APP_URL").json = "{}";
    },
  ],
  [
    "resource field",
    (i) => {
      binding(i, "DB").password = "never accept";
    },
  ],
]) {
  test(`refuses unsupported ${name} even when canonical projection would keep the original digest`, () => {
    const input = fixture();
    mutate(input);
    refusal(input);
  });
}

test("accepts the exact decoded byte ceiling and rejects the next byte before encoding", () => {
  const input = fixture({ assets: false });
  input.files = [{ path: "index.js", kind: "module", bytes: Buffer.alloc(16 * 1024 * 1024) }];
  input.baseline.files = [
    {
      path: "index.js",
      kind: "module",
      contentType: "application/javascript+module",
      size: input.files[0].bytes.length,
      sha256: candidateSha256(input.files[0].bytes),
    },
  ];
  repin(input);
  const request = prepareCandidateBaselineUpload(input);
  assert.equal(
    JSON.parse(request.body).modules[0].content_base64.length,
    4 * Math.ceil(input.files[0].bytes.length / 3),
  );
  input.files[0].bytes = Buffer.alloc(16 * 1024 * 1024 + 1);
  input.baseline.files[0].size += 1;
  input.baseline.files[0].sha256 = candidateSha256(input.files[0].bytes);
  repin(input);
  refusal(input);
});

test("module-only B refuses any asset ticket or asset configuration", () => {
  const input = fixture({ assets: false });
  input.assetsTicket = { jwt: "fixture.baseline.ticket" };
  refusal(input);
  input.assetsTicket = null;
  input.baseline.assets = { run_worker_first: true };
  repin(input);
  refusal(input);
});

test("supports bounded public vars but never controls in their text", () => {
  const input = fixture();
  input.baseline.bindings.push({ name: "FEATURED_IMAGE_HOSTS", type: "plain_text", text: "" });
  input.baseline.bindings.sort((a, b) => sort(a.name, b.name));
  repin(input);
  assert.ok(prepareCandidateBaselineUpload(input));
  binding(input, "FEATURED_IMAGE_HOSTS").text = "public\ncontrol";
  repin(input);
  refusal(input);
});
