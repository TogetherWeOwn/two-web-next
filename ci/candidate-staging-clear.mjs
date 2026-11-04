// Normal staging actors check dirty occupancy while holding the shared workflow
// exclusion. This is a read-only guard, never a recovery or lock acquisition.
import { pathToFileURL } from "node:url";
import { createCandidateStagingJournal } from "./candidate-staging-occupancy.mjs";

const REPOSITORY = "TogetherWeOwn/two-web-next";
const ID = /^[1-9][0-9]{0,19}$/;
const SHA = /^[a-f0-9]{40}$/;

function requireEvidence(value) {
  if (!value) throw new Error("Staging occupancy guard refused");
}

export async function assertNormalStagingClear({ token, context, fetchImpl = fetch } = {}) {
  try {
    // The workflow must supply these from the runner, not dispatch inputs. The
    // installed workflow/source closure and global exclusion remain prerequisites.
    requireEvidence(
      context !== null &&
        typeof context === "object" &&
        !Array.isArray(context) &&
        Object.keys(context).sort().join(",") ===
          "actions,event,ref,repository,runAttempt,runId,sha,workflowRef" &&
        context.actions === "true" &&
        context.repository === REPOSITORY &&
        context.ref === "refs/heads/main" &&
        ["push", "workflow_dispatch", "workflow_run", "schedule"].includes(context.event) &&
        typeof context.runId === "string" &&
        ID.test(context.runId) &&
        typeof context.runAttempt === "string" &&
        ID.test(context.runAttempt) &&
        typeof context.sha === "string" &&
        SHA.test(context.sha) &&
        typeof context.workflowRef === "string" &&
        new RegExp(`^${REPOSITORY}/\\.github/workflows/[a-z0-9-]+\\.yml@refs/heads/main$`).test(
          context.workflowRef,
        ),
    );
    const journal = createCandidateStagingJournal({
      token,
      // Public GitHub Actions bot/App IDs, not an actor selected by an input or
      // inferred from an arbitrary journal record. Shared-principal provenance
      // still requires the installed controller's independent containment gate.
      creatorId: "41898282",
      appId: "15368",
      fetchImpl,
    });
    await journal.assertClear();
  } catch {
    // No provider body, path, token or journal payload reaches workflow output.
    throw new Error("Staging occupancy guard refused");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireEvidence(process.argv.length === 2);
    await assertNormalStagingClear({
      token: process.env.GITHUB_TOKEN,
      context: {
        actions: process.env.GITHUB_ACTIONS,
        event: process.env.GITHUB_EVENT_NAME,
        ref: process.env.GITHUB_REF,
        repository: process.env.GITHUB_REPOSITORY,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        runId: process.env.GITHUB_RUN_ID,
        sha: process.env.GITHUB_SHA,
        workflowRef: process.env.GITHUB_WORKFLOW_REF,
      },
    });
    console.log("Staging occupancy clear at observation; shared exclusion must remain held");
  } catch {
    console.error("Staging occupancy guard refused");
    process.exitCode = 1;
  }
}
