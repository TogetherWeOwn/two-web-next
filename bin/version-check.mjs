#!/usr/bin/env node
// Prove `GET /version` (src/version.ts) reports a given commit:
//
//   node bin/version-check.mjs <origin> <40-hex-commit>
//
// Passes when `sha` equals the commit and `deployedAt` is a canonical ISO 8601 UTC time no
// later than now (plus clock skew). Retries briefly, then fails closed. The
// staging deploy runs it after bin/revision-check.mjs proved the new Version
// serves; an operator can run it against the apex after a promotion.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMMIT = /^[0-9a-f]{40}$/;
const SKEW_MS = 5 * 60_000;

/** Why a `/version` body does not prove `expected`, or null when it does. */
export function versionMismatch(data, expected, now = Date.now()) {
  if (data === null || typeof data !== "object" || Array.isArray(data))
    return "/version is not a JSON object";
  if (data.sha !== expected) return `/version sha is ${data.sha ?? "null"}, expected ${expected}`;
  // The route emits Date#toISOString(); anything else Date.parse happens to
  // accept (a bare "2026", a locale string) is not an upload instant.
  const at = typeof data.deployedAt === "string" ? Date.parse(data.deployedAt) : Number.NaN;
  if (Number.isNaN(at) || new Date(at).toISOString() !== data.deployedAt)
    return "/version deployedAt is not an ISO 8601 UTC timestamp";
  if (at > now + SKEW_MS) return `/version deployedAt ${data.deployedAt} is in the future`;
  return null;
}

export async function verifyVersion(
  origin,
  expected,
  {
    attempts = 3,
    delayMs = 5_000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.log,
  } = {},
) {
  let last = "no attempt";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(new URL("/version", origin), {
        redirect: "manual",
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) last = `/version answered HTTP ${response.status}`;
      else {
        const data = await response.json();
        last = versionMismatch(data, expected) ?? "";
        if (!last) return data;
      }
    } catch (error) {
      last = `request failed (${error instanceof Error ? error.name : "error"})`;
    }
    log(`version attempt ${attempt}/${attempts}: ${last}`);
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(last);
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  const [origin, expected, ...extra] = process.argv.slice(2);
  if (!origin || !COMMIT.test(expected ?? "") || extra.length) {
    console.error("Usage: node bin/version-check.mjs <origin> <40-hex-commit>");
    process.exitCode = 2;
  } else {
    try {
      const data = await verifyVersion(origin, expected);
      console.log(`/version live: sha ${data.sha}, deployedAt ${data.deployedAt}`);
    } catch (error) {
      console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
