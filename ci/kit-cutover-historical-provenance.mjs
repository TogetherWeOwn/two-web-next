import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { sourceInputs, verifyPackage, verifyStagingProof } from "./kit-cutover-evidence.mjs";

const repository = "TogetherWeOwn/two-web-next";
const main = "refs/heads/main";
const workflowRef = `${repository}/.github/workflows/xfs-qualification.yml@${main}`;
const commit = /^[a-f0-9]{40}$/;
const positiveId = /^[1-9][0-9]{0,14}$/;
const digest = /^[a-f0-9]{64}$/;
const matches = (value, pattern) => typeof value === "string" && pattern.test(value);

function git(root, args, refusal) {
  try {
    return execFileSync("git", ["--no-replace-objects", ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        GIT_ALLOW_PROTOCOL: "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_GRAFT_FILE: "/dev/null",
        GIT_NO_LAZY_FETCH: "1",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 4096,
    });
  } catch {
    throw new Error(refusal);
  }
}

async function readDispatchInputs(path) {
  try {
    const stat = await lstat(path);
    if (stat.isFile() && stat.size <= 1024 * 1024) {
      return JSON.parse(await readFile(path, "utf8"))?.inputs;
    }
  } catch {
    throw new Error("Protected dispatch event payload unavailable");
  }
  throw new Error("Protected dispatch event payload unavailable");
}

// Run from trusted dispatcher code with the original runner environment and
// event file. sourceRoot is a separate fresh Git checkout with full main history
// that has never executed candidate code. Keep artifacts and builds outside it.
// Take manifestDigest and proof from the trusted jobs in this same attempt.
// The Actions run/attempt API supplies head_sha but omits the dispatch inputs.
export async function verifyHistoricalCutover({
  env,
  sourceRoot,
  selectedSha,
  packetDir,
  manifestDigest,
  proof,
}) {
  const { GITHUB_SHA: dispatcherSha, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt } = env;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== main ||
    env.GITHUB_REF_PROTECTED !== "true" ||
    env.GITHUB_WORKFLOW_REF !== workflowRef ||
    !matches(dispatcherSha, commit) ||
    env.GITHUB_WORKFLOW_SHA !== dispatcherSha ||
    !matches(runId, positiveId) ||
    !matches(runAttempt, positiveId)
  ) {
    throw new Error("Historical cutover requires the protected main XFS dispatch attempt");
  }

  const dispatch = await readDispatchInputs(env.GITHUB_EVENT_PATH);
  const sourceSha = dispatch?.source_sha;
  if (!matches(sourceSha, commit)) {
    throw new Error("Protected dispatch lacks an explicit full source_sha input");
  }
  if (sourceSha !== selectedSha) throw new Error("Selected source differs from dispatch input");
  const profile = dispatch.cutover_profile;
  if (dispatch.qualify_cutover !== "true" || !["all-off", "ember", "admin"].includes(profile)) {
    throw new Error("Protected dispatch lacks an isolated cutover profile");
  }
  if (!matches(manifestDigest, digest)) throw new Error("Invalid attempt manifest digest");

  git(
    sourceRoot,
    ["merge-base", "--is-ancestor", sourceSha, dispatcherSha],
    "Selected source is not provably in protected main history at dispatch",
  );

  const checkoutRefusal = "Checked out source tree differs from selected source";
  if (
    git(sourceRoot, ["rev-parse", "--show-prefix", "--verify", "HEAD"], checkoutRefusal) !==
      `\n${sourceSha}\n` ||
    git(
      sourceRoot,
      [
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
      ],
      checkoutRefusal,
    ) !== ""
  ) {
    throw new Error(checkoutRefusal);
  }

  const pin = { sourceSha, runId, runAttempt, digest: manifestDigest };
  try {
    await verifyPackage(packetDir, pin, await sourceInputs(sourceRoot));
  } catch {
    throw new Error("Historical cutover packet failed manifest or source verification");
  }
  try {
    verifyStagingProof(proof, { ...pin, mode: profile === "all-off" ? "kit" : profile });
  } catch {
    throw new Error("Historical cutover proof failed attempt or profile verification");
  }
  return { dispatcherSha, ...pin };
}
