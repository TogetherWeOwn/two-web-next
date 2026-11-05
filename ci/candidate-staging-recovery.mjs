// Restore original B traffic before re-enabling its persistent settings. The
// joined variant first uploads B-prime and rechecks latest after restoration.
// Neither variant admits stored assets/resources or clears a dirty journal.
import { candidateSha256, identitySnapshot } from "./candidate-staging-admission.mjs";
import { candidateAssetCapabilityExpiry } from "./candidate-staging-assets.mjs";
import {
  candidateBaselineVersionSnapshot,
  readCandidateBaselineVersionResult,
} from "./candidate-staging-baseline-provider.mjs";
import { createCandidateBaselineVersionUploader } from "./candidate-staging-baseline-version.mjs";
import { prepareCandidateBaselineAssetInput } from "./candidate-staging-baseline-upload.mjs";
import { createCandidateRecoveryComponentGuard } from "./candidate-staging-recovery-components.mjs";
import { createCandidateTrafficRestorer } from "./candidate-staging-restore-traffic.mjs";
import { createCandidateServingReader } from "./candidate-staging-serving.mjs";
import {
  admitCandidateSealedSettingsSnapshot,
  createCandidateSettingsLifecycle,
} from "./candidate-staging-settings-lifecycle.mjs";

const ERROR = "Candidate recovery refused: traffic and settings";
const digest = (value) => candidateSha256(JSON.stringify(value));

function requireEvidence(condition) {
  if (!condition) throw new Error(ERROR);
}

// Inputs must come from independently retained controller state. Complete B and
// exclusion admission remain installed prerequisites, not authority from these pins.
export function createCandidateTrafficSettingsRecovery(options = {}) {
  return createRecovery(options, false);
}

// The installed caller must still admit complete B, stored assets, principals,
// native idle controls and exclusion. This scoped result cannot clean a journal.
export function createCandidateBaselineRecovery(options = {}) {
  return createRecovery(options, true);
}

function createRecovery(options, restoreLatestUpload) {
  try {
    const {
      token,
      assertExclusive,
      admitBaseline,
      signal,
      fetchImpl = fetch,
      clock = () => Math.floor(Date.now() / 1000),
    } = options;
    requireEvidence(
      typeof token === "string" &&
        token.length > 0 &&
        token.length <= 4096 &&
        !/[\s\x00-\x1f\x7f]/.test(token) &&
        [assertExclusive, admitBaseline, fetchImpl, clock].every(
          (fn) => typeof fn === "function",
        ) &&
        (signal === undefined || signal instanceof AbortSignal),
    );
    // Canonical admission bounds byte inputs before copying. This also binds the
    // independently retained component digests to the expected dirty payload.
    // Preserve the 576-GET maximum: traffic/settings allows nine 64-GET scans;
    // joined recovery allows 24 scans of at most 24 GETs, including asset writes.
    // Oversized history refuses at entry, never by truncation. This does not
    // prove available shared quota or admit history compaction.
    const maxScans = restoreLatestUpload ? 24 : 9;
    const requireDirty = createCandidateRecoveryComponentGuard({
      ...options,
      maxReadRequests: restoreLatestUpload ? 24 : 64,
    });
    const run = identitySnapshot(options.identity);
    const profile = structuredClone(options.profile);
    const profileSha256 = options.profileSha256;
    const state = structuredClone(options.state);
    const serving = structuredClone(options.serving);
    const settings = structuredClone(options.settings);
    // The component guard has already bounded and rehashed these inputs. Copy
    // synchronously before any installed callback can mutate the caller's data.
    const baseline = restoreLatestUpload ? structuredClone(options.baseline) : null;
    const files = restoreLatestUpload
      ? options.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }))
      : null;
    const ownerDeploymentId = options.deploymentId;
    const ownerStateSha256 = options.expectedPayload.baseline.stateSha256;
    const createdAt = Date.parse(options.expectedPayload.createdAt);
    const expiresAt = Date.parse(options.expectedPayload.baseline.expiresAt);
    const accountBase = `https://api.cloudflare.com/client/v4/accounts/${profile.accountId}`;
    const base = `${accountBase}/workers/scripts/${profile.scriptName}`;
    const versionsBase = `${accountBase}/workers/workers/${profile.scriptName}/versions`;
    const trafficContext = Object.freeze({
      phase: "restore-baseline-traffic",
      q: run.q,
      profileSha256,
      snapshotSha256: state.servingSha256,
      baseline: serving,
    });
    const settingsStateSha256 = digest({
      settings: settings.settings,
      subdomain: settings.subdomain,
    });
    let busy = false;
    return Object.freeze({
      async restore(operationSignal) {
        // Never let two calls interleave sink restoration and traffic mutation.
        requireEvidence(!busy);
        busy = true;
        try {
          requireEvidence(operationSignal === undefined || operationSignal instanceof AbortSignal);
          const deadline = AbortSignal.any([
            ...(signal ? [signal] : []),
            ...(operationSignal ? [operationSignal] : []),
            AbortSignal.timeout(180_000),
          ]);
          let lastNow = clock();
          let context = trafficContext;
          let epoch = 0;
          let scans = 0;
          let checkpoint = null;
          function currentTime() {
            deadline.throwIfAborted();
            const now = clock();
            requireEvidence(
              Number.isSafeInteger(lastNow) &&
                lastNow >= 0 &&
                Number.isSafeInteger(now) &&
                now >= lastNow &&
                now <= 253402300799 &&
                createdAt <= now * 1000 &&
                now * 1000 < expiresAt,
            );
            lastNow = now;
            deadline.throwIfAborted();
            return now;
          }
          function activeSignal(childSignal) {
            const active = AbortSignal.any([deadline, ...(childSignal ? [childSignal] : [])]);
            active.throwIfAborted();
            return active;
          }
          // A typed, private checkpoint is retained evidence, NOT a fresh journal
          // observation. Exclusion must stay held between checkpoints. Every
          // mutation invalidates it until a real post-mutation scan succeeds.
          function retainedOwnership(childSignal) {
            activeSignal(childSignal);
            currentTime();
            requireEvidence(
              checkpoint?.schema === "two.candidate-recovery-owner-checkpoint.v1" &&
                checkpoint.epoch === epoch &&
                checkpoint.owner.schema === "two.candidate-recovery-component-owner.v1" &&
                checkpoint.owner.promotable === false &&
                checkpoint.owner.scope === "web-settings-and-serving-pins-only" &&
                checkpoint.owner.q === run.q &&
                checkpoint.owner.deploymentId === ownerDeploymentId &&
                checkpoint.owner.stateSha256 === ownerStateSha256,
            );
          }
          async function refreshOwnership(childSignal) {
            const active = activeSignal(childSignal);
            checkpoint = null;
            requireEvidence(scans < maxScans);
            scans++;
            const owner = await requireDirty(context, active);
            active.throwIfAborted();
            currentTime();
            checkpoint = Object.freeze({
              schema: "two.candidate-recovery-owner-checkpoint.v1",
              epoch,
              owner,
            });
            retainedOwnership(active);
          }
          async function authority(childSignal) {
            const active = activeSignal(childSignal);
            retainedOwnership(active);
            await assertExclusive(structuredClone(context), active);
            active.throwIfAborted();
            currentTime();
            await admitBaseline(structuredClone(context), active);
            retainedOwnership(active);
          }
          async function guardedFetch(url, request) {
            const active = activeSignal(request.signal);
            retainedOwnership(active);
            if (request.method === "GET") return fetchImpl(url, request);
            const allowed =
              (context.phase === "restore-baseline-traffic" &&
                url === `${base}/deployments` &&
                request.method === "POST") ||
              (context.phase === "restore" &&
                ((url === `${base}/script-settings` && request.method === "PATCH") ||
                  (url === `${base}/subdomain` && request.method === "POST"))) ||
              (restoreLatestUpload &&
                context.phase === "restore-baseline-version" &&
                request.method === "POST" &&
                (url === `${versionsBase}?deploy=false` ||
                  url === `${base}/assets-upload-session` ||
                  url === `${accountBase}/workers/assets/upload?base64=true` ||
                  (url.startsWith(`${accountBase}/workers/assets/upload/`) &&
                    /^[a-f0-9]{32}$/.test(
                      url.slice(`${accountBase}/workers/assets/upload/`.length),
                    ))));
            requireEvidence(allowed && scans + 2 <= maxScans);
            await authority(active);
            if (context.phase === "restore-baseline-version") await assertSealed();
            // Last awaited authorization before dispatch; no callback can turn
            // cached evidence into mutation authority or substitute an endpoint.
            await refreshOwnership(active);
            // The outer journal checks can consume an asset capability's margin
            // after the uploader checked it. Revalidate after those awaits too.
            if (url === `${versionsBase}?deploy=false`) {
              const jwt = JSON.parse(request.body).assets?.jwt;
              if (jwt !== undefined) candidateAssetCapabilityExpiry(jwt, currentTime());
            } else if (url.startsWith(`${accountBase}/workers/assets/upload`)) {
              const bearer = request.headers.Authorization;
              requireEvidence(typeof bearer === "string" && bearer.startsWith("Bearer "));
              candidateAssetCapabilityExpiry(bearer.slice(7), currentTime());
            }
            epoch++;
            checkpoint = null;
            let response;
            try {
              response = await fetchImpl(url, request);
              requireEvidence(response.ok);
              await refreshOwnership(active);
              return response;
            } catch {
              checkpoint = null;
              // Close an unconsumed response if the post-write check refuses.
              try {
                await response?.body?.cancel();
              } catch {
                throw new Error(ERROR);
              }
              throw new Error(ERROR);
            }
          }
          await refreshOwnership(deadline);
          const common = {
            token,
            identity: run,
            profile,
            profileSha256,
            assertExclusive: (_context, childSignal) => authority(childSignal),
            requireDirty: (_context, childSignal) => retainedOwnership(childSignal),
            signal: deadline,
            fetchImpl: guardedFetch,
            clock: currentTime,
          };
          // Readbacks validate retained ownership and fresh exclusion/B admission.
          // Neither candidate flags nor nested reads trigger a full journal scan.
          const readSettings = createCandidateSettingsLifecycle({
            ...common,
            assertBaselineServing: async () => {
              throw new Error(ERROR);
            },
          });
          async function assertSealed() {
            const observed = await readSettings.snapshot();
            admitCandidateSealedSettingsSnapshot(
              observed.snapshot,
              observed.snapshotSha256,
              run.q,
              profileSha256,
            );
            await authority();
          }
          let uploaded = null;
          if (restoreLatestUpload) {
            const input = { baseline, baselineSha256: state.baselineSha256, files };
            const admitted = prepareCandidateBaselineAssetInput({
              ...input,
              identity: run,
              profile,
              profileSha256,
              now: currentTime(),
            });
            context = Object.freeze({
              phase: "restore-baseline-version",
              q: run.q,
              profileSha256,
              baselineSha256: state.baselineSha256,
              baselineVersionId: baseline.versionId,
              assetRootSha256: admitted.assetRootSha256,
            });
            await refreshOwnership(deadline);
            uploaded = await createCandidateBaselineVersionUploader({
              ...common,
              admitBaseline: () => authority(),
              assertSealed,
            }).upload(input, deadline);
            context = trafficContext;
            await refreshOwnership(deadline);
          }
          await authority();
          const traffic = await createCandidateTrafficRestorer({
            ...common,
            admitBaseline: () => authority(),
            assertSealed,
          }).restore(serving, state.servingSha256, deadline);
          await refreshOwnership(deadline);
          context = Object.freeze({
            phase: "restore",
            q: run.q,
            profileSha256,
            snapshotSha256: state.settingsSha256,
          });
          const reader = createCandidateServingReader(common);
          // The new deployment pin is held only in this closure, obtained from
          // the actual restorer's POST/exact/list readback, never an input flag.
          async function assertRestored() {
            return reader.assertRestored(
              serving,
              state.servingSha256,
              traffic.deploymentId,
              deadline,
            );
          }
          await assertRestored();
          const lifecycle = createCandidateSettingsLifecycle({
            ...common,
            assertBaselineServing: assertRestored,
          });
          await lifecycle.restore(settings, state.settingsSha256);
          await assertRestored();
          const observedSettings = await readSettings.snapshot();
          requireEvidence(
            digest({
              settings: observedSettings.snapshot.settings,
              subdomain: observedSettings.snapshot.subdomain,
            }) === settingsStateSha256,
          );
          let latestEvidence = null;
          if (restoreLatestUpload) {
            const retained = {
              manifest: {
                versionId: uploaded.versionId,
                mainModule: baseline.mainModule,
                producer: { sourceSha: baseline.annotations["workers/tag"] },
              },
              files: files.map((file) => ({
                ...file,
                contentType: baseline.files.find(
                  (record) => record.kind === file.kind && record.path === file.path,
                ).contentType,
              })),
            };
            async function readVersion(path) {
              await authority();
              const url = `${versionsBase}/${path}?include=modules`;
              const response = await guardedFetch(url, {
                method: "GET",
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
                redirect: "error",
                credentials: "omit",
                cache: "no-store",
                signal: activeSignal(AbortSignal.timeout(10_000)),
              });
              const value = await readCandidateBaselineVersionResult(response, url);
              await authority();
              requireEvidence(
                value.id === uploaded.versionId &&
                  value.number === uploaded.versionNumber &&
                  value.created_on === uploaded.versionCreatedAt,
              );
              const observed = candidateBaselineVersionSnapshot(
                value,
                retained,
                run,
                profile,
                profileSha256,
                currentTime(),
              );
              requireEvidence(
                digest({
                  ...observed,
                  versionId: baseline.versionId,
                  capturedAt: baseline.capturedAt,
                }) === state.baselineSha256,
              );
              return digest(observed);
            }
            const immutableSha256 = await readVersion(uploaded.versionId);
            const latestSha256 = await readVersion("latest");
            latestEvidence = {
              latestVersionId: uploaded.versionId,
              immutableSha256,
              latestSha256,
            };
          }
          const finalServing = await assertRestored();
          await authority();
          await refreshOwnership(deadline);
          const observedAt = currentTime();
          deadline.throwIfAborted();
          return Object.freeze({
            schema: restoreLatestUpload
              ? "two.candidate-baseline-recovery.v1"
              : "two.candidate-traffic-settings-recovery.v1",
            promotable: false,
            scope: restoreLatestUpload
              ? "baseline-traffic-settings-and-latest-upload-only"
              : "baseline-traffic-and-settings-only",
            q: run.q,
            profileSha256,
            baselineSha256: state.baselineSha256,
            baselineServingSha256: state.servingSha256,
            settingsSha256: state.settingsSha256,
            deploymentId: traffic.deploymentId,
            versionId: serving.versionId,
            servingSha256: finalServing.snapshotSha256,
            settingsStateSha256,
            ...(latestEvidence ?? {}),
            observedAt,
          });
        } catch {
          // Uncertain mutations stay dirty. No force, retry, provider error body,
          // bearer, automatic reseal or complete-recovery claim escapes.
          throw new Error(ERROR);
        } finally {
          busy = false;
        }
      },
    });
  } catch {
    throw new Error(ERROR);
  }
}
