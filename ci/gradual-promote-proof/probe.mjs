// Version-attribution probe for the gradual-promotion proof harness.
//
// A green HTTP response does not prove which Worker version served it:
// Cloudflare falls back to normal routing when a version override is not
// applied. This probe reads the fixture's x-proof-version-id header
// (sourced from the version-metadata binding) and fails unless it equals
// the expected version, so override and live-traffic attribution are
// evidence rather than assumption.
//
// Usage: node ci/gradual-promote-proof/probe.mjs <base-url> <expected-version-id>
//          [--version-override worker-name="<version-uuid>"]
//          [--attempts <1-10>] [--delay-ms <0-30000>]
//
// The CLI retries a bounded number of times (default 6 attempts, 5s apart)
// and prints one JSON line per attempt, so a deployment change still
// propagating to an edge does not fail the run on a single stale response,
// and every attempt is preserved in the evidence file. Cloudflare applies
// a version override only when the named version is in the current
// deployment; the workflow deploys the candidate at 0% before probing it.
import { pathToFileURL } from "node:url";
import { assertVersionOverride } from "../../bin/smoke.mjs";

export async function probeVersion(
  baseUrl,
  expectedVersionId,
  { versionOverride, fetchImpl = fetch, timeoutMs = 10_000 } = {},
) {
  const base = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      "base-url must be an HTTP(S) origin without credentials, path, query or fragment",
    );
  }
  if (typeof expectedVersionId !== "string" || expectedVersionId.length === 0) {
    throw new Error("expected version id is required");
  }
  if (versionOverride !== undefined) assertVersionOverride(versionOverride);
  const response = await fetchImpl(new URL("/up", base), {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers:
      versionOverride === undefined
        ? {}
        : { "Cloudflare-Workers-Version-Overrides": versionOverride },
  });
  const servedVersionId = response.headers.get("x-proof-version-id");
  const record = {
    url: `${base.origin}/up`,
    status: response.status,
    expectedVersionId,
    servedVersionId,
    servedVersionTag: response.headers.get("x-proof-version-tag"),
    servedLabel: response.headers.get("x-proof-label"),
    servedMode: response.headers.get("x-proof-mode"),
    overrideRequested: versionOverride !== undefined,
    attributionOk: servedVersionId === expectedVersionId,
  };
  // Drain the body so the connection can close; the headers carry the proof.
  await response.text().catch(() => "");
  return record;
}

// A deployment change can take a couple of seconds to be available
// globally, so a probe made right after a deploy or rollback can see a
// stale version from one edge. Retry for a bounded number of attempts,
// report every attempt to `onAttempt`, and return the last record (the
// first attributed one, or the final failure).
export async function probeVersionWithRetry(
  baseUrl,
  expectedVersionId,
  {
    versionOverride,
    fetchImpl = fetch,
    timeoutMs = 10_000,
    attempts = 6,
    delayMs = 5_000,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onAttempt,
  } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("attempts must be an integer between 1 and 10");
  }
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
    throw new Error("delay-ms must be an integer between 0 and 30000");
  }
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const record = await probeVersion(baseUrl, expectedVersionId, {
        versionOverride,
        fetchImpl,
        timeoutMs,
      });
      last = { attempt, ...record };
    } catch (error) {
      last = {
        attempt,
        expectedVersionId,
        servedVersionId: null,
        overrideRequested: versionOverride !== undefined,
        attributionOk: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    onAttempt?.(last);
    if (last.attributionOk || attempt === attempts) return last;
    if (delayMs > 0) await sleepImpl(delayMs);
  }
  return last;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [baseUrl, expectedVersionId, ...flags] = process.argv.slice(2);
  let versionOverride;
  let attempts = 6;
  let delayMs = 5_000;
  let usage = typeof baseUrl !== "string" || typeof expectedVersionId !== "string";
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === "--version-override" && typeof flags[i + 1] === "string") {
      versionOverride = flags[i + 1];
      i += 1;
    } else if (flags[i] === "--attempts" && typeof flags[i + 1] === "string") {
      attempts = Number(flags[i + 1]);
      i += 1;
    } else if (flags[i] === "--delay-ms" && typeof flags[i + 1] === "string") {
      delayMs = Number(flags[i + 1]);
      i += 1;
    } else {
      usage = true;
    }
  }
  if (usage) {
    console.error(
      'Usage: node ci/gradual-promote-proof/probe.mjs <base-url> <expected-version-id> [--version-override worker-name="<version-uuid>"] [--attempts <1-10>] [--delay-ms <0-30000>]',
    );
    process.exitCode = 2;
  } else {
    try {
      const record = await probeVersionWithRetry(baseUrl, expectedVersionId, {
        versionOverride,
        attempts,
        delayMs,
        onAttempt: (attemptRecord) => process.stdout.write(`${JSON.stringify(attemptRecord)}\n`),
      });
      process.exitCode = record.attributionOk ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
