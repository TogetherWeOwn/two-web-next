import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readSync } from "node:fs";

const REPOSITORY = "TogetherWeOwn/two-web-next";
const SHA = /^[0-9a-f]{40}$/;
const STABLE_TAG = /^v(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})$/;
const WORKFLOWS = [".github/workflows/rollback-production.yml", ".github/workflows/release.yml"];
const MAX_EVIDENCE = 1024 * 1024;
const MAX_WORKFLOW = 256 * 1024;

function git(args, failure, maxBuffer = 4096) {
  try {
    return execFileSync("git", ["--no-replace-objects", ...args], {
      env: {
        PATH: process.env.PATH,
        GIT_ALLOW_PROTOCOL: "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer,
    });
  } catch {
    throw new Error(failure);
  }
}

function readEvidence() {
  const bytes = Buffer.alloc(MAX_EVIDENCE + 1);
  let length = 0;
  try {
    while (length < bytes.length) {
      const count = readSync(0, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
  } catch {
    throw new Error("release evidence is unreadable");
  }
  if (length === 0) throw new Error("release evidence is absent");
  if (length > MAX_EVIDENCE) throw new Error("release evidence exceeds 1 MiB");
  const input = bytes.subarray(0, length);
  try {
    if (!isUtf8(input)) throw new Error("invalid UTF-8");
    return JSON.parse(input.toString("utf8"));
  } catch {
    throw new Error("release evidence must be UTF-8 JSON");
  }
}

function releaseRef(evidence, tag) {
  const release = evidence?.release;
  const ref = evidence?.ref;
  const qualifiedTag = `refs/tags/${tag}`;
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  if (
    !Number.isSafeInteger(release?.id) ||
    release.id <= 0 ||
    release.url !== `${api}/releases/${release.id}` ||
    release.html_url !== `https://github.com/${REPOSITORY}/releases/tag/${tag}` ||
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.immutable !== true ||
    typeof release.published_at !== "string" ||
    !Number.isFinite(Date.parse(release.published_at))
  ) {
    throw new Error("evidence must identify the selected immutable published stable release");
  }
  if (
    ref?.ref !== qualifiedTag ||
    ref.url !== `${api}/git/${qualifiedTag}` ||
    !["tag", "commit"].includes(ref.object?.type) ||
    typeof ref.object?.sha !== "string" ||
    !SHA.test(ref.object.sha)
  ) {
    throw new Error("evidence must identify the selected release tag ref and its Git object");
  }
  return ref.object;
}

function workflowBlob(commit, path, revision) {
  const failure = `${revision} revision lacks a readable regular workflow blob at ${path}`;
  const entry = git(["ls-tree", "-z", "--full-tree", commit, "--", path], failure).toString("utf8");
  const match = /^(?:100644|100755) blob ([0-9a-f]{40})\t/.exec(entry);
  if (!match || entry.slice(match[0].length) !== `${path}\0`) throw new Error(failure);
  const oid = match[1];
  if (git(["cat-file", "-t", oid], failure).toString("ascii").trimEnd() !== "blob") {
    throw new Error(failure);
  }
  const bytes = git(["cat-file", "blob", oid], failure, MAX_WORKFLOW);
  if (bytes.length === 0) throw new Error(failure);
  return { oid, bytes };
}

function verify(tag, pin, reviewed, evidence) {
  const object = releaseRef(evidence, tag);
  const localTag = git(
    ["show-ref", "--verify", "--hash", `refs/tags/${tag}`],
    "local release tag ref is absent or unreadable",
  )
    .toString("ascii")
    .trimEnd();
  if (localTag !== object.sha) throw new Error("local release tag differs from captured tag ref");
  const type = git(["cat-file", "-t", localTag], "release tag object is unreadable")
    .toString("ascii")
    .trimEnd();
  if (type !== object.type)
    throw new Error("release tag object type differs from captured tag ref");
  // Peel the captured object, so a concurrent ref update cannot change the
  // inputs used to look up the commit and its blobs.
  const peeled = git(
    ["rev-parse", "--verify", "--end-of-options", `${localTag}^{commit}`],
    "release tag does not peel to a readable commit",
  )
    .toString("ascii")
    .trimEnd();
  if (peeled !== pin) throw new Error("release tag peeled commit does not match the proposed pin");
  const reviewedCommit = git(
    ["cat-file", "-t", reviewed],
    "reviewed revision is not a readable commit",
  )
    .toString("ascii")
    .trimEnd();
  if (reviewedCommit !== "commit") throw new Error("reviewed revision is not a readable commit");

  const workflows = WORKFLOWS.map((path) => {
    const pinned = workflowBlob(pin, path, "pinned");
    const reference = workflowBlob(reviewed, path, "reviewed");
    if (!pinned.bytes.equals(reference.bytes)) throw new Error(`workflow bytes differ at ${path}`);
    return {
      path,
      blob: pinned.oid,
      sha256: createHash("sha256").update(pinned.bytes).digest("hex"),
    };
  });
  return {
    repository: REPOSITORY,
    releaseId: evidence.release.id,
    tag,
    tagObject: localTag,
    pin,
    reviewed,
    workflows,
  };
}

try {
  const [tag, pin, reviewed] = process.argv.slice(2);
  if (process.argv.length !== 5 || !STABLE_TAG.test(tag) || !SHA.test(pin) || !SHA.test(reviewed)) {
    throw new Error(
      "usage: node ci/verify-release-workflow-pin.mjs <tag> <pin-sha> <reviewed-sha> < evidence.json",
    );
  }
  console.log(JSON.stringify(verify(tag, pin, reviewed, readEvidence())));
} catch (error) {
  console.error(`release workflow pin refused: ${error.message}`);
  process.exitCode = 1;
}
