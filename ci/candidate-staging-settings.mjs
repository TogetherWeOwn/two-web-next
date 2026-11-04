// Read-only persistent settings observation, not upload or activation authority.
// The installed controller must hold exclusion and compare observations across
// every mutation/suite/recovery phase; two GETs cannot prove continuous state.
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import { prepareCandidateAssetInput } from "./candidate-staging-upload.mjs";

const MAX_RESPONSE = 64 * 1024;
const ERROR = "Candidate settings refused: observation";

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

function empty(value) {
  return Array.isArray(value) && value.length === 0;
}

function admitSettings(value) {
  // No provider default is inferred from an omitted field. The pinned client
  // calls these fields optional; this deliberately stricter envelope refuses
  // until the provider explicitly reports every disabled sink we rely on.
  requireEvidence(
    keys(value, "logpush,observability,tags,tail_consumers") &&
      value.logpush === false &&
      empty(value.tags) &&
      empty(value.tail_consumers),
  );
  const observability = value.observability;
  requireEvidence(
    keys(observability, "enabled,head_sampling_rate,logs") &&
      observability.enabled === false &&
      observability.head_sampling_rate === 0,
  );
  const logs = observability.logs;
  requireEvidence(
    keys(logs, "enabled,head_sampling_rate,invocation_logs,persist,destinations") &&
      logs.enabled === false &&
      logs.head_sampling_rate === 0 &&
      logs.invocation_logs === false &&
      logs.persist === false &&
      empty(logs.destinations),
  );
  // Canonical serialization never uses the provider's key order or raw text.
  return [false, [], [], [false, 0, [false, 0, false, false, []]]];
}

function admitSubdomain(value) {
  requireEvidence(
    keys(value, "enabled,previews_enabled") &&
      value.enabled === false &&
      value.previews_enabled === false,
  );
  return [false, false];
}

export async function boundedResult(response, url) {
  requireEvidence(response.body);
  const reader = response.body.getReader();
  try {
    requireEvidence(
      response.status === 200 &&
        !response.redirected &&
        (response.url === "" || response.url === url) &&
        response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ===
          "application/json",
    );
    const length = response.headers.get("content-length");
    requireEvidence(
      length === null || (/^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= MAX_RESPONSE),
    );
    let size = 0;
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireEvidence(size <= MAX_RESPONSE);
      chunks.push(Buffer.from(value));
    }
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    requireEvidence(
      value?.success === true &&
        empty(value.errors) &&
        value.result !== null &&
        typeof value.result === "object" &&
        !Array.isArray(value.result),
    );
    return value.result;
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export function createCandidateSettingsReader({
  token,
  profile,
  profileSha256,
  signal,
  fetchImpl = fetch,
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  requireEvidence(
    typeof token === "string" &&
      token.length > 0 &&
      token.length <= 4096 &&
      !/[\s\x00-\x1f\x7f]/.test(token) &&
      (signal === undefined || signal instanceof AbortSignal) &&
      typeof fetchImpl === "function" &&
      typeof clock === "function",
  );
  const installedProfile = structuredClone(profile);
  return Object.freeze({
    async observe(options) {
      try {
        requireEvidence(keys(options, "identity,bundle,verifier"));
        let lastNow = clock();
        // Reuse the exact installed profile pin, run/verifier and inert-byte
        // admission. No endpoint/account/clock can come from candidate output.
        const input = prepareCandidateAssetInput({
          ...options,
          profile: installedProfile,
          profileSha256,
          now: lastNow,
        });
        // The installed parent's signal must reach fetch/body consumption, not
        // just the clock check after a request has already completed.
        const deadline = AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(30_000),
        ]);
        function currentTime() {
          const time = clock();
          requireEvidence(
            Number.isSafeInteger(time) && time >= lastNow && time < input.expiresAt - 30,
          );
          deadline.throwIfAborted();
          lastNow = time;
          return time;
        }
        const base = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/${input.scriptName}`;
        async function get(path) {
          currentTime();
          const url = `${base}/${path}`;
          const response = await fetchImpl(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
          });
          const value = await boundedResult(response, url);
          currentTime();
          return value;
        }
        const settings = admitSettings(await get("script-settings"));
        const subdomain = admitSubdomain(await get("subdomain"));
        const observedAt = currentTime();
        return Object.freeze({
          schema: "two.candidate-settings-observation.v1",
          promotable: false,
          q: input.q,
          bundleRootSha256: input.bundleRootSha256,
          profileSha256,
          readbackScope: "script-settings-and-disabled-subdomain",
          settingsSha256: candidateSha256(
            JSON.stringify([input.accountId, input.scriptName, settings, subdomain]),
          ),
          observedAt,
        });
      } catch {
        // Neither provider bodies/exceptions nor verifier material escape.
        throw new Error(ERROR);
      }
    },
  });
}
