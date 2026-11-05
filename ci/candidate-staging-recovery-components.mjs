// Joins web/settings/serving component pins to sole dirty-journal ownership.
// Not complete baseline admission, exclusion, B-prime serving or cleanup authority.
import { candidateSha256, identitySnapshot } from "./candidate-staging-admission.mjs";
import { createCandidateBaselineProviderReader } from "./candidate-staging-baseline-provider.mjs";
import { prepareCandidateBaselineAssetInput } from "./candidate-staging-baseline-upload.mjs";
import {
  admitCandidateServingSnapshot,
  createCandidateServingReader,
} from "./candidate-staging-serving.mjs";
import {
  admitCandidateSettingsSnapshot,
  createCandidateSettingsLifecycle,
} from "./candidate-staging-settings-lifecycle.mjs";
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

// Read-only assembly before the dirty journal is created. These component pins
// still lack stored-asset, complete resource/capability and installed exclusion
// admission; they must not authorize candidate mutation or journal cleanup.
export function createCandidateRecoveryComponentReader({
  token,
  githubToken,
  identity,
  profile,
  profileSha256,
  installedContract,
  sourceManifestBytes,
  assertExclusive,
  signal,
  fetchImpl = fetch,
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  try {
    requireEvidence(
      typeof assertExclusive === "function" &&
        typeof clock === "function" &&
        (signal === undefined || signal instanceof AbortSignal) &&
        Buffer.isBuffer(sourceManifestBytes) &&
        sourceManifestBytes.length > 0 &&
        sourceManifestBytes.length <= 64 * 1024,
    );
    const run = identitySnapshot(identity);
    profileSnapshot(profile, profileSha256);
    const fixed = {
      token,
      githubToken,
      identity: run,
      profile: structuredClone(profile),
      profileSha256,
      installedContract: structuredClone(installedContract),
      sourceManifestBytes: Buffer.from(sourceManifestBytes),
      fetchImpl,
    };
    const refuseMutation = async () => {
      throw new Error(ERROR);
    };
    return Object.freeze({
      async capture(selection, operationSignal) {
        try {
          requireEvidence(operationSignal === undefined || operationSignal instanceof AbortSignal);
          const selected = structuredClone(selection);
          const deadline = AbortSignal.any([
            ...(signal ? [signal] : []),
            ...(operationSignal ? [operationSignal] : []),
            AbortSignal.timeout(180_000),
          ]);
          let lastNow = clock();
          function currentTime() {
            deadline.throwIfAborted();
            const now = clock();
            requireEvidence(
              Number.isSafeInteger(lastNow) &&
                lastNow >= 0 &&
                lastNow <= 253402300799 &&
                Number.isSafeInteger(now) &&
                now >= lastNow &&
                now <= 253402300799,
            );
            lastNow = now;
            return now;
          }
          async function guard(context, childSignal) {
            currentTime();
            const active = AbortSignal.any([deadline, ...(childSignal ? [childSignal] : [])]);
            active.throwIfAborted();
            await assertExclusive(context, active);
            active.throwIfAborted();
            currentTime();
          }
          const options = {
            ...fixed,
            assertExclusive: guard,
            requireDirty: refuseMutation,
            assertBaselineServing: refuseMutation,
            signal: deadline,
            clock: currentTime,
          };
          currentTime();
          const settingsReader = createCandidateSettingsLifecycle(options);
          const before = await settingsReader.snapshot();
          const provider = await createCandidateBaselineProviderReader(options).observe(selected, {
            signal: deadline,
          });
          const after = await settingsReader.snapshot();
          requireEvidence(
            digest({ settings: before.snapshot.settings, subdomain: before.snapshot.subdomain }) ===
              digest({ settings: after.snapshot.settings, subdomain: after.snapshot.subdomain }),
          );
          const serving = await createCandidateServingReader(options).capture(deadline);
          requireEvidence(
            serving.snapshot.deploymentId === provider.serving.deploymentId &&
              serving.snapshot.versionId === provider.serving.versionId &&
              serving.snapshot.historySha256 === provider.serving.historySha256,
          );
          const state = Object.freeze({
            schema: "two.candidate-recovery-components.v1",
            promotable: false,
            scope: "web-settings-and-serving-pins-only",
            q: run.q,
            profileSha256,
            baselineSha256: provider.baselineSha256,
            settingsSha256: after.snapshotSha256,
            servingSha256: serving.snapshotSha256,
          });
          await guard(
            Object.freeze({ phase: "capture-recovery-components", q: run.q, profileSha256 }),
          );
          const capturedAt = currentTime();
          deadline.throwIfAborted();
          return Object.freeze({
            schema: "two.candidate-recovery-component-capture.v1",
            promotable: false,
            scope: state.scope,
            q: run.q,
            profileSha256,
            provenance: provider.provenance,
            state,
            stateSha256: digest(state),
            baseline: provider.baseline,
            files: provider.files,
            settings: after.snapshot,
            serving: serving.snapshot,
            capturedAt,
          });
        } catch {
          throw new Error(ERROR);
        }
      },
    });
  } catch {
    throw new Error(ERROR);
  }
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
