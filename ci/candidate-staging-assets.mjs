// Trusted fixed-endpoint asset transport. Nothing imports candidate code or
// discovers config, executes Wrangler, selects a version or restores staging.
import { createRequire } from "node:module";
import { extname } from "node:path";
import { prepareCandidateAssetInput } from "./candidate-staging-upload.mjs";

// Use already locked dependencies, never packages inside candidate output.
// This file and its dependency tree must run from the installed trusted closure.
const require = createRequire(import.meta.url);
const { hash } = require("blake3-wasm");
const mime = require("mime");
const BASE = "https://api.cloudflare.com/client/v4/accounts";
// At most 4096 hashes including quotes, commas and singleton bucket brackets,
// one 8192-byte capability, plus a bounded success-envelope allowance.
const MAX_RESPONSE = 4096 * 40 + 8192 + 4096;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HEX = /^[a-f0-9]{32}$/;

function requireEvidence(condition) {
  if (!condition) throw new Error("Candidate assets refused: transport");
}

function jwtClaims(jwt, now) {
  requireEvidence(typeof jwt === "string" && jwt.length <= 8192 && JWT.test(jwt));
  const claims = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(jwt.split(".")[1], "base64url")),
  );
  requireEvidence(
    claims !== null &&
      typeof claims === "object" &&
      !Array.isArray(claims) &&
      Number.isSafeInteger(claims.exp) &&
      claims.exp <= 253402300799 &&
      claims.exp > now + 30 &&
      (claims.wrangler_single_asset_uploads === undefined ||
        typeof claims.wrangler_single_asset_uploads === "boolean"),
  );
  // Claims are safety hints, not signature verification. Capability authority
  // comes exclusively from this transport's authenticated fixed-origin response.
  return claims;
}

async function boundedResult(response) {
  requireEvidence(response.body);
  const reader = response.body.getReader();
  try {
    requireEvidence(
      response.status === 200 &&
        !response.redirected &&
        response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ===
          "application/json",
    );
    const length = response.headers.get("content-length");
    requireEvidence(
      length === null || (/^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= MAX_RESPONSE),
    );
    const chunks = [];
    let size = 0;
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
        Array.isArray(value.errors) &&
        value.errors.length === 0 &&
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

export function createCandidateAssetUploader({
  token,
  fetchImpl = fetch,
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  requireEvidence(
    typeof token === "string" &&
      token.length > 0 &&
      token.length <= 4096 &&
      !/[\s\x00-\x1f\x7f]/.test(token) &&
      typeof fetchImpl === "function" &&
      typeof clock === "function",
  );
  return Object.freeze({
    async upload(options) {
      try {
        // No caller clock, ticket, URL or arbitrary request options are accepted.
        requireEvidence(
          options !== null &&
            typeof options === "object" &&
            Object.keys(options).sort().join(",") ===
              "bundle,identity,profile,profileSha256,verifier",
        );
        const now = clock();
        const input = prepareCandidateAssetInput({ ...options, now });
        const manifest = Object.create(null);
        const lookup = new Map();
        for (const entry of input.entries) {
          const path = entry.path.slice("assets/".length);
          // Control files are not interpreted. Refuse them rather than publish
          // source or accidentally introduce provider-side routing semantics.
          requireEvidence(
            !path
              .split("/")
              .some((part) => ["_worker.js", "_headers", "_redirects"].includes(part)),
          );
          const digest = hash(entry.bytes.toString("base64") + extname(path).substring(1))
            .toString("hex")
            .slice(0, 32);
          const mediaType = mime.lookup(path, "application/null");
          const type = mediaType.startsWith("text/") ? `${mediaType}; charset=utf-8` : mediaType;
          const previous = lookup.get(digest);
          requireEvidence(
            !previous || (previous.type === type && previous.bytes.equals(entry.bytes)),
          );
          manifest[`/${path}`] = { hash: digest, size: entry.bytes.length };
          lookup.set(digest, { bytes: entry.bytes, type });
        }
        // No assets means no provider session and no implicit asset retention.
        if (input.entries.length === 0) return null;
        const deadline = AbortSignal.timeout(120_000);
        let lastNow = now;
        function currentTime() {
          const time = clock();
          requireEvidence(
            Number.isSafeInteger(time) && time >= lastNow && time < input.expiresAt - 30,
          );
          deadline.throwIfAborted();
          lastNow = time;
          return time;
        }
        async function post(path, bearer, body, contentType) {
          currentTime();
          const response = await fetchImpl(`${BASE}/${input.accountId}/${path}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${bearer}`,
              ...(contentType ? { "Content-Type": contentType } : {}),
            },
            body,
            redirect: "error",
            signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
          });
          const result = await boundedResult(response);
          currentTime();
          return result;
        }
        const session = await post(
          `workers/scripts/${input.scriptName}/assets-upload-session`,
          token,
          JSON.stringify({ manifest }),
          "application/json",
        );
        const claims = jwtClaims(session.jwt, currentTime());
        requireEvidence(Array.isArray(session.buckets) && session.buckets.length <= lookup.size);
        const requested = new Set();
        for (const bucket of session.buckets) {
          requireEvidence(
            Array.isArray(bucket) && bucket.length > 0 && bucket.length <= lookup.size,
          );
          for (const digest of bucket) {
            requireEvidence(
              typeof digest === "string" &&
                HEX.test(digest) &&
                lookup.has(digest) &&
                !requested.has(digest),
            );
            requested.add(digest);
          }
        }
        const buckets =
          claims.wrangler_single_asset_uploads === true
            ? [...requested].map((digest) => [digest])
            : session.buckets;
        let completion = requested.size === 0 ? session.jwt : null;
        for (const bucket of buckets) {
          requireEvidence(claims.exp > currentTime() + 30);
          let result;
          if (claims.wrangler_single_asset_uploads === true) {
            const digest = bucket[0];
            const entry = lookup.get(digest);
            result = await post(
              `workers/assets/upload/${digest}`,
              session.jwt,
              new Blob([entry.bytes]),
              entry.type,
            );
          } else {
            const form = new FormData();
            for (const digest of bucket) {
              const entry = lookup.get(digest);
              form.set(
                digest,
                new Blob([entry.bytes.toString("base64")], { type: entry.type }),
                digest,
              );
            }
            result = await post("workers/assets/upload?base64=true", session.jwt, form);
          }
          if (result.jwt !== undefined) {
            jwtClaims(result.jwt, currentTime());
            requireEvidence(completion === null || completion === result.jwt);
            completion = result.jwt;
          }
        }
        jwtClaims(completion, currentTime());
        // This capability is deliberately not a public/durable receipt. Return
        // directly to the exact version constructor; never log or serialize it.
        return Object.freeze({
          q: input.q,
          bundleRootSha256: input.bundleRootSha256,
          assetRootSha256: input.assetRootSha256,
          jwt: completion,
        });
      } catch {
        // Never forward provider errors, URL, bearer, response text or file data.
        throw new Error("Candidate assets refused: transport");
      }
    },
  });
}
