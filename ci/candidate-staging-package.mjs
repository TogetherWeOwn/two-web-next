// Inert post-sandbox packaging. The trusted caller must first stop the entire
// candidate sandbox and hold its output tree read-only. No bundler, dependency
// loader, candidate manifest or candidate script runs in this module.
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  admitCandidateBundle,
  candidateIdentity,
  candidateSha256,
  safeBundlePath,
} from "./candidate-staging-admission.mjs";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 4096;
const MAX_NODES = 8192;
const CONTROL = new Set(["_worker.js", "_headers", "_redirects", "_routes.json", ".assetsignore"]);
const REBUILD_SCHEMA = "two.rebuilt-baseline-manifest.v1";
const DIGEST = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[1-9][0-9]{0,15}$/;

function requireEvidence(value) {
  if (!value) throw new Error("Candidate package refused: output");
}

function keys(value, names) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === names.split(",").sort().join(",")
  );
}

function sameFile(before, after) {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs", "nlink"].every(
    (key) => before[key] === after[key],
  );
}

// Linux descriptor-relative traversal pins every ancestor, including when a
// name is replaced. O_NOFOLLOW rejects links; O_NONBLOCK avoids waiting on FIFOs.
// /proc paths here are derived solely from our own open numeric descriptors.
export function collectCandidateKitPackage(options) {
  try {
    requireEvidence(
      process.platform === "linux" &&
        keys(options, "assetRoot,worker") &&
        typeof options.assetRoot === "string" &&
        options.assetRoot.startsWith("/") &&
        Buffer.isBuffer(options.worker) &&
        options.worker.length > 0 &&
        options.worker.length <= MAX_BYTES,
    );
    const root = resolve(options.assetRoot);
    requireEvidence(realpathSync(root) === root);
    const files = [{ path: "worker/worker.mjs", type: "file", bytes: Buffer.from(options.worker) }];
    const paths = new Set(["worker/worker.mjs"]);
    let total = options.worker.length;
    let nodes = 0;
    let ignored = 0;
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    function walk(fd, prefix, depth) {
      requireEvidence(depth <= 16);
      const before = fstatSync(fd, { bigint: true });
      requireEvidence(before.isDirectory());
      const directory = opendirSync(`/proc/self/fd/${fd}`, { bufferSize: 32 });
      try {
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          requireEvidence(++nodes <= MAX_NODES);
          const relative = prefix + entry.name;
          const path = `assets/${relative}`;
          requireEvidence(
            (safeBundlePath(path) || relative === ".assetsignore") &&
              !paths.has(path.toLowerCase()),
          );
          paths.add(path.toLowerCase());
          const child = openSync(`/proc/self/fd/${fd}/${entry.name}`, flags);
          try {
            const stat = fstatSync(child, { bigint: true });
            const isControl = CONTROL.has(entry.name.toLowerCase());
            if (isControl) {
              // Adapter control files are NOT public assets. Never load their
              // rules. Only the exact three known root files may be discarded.
              requireEvidence(
                prefix === "" &&
                  ["_worker.js", "_headers", ".assetsignore"].includes(entry.name) &&
                  stat.isFile() &&
                  stat.nlink === 1n &&
                  stat.size <= BigInt(MAX_BYTES),
              );
              ignored++;
            } else if (stat.isDirectory()) {
              walk(child, `${relative}/`, depth + 1);
            } else {
              requireEvidence(stat.isFile() && stat.nlink === 1n && stat.size <= BigInt(MAX_BYTES));
              total += Number(stat.size);
              requireEvidence(total <= MAX_BYTES && files.length < MAX_FILES);
              const bytes = Buffer.alloc(Number(stat.size));
              let offset = 0;
              while (offset < bytes.length) {
                const count = readSync(child, bytes, offset, bytes.length - offset, offset);
                requireEvidence(count > 0);
                offset += count;
              }
              const sentinel = Buffer.alloc(1);
              requireEvidence(
                readSync(child, sentinel, 0, 1, offset) === 0 &&
                  sameFile(stat, fstatSync(child, { bigint: true })),
              );
              files.push({ path, type: "file", bytes });
            }
          } finally {
            closeSync(child);
          }
        }
      } finally {
        directory.closeSync();
      }
      requireEvidence(sameFile(before, fstatSync(fd, { bigint: true })));
    }
    const fd = openSync(root, flags | constants.O_DIRECTORY);
    try {
      walk(fd, "", 0);
    } finally {
      closeSync(fd);
    }
    // A Kit output needs its generated entrypoint; a random asset directory is
    // not a complete Kit build. _headers is optional and never supplies policy.
    requireEvidence(paths.has("assets/_worker.js"));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files, bytes: total, ignoredControlFiles: ignored };
  } catch {
    throw new Error("Candidate package refused: output");
  }
}

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

function canonicalOutputPath(value) {
  // A deliberately narrow UTF-8 subset: no normalization, percent decoding or
  // extension filtering can silently change the deployed path inventory.
  return (
    typeof value === "string" &&
    value.length <= 240 &&
    /^[A-Za-z0-9_./-]+$/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("."))
  );
}

function componentProfile(components) {
  requireEvidence(Array.isArray(components) && components.length > 0 && components.length <= 32);
  const seen = new Set();
  const profile = [];
  for (const component of components) {
    requireEvidence(
      keys(component, "id,mainModule,assets,sourceMaps") &&
        typeof component.id === "string" &&
        /^[a-z][a-z0-9-]{0,63}$/.test(component.id) &&
        !seen.has(component.id) &&
        canonicalOutputPath(component.mainModule) &&
        ["none", "empty", "present"].includes(component.assets) &&
        Array.isArray(component.sourceMaps) &&
        component.sourceMaps.length <= MAX_FILES,
    );
    seen.add(component.id);
    const maps = [];
    for (const path of component.sourceMaps) {
      requireEvidence(canonicalOutputPath(path) && path.endsWith(".map"));
      maps.push(path);
    }
    maps.sort();
    requireEvidence(new Set(maps.map((path) => path.toLowerCase())).size === maps.length);
    profile.push(Object.freeze({ ...component, sourceMaps: Object.freeze(maps) }));
  }
  profile.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  return Object.freeze(profile);
}

// Pure post-sandbox producer seam. `components` and both digests come from the
// trusted, separately pinned complete recipe/config profile, NOT build output.
// `files` must be the entire inert output inventory, obtained after destruction
// of the source sandbox (e.g. collectCandidateKitPackage for the web component).
// This validates coverage against that profile; it cannot attest enumeration,
// sandbox destruction, source authentication or the contents behind a digest.
export function createRebuiltBaselineManifest(options) {
  try {
    requireEvidence(
      keys(options, "components,configDigest,recipeDigest,files") &&
        matches(DIGEST, options.configDigest) &&
        matches(DIGEST, options.recipeDigest) &&
        Array.isArray(options.files) &&
        options.files.length > 0 &&
        options.files.length <= MAX_FILES,
    );
    const components = componentProfile(options.components);
    const byId = new Map(components.map((component) => [component.id, component]));
    const names = new Map();
    const counts = new Map(components.map((component) => [component.id, { assets: 0, maps: [] }]));
    const records = [];
    let total = 0;
    for (const file of options.files) {
      requireEvidence(
        keys(file, "component,kind,path,type,bytes,contentType") &&
          byId.has(file.component) &&
          ["module", "source-map", "asset"].includes(file.kind) &&
          canonicalOutputPath(file.path) &&
          file.type === "file" &&
          Buffer.isBuffer(file.bytes) &&
          (file.kind === "asset"
            ? file.contentType === null
            : file.kind === "source-map"
              ? file.contentType === "application/source-map" && file.path.endsWith(".map")
              : file.contentType === "application/javascript+module"),
      );
      total += file.bytes.length;
      requireEvidence(total <= MAX_BYTES);
      // Module and map paths share one namespace; static assets have another.
      // Check ancestors too: Foo/a and foo/b, or a file replacing a directory,
      // must not depend on the producer's filesystem case semantics.
      const namespace = `${file.component}/${file.kind === "asset" ? "asset" : "code"}/`;
      const parts = file.path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const path = namespace + parts.slice(0, i).join("/");
        const kind = i === parts.length ? "file" : "directory";
        const previous = names.get(path.toLowerCase());
        requireEvidence(
          !previous || (kind === "directory" && previous.kind === kind && previous.path === path),
        );
        names.set(path.toLowerCase(), { path, kind });
        requireEvidence(names.size <= MAX_NODES);
      }
      if (file.kind === "asset") counts.get(file.component).assets++;
      if (file.kind === "source-map") counts.get(file.component).maps.push(file.path);
      records.push(
        Object.freeze({
          component: file.component,
          kind: file.kind,
          path: file.path,
          size: file.bytes.length,
          sha256: candidateSha256(file.bytes),
          contentType: file.contentType,
        }),
      );
    }
    for (const component of components) {
      const count = counts.get(component.id);
      requireEvidence(
        records.some(
          (file) =>
            file.component === component.id &&
            file.kind === "module" &&
            file.path === component.mainModule &&
            file.size > 0,
        ) &&
          (component.assets === "present" ? count.assets > 0 : count.assets === 0) &&
          JSON.stringify(count.maps.sort()) === JSON.stringify(component.sourceMaps),
      );
    }
    records.sort((a, b) => {
      for (const key of ["component", "path"]) {
        const order = Buffer.compare(Buffer.from(a[key]), Buffer.from(b[key]));
        if (order) return order;
      }
      return Buffer.compare(Buffer.from(a.kind), Buffer.from(b.kind));
    });
    const canonical = `${JSON.stringify([
      REBUILD_SCHEMA,
      records.map((file) => [
        file.component,
        file.kind,
        file.path,
        file.size,
        file.sha256,
        file.contentType,
      ]),
      options.configDigest,
      options.recipeDigest,
    ])}\n`;
    requireEvidence(
      Buffer.byteLength(canonical) <= 1024 * 1024 &&
        total + Buffer.byteLength(canonical) <= MAX_BYTES,
    );
    return Object.freeze({
      schema: REBUILD_SCHEMA,
      promotable: false,
      scope: "complete-retained-manifest-only",
      components,
      files: Object.freeze(records),
      configDigest: options.configDigest,
      recipeDigest: options.recipeDigest,
      canonical,
      rootSha256: candidateSha256(canonical),
      bytes: total,
    });
  } catch {
    throw new Error("Candidate package refused: rebuild-manifest");
  }
}

// The wrapper supplies selections/producer records through its protected output
// channel and artifact metadata through independent GitHub readers. Never call
// this with archive-local attestations as authority. This pure join deliberately
// grants NO operational admission: run/job/workflow authentication, retained ZIP
// validation, sandbox isolation and every F/O control remain external gates.
export function finalizeRebuiltBaselineProducerReceipt(options) {
  try {
    requireEvidence(keys(options, "expected,builds"));
    const { expected, builds } = options;
    requireEvidence(
      keys(expected, "repositoryId,sourceSha,producerSha,components,configDigest,recipeDigest") &&
        matches(ID, expected.repositoryId) &&
        matches(SHA, expected.sourceSha) &&
        matches(SHA, expected.producerSha) &&
        matches(DIGEST, expected.configDigest) &&
        matches(DIGEST, expected.recipeDigest) &&
        Array.isArray(builds) &&
        builds.length === 2,
    );
    const receipts = [];
    const artifacts = new Set();
    const jobs = new Set();
    let manifest;
    for (const build of builds) {
      requireEvidence(keys(build, "selection,artifact,producer,files"));
      const { selection, artifact, producer, files } = build;
      requireEvidence(
        keys(selection, "runId,runAttempt,jobId,artifactId,archiveSha256") &&
          [selection.runId, selection.runAttempt, selection.jobId, selection.artifactId].every(
            (value) => matches(ID, value),
          ) &&
          matches(DIGEST, selection.archiveSha256) &&
          !artifacts.has(selection.artifactId) &&
          !jobs.has(selection.jobId),
      );
      artifacts.add(selection.artifactId);
      jobs.add(selection.jobId);
      const actualId = (value, selected) =>
        Number.isSafeInteger(value) && String(value) === selected;
      requireEvidence(
        actualId(artifact?.id, selection.artifactId) &&
          artifact.expired === false &&
          artifact.digest === `sha256:${selection.archiveSha256}` &&
          actualId(artifact.workflow_run?.id, selection.runId) &&
          actualId(artifact.workflow_run.repository_id, expected.repositoryId) &&
          actualId(artifact.workflow_run.head_repository_id, expected.repositoryId) &&
          artifact.workflow_run.head_sha === expected.producerSha,
      );
      const current = createRebuiltBaselineManifest({
        components: expected.components,
        configDigest: expected.configDigest,
        recipeDigest: expected.recipeDigest,
        files,
      });
      requireEvidence(
        keys(
          producer,
          "schema,repositoryId,sourceSha,producerSha,runId,runAttempt,jobId,artifactId,archiveSha256,manifestRoot",
        ) &&
          producer.schema === "two.rebuilt-baseline-producer.v1" &&
          ["repositoryId", "sourceSha", "producerSha"].every(
            (key) => producer[key] === expected[key],
          ) &&
          ["runId", "runAttempt", "jobId", "artifactId", "archiveSha256"].every(
            (key) => producer[key] === selection[key],
          ) &&
          producer.manifestRoot === current.rootSha256 &&
          (!manifest || manifest.canonical === current.canonical),
      );
      manifest = current;
      receipts.push(Object.freeze({ ...selection }));
    }
    return Object.freeze({
      schema: "two.rebuilt-baseline-pair.v1",
      promotable: false,
      scope: "paired-retained-manifests-only",
      operationalAdmission: false,
      repositoryId: expected.repositoryId,
      sourceSha: expected.sourceSha,
      producerSha: expected.producerSha,
      builds: Object.freeze(receipts),
      manifest,
    });
  } catch {
    throw new Error("Candidate package refused: rebuild-pair");
  }
}

// Run only in the trusted wrapper after immutable upload metadata is known.
// This assembles the join; it does NOT authenticate its caller or constitute an
// attestation. Its authority must come from independently verified producer
// workflow/run/attempt/source, never a receipt found inside the candidate ZIP.
export function finalizeCandidateProducerReceipt(options) {
  try {
    requireEvidence(keys(options, "identity,build,artifact,files"));
    const { identity, build, artifact, files } = options;
    requireEvidence(
      keys(identity, "descriptor,q,ciRunId,ciRunAttempt") &&
        Array.isArray(identity.descriptor) &&
        identity.descriptor.length === 12,
    );
    const d = identity.descriptor;
    const expected = candidateIdentity(
      {
        prNumber: d[3],
        headSha: d[4],
        ciRunId: identity.ciRunId,
        ciRunAttempt: identity.ciRunAttempt,
      },
      {
        repositoryId: d[1],
        repository: d[2],
        controllerSha: d[5],
        launcherSha: d[6],
        checkoutSha: d[5],
        runId: d[7],
        runAttempt: d[8],
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        path: ".github/workflows/candidate-staging.yml",
      },
    );
    requireEvidence(
      identity.q === expected.q && JSON.stringify(d) === JSON.stringify(expected.descriptor),
    );
    requireEvidence(Array.isArray(files) && files.length > 0 && files.length <= MAX_FILES);
    let total = 0;
    const records = files
      .map((file) => {
        requireEvidence(
          keys(file, "path,type,bytes") &&
            safeBundlePath(file.path) &&
            file.type === "file" &&
            Buffer.isBuffer(file.bytes),
        );
        total += file.bytes.length;
        requireEvidence(total <= MAX_BYTES);
        return { path: file.path, size: file.bytes.length, sha256: candidateSha256(file.bytes) };
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const receipt = {
      schema: "two.candidate-build.v1",
      q: identity.q,
      ciRunId: identity.ciRunId,
      ciRunAttempt: identity.ciRunAttempt,
      buildRunId: build?.runId,
      buildRunAttempt: build?.runAttempt,
      artifactId: build?.artifactId,
      archiveSha256: build?.archiveSha256,
      files: records,
      rootSha256: candidateSha256(
        JSON.stringify(records.map((file) => [file.path, file.size, file.sha256])),
      ),
    };
    requireEvidence(Buffer.byteLength(JSON.stringify(receipt)) <= 1024 * 1024);
    admitCandidateBundle(expected, build, artifact, receipt, files);
    for (const record of records) Object.freeze(record);
    Object.freeze(records);
    return Object.freeze(receipt);
  } catch {
    throw new Error("Candidate package refused: receipt");
  }
}
