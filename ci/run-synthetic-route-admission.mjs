import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { admitSyntheticRouteEvidence } from "./admit-synthetic-route-evidence.mjs";
import { createRouteEvidenceDownload } from "./route-evidence-download.mjs";
import { createRouteEvidenceRequest } from "./route-evidence-github.mjs";

// The caller must be the reviewed, required workflow. These environment values
// are provider context and direct needs outputs, never fields from the report.
const env = process.env;
const positiveInteger = (value) => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value))
    throw new Error("invalid numeric context");
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("invalid numeric context");
  return result;
};

try {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const orchestrationSha = env.ROUTE_WORKFLOW_SHA;
  if (
    !/^[a-f0-9]{40}$/.test(orchestrationSha ?? "") ||
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 5000,
    }).trim() !== orchestrationSha
  )
    throw new Error("unverified workflow checkout");
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const repository = env.GITHUB_REPOSITORY;
  const result = await admitSyntheticRouteEvidence({
    root,
    context: {
      repository,
      eventName: env.GITHUB_EVENT_NAME,
      ref: env.GITHUB_REF,
      sha: env.GITHUB_SHA,
    },
    event,
    expected: {
      repository,
      runId: positiveInteger(env.GITHUB_RUN_ID),
      runAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT),
      producerJobName: "route-evidence-producer",
      producerResult: env.ROUTE_PRODUCER_RESULT,
      requiredSteps: ["Run cases", "Upload report"],
      orchestrationSha,
      artifactId: positiveInteger(env.ROUTE_ARTIFACT_ID),
      // The upload action emits bare hex; the REST API uses a prefixed digest.
      artifactDigest: `sha256:${env.ROUTE_ARTIFACT_DIGEST ?? ""}`,
    },
    request: createRouteEvidenceRequest(repository, env.GH_TOKEN),
    download: createRouteEvidenceDownload(repository, env.GH_TOKEN),
  });
  process.stdout.write(
    `synthetic route evidence admitted for ${result.sourceSha}; not route parity\n`,
  );
} catch {
  // Do not expose event payloads, API response bodies or credentials in logs.
  process.stderr.write("route evidence refused: synthetic admission failed\n");
  process.exitCode = 1;
}
