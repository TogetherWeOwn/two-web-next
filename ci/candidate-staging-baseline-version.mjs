// B-prime transport and immutable/latest-upload observation, not traffic or
// complete restoration. Installed adapters must authenticate B and dirty ownership.
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import {
  candidateAssetCapabilityExpiry,
  createCandidateBaselineAssetUploader,
} from "./candidate-staging-assets.mjs";
import {
  candidateBaselineVersionSnapshot,
  readCandidateBaselineVersionResult,
} from "./candidate-staging-baseline-provider.mjs";
import {
  prepareCandidateBaselineAssetInput,
  prepareCandidateBaselineUpload,
} from "./candidate-staging-baseline-upload.mjs";
import { identitySnapshot, profileSnapshot } from "./candidate-staging-upload.mjs";

const ERROR = "Candidate recovery refused: baseline version";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = (value) => candidateSha256(JSON.stringify(value));

function requireEvidence(condition) {
  if (!condition) throw new Error(ERROR);
}

export function createCandidateBaselineVersionUploader({
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
  const fixedIdentity = structuredClone(identity);
  const fixedProfile = structuredClone(profile);
  const run = identitySnapshot(fixedIdentity);
  const installed = profileSnapshot(fixedProfile, profileSha256);
  const base = `https://api.cloudflare.com/client/v4/accounts/${installed.accountId}/workers/workers/${installed.scriptName}/versions`;
  return Object.freeze({
    async upload(options, operationSignal) {
      try {
        requireEvidence(
          options !== null &&
            typeof options === "object" &&
            !Array.isArray(options) &&
            Object.keys(options).sort().join(",") === "baseline,baselineSha256,files" &&
            (operationSignal === undefined || operationSignal instanceof AbortSignal),
        );
        const deadline = AbortSignal.any([
          ...(signal ? [signal] : []),
          ...(operationSignal ? [operationSignal] : []),
          AbortSignal.timeout(180_000),
        ]);
        let lastNow = clock();
        function currentTime() {
          const now = clock();
          requireEvidence(
            Number.isSafeInteger(lastNow) &&
              lastNow >= 0 &&
              lastNow <= 253402300799 &&
              Number.isSafeInteger(now) &&
              now >= lastNow &&
              now <= 253402300799,
          );
          deadline.throwIfAborted();
          lastNow = now;
          return now;
        }
        const initial = {
          ...options,
          identity: fixedIdentity,
          profile: fixedProfile,
          profileSha256,
          now: currentTime(),
        };
        // Bound and validate before copying; neither assets nor module requests
        // can see a caller mutation made while an installed guard is awaiting.
        const admitted = prepareCandidateBaselineAssetInput(initial);
        const input = {
          identity: fixedIdentity,
          profile: fixedProfile,
          profileSha256,
          baseline: structuredClone(options.baseline),
          baselineSha256: options.baselineSha256,
          files: options.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
        };
        const context = Object.freeze({
          phase: "restore-baseline-version",
          q: run.q,
          profileSha256,
          baselineSha256: input.baselineSha256,
          baselineVersionId: input.baseline.versionId,
          assetRootSha256: admitted.assetRootSha256,
        });
        async function check(adapter) {
          currentTime();
          await adapter(context, deadline);
          currentTime();
        }
        async function guard() {
          for (const adapter of [assertExclusive, requireDirty, admitBaseline, assertSealed])
            await check(adapter);
        }
        await guard();
        const assetsTicket = await createCandidateBaselineAssetUploader({
          token,
          fetchImpl,
          clock: currentTime,
          signal: deadline,
          assertExclusive: () => check(assertExclusive),
          requireDirty: () => check(requireDirty),
          admitBaseline: async () => {
            await check(admitBaseline);
            await check(assertSealed);
          },
        }).upload(input);
        await guard();
        const assetsExpiresAt =
          assetsTicket === null
            ? undefined
            : candidateAssetCapabilityExpiry(assetsTicket.jwt, currentTime());
        const request = prepareCandidateBaselineUpload({
          ...input,
          assetsTicket,
          now: currentTime(),
        });
        requireEvidence(request.url === `${base}?deploy=false` && request.method === "POST");
        async function send(url, method = "GET", body, expiresAt) {
          await guard();
          // Installed checks may consume the capability's remaining lifetime.
          // Keep the same margin immediately before sending the version body.
          if (expiresAt !== undefined) requireEvidence(expiresAt > currentTime() + 30);
          const response = await fetchImpl(url, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body } : {}),
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
          });
          const value = await readCandidateBaselineVersionResult(response, url);
          await guard();
          return value;
        }
        const startedAt = currentTime();
        // A lost/uncertain POST is never retried. A later installed recovery
        // must re-admit dirty state rather than inherit from the newest upload.
        const uploaded = await send(request.url, "POST", request.body, assetsExpiresAt);
        requireEvidence(
          typeof uploaded.id === "string" &&
            UUID.test(uploaded.id) &&
            uploaded.id !== input.baseline.versionId &&
            Number.isSafeInteger(uploaded.number) &&
            uploaded.number > 0 &&
            typeof uploaded.created_on === "string" &&
            uploaded.created_on.length <= 40 &&
            Date.parse(uploaded.created_on) >= startedAt * 1000 &&
            Math.floor(Date.parse(uploaded.created_on) / 1000) <= currentTime(),
        );
        const retained = {
          manifest: {
            versionId: uploaded.id,
            mainModule: input.baseline.mainModule,
            producer: { sourceSha: input.baseline.annotations["workers/tag"] },
          },
          files: input.files.map((file) => ({
            ...file,
            contentType: input.baseline.files.find(
              (record) => record.kind === file.kind && record.path === file.path,
            ).contentType,
          })),
        };
        function admit(value) {
          requireEvidence(
            value.id === uploaded.id &&
              value.number === uploaded.number &&
              value.created_on === uploaded.created_on,
          );
          const observed = candidateBaselineVersionSnapshot(
            value,
            retained,
            run,
            installed,
            profileSha256,
            currentTime(),
          );
          // Only B-prime's UUID and observation time differ. Secret names/types
          // and every supported non-secret binding/config/module remain exact B.
          requireEvidence(
            digest({
              ...observed,
              versionId: input.baseline.versionId,
              capturedAt: input.baseline.capturedAt,
            }) === input.baselineSha256,
          );
          return digest(observed);
        }
        const immutable = await send(`${base}/${uploaded.id}?include=modules`);
        const immutableSha256 = admit(immutable);
        // `latest` is an observation ONLY, never a binding inheritance source.
        // Another upload, including identical B bytes at another UUID, refuses.
        const latest = await send(`${base}/latest?include=modules`);
        const latestSha256 = admit(latest);
        await guard();
        return Object.freeze({
          schema: "two.candidate-baseline-version.v1",
          promotable: false,
          recoveryScope: "immutable-code-config-and-latest-upload-only",
          q: run.q,
          profileSha256,
          baselineSha256: input.baselineSha256,
          baselineVersionId: input.baseline.versionId,
          versionId: uploaded.id,
          requestSha256: request.proof.requestSha256,
          immutableSha256,
          latestSha256,
          observedAt: currentTime(),
        });
      } catch {
        // No binding values, body, asset capabilities or provider errors escape.
        throw new Error(ERROR);
      }
    },
  });
}
