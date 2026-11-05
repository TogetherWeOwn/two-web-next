// Installed-only adapters must enforce exclusion, dirty baseline ownership and
// independently verified B serving. This helper never clears occupancy or selects
// a version. Its narrow snapshot is not a complete provider recovery artifact.
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import { boundedResult } from "./candidate-staging-settings.mjs";
import { identitySnapshot, profileSnapshot } from "./candidate-staging-upload.mjs";

const ERROR = "Candidate settings refused: lifecycle";
const DIGEST = /^[a-f0-9]{64}$/;

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

function rate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function tailSnapshot(value) {
  // Only the installed staging tail is restorable; never admit production,
  // environment/dispatch selectors, streaming tails or arbitrary consumers.
  requireEvidence(
    empty(value) ||
      (Array.isArray(value) &&
        value.length === 1 &&
        keys(value[0], "service") &&
        value[0].service === "two-web-next-alerts"),
  );
  return value.length === 0 ? [] : [{ service: "two-web-next-alerts" }];
}

function settingsSnapshot(value) {
  requireEvidence(
    keys(value, "logpush,observability,tags,tail_consumers") &&
      typeof value.logpush === "boolean" &&
      empty(value.tags),
  );
  const tails = tailSnapshot(value.tail_consumers);
  const o = value.observability;
  requireEvidence(
    keys(o, "enabled,head_sampling_rate,logs") &&
      typeof o.enabled === "boolean" &&
      rate(o.head_sampling_rate),
  );
  const l = o.logs;
  requireEvidence(
    keys(l, "enabled,head_sampling_rate,invocation_logs,persist,destinations") &&
      typeof l.enabled === "boolean" &&
      rate(l.head_sampling_rate) &&
      typeof l.invocation_logs === "boolean" &&
      typeof l.persist === "boolean" &&
      empty(l.destinations),
  );
  // Unsupported consumers/destinations and unknown fields refuse, rather than
  // being dropped from B or replayed into a privileged PATCH.
  return {
    logpush: value.logpush,
    tags: [],
    tail_consumers: tails,
    observability: {
      enabled: o.enabled,
      head_sampling_rate: o.head_sampling_rate,
      logs: {
        enabled: l.enabled,
        head_sampling_rate: l.head_sampling_rate,
        invocation_logs: l.invocation_logs,
        persist: l.persist,
        destinations: [],
      },
    },
  };
}

function subdomainSnapshot(value) {
  requireEvidence(
    keys(value, "enabled,previews_enabled") &&
      typeof value.enabled === "boolean" &&
      typeof value.previews_enabled === "boolean",
  );
  return { enabled: value.enabled, previews_enabled: value.previews_enabled };
}

function sealedSettings() {
  return {
    logpush: false,
    tags: [],
    tail_consumers: [],
    observability: {
      enabled: false,
      head_sampling_rate: 0,
      logs: {
        enabled: false,
        head_sampling_rate: 0,
        invocation_logs: false,
        persist: false,
        destinations: [],
      },
    },
  };
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function digest(value) {
  return candidateSha256(JSON.stringify(value));
}

// Integrity admission is shared with the journal-bound component guard. The
// expected digest still comes from the independently retained recovery state.
export function admitCandidateSettingsSnapshot(raw, expected, q, profileSha256) {
  requireEvidence(typeof expected === "string" && DIGEST.test(expected));
  const s = structuredClone(raw);
  requireEvidence(
    keys(s, "schema,promotable,q,profileSha256,capturedAt,settings,subdomain") &&
      s.schema === "two.candidate-settings-snapshot.v1" &&
      s.promotable === false &&
      s.q === q &&
      s.profileSha256 === profileSha256 &&
      Number.isSafeInteger(s.capturedAt) &&
      s.capturedAt >= 0,
  );
  const canonical = {
    schema: s.schema,
    promotable: false,
    q,
    profileSha256,
    capturedAt: s.capturedAt,
    settings: settingsSnapshot(s.settings),
    subdomain: subdomainSnapshot(s.subdomain),
  };
  requireEvidence(digest(canonical) === expected);
  return freeze(canonical);
}

export function createCandidateSettingsLifecycle({
  token,
  identity,
  profile,
  profileSha256,
  assertExclusive,
  requireDirty,
  assertBaselineServing,
  signal,
  fetchImpl = fetch,
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  requireEvidence(
    typeof token === "string" &&
      token.length > 0 &&
      token.length <= 4096 &&
      !/[\s\x00-\x1f\x7f]/.test(token) &&
      [assertExclusive, requireDirty, assertBaselineServing, fetchImpl, clock].every(
        (fn) => typeof fn === "function",
      ) &&
      (signal === undefined || signal instanceof AbortSignal),
  );
  const installed = profileSnapshot(profile, profileSha256);
  const { q } = identitySnapshot(identity);
  const base = `https://api.cloudflare.com/client/v4/accounts/${installed.accountId}/workers/scripts/${installed.scriptName}`;

  async function operation(phase, snapshot, snapshotSha256, action) {
    try {
      const baseline =
        phase === "snapshot"
          ? null
          : admitCandidateSettingsSnapshot(snapshot, snapshotSha256, q, profileSha256);
      const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
      let lastNow = clock();
      function currentTime() {
        const time = clock();
        requireEvidence(
          Number.isSafeInteger(time) &&
            time >= 0 &&
            Number.isSafeInteger(lastNow) &&
            time >= lastNow &&
            (baseline === null || baseline.capturedAt <= time),
        );
        deadline.throwIfAborted();
        lastNow = time;
        return time;
      }
      const context = freeze({ phase, q, profileSha256, snapshotSha256 });
      async function guard() {
        currentTime();
        await assertExclusive(context, deadline);
        if (baseline) await requireDirty(context, deadline);
        // Never restore B's log/preview sinks while candidate code is selected.
        // This is an independent trusted provider assertion, not a caller flag.
        if (phase === "restore") await assertBaselineServing(context, deadline);
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
      async function read() {
        const settings = settingsSnapshot(await request("script-settings"));
        const subdomain = subdomainSnapshot(await request("subdomain"));
        return { settings, subdomain };
      }
      async function write(state) {
        const settings = settingsSnapshot(
          await request("script-settings", "PATCH", state.settings),
        );
        requireEvidence(digest(settings) === digest(state.settings));
        const observed = settingsSnapshot(await request("script-settings"));
        requireEvidence(digest(observed) === digest(state.settings));
        const subdomain = subdomainSnapshot(await request("subdomain", "POST", state.subdomain));
        requireEvidence(digest(subdomain) === digest(state.subdomain));
        const final = await read();
        requireEvidence(digest(final) === digest(state));
        return final;
      }
      const result = await action({ baseline, read, write, currentTime });
      await guard();
      return freeze(result);
    } catch {
      // No provider bodies, bearer values, snapshots or adapter errors escape.
      // No retry and no automatic clean status, even after a partial mutation.
      throw new Error(ERROR);
    }
  }

  function receipt(phase, snapshotSha256, state, observedAt) {
    return {
      schema: "two.candidate-settings-lifecycle.v1",
      promotable: false,
      phase,
      q,
      profileSha256,
      snapshotSha256,
      stateSha256: digest(state),
      observedAt,
    };
  }

  return Object.freeze({
    snapshot() {
      return operation("snapshot", null, null, async ({ read, currentTime }) => {
        const state = await read();
        const snapshot = {
          schema: "two.candidate-settings-snapshot.v1",
          promotable: false,
          q,
          profileSha256,
          capturedAt: currentTime(),
          ...state,
        };
        return { snapshot, snapshotSha256: digest(snapshot) };
      });
    },
    seal(snapshot, snapshotSha256) {
      return operation(
        "seal",
        snapshot,
        snapshotSha256,
        async ({ baseline, read, write, currentTime }) => {
          const before = await read();
          requireEvidence(
            digest(before) ===
              digest({ settings: baseline.settings, subdomain: baseline.subdomain }),
          );
          const sealed = await write({
            settings: sealedSettings(),
            subdomain: { enabled: false, previews_enabled: false },
          });
          return receipt("seal", snapshotSha256, sealed, currentTime());
        },
      );
    },
    restore(snapshot, snapshotSha256) {
      return operation(
        "restore",
        snapshot,
        snapshotSha256,
        async ({ baseline, write, currentTime }) => {
          const restored = await write({
            settings: baseline.settings,
            subdomain: baseline.subdomain,
          });
          return receipt("restore", snapshotSha256, restored, currentTime());
        },
      );
    },
  });
}
