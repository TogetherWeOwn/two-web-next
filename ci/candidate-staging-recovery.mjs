// Restore original B traffic before re-enabling its persistent settings. This
// partial transaction never repairs latest-upload inheritance or clears a journal.
import { candidateSha256, identitySnapshot } from "./candidate-staging-admission.mjs";
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
    // At most nine complete scans, each capped at 64 actual GitHub GETs.
    // Oversized history refuses at entry before mutation; it is never truncated.
    // This is not proof of available account quota or a history-compaction policy.
    const requireDirty = createCandidateRecoveryComponentGuard({ ...options, maxReadRequests: 64 });
    const run = identitySnapshot(options.identity);
    const profile = structuredClone(options.profile);
    const profileSha256 = options.profileSha256;
    const state = structuredClone(options.state);
    const serving = structuredClone(options.serving);
    const settings = structuredClone(options.settings);
    const ownerDeploymentId = options.deploymentId;
    const ownerStateSha256 = options.expectedPayload.baseline.stateSha256;
    const createdAt = Date.parse(options.expectedPayload.createdAt);
    const expiresAt = Date.parse(options.expectedPayload.baseline.expiresAt);
    const base = `https://api.cloudflare.com/client/v4/accounts/${profile.accountId}/workers/scripts/${profile.scriptName}`;
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
                  (url === `${base}/subdomain` && request.method === "POST")));
            requireEvidence(allowed);
            await authority(active);
            // Last awaited authorization before dispatch; no callback can turn
            // cached evidence into mutation authority or substitute an endpoint.
            await refreshOwnership(active);
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
          const finalServing = await assertRestored();
          await authority();
          await refreshOwnership(deadline);
          const observedAt = currentTime();
          deadline.throwIfAborted();
          return Object.freeze({
            schema: "two.candidate-traffic-settings-recovery.v1",
            promotable: false,
            scope: "baseline-traffic-and-settings-only",
            q: run.q,
            profileSha256,
            baselineSha256: state.baselineSha256,
            baselineServingSha256: state.servingSha256,
            settingsSha256: state.settingsSha256,
            deploymentId: traffic.deploymentId,
            versionId: serving.versionId,
            servingSha256: finalServing.snapshotSha256,
            settingsStateSha256,
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
