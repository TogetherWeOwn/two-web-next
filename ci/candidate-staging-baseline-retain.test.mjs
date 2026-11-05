import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import {
  baselineProducerRecord,
  retainStagingBaseline,
} from "./candidate-staging-baseline-retain.mjs";

const REFUSED = { message: "Candidate baseline retention refused" };
const VERSION = "12345678-1234-1234-1234-123456789abc";
const SHA = "b".repeat(40);
const WORKER = Buffer.from("globalThis.__baselineExecuted = true; throw new Error('inert');");
const IGNORE = "\n_worker.js\n_routes.json\n_headers\n_redirects";
const SECRET = "synthetic-asset-capability-must-not-escape";
const SCRIPT = resolve("ci/candidate-staging-baseline-retain.mjs");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "staging-baseline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assetRoot = join(root, "assets");
  mkdirSync(assetRoot);
  writeFileSync(join(assetRoot, "_worker.js"), "generated entry");
  writeFileSync(join(assetRoot, "_headers"), "/*\n  X-Header: ignored");
  writeFileSync(join(assetRoot, ".assetsignore"), IGNORE);
  writeFileSync(join(assetRoot, "style.css"), "body{}");
  const producer = {
    repository: "TogetherWeOwn/two-web-next",
    repositoryId: "1234",
    sourceSha: SHA,
    workflowSha: SHA,
    runId: "500",
    runAttempt: "1",
    event: "workflow_run",
  };
  const row = {
    type: "deploy",
    version: 1,
    worker_name: "two-web-next",
    version_id: VERSION,
    targets: ["next.togetherweown.com (custom domain)"],
    worker_name_overridden: false,
    timestamp: "2026-11-05T02:40:00.123Z",
  };
  const metadata = {
    main_module: "_worker.js",
    annotations: { "workers/tag": SHA },
    assets: { jwt: SECRET },
    bindings: [{ name: "PRIVATE", type: "secret_text", text: SECRET }],
  };
  return { root, assetRoot, producer, row, metadata };
}

async function upload(w, modify = () => {}) {
  const f = new FormData();
  f.append("metadata", JSON.stringify(w.metadata));
  f.append(
    "_worker.js",
    new File([WORKER], "_worker.js", { type: "application/javascript+module" }),
  );
  f.append(
    "_worker.js.map",
    new File(["{}"], "_worker.js.map", { type: "application/source-map" }),
  );
  modify(f);
  return Buffer.from(await new Response(f).arrayBuffer());
}

async function options(w, modify) {
  return {
    upload: await upload(w, modify),
    deployOutput: Buffer.from(`${JSON.stringify(w.row)}\n`),
    producer: w.producer,
    assetRoot: w.assetRoot,
  };
}

function producerOptions(retained) {
  return {
    manifestBytes: retained.manifestBytes,
    artifactId: "600",
    archiveSha256: "d".repeat(64),
  };
}

test("retention joins the actual upload bytes and normal staging UUID without serializing capabilities or metadata", async (t) => {
  const w = fixture(t);
  const result = await retainStagingBaseline(await options(w));
  assert.equal(globalThis.__baselineExecuted, undefined);
  assert.deepEqual(result.manifest.producer, w.producer);
  assert.equal(result.manifest.versionId, VERSION);
  assert.equal(result.manifest.promotable, false);
  assert.equal(result.manifest.scope, "retained-bytes-only");
  assert.deepEqual(
    result.manifest.files.map((f) => [f.kind, f.path, f.contentType]),
    [
      ["asset", "style.css", null],
      ["module", "_worker.js", "application/javascript+module"],
      ["module", "_worker.js.map", "application/source-map"],
    ],
  );
  assert.equal(result.entries.length, 4);
  assert.equal(result.entries[2].bytes.toString(), WORKER.toString());
  for (const entry of result.entries) {
    assert.doesNotMatch(
      entry.bytes.toString(),
      /synthetic-asset-capability|PRIVATE|X-Header|generated entry/,
    );
    assert.match(entry.path, /^(baseline\.json|file-[0-9]{4})$/);
  }
  for (const record of result.manifest.files) {
    const bytes = result.entries.find((entry) => entry.path === record.entry).bytes;
    assert.equal(candidateSha256(bytes), record.sha256);
    assert.equal(bytes.length, record.size);
  }
  assert.equal(candidateSha256(JSON.stringify(result.manifest.files)), result.manifest.rootSha256);
  const receipt = baselineProducerRecord(producerOptions(result));
  assert.equal(receipt.artifactId, "600");
  assert.equal(receipt.archiveSha256, "d".repeat(64));
  assert.equal(receipt.manifestSha256, candidateSha256(result.manifestBytes));
  assert.equal(receipt.versionId, VERSION);
  assert.equal(receipt.scope, "producer-join-only");
  assert.equal(Object.isFrozen(receipt), true);
});

for (const [field, values] of Object.entries({
  repository: ["attacker/repo", null],
  repositoryId: [1234, "0", "../1"],
  sourceSha: ["B".repeat(40), "bad"],
  workflowSha: [null, "bad"],
  runId: [500, "0", "500/1"],
  runAttempt: ["0", 1, null],
  event: ["push", "pull_request"],
})) {
  for (const value of values)
    test(`retention refuses producer ${field}=${value}`, async (t) => {
      const w = fixture(t);
      w.producer[field] = value;
      await assert.rejects(retainStagingBaseline(await options(w)), REFUSED);
    });
}
for (const [field, value] of [
  ["type", "version-upload"],
  ["version", 2],
  ["worker_name", "two-web-next-production"],
  ["version_id", null],
  ["version_id", VERSION.toUpperCase()],
  ["worker_name_overridden", true],
  ["wrangler_environment", "production"],
  ["targets", []],
  ["targets", ["togetherweown.com (custom domain)"]],
  ["targets", ["next.togetherweown.com (custom domain)", "foreign"]],
  ["timestamp", "bad"],
]) {
  test(`retention refuses deploy output ${field}=${value}`, async (t) => {
    const w = fixture(t);
    w.row[field] = value;
    await assert.rejects(retainStagingBaseline(await options(w)), REFUSED);
  });
}
for (const [name, change] of [
  ["missing metadata", (f) => f.delete("metadata")],
  ["duplicate metadata", (f) => f.append("metadata", "{}")],
  ["bad metadata", (f) => f.set("metadata", "{")],
  ["large metadata", (f) => f.set("metadata", " ".repeat(65537))],
  ["metadata file", (f) => f.set("metadata", new File(["{}"], "metadata"))],
  ["missing worker", (f) => f.delete("_worker.js")],
  ["duplicate worker", (f) => f.append("_worker.js", new File(["x"], "_worker.js"))],
  ["worker text", (f) => f.set("_worker.js", "code")],
  [
    "worker MIME",
    (f) => f.set("_worker.js", new File(["x"], "_worker.js", { type: "text/plain" })),
  ],
  [
    "worker filename",
    (f) =>
      f.set("_worker.js", new File(["x"], "other.js", { type: "application/javascript+module" })),
  ],
  ["extra module", (f) => f.append("other.js", new File(["x"], "other.js"))],
  ["traversal", (f) => f.append("../escape.js", new File(["x"], "escape.js"))],
])
  test(`retention refuses ${name}`, async (t) => {
    const w = fixture(t);
    await assert.rejects(retainStagingBaseline(await options(w, change)), REFUSED);
  });
for (const [name, change] of [
  ["main module", (w) => (w.metadata.main_module = "foreign.js")],
  ["source tag", (w) => (w.metadata.annotations["workers/tag"] = "a".repeat(40))],
  [
    "arbitrary ignore rule",
    (w) => writeFileSync(join(w.assetRoot, ".assetsignore"), `${IGNORE}\nstyle.css`),
  ],
  ["asset link", (w) => symlinkSync("_worker.js", join(w.assetRoot, "escape.js"))],
  ["hardlink", (w) => linkSync(join(w.assetRoot, "style.css"), join(w.assetRoot, "alias.css"))],
  [
    "duplicate deploy receipt",
    (w, o) => (o.deployOutput = Buffer.concat([o.deployOutput, o.deployOutput])),
  ],
  ["non-UTF8 deploy output", (w, o) => (o.deployOutput = Buffer.from([255]))],
  ["large deploy output", (w, o) => (o.deployOutput = Buffer.alloc(16385))],
  ["large upload", (w, o) => (o.upload = Buffer.alloc(16 * 1024 * 1024 + 1))],
  ["bad form", (w, o) => (o.upload = Buffer.from("--invalid"))],
])
  test(`retention refuses ${name} with bounded errors`, async (t) => {
    const w = fixture(t);
    const o = await options(w);
    change(w, o);
    // Metadata lives in the serialized form, so regenerate after metadata edits.
    if (["main module", "source tag"].includes(name)) o.upload = await upload(w);
    await assert.rejects(retainStagingBaseline(o), REFUSED);
  });

test("missing source map is representable, but never guessed or synthesized", async (t) => {
  const w = fixture(t);
  const r = await retainStagingBaseline(await options(w, (f) => f.delete("_worker.js.map")));
  assert.equal(r.manifest.files.length, 2);
});

for (const [field, value] of [
  ["artifactId", "0"],
  ["artifactId", 600],
  ["archiveSha256", "sha256:abc"],
  ["archiveSha256", "D".repeat(64)],
  ["manifestBytes", Buffer.from("{}")],
]) {
  test(`independent record refuses malformed ${field}=${value}`, async (t) => {
    const w = fixture(t);
    const o = producerOptions(await retainStagingBaseline(await options(w)));
    o[field] = value;
    assert.throws(() => baselineProducerRecord(o), REFUSED);
  });
}

test("producer join refuses manifest changes after payload upload", async (t) => {
  const w = fixture(t);
  const r = await retainStagingBaseline(await options(w));
  r.manifest.files[0].sha256 = "a".repeat(64);
  assert.throws(
    () =>
      baselineProducerRecord({
        ...producerOptions(r),
        manifestBytes: Buffer.from(JSON.stringify(r.manifest)),
      }),
    REFUSED,
  );
});

test("CLI refuses before reading private captures outside its runner-owned root", (t) => {
  const w = fixture(t);
  const r = spawnSync(process.execPath, [SCRIPT, "retain"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: "TogetherWeOwn/two-web-next",
      GITHUB_REF: "refs/heads/main",
      RUNNER_TEMP: w.root,
      BASELINE_RETENTION_ROOT: w.assetRoot,
    },
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `${REFUSED.message}\n`);
  assert.equal(existsSync(join(w.assetRoot, "style.css")), true);
});

test("normal staging workflow retains bytes and independent record, never raw captures or secrets", () => {
  const w = YAML.parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
  const steps = w.jobs["deploy-staging"].steps;
  const at = (name) => steps.findIndex((step) => step.name === name);
  const deploy = steps[at("Deploy to Cloudflare Workers")];
  assert.match(deploy.run, /umask 077/);
  assert.match(deploy.run, /--outfile "\$\{BASELINE_RETENTION_ROOT:\?\}\/upload.form"/);
  assert.equal(
    deploy.env.WRANGLER_OUTPUT_FILE_PATH,
    "${{ env.BASELINE_RETENTION_ROOT }}/deploy.jsonl",
  );
  assert.equal(
    at("Re-verify exact-SHA full CI before Worker deploy") + 1,
    at("Deploy to Cloudflare Workers"),
  );
  assert.equal(deploy.id, "baseline-retention");
  assert.match(
    deploy.run,
    /env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID -u WRANGLER_OUTPUT_FILE_PATH node \.staging-baseline-control\/ci\/candidate-staging-baseline-retain.mjs retain/,
  );
  assert.match(deploy.run, /trap 'rm -f -- .*upload\.form.*deploy\.jsonl.*' EXIT/);
  assert.ok(deploy.run.indexOf("trap '") < deploy.run.indexOf("npx wrangler deploy"));
  assert.ok(
    deploy.run.indexOf("npx wrangler deploy") < deploy.run.indexOf("env -u CLOUDFLARE_API_TOKEN"),
  );
  assert.equal(deploy.if, undefined);
  assert.equal(deploy["continue-on-error"], undefined);
  const payload = steps[at("Upload retained staging baseline")];
  const independent = steps[at("Upload independent staging baseline producer record")];
  for (const step of [payload, independent]) {
    assert.equal(step.uses, "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
    assert.equal(step.with["if-no-files-found"], "error");
    assert.equal(step.with["retention-days"], 30);
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.if, undefined);
    assert.doesNotMatch(step.with.path, /upload\.form|deploy\.jsonl/);
  }
  assert.equal(payload.with.path, "${{ env.BASELINE_RETENTION_ROOT }}/payload/*");
  assert.equal(independent.with.path, "${{ env.BASELINE_RETENTION_ROOT }}/producer.json");
  assert.ok(
    at("Upload retained staging baseline") <
      at("Join independent staging baseline producer record"),
  );
  assert.ok(
    at("Join independent staging baseline producer record") <
      at("Upload independent staging baseline producer record"),
  );
  assert.ok(
    at("Upload independent staging baseline producer record") <
      at("Re-verify exact-SHA full CI before detaching web consumers"),
  );
  assert.deepEqual(steps[at("Join independent staging baseline producer record")].env, {
    BASELINE_ARTIFACT_ID: "${{ steps.baseline-artifact.outputs.artifact-id }}",
    BASELINE_ARCHIVE_SHA256: "${{ steps.baseline-artifact.outputs.artifact-digest }}",
  });
  // The launcher now exists, but only its read-only observation phase is wired.
  // Retention must not silently activate any candidate mutation or qualification.
  const launcher = YAML.parse(readFileSync(".github/workflows/candidate-staging.yml", "utf8"));
  assert.deepEqual(Object.keys(launcher.on), ["workflow_dispatch"]);
  assert.deepEqual(launcher.permissions, {
    contents: "read",
    actions: "read",
    "pull-requests": "read",
  });
  assert.deepEqual(Object.keys(launcher.jobs), ["preflight"]);
  const preflight = launcher.jobs.preflight;
  assert.equal(preflight.environment, undefined);
  assert.equal(preflight.permissions, undefined);
  assert.equal(preflight.steps.length, 3);
  assert.deepEqual(
    preflight.steps.filter((step) => step.run).map((step) => ({ run: step.run, env: step.env })),
    [
      {
        run: "node ci/candidate-staging-preflight.mjs",
        env: { GITHUB_TOKEN: "${{ github.token }}", CANDIDATE_SELECTION: "${{ toJSON(inputs) }}" },
      },
    ],
  );
  assert.ok(!JSON.stringify(launcher).includes("secrets."));
});
