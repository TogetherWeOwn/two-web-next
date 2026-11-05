import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import YAML from "yaml";

const SCRIPT = resolve("ci/candidate-staging-baseline-retain.mjs");
const SHA = "b".repeat(40);
const VERSION = "12345678-1234-1234-1234-123456789abc";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "baseline-cli-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  const root = join(cwd, "staging-baseline-capture");
  const assetRoot = join(cwd, "web/.svelte-kit/cloudflare");
  mkdirSync(join(root, "payload"), { recursive: true });
  mkdirSync(assetRoot, { recursive: true });
  writeFileSync(join(assetRoot, "_worker.js"), "generated");
  writeFileSync(
    join(assetRoot, ".assetsignore"),
    "\n_worker.js\n_routes.json\n_headers\n_redirects",
  );
  writeFileSync(join(assetRoot, "style.css"), "body{}");
  const output = join(cwd, "outputs");
  writeFileSync(output, "");
  const env = {
    PATH: process.env.PATH,
    GITHUB_REPOSITORY: "TogetherWeOwn/two-web-next",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY_ID: "1234",
    DEPLOY_SHA: SHA,
    GITHUB_WORKFLOW_SHA: SHA,
    GITHUB_RUN_ID: "500",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "workflow_run",
    RUNNER_TEMP: cwd,
    BASELINE_RETENTION_ROOT: root,
    GITHUB_OUTPUT: output,
  };
  return { cwd, root, env, output };
}

async function captures(w) {
  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({
      main_module: "_worker.js",
      annotations: { "workers/tag": SHA },
      assets: { jwt: "synthetic-capability-must-not-leak" },
    }),
  );
  form.append(
    "_worker.js",
    new File(["throw new Error('must not execute');"], "_worker.js", {
      type: "application/javascript+module",
    }),
  );
  writeFileSync(join(w.root, "upload.form"), Buffer.from(await new Response(form).arrayBuffer()));
  writeFileSync(
    join(w.root, "deploy.jsonl"),
    JSON.stringify({
      type: "deploy",
      version: 1,
      worker_name: "two-web-next",
      version_id: VERSION,
      targets: ["next.togetherweown.com (custom domain)"],
      worker_name_overridden: false,
      timestamp: "2026-11-05T02:40:00Z",
    }),
  );
}

function cli(w, mode) {
  return spawnSync(process.execPath, [SCRIPT, mode], {
    cwd: w.cwd,
    env: w.env,
    encoding: "utf8",
    timeout: 10000,
  });
}

test("actual CLI writes only sanitized flat payload then separate immutable artifact join", async (t) => {
  const w = fixture(t);
  await captures(w);
  let result = cli(w, "retain");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(join(w.root, "upload.form")), false);
  assert.equal(existsSync(join(w.root, "deploy.jsonl")), false);
  assert.equal(readFileSync(w.output, "utf8"), `version-id=${VERSION}\n`);
  assert.deepEqual(readdirSync(join(w.root, "payload")), [
    "baseline.json",
    "file-0000",
    "file-0001",
  ]);
  for (const name of readdirSync(join(w.root, "payload")))
    assert.doesNotMatch(
      readFileSync(join(w.root, "payload", name), "utf8"),
      /synthetic-capability/,
    );
  w.env.BASELINE_ARTIFACT_ID = "600";
  w.env.BASELINE_ARCHIVE_SHA256 = "d".repeat(64);
  result = cli(w, "producer");
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(join(w.root, "producer.json"), "utf8"));
  assert.equal(record.artifactId, "600");
  assert.equal(record.versionId, VERSION);
  assert.equal(record.producer.sourceSha, SHA);
  assert.equal(record.archiveSha256, "d".repeat(64));
  const retry = cli(w, "producer");
  assert.equal(retry.status, 1);
  assert.equal(readFileSync(join(w.root, "producer.json"), "utf8"), JSON.stringify(record));
});

test("normal staging reruns retain their explicit attempt without becoming admission authority", async (t) => {
  const w = fixture(t);
  await captures(w);
  w.env.GITHUB_RUN_ATTEMPT = "2";
  const r = cli(w, "retain");
  assert.equal(r.status, 0, r.stderr);
  const manifest = JSON.parse(readFileSync(join(w.root, "payload/baseline.json"), "utf8"));
  assert.equal(manifest.producer.runAttempt, "2");
  assert.equal(manifest.promotable, false);
  assert.equal(manifest.scope, "retained-bytes-only");
});

test("old target checkouts get retention tooling from the workflow-pinned control closure", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
  const steps = workflow.jobs["deploy-staging"].steps;
  const control = steps.find((s) => s.name === "Read installed staging baseline retention tooling");
  assert.ok(control, "missing workflow-pinned control checkout");
  assert.equal(control.with.ref, "${{ github.workflow_sha }}");
  assert.equal(control.with.path, ".staging-baseline-control");
  assert.equal(control.with["persist-credentials"], false);
  assert.deepEqual(control.with["sparse-checkout"].trim().split("\n"), [
    "ci/candidate-staging-baseline-retain.mjs",
    "ci/candidate-staging-package.mjs",
    "ci/candidate-staging-admission.mjs",
  ]);
  assert.match(
    steps.find((s) => s.name === "Deploy to Cloudflare Workers").run,
    /node \.staging-baseline-control\/ci\/candidate-staging-baseline-retain.mjs retain/,
  );
  assert.equal(
    steps.find((s) => s.name === "Join independent staging baseline producer record").run,
    "node .staging-baseline-control/ci/candidate-staging-baseline-retain.mjs producer",
  );
});

test("actual CLI deletes sensitive captures after parse failure without emitting raw data", async (t) => {
  const w = fixture(t);
  await captures(w);
  writeFileSync(join(w.root, "upload.form"), "synthetic-private-parser-message");
  const r = cli(w, "retain");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "Candidate baseline retention refused\n");
  assert.equal(existsSync(join(w.root, "upload.form")), false);
  assert.equal(existsSync(join(w.root, "deploy.jsonl")), false);
  assert.equal(readFileSync(w.output, "utf8"), "");
  assert.equal(readdirSync(join(w.root, "payload")).length, 0);
});

for (const mode of ["success", "deploy-failure", "sanitizer-failure"])
  test(`actual deploy shell cleans captures on ${mode} and scrubs sanitizer credentials`, (t) => {
    const w = fixture(t);
    const bin = join(w.cwd, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npx"),
      `#!/bin/bash\nset -eu\nprintf '%s' private > "$BASELINE_RETENTION_ROOT/upload.form"\nprintf '%s' private > "$BASELINE_RETENTION_ROOT/deploy.jsonl"\ntest "${mode}" != deploy-failure\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, "node"),
      `#!/bin/bash\nset -eu\n[ -z "\${CLOUDFLARE_API_TOKEN+x}" ]\n[ -z "\${CLOUDFLARE_ACCOUNT_ID+x}" ]\n[ -z "\${WRANGLER_OUTPUT_FILE_PATH+x}" ]\nprintf scrubbed > "$BASELINE_RETENTION_ROOT/sanitizer-ran"\ntest "${mode}" != sanitizer-failure\n`,
      { mode: 0o700 },
    );
    const workflow = YAML.parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
    const step = workflow.jobs["deploy-staging"].steps.find(
      (s) => s.name === "Deploy to Cloudflare Workers",
    );
    const shell = step.run
      .replaceAll("${{ steps.kit-route-flags.outputs.archive }}", "false")
      .replaceAll("${{ steps.kit-route-flags.outputs.static }}", "false");
    const r = spawnSync("/bin/bash", ["-c", shell], {
      cwd: w.cwd,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...w.env,
        PATH: `${bin}:${process.env.PATH}`,
        CLOUDFLARE_API_TOKEN: "synthetic-provider-token",
        CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
        WRANGLER_OUTPUT_FILE_PATH: join(w.root, "deploy.jsonl"),
      },
    });
    assert.equal(r.status, mode === "success" ? 0 : 1, r.stderr);
    assert.equal(existsSync(join(w.root, "upload.form")), false);
    assert.equal(existsSync(join(w.root, "deploy.jsonl")), false);
    assert.equal(existsSync(join(w.root, "sanitizer-ran")), mode !== "deploy-failure");
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  });
