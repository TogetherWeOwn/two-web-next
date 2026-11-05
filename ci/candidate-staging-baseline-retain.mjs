// Normal staging producer only. Discard upload metadata (including asset JWTs),
// retain inert exact module/asset bytes, and publish the artifact join separately.
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import { collectCandidateKitPackage } from "./candidate-staging-package.mjs";

const MAX = 16 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]{0,15}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ERROR = "Candidate baseline retention refused";

function requireEvidence(value) {
  if (!value) throw new Error(ERROR);
}

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

function keys(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === fields.split(",").sort().join(",")
  );
}

function source(input) {
  requireEvidence(
    keys(input, "repository,repositoryId,sourceSha,workflowSha,runId,runAttempt,event"),
  );
  requireEvidence(
    input.repository === "TogetherWeOwn/two-web-next" &&
      matches(ID, input.repositoryId) &&
      matches(SHA, input.sourceSha) &&
      matches(SHA, input.workflowSha) &&
      matches(ID, input.runId) &&
      matches(ID, input.runAttempt) &&
      ["workflow_run", "workflow_dispatch"].includes(input.event),
  );
  return { ...input };
}

function readBounded(path, max) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    requireEvidence(
      before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(max),
    );
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      requireEvidence(count > 0);
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    requireEvidence(
      readSync(fd, Buffer.alloc(1), 0, 1, offset) === 0 &&
        ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs", "nlink"].every(
          (key) => before[key] === after[key],
        ),
    );
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function json(bytes) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

// This is a retention record, NOT an authenticated provider snapshot, actual
// serving observation, complete B admission, or permission to mutate staging.
export async function retainStagingBaseline({ upload, deployOutput, producer, assetRoot }) {
  try {
    const provenance = source(producer);
    requireEvidence(
      Buffer.isBuffer(upload) &&
        upload.length > 0 &&
        upload.length <= MAX &&
        Buffer.isBuffer(deployOutput) &&
        deployOutput.length > 0 &&
        deployOutput.length <= 16384,
    );
    const rows = new TextDecoder("utf-8", { fatal: true })
      .decode(deployOutput)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    requireEvidence(rows.length === 1);
    const row = rows[0];
    requireEvidence(
      row.type === "deploy" &&
        row.version === 1 &&
        row.worker_name === "two-web-next" &&
        matches(UUID, row.version_id) &&
        row.wrangler_environment === undefined &&
        row.worker_name_overridden === false &&
        Array.isArray(row.targets) &&
        row.targets.length === 1 &&
        row.targets[0] === "next.togetherweown.com (custom domain)" &&
        typeof row.timestamp === "string" &&
        Number.isFinite(Date.parse(row.timestamp)),
    );
    const end = upload.indexOf("\r\n");
    requireEvidence(end > 2 && end <= 90 && upload.subarray(0, 2).equals(Buffer.from("--")));
    const boundary = upload.subarray(2, end).toString("ascii");
    requireEvidence(/^[A-Za-z0-9-]{8,80}$/.test(boundary));
    const form = await new Response(upload, {
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    }).formData();
    const meta = form.getAll("metadata");
    requireEvidence(
      meta.length === 1 && typeof meta[0] === "string" && Buffer.byteLength(meta[0]) <= 65536,
    );
    const metadata = JSON.parse(meta[0]);
    // Nothing else in metadata is serialized. In particular, assets.jwt, secret
    // bindings, package metadata and provider messages never enter the artifact.
    requireEvidence(
      metadata.main_module === "_worker.js" &&
        metadata.annotations?.["workers/tag"] === provenance.sourceSha,
    );
    const files = [];
    const names = new Set();
    let size = 0;
    for (const [name, value] of form) {
      if (name === "metadata") continue;
      requireEvidence(
        !names.has(name) &&
          ["_worker.js", "_worker.js.map"].includes(name) &&
          typeof value !== "string" &&
          value.name === name &&
          value.type ===
            (name === "_worker.js" ? "application/javascript+module" : "application/source-map"),
      );
      names.add(name);
      size += value.size;
      requireEvidence(size <= MAX);
      files.push({
        kind: "module",
        path: name,
        contentType: value.type,
        bytes: Buffer.from(await value.arrayBuffer()),
      });
    }
    requireEvidence(names.has("_worker.js"));
    const worker = files.find((file) => file.path === "_worker.js").bytes;
    const assets = collectCandidateKitPackage({ assetRoot, worker }).files.filter((file) =>
      file.path.startsWith("assets/"),
    );
    // Match the shipped Kit adapter's exact ignore policy. Do not treat arbitrary
    // ignore rules as a complete retained asset set, or interpret candidate rules.
    const ignore = readBounded(resolve(assetRoot, ".assetsignore"), 1024);
    requireEvidence(
      ignore.equals(Buffer.from("\n_worker.js\n_routes.json\n_headers\n_redirects")) ||
        ignore.equals(Buffer.from("\n_worker.js\n_routes.json\n_headers\n_redirects\n")),
    );
    for (const asset of assets) {
      size += asset.bytes.length;
      requireEvidence(size <= MAX);
      files.push({
        kind: "asset",
        path: asset.path.slice(7),
        contentType: null,
        bytes: asset.bytes,
      });
    }
    files.sort((a, b) => (`${a.kind}:${a.path}` < `${b.kind}:${b.path}` ? -1 : 1));
    const records = files.map((file, index) => ({
      kind: file.kind,
      path: file.path,
      contentType: file.contentType,
      size: file.bytes.length,
      sha256: candidateSha256(file.bytes),
      entry: `file-${String(index).padStart(4, "0")}`,
    }));
    const manifest = {
      schema: "two.staging-baseline-retention.v1",
      promotable: false,
      scope: "retained-bytes-only",
      producer: provenance,
      versionId: row.version_id,
      mainModule: "_worker.js",
      files: records,
      rootSha256: candidateSha256(JSON.stringify(records)),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    requireEvidence(
      manifestBytes.length <= 1024 * 1024 &&
        size + manifestBytes.length <= MAX &&
        records.length < 4096,
    );
    return {
      manifest,
      manifestBytes,
      entries: [
        { path: "baseline.json", bytes: manifestBytes },
        ...files.map((file, index) => ({ path: records[index].entry, bytes: file.bytes })),
      ],
    };
  } catch {
    throw new Error(ERROR);
  }
}

export function baselineProducerRecord({ manifestBytes, artifactId, archiveSha256 }) {
  try {
    requireEvidence(
      Buffer.isBuffer(manifestBytes) &&
        manifestBytes.length > 0 &&
        manifestBytes.length <= 1024 * 1024,
    );
    const manifest = json(manifestBytes);
    requireEvidence(
      keys(manifest, "schema,promotable,scope,producer,versionId,mainModule,files,rootSha256") &&
        manifest.schema === "two.staging-baseline-retention.v1" &&
        manifest.promotable === false &&
        manifest.scope === "retained-bytes-only" &&
        matches(UUID, manifest.versionId) &&
        manifest.mainModule === "_worker.js" &&
        Array.isArray(manifest.files) &&
        manifest.files.length > 0 &&
        manifest.files.length < 4096 &&
        matches(DIGEST, manifest.rootSha256) &&
        candidateSha256(JSON.stringify(manifest.files)) === manifest.rootSha256 &&
        matches(ID, artifactId) &&
        matches(DIGEST, archiveSha256),
    );
    return Object.freeze({
      schema: "two.staging-baseline-producer.v1",
      promotable: false,
      scope: "producer-join-only",
      producer: source(manifest.producer),
      versionId: manifest.versionId,
      artifactId,
      archiveSha256,
      manifestSha256: candidateSha256(manifestBytes),
      rootSha256: manifest.rootSha256,
    });
  } catch {
    throw new Error(ERROR);
  }
}

async function main() {
  const env = process.env;
  try {
    requireEvidence(
      env.GITHUB_REPOSITORY === "TogetherWeOwn/two-web-next" &&
        env.GITHUB_REF === "refs/heads/main",
    );
    const root = resolve(env.BASELINE_RETENTION_ROOT ?? "");
    requireEvidence(
      typeof env.RUNNER_TEMP === "string" &&
        root.startsWith(`${resolve(env.RUNNER_TEMP)}/staging-baseline-`),
    );
    if (process.argv[2] === "retain" && process.argv.length === 3) {
      const raw = resolve(root, "upload.form");
      const output = resolve(root, "deploy.jsonl");
      try {
        const retained = await retainStagingBaseline({
          upload: readBounded(raw, MAX),
          deployOutput: readBounded(output, 16384),
          producer: {
            repository: env.GITHUB_REPOSITORY,
            repositoryId: env.GITHUB_REPOSITORY_ID,
            sourceSha: env.DEPLOY_SHA,
            workflowSha: env.GITHUB_WORKFLOW_SHA,
            runId: env.GITHUB_RUN_ID,
            runAttempt: env.GITHUB_RUN_ATTEMPT,
            event: env.GITHUB_EVENT_NAME,
          },
          assetRoot: resolve("web/.svelte-kit/cloudflare"),
        });
        for (const entry of retained.entries)
          writeFileSync(resolve(root, "payload", entry.path), entry.bytes, {
            flag: "wx",
            mode: 0o600,
          });
        writeFileSync(env.GITHUB_OUTPUT, `version-id=${retained.manifest.versionId}\n`, {
          flag: "a",
        });
      } finally {
        rmSync(raw, { force: true });
        rmSync(output, { force: true });
      }
    } else if (process.argv[2] === "producer" && process.argv.length === 3) {
      const record = baselineProducerRecord({
        manifestBytes: readBounded(resolve(root, "payload/baseline.json"), 1024 * 1024),
        artifactId: env.BASELINE_ARTIFACT_ID,
        archiveSha256: env.BASELINE_ARCHIVE_SHA256,
      });
      writeFileSync(resolve(root, "producer.json"), JSON.stringify(record), {
        flag: "wx",
        mode: 0o600,
      });
    } else {
      throw new Error(ERROR);
    }
  } catch {
    process.stderr.write(`${ERROR}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
