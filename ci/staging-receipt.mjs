import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readRevision } from "../bin/revision-check.mjs";
import { PROMOTION_SOAK_MS } from "./resolve-promotion-sha.mjs";
import {
  isSha,
  readStagingIdentity,
  resolveStagingCandidate,
  STAGING_ORIGIN,
} from "./staging-provenance.mjs";

const workerId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sha = (value) => (isSha(value) ? `\`${value}\`` : "unavailable");
const positiveId = (value) =>
  (typeof value === "number" || typeof value === "string") && /^[1-9][0-9]{0,15}$/.test(value);

function runLink(repository, id, attempt) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !positiveId(id) || !positiveId(attempt)) {
    return "unavailable";
  }
  return `[${id}, attempt ${attempt}](https://github.com/${repository}/actions/runs/${id}/attempts/${attempt})`;
}

export async function stagingReceipt(mode, env, event, { fetchImpl = fetch } = {}) {
  const e2e = mode === "e2e";
  const repo = env.GITHUB_REPOSITORY;
  const trigger = event?.workflow_run;
  const currentRun = runLink(repo, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
  let candidate = env.STAGING_CANDIDATE;
  if (e2e) {
    try {
      if (
        candidate !==
        resolveStagingCandidate({
          eventName: env.GITHUB_EVENT_NAME,
          event,
          sha: env.GITHUB_SHA,
          ref: env.GITHUB_REF,
          repository: repo,
        })
      ) {
        candidate = undefined;
      }
    } catch {
      candidate = undefined;
    }
  }

  let up;
  let version;
  if (env.STAGING_JOB_STATUS === "success" && isSha(candidate)) {
    [up, version] = await Promise.all([
      readRevision(STAGING_ORIGIN, {
        fetchImpl: async (url, options) => {
          const response = await fetchImpl(url, { ...options, redirect: "error" });
          if (response.status !== 200 && response.status !== 503) {
            throw new Error("Unexpected /up response status");
          }
          return response;
        },
      }).catch(() => null),
      readStagingIdentity({ fetchImpl }).catch(() => null),
    ]);
  }
  const versionId =
    typeof up?.version_id === "string" &&
    up.version_id.length === 36 &&
    workerId.test(up.version_id)
      ? up.version_id
      : null;
  const matched = versionId && version?.sha === candidate && up.commit === candidate;
  let soak;
  if (e2e && env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    soak = "This manual E2E run is ineligible for automatic promotion";
  } else if (e2e && env.GITHUB_RUN_ATTEMPT !== "1") {
    soak = "This E2E attempt is ineligible for automatic promotion";
  } else if (e2e && env.STAGING_SKIP_E2E === "true") {
    soak = "This E2E run is ineligible (journeys scope-skipped)";
  } else if (!matched) {
    soak = "Unproven (identity receipt refused)";
  } else if (e2e) {
    soak = `Pending successful qualification and ${PROMOTION_SOAK_MS / 60_000}-minute soak. Production checks run history separately.`;
  } else {
    soak = "Pending a qualifying staging E2E run";
  }

  const deployRun = runLink(repo, trigger?.id, trigger?.run_attempt);
  const ciRun = runLink(repo, env.STAGING_CI_RUN_ID, env.STAGING_CI_RUN_ATTEMPT);
  const provenance = e2e
    ? env.GITHUB_EVENT_NAME === "workflow_dispatch"
      ? "Manual dispatch has no triggering deploy or verified CI attempt in this run"
      : `Triggering deploy run ${deployRun}, workflow head ${sha(trigger?.head_sha)}. The linked deploy summary records the verified CI attempt when available.`
    : `Verified full CI run ${ciRun}, source ${sha(candidate)}`;
  return [
    "## Staging evidence",
    "",
    `- ${e2e ? "Staging E2E" : "Staging deploy"} run ${currentRun}`,
    `- Workflow trigger SHA (run head) ${sha(env.GITHUB_SHA)}`,
    `- ${provenance}`,
    `- Candidate source ${sha(candidate)}`,
    `- Live /up source ${sha(up?.commit)}, Worker version ${versionId ? `\`${versionId}\`` : "unavailable"}`,
    `- Live /version source ${sha(version?.sha)}${version ? `, deployed at \`${version.deployedAt}\`` : ""}`,
    `- Identity receipt ${matched ? "matched at observation" : "refused (disagreement or missing proof)"}`,
    `- **Soak eligibility** ${soak}`,
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2];
    if (mode !== "deploy" && mode !== "e2e") throw new Error("Invalid staging receipt mode");
    const env = process.env;
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    appendFileSync(env.GITHUB_STEP_SUMMARY, await stagingReceipt(mode, env, event));
  } catch {
    console.warn("::warning::Staging evidence summary unavailable");
  }
}
