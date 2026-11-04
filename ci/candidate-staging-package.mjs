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
