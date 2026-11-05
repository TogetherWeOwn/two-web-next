// Joins web/settings/serving component pins to sole dirty-journal ownership.
// Not complete baseline admission, exclusion, B-prime serving or cleanup authority.
import { candidateSha256, identitySnapshot } from "./candidate-staging-admission.mjs";
import { prepareCandidateBaselineAssetInput } from "./candidate-staging-baseline-upload.mjs";
import { admitCandidateServingSnapshot } from "./candidate-staging-serving.mjs";
import { admitCandidateSettingsSnapshot } from "./candidate-staging-settings-lifecycle.mjs";
import { profileSnapshot } from "./candidate-staging-upload.mjs";

const ERROR = "Candidate recovery refused: component ownership";
const digest = (value) => candidateSha256(JSON.stringify(value));

function requireEvidence(condition) {
  if (!condition) throw new Error(ERROR);
}

function keys(value, names) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === names.split(",").sort().join(",")
  );
}

// All inputs are installed controller state, not candidate-supplied callbacks or
// pins learned from the journal row being checked. The outer state still needs
// independent artifact provenance, complete provider admission and retention.
export function createCandidateRecoveryComponentGuard({
  journal,
  deploymentId,
  identity,
  profile,
  profileSha256,
  expectedPayload,
  state,
  baseline,
  files,
  settings,
  serving,
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  try {
    requireEvidence(typeof journal?.bindRecovery === "function" && typeof clock === "function");
    const run = identitySnapshot(identity);
    profileSnapshot(profile, profileSha256);
    const expected = structuredClone(expectedPayload);
    const s = structuredClone(state);
    requireEvidence(
      keys(
        s,
        "schema,promotable,scope,q,profileSha256,baselineSha256,settingsSha256,servingSha256",
      ) &&
        s.schema === "two.candidate-recovery-components.v1" &&
        s.promotable === false &&
        s.scope === "web-settings-and-serving-pins-only" &&
        s.q === run.q &&
        s.profileSha256 === profileSha256,
    );
    const canonical = {
      schema: s.schema,
      promotable: false,
      scope: s.scope,
      q: run.q,
      profileSha256,
      baselineSha256: s.baselineSha256,
      settingsSha256: s.settingsSha256,
      servingSha256: s.servingSha256,
    };
    const stateSha256 = digest(canonical);
    requireEvidence(expected?.baseline?.stateSha256 === stateSha256);
    const owner = journal.bindRecovery({ deploymentId, identity: run, expectedPayload: expected });
    const b = structuredClone(baseline);
    let lastNow = clock();
    const createdAt = Date.parse(expected.createdAt);
    const expiresAt = Date.parse(expected.baseline.expiresAt);
    function currentTime() {
      const now = clock();
      requireEvidence(
        Number.isSafeInteger(lastNow) &&
          lastNow >= 0 &&
          lastNow <= 253402300799 &&
          Number.isSafeInteger(now) &&
          now >= lastNow &&
          now <= 253402300799 &&
          Number.isFinite(createdAt) &&
          Number.isFinite(expiresAt) &&
          createdAt <= now * 1000 &&
          now * 1000 < expiresAt,
      );
      lastNow = now;
      return now;
    }
    const admitted = prepareCandidateBaselineAssetInput({
      identity: run,
      profile,
      profileSha256,
      baseline: b,
      baselineSha256: s.baselineSha256,
      files,
      now: currentTime(),
    });
    const fixedSettings = admitCandidateSettingsSnapshot(
      settings,
      s.settingsSha256,
      run.q,
      profileSha256,
    );
    const fixedServing = admitCandidateServingSnapshot(
      serving,
      s.servingSha256,
      run.q,
      profileSha256,
    );
    requireEvidence(
      fixedServing.versionId === b.versionId &&
        [b.capturedAt, fixedSettings.capturedAt, fixedServing.observedAt].every(
          (time) => time * 1000 <= createdAt,
        ),
    );

    function admitContext(raw) {
      const context = structuredClone(raw);
      requireEvidence(context?.q === run.q && context.profileSha256 === profileSha256);
      switch (context.phase) {
        case "restore-baseline-assets":
        case "restore-baseline-version": {
          const version = context.phase === "restore-baseline-version";
          requireEvidence(
            keys(
              context,
              `phase,q,profileSha256,baselineSha256,assetRootSha256${version ? ",baselineVersionId" : ""}`,
            ) &&
              context.baselineSha256 === s.baselineSha256 &&
              context.assetRootSha256 === admitted.assetRootSha256 &&
              (!version || context.baselineVersionId === b.versionId),
          );
          break;
        }
        case "seal":
        case "restore":
          requireEvidence(
            keys(context, "phase,q,profileSha256,snapshotSha256") &&
              context.snapshotSha256 === s.settingsSha256,
          );
          break;
        case "unchanged":
          requireEvidence(
            keys(context, "phase,q,profileSha256,snapshotSha256,restoreDeploymentId") &&
              context.snapshotSha256 === s.servingSha256 &&
              context.restoreDeploymentId === null,
          );
          break;
        case "restore-baseline-traffic":
          requireEvidence(
            keys(context, "phase,q,profileSha256,snapshotSha256,baseline") &&
              context.snapshotSha256 === s.servingSha256,
          );
          admitCandidateServingSnapshot(context.baseline, s.servingSha256, run.q, profileSha256);
          break;
        default:
          // In particular, a new B-prime serving pin or a restore deployment ID
          // needs its own independently verified mutation join, not this adapter.
          throw new Error(ERROR);
      }
      return context;
    }

    return async (context, signal) => {
      try {
        requireEvidence(signal === undefined || signal instanceof AbortSignal);
        const fixedContext = admitContext(context);
        const deadline = AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(60_000),
        ]);
        deadline.throwIfAborted();
        currentTime();
        const ownership = await owner(fixedContext, deadline);
        deadline.throwIfAborted();
        currentTime();
        deadline.throwIfAborted();
        return Object.freeze({
          schema: "two.candidate-recovery-component-owner.v1",
          promotable: false,
          scope: "web-settings-and-serving-pins-only",
          q: run.q,
          deploymentId: ownership.deploymentId,
          stateSha256,
        });
      } catch {
        throw new Error(ERROR);
      }
    };
  } catch {
    throw new Error(ERROR);
  }
}
