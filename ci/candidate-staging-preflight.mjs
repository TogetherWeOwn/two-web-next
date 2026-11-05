// First read-only launcher phase. No candidate checkout, build, provider access,
// CI verdict, staging occupancy or qualification receipt is produced here.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { candidateIdentity } from "./candidate-staging-admission.mjs";
import { createCandidateGitHubReader } from "./candidate-staging-github.mjs";

const ERROR = "Candidate preflight refused";
const REPOSITORY = "TogetherWeOwn/two-web-next";
const PATH = ".github/workflows/candidate-staging.yml";

function requireEvidence(condition) {
  if (!condition) throw new Error(ERROR);
}

export async function readCandidatePreflight({
  token,
  selection,
  context,
  fetchImpl = fetch,
} = {}) {
  try {
    // Runner context comes only from the pinned main workflow, not input fields.
    // This local shape check is not proof by itself; verifyLauncher reads GitHub.
    const fixed = structuredClone(context);
    requireEvidence(
      fixed !== null &&
        typeof fixed === "object" &&
        !Array.isArray(fixed) &&
        Object.keys(fixed).sort().join(",") ===
          "actions,checkoutSha,event,ref,repository,repositoryId,runAttempt,runId,sha,workflowRef,workflowSha" &&
        fixed.actions === "true" &&
        fixed.workflowRef === `${REPOSITORY}/${PATH}@refs/heads/main` &&
        fixed.workflowSha === fixed.sha &&
        fixed.checkoutSha === fixed.workflowSha,
    );
    const identity = candidateIdentity(structuredClone(selection), {
      repositoryId: fixed.repositoryId,
      repository: fixed.repository,
      controllerSha: fixed.workflowSha,
      launcherSha: fixed.workflowSha,
      checkoutSha: fixed.checkoutSha,
      runId: fixed.runId,
      runAttempt: fixed.runAttempt,
      event: fixed.event,
      ref: fixed.ref,
      path: PATH,
    });
    const reader = createCandidateGitHubReader({ token, fetchImpl });
    const launcher = await reader.verifyLauncher(identity);
    // Final live-head observation after launcher/attempt admission. Never follow
    // a moved head and never claim the selected CI attempt has been verified.
    await reader.verifyPullRequest(identity);
    return Object.freeze({
      schema: "two.candidate-preflight.v1",
      promotable: false,
      scope: "launcher-and-pr-only",
      qualification: false,
      q: identity.q,
      repositoryId: identity.descriptor[1],
      repository: REPOSITORY,
      prNumber: identity.descriptor[3],
      headSha: identity.descriptor[4],
      controllerSha: launcher.controllerSha,
      launcherSha: identity.descriptor[6],
      workflowId: launcher.workflowId,
      runId: launcher.runId,
      runAttempt: launcher.runAttempt,
      selectedCiRunId: identity.ciRunId,
      selectedCiRunAttempt: identity.ciRunAttempt,
    });
  } catch {
    throw new Error(ERROR);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireEvidence(process.argv.length === 2);
    const raw = process.env.CANDIDATE_SELECTION;
    requireEvidence(typeof raw === "string" && Buffer.byteLength(raw) <= 4096);
    const checkoutSha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 128,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const result = await readCandidatePreflight({
      token: process.env.GITHUB_TOKEN,
      selection: JSON.parse(raw),
      context: {
        actions: process.env.GITHUB_ACTIONS,
        checkoutSha,
        event: process.env.GITHUB_EVENT_NAME,
        ref: process.env.GITHUB_REF,
        repository: process.env.GITHUB_REPOSITORY,
        repositoryId: process.env.GITHUB_REPOSITORY_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        runId: process.env.GITHUB_RUN_ID,
        sha: process.env.GITHUB_SHA,
        workflowRef: process.env.GITHUB_WORKFLOW_REF,
        workflowSha: process.env.GITHUB_WORKFLOW_SHA,
      },
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error(ERROR);
    process.exitCode = 1;
  }
}
