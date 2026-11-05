// Restore only authenticated B's traffic. This does not repair latest-upload
// inheritance, settings, assets or components, and never clears dirty occupancy.
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import {
  admitCandidateServingSnapshot,
  candidateDeploymentSnapshot,
  createCandidateServingReader,
} from "./candidate-staging-serving.mjs";
import { boundedResult } from "./candidate-staging-settings.mjs";
import { identitySnapshot, profileSnapshot } from "./candidate-staging-upload.mjs";

const ERROR = "Candidate recovery refused: baseline traffic";

function requireEvidence(condition) {
  if (!condition) throw new Error(ERROR);
}

function digest(value) {
  return candidateSha256(JSON.stringify(value));
}

export function createCandidateTrafficRestorer({
  token,
  identity,
  profile,
  profileSha256,
  assertExclusive,
  requireDirty,
  admitBaseline,
  assertSealed,
  signal,
  fetchImpl = fetch,
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  requireEvidence(
    typeof token === "string" &&
      token.length > 0 &&
      token.length <= 4096 &&
      !/[\s\x00-\x1f\x7f]/.test(token) &&
      [assertExclusive, requireDirty, admitBaseline, assertSealed, fetchImpl, clock].every(
        (fn) => typeof fn === "function",
      ) &&
      (signal === undefined || signal instanceof AbortSignal),
  );
  const installed = profileSnapshot(profile, profileSha256);
  const run = identitySnapshot(identity);
  const base = `https://api.cloudflare.com/client/v4/accounts/${installed.accountId}/workers/scripts/${installed.scriptName}`;
  return Object.freeze({
    async restore(snapshot, snapshotSha256, operationSignal) {
      try {
        const baseline = admitCandidateServingSnapshot(
          snapshot,
          snapshotSha256,
          run.q,
          profileSha256,
        );
        requireEvidence(operationSignal === undefined || operationSignal instanceof AbortSignal);
        const deadline = AbortSignal.any([
          ...(signal ? [signal] : []),
          ...(operationSignal ? [operationSignal] : []),
          AbortSignal.timeout(60_000),
        ]);
        let lastNow = clock();
        function currentTime() {
          const time = clock();
          requireEvidence(
            Number.isSafeInteger(time) &&
              Number.isSafeInteger(lastNow) &&
              time >= baseline.observedAt &&
              time >= lastNow,
          );
          deadline.throwIfAborted();
          lastNow = time;
          return time;
        }
        const context = Object.freeze({
          phase: "restore-baseline-traffic",
          q: run.q,
          profileSha256,
          snapshotSha256,
          baseline,
        });
        async function guard() {
          currentTime();
          await assertExclusive(context, deadline);
          // These installed adapters bind the pin/version to the authenticated
          // current dirty manifest and independently admit B's actual contents.
          await requireDirty(context, deadline);
          await admitBaseline(context, deadline);
          await assertSealed(context, deadline);
          currentTime();
        }
        async function request(path, method = "GET", body) {
          await guard();
          const url = `${base}/${path}`;
          const response = await fetchImpl(url, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            redirect: "error",
            signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
          });
          const value = await boundedResult(response, url);
          await guard();
          return value;
        }
        const reader = createCandidateServingReader({
          token,
          identity: run,
          profile: installed,
          profileSha256,
          // The same dirty manifest must hold even for the reader's capture
          // phase. Its own context is not a replacement recovery manifest.
          assertExclusive: guard,
          requireDirty: guard,
          signal: deadline,
          fetchImpl,
          clock: currentTime,
        });
        await guard();
        const before = await reader.capture(deadline);
        let deploymentId = before.snapshot.deploymentId;
        const changed = before.snapshot.versionId !== baseline.versionId;
        if (changed) {
          const startedAt = currentTime();
          // No caller endpoint, version, percentage, force or retry parameter.
          // A provider refusal after secret removal stays dirty, not force=true.
          const selected = candidateDeploymentSnapshot(
            await request("deployments", "POST", {
              strategy: "percentage",
              versions: [{ version_id: baseline.versionId, percentage: 100 }],
            }),
            currentTime(),
          );
          requireEvidence(
            selected.versions.length === 1 &&
              selected.versions[0].versionId === baseline.versionId &&
              selected.versions[0].percentage === 100 &&
              selected.deploymentId !== before.snapshot.deploymentId &&
              selected.deploymentId !== baseline.deploymentId &&
              Date.parse(selected.createdAt) >= startedAt * 1000,
          );
          const exact = candidateDeploymentSnapshot(
            await request(`deployments/${selected.deploymentId}`),
            currentTime(),
          );
          requireEvidence(digest(exact) === digest(selected));
          deploymentId = selected.deploymentId;
        }
        // Both a fresh mutation and an idempotent retry require independent
        // list/exact/list admission at the pinned deployment, never POST alone.
        const restored = await reader.assertRestored(
          baseline,
          snapshotSha256,
          deploymentId,
          deadline,
        );
        await guard();
        return Object.freeze({
          schema: "two.candidate-baseline-traffic.v1",
          promotable: false,
          recoveryScope: "serving-traffic-only",
          q: run.q,
          profileSha256,
          baselineServingSha256: snapshotSha256,
          deploymentId,
          versionId: baseline.versionId,
          servingSha256: restored.snapshotSha256,
          changed,
          observedAt: currentTime(),
        });
      } catch {
        // Cancellation, refusal and uncertain writes never retry or emit a
        // clean/recovery-complete claim. Provider and adapter text stays private.
        throw new Error(ERROR);
      }
    },
  });
}
