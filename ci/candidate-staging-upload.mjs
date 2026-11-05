// Construct an inert web-version request, never invoke Wrangler or activate it.
// The installed controller must independently admit the profile's capabilities,
// asset-ticket provenance, dirty occupancy, exact head and restorable baseline.
import {
  candidateSha256,
  identitySnapshot,
  safeBundlePath,
} from "./candidate-staging-admission.mjs";
export { identitySnapshot } from "./candidate-staging-admission.mjs";

const HEX = /^[a-f0-9]{64}$/;
const RESOURCE = /^[a-f0-9]{32}$/;
const ID = /^[1-9][0-9]{0,19}$/;
const ORIGIN = "https://next.togetherweown.com";
const MAX_BYTES = 16 * 1024 * 1024;

function requireEvidence(condition) {
  if (!condition) throw new Error("Candidate upload refused: request");
}

function keys(value, names) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === names.split(",").sort().join(",")
  );
}

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

export function profileSnapshot(input, expectedDigest) {
  const profile = structuredClone(input);
  requireEvidence(
    keys(profile, "schema,accountId,scriptName,bindings") &&
      profile.schema === "two.candidate-upload-profile.v1" &&
      matches(RESOURCE, profile.accountId) &&
      profile.scriptName === "two-web-next" &&
      Array.isArray(profile.bindings) &&
      profile.bindings.length <= 4 &&
      matches(HEX, expectedDigest),
  );
  const names = new Set();
  for (const binding of profile.bindings) {
    requireEvidence(!names.has(binding?.name));
    names.add(binding?.name);
    if (["DB", "BOT_DB"].includes(binding?.name)) {
      requireEvidence(
        keys(binding, "name,type,id") &&
          binding.type === "hyperdrive" &&
          matches(RESOURCE, binding.id),
      );
    } else {
      requireEvidence(
        keys(binding, "name,type,text") &&
          ["DISCORD_CLIENT_ID", "DISCORD_GUILD_ID"].includes(binding.name) &&
          binding.type === "plain_text" &&
          matches(ID, binding.text),
      );
    }
  }
  // Only the exact independently pinned serialization is accepted. Do not
  // derive expectedDigest from candidate inputs or from this same request.
  requireEvidence(candidateSha256(JSON.stringify(profile)) === expectedDigest);
  return profile;
}

function verifierSnapshot(raw, identity, now) {
  requireEvidence(typeof raw === "string" && Buffer.byteLength(raw) <= 4096);
  const value = JSON.parse(raw);
  requireEvidence(
    JSON.stringify(value) === raw &&
      keys(value, "schema,descriptor,q,credentialSha256,issuedAt,notBefore,expiresAt") &&
      value.schema === "two.qa.verifier.v1" &&
      JSON.stringify(value.descriptor) === JSON.stringify(identity.descriptor) &&
      value.q === identity.q &&
      matches(HEX, value.credentialSha256) &&
      Number.isSafeInteger(value.issuedAt) &&
      value.issuedAt > 0 &&
      value.notBefore === value.issuedAt &&
      Number.isSafeInteger(value.expiresAt) &&
      value.expiresAt <= 253402300799 &&
      // Issuance chooses the fixed 25-minute lifetime; callers cannot shorten
      // or extend it by replacing public metadata at upload time.
      value.expiresAt - value.issuedAt === 1500 &&
      Number.isSafeInteger(now) &&
      now >= value.issuedAt &&
      now < value.expiresAt - 30,
  );
  return value;
}

function bundleSnapshot(input, identity) {
  requireEvidence(
    keys(input, "q,build,rootSha256,bytes,files,entries") &&
      input.q === identity.q &&
      keys(input.build, "runId,runAttempt,artifactId,archiveSha256") &&
      [input.build.runId, input.build.runAttempt, input.build.artifactId].every((v) =>
        matches(ID, v),
      ) &&
      matches(HEX, input.build.archiveSha256) &&
      matches(HEX, input.rootSha256) &&
      Array.isArray(input.entries) &&
      input.entries.length > 0 &&
      input.entries.length <= 4096,
  );
  const names = new Set();
  let size = 0;
  const entries = input.entries.map((entry) => {
    requireEvidence(
      keys(entry, "path,type,bytes") &&
        safeBundlePath(entry.path) &&
        entry.type === "file" &&
        Buffer.isBuffer(entry.bytes) &&
        !names.has(entry.path.toLowerCase()),
    );
    names.add(entry.path.toLowerCase());
    size += entry.bytes.length;
    requireEvidence(size <= MAX_BYTES);
    return { path: entry.path, bytes: Buffer.from(entry.bytes) };
  });
  requireEvidence(names.has("worker/worker.mjs"));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const records = entries.map((entry) => [
    entry.path,
    entry.bytes.length,
    candidateSha256(entry.bytes),
  ]);
  const root = candidateSha256(JSON.stringify(records));
  requireEvidence(
    root === input.rootSha256 && size === input.bytes && entries.length === input.files,
  );
  return {
    entries,
    records,
    root,
    build: structuredClone(input.build),
    assetRoot: candidateSha256(
      JSON.stringify(records.filter(([path]) => path.startsWith("assets/"))),
    ),
  };
}

// Shared asset admission keeps the same profile, verifier and byte predicates
// as version construction. The sender constructs this snapshot itself; a plan
// supplied by a caller is never accepted as transport authority.
export function prepareCandidateAssetInput(options) {
  try {
    requireEvidence(keys(options, "identity,bundle,profile,profileSha256,verifier,now"));
    const identity = identitySnapshot(options.identity);
    const profile = profileSnapshot(options.profile, options.profileSha256);
    const run = verifierSnapshot(options.verifier, identity, options.now);
    const bundle = bundleSnapshot(options.bundle, identity);
    return {
      accountId: profile.accountId,
      scriptName: profile.scriptName,
      entries: bundle.entries.filter((entry) => entry.path.startsWith("assets/")),
      q: identity.q,
      bundleRootSha256: bundle.root,
      assetRootSha256: bundle.assetRoot,
      issuedAt: run.issuedAt,
      expiresAt: run.expiresAt,
    };
  } catch {
    throw new Error("Candidate assets refused: input");
  }
}

export function prepareCandidateWebUpload(options) {
  try {
    requireEvidence(
      keys(options, "identity,bundle,profile,profileSha256,verifier,assetsTicket") ||
        keys(options, "identity,bundle,profile,profileSha256,verifier,assetsTicket,now"),
    );
    const {
      identity: input,
      bundle: admittedBundle,
      profile: installedProfile,
      profileSha256,
      verifier,
      assetsTicket,
      now = Math.floor(Date.now() / 1000),
    } = options;
    const identity = identitySnapshot(input);
    const profile = profileSnapshot(installedProfile, profileSha256);
    const run = verifierSnapshot(verifier, identity, now);
    // Rehash and copy all bytes before producing Blob parts. A mutated admission
    // result cannot silently substitute code, paths or static assets.
    const bundle = bundleSnapshot(admittedBundle, identity);
    const hasAssets = bundle.entries.some((entry) => entry.path.startsWith("assets/"));
    const ticket = structuredClone(assetsTicket);
    if (hasAssets) {
      requireEvidence(
        keys(ticket, "q,bundleRootSha256,assetRootSha256,jwt") &&
          ticket.q === identity.q &&
          ticket.bundleRootSha256 === bundle.root &&
          ticket.assetRootSha256 === bundle.assetRoot &&
          typeof ticket.jwt === "string" &&
          ticket.jwt.length <= 8192 &&
          /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket.jwt),
      );
    } else {
      requireEvidence(ticket === null);
    }
    const metadata = {
      main_module: "worker/worker.mjs",
      compatibility_date: "2026-09-29",
      compatibility_flags: ["nodejs_compat"],
      // Explicit empty retention is deliberate. No remote secret, variable,
      // asset, tail consumer, container or configuration is copied from B.
      keep_bindings: [],
      keep_assets: false,
      bindings: [
        { name: "APP_URL", type: "plain_text", text: ORIGIN },
        { name: "QA_RUN_AUTH", type: "plain_text", text: verifier },
        { name: "CF_VERSION_METADATA", type: "version_metadata" },
        ...profile.bindings,
        ...(hasAssets ? [{ name: "ASSETS", type: "assets" }] : []),
      ],
      tail_consumers: [],
      streaming_tail_consumers: [],
      annotations: { "workers/tag": `candidate-${identity.q.slice(0, 32)}` },
      ...(hasAssets ? { assets: { jwt: ticket.jwt, config: { run_worker_first: true } } } : {}),
    };
    const encoded = JSON.stringify(metadata);
    const form = new FormData();
    form.set("metadata", encoded);
    for (const entry of bundle.entries) {
      if (entry.path.startsWith("worker/")) {
        form.set(
          entry.path,
          new Blob([entry.bytes], { type: "application/javascript+module" }),
          entry.path,
        );
      }
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${profile.accountId}/workers/scripts/${profile.scriptName}/versions?bindings_inherit=strict`;
    const metadataSha256 = candidateSha256(encoded);
    // form contains a short-lived asset upload capability; never log, persist
    // or publish it. Only this allowlisted proof belongs in a durable receipt.
    return Object.freeze({
      url,
      method: "POST",
      form,
      proof: Object.freeze({
        schema: "two.candidate-upload-request.v1",
        purpose: "premerge-candidate",
        promotable: false,
        q: identity.q,
        headSha: identity.descriptor[4],
        controllerSha: identity.descriptor[5],
        launcherSha: identity.descriptor[6],
        controllerRunId: identity.descriptor[7],
        controllerRunAttempt: identity.descriptor[8],
        ciRunId: identity.ciRunId,
        ciRunAttempt: identity.ciRunAttempt,
        profileSha256,
        bundleRootSha256: bundle.root,
        assetRootSha256: bundle.assetRoot,
        metadataSha256,
        requestSha256: candidateSha256(JSON.stringify([url, metadataSha256, bundle.records])),
        build: Object.freeze(bundle.build),
        issuedAt: run.issuedAt,
        expiresAt: run.expiresAt,
      }),
    });
  } catch {
    // JSON/parser errors can include public verifier data or an asset ticket.
    throw new Error("Candidate upload refused: request");
  }
}
