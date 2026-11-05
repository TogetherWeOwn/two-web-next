// Inert B-prime request construction, never upload, traffic selection or cleanup.
// The installed controller must authenticate original B and the independent pin;
// a matching digest is integrity only, not baseline or recovery authority.
import { candidateSha256 } from "./candidate-staging-admission.mjs";
import { identitySnapshot, profileSnapshot } from "./candidate-staging-upload.mjs";

const ERROR = "Candidate recovery refused: baseline request";
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RESOURCE = /^[a-f0-9]{32}$/;
const MAX_BYTES = 16 * 1024 * 1024;
const PUBLIC_NAMES = new Set([
  "APP_URL",
  "FEATURED_IMAGE_HOSTS",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
  "DISCORD_MODERATOR_ROLE_IDS",
  "DISCORD_INVITE_URL",
  "KIT_ROUTE_ARCHIVE",
  "KIT_ROUTE_STATIC",
]);
const QUEUES = {
  SYNC_EVENT_QUEUE: "two-sync-event",
  INTERNAL_ACTION_QUEUE: "two-internal-action",
};

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

function matches(pattern, value) {
  return typeof value === "string" && pattern.test(value);
}

function digest(value) {
  return candidateSha256(JSON.stringify(value));
}

function path(value) {
  return (
    typeof value === "string" &&
    value.length <= 240 &&
    /^[A-Za-z0-9_./-]+$/.test(value) &&
    value.split("/").every((part) => part && !part.startsWith("."))
  );
}

export function candidateBaselineBindingsSnapshot(input) {
  requireEvidence(Array.isArray(input) && input.length > 0 && input.length <= 64);
  const names = new Set();
  const bindings = [];
  for (const b of input) {
    requireEvidence(
      matches(/^[A-Z][A-Z0-9_]{0,63}$/, b?.name) && b.name !== "QA_RUN_AUTH" && !names.has(b.name),
    );
    names.add(b.name);
    if (["secret_text", "secret_key"].includes(b.type)) {
      // Preserve only names/types. Never accept secret text, key data, a rename
      // or a caller-selected inheritance source in the recovery artifact.
      requireEvidence(keys(b, "name,type"));
      bindings.push({ name: b.name, type: b.type });
    } else if (b.type === "plain_text") {
      requireEvidence(
        keys(b, "name,type,text") &&
          PUBLIC_NAMES.has(b.name) &&
          typeof b.text === "string" &&
          Buffer.byteLength(b.text) <= 4096 &&
          !/[\x00-\x1f\x7f]/.test(b.text),
      );
      if (b.name === "APP_URL") requireEvidence(b.text === "https://next.togetherweown.com");
      bindings.push({ name: b.name, type: b.type, text: b.text });
    } else if (b.type === "hyperdrive") {
      requireEvidence(
        keys(b, "name,type,id") && ["DB", "BOT_DB"].includes(b.name) && matches(RESOURCE, b.id),
      );
      bindings.push({ name: b.name, type: b.type, id: b.id });
    } else if (b.type === "queue") {
      requireEvidence(
        keys(b, "name,type,queue_name") &&
          Object.hasOwn(QUEUES, b.name) &&
          QUEUES[b.name] === b.queue_name,
      );
      bindings.push({ name: b.name, type: b.type, queue_name: b.queue_name });
    } else {
      requireEvidence(
        keys(b, "name,type") &&
          ((b.name === "ASSETS" && b.type === "assets") ||
            (b.name === "CF_VERSION_METADATA" && b.type === "version_metadata")),
      );
      bindings.push({ name: b.name, type: b.type });
    }
  }
  // A baseline cannot omit the staging origin and silently inherit it from C.
  requireEvidence(bindings.some((b) => b.name === "APP_URL" && b.type === "plain_text"));
  return bindings.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function filesSnapshot(input) {
  requireEvidence(Array.isArray(input) && input.length > 0 && input.length <= 4096);
  let size = 0;
  const names = new Set();
  const records = [];
  for (const f of input) {
    requireEvidence(
      keys(f, "path,kind,contentType,size,sha256") &&
        path(f.path) &&
        ["module", "asset"].includes(f.kind) &&
        !names.has(`${f.kind}:${f.path.toLowerCase()}`) &&
        Number.isSafeInteger(f.size) &&
        f.size >= 0 &&
        matches(HEX, f.sha256) &&
        (f.kind === "asset"
          ? f.contentType === null
          : ["application/javascript+module", "application/wasm", "text/plain"].includes(
              f.contentType,
            ) ||
            (f.path === "_worker.js.map" && f.contentType === "application/source-map")),
    );
    names.add(`${f.kind}:${f.path.toLowerCase()}`);
    size += f.size;
    requireEvidence(size <= MAX_BYTES);
    records.push({
      path: f.path,
      kind: f.kind,
      contentType: f.contentType,
      size: f.size,
      sha256: f.sha256,
    });
  }
  return records.sort((a, b) => {
    const x = `${a.kind}:${a.path}`;
    const y = `${b.kind}:${b.path}`;
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function baselineInput(options) {
  try {
    requireEvidence(
      keys(options, "identity,profile,profileSha256,baseline,baselineSha256,files,now"),
    );
    const run = identitySnapshot(options.identity);
    const installed = profileSnapshot(options.profile, options.profileSha256);
    const b = structuredClone(options.baseline);
    requireEvidence(
      keys(
        b,
        "schema,promotable,q,profileSha256,versionId,capturedAt,mainModule,compatibilityDate,compatibilityFlags,placement,annotations,assets,bindings,files",
      ) &&
        b.schema === "two.candidate-baseline-web.v1" &&
        b.promotable === false &&
        b.q === run.q &&
        b.profileSha256 === options.profileSha256 &&
        matches(UUID, b.versionId) &&
        matches(HEX, options.baselineSha256) &&
        Number.isSafeInteger(b.capturedAt) &&
        b.capturedAt >= 0 &&
        Number.isSafeInteger(options.now) &&
        options.now >= b.capturedAt &&
        options.now <= 253402300799 &&
        path(b.mainModule) &&
        b.compatibilityDate === "2026-09-29" &&
        Array.isArray(b.compatibilityFlags) &&
        b.compatibilityFlags.length === 1 &&
        b.compatibilityFlags[0] === "nodejs_compat" &&
        keys(b.placement, "mode,region") &&
        b.placement.mode === "targeted" &&
        b.placement.region === "aws:us-east-1" &&
        keys(b.annotations, "workers/tag") &&
        matches(/^[a-f0-9]{40}$/, b.annotations["workers/tag"]) &&
        (b.assets === null ||
          (keys(b.assets, "run_worker_first") && b.assets.run_worker_first === true)),
    );
    const bindings = candidateBaselineBindingsSnapshot(b.bindings);
    const records = filesSnapshot(b.files);
    requireEvidence(records.some((f) => f.kind === "module" && f.path === b.mainModule));
    const canonical = {
      schema: b.schema,
      promotable: false,
      q: run.q,
      profileSha256: options.profileSha256,
      versionId: b.versionId,
      capturedAt: b.capturedAt,
      mainModule: b.mainModule,
      compatibilityDate: b.compatibilityDate,
      compatibilityFlags: ["nodejs_compat"],
      placement: { mode: "targeted", region: "aws:us-east-1" },
      annotations: { "workers/tag": b.annotations["workers/tag"] },
      assets: b.assets === null ? null : { run_worker_first: true },
      bindings,
      files: records,
    };
    requireEvidence(digest(canonical) === options.baselineSha256);
    requireEvidence(Array.isArray(options.files) && options.files.length === records.length);
    const supplied = new Map();
    let size = 0;
    for (const f of options.files) {
      requireEvidence(
        keys(f, "path,kind,bytes") &&
          path(f.path) &&
          ["module", "asset"].includes(f.kind) &&
          Buffer.isBuffer(f.bytes) &&
          !supplied.has(`${f.kind}:${f.path}`),
      );
      size += f.bytes.length;
      requireEvidence(size <= MAX_BYTES);
      supplied.set(`${f.kind}:${f.path}`, Buffer.from(f.bytes));
    }
    for (const record of records) {
      const bytes = supplied.get(`${record.kind}:${record.path}`);
      requireEvidence(
        bytes && bytes.length === record.size && candidateSha256(bytes) === record.sha256,
      );
    }
    const assets = records.filter((f) => f.kind === "asset");
    const hasAssets = assets.length > 0;
    requireEvidence(
      hasAssets === bindings.some((v) => v.type === "assets") && hasAssets === (b.assets !== null),
    );
    return {
      run,
      installed,
      b: canonical,
      bindings,
      records,
      supplied,
      hasAssets,
      assetRootSha256: digest(assets),
    };
  } catch {
    throw new Error(ERROR);
  }
}

// Shared copied-byte admission for recovery assets and the B-prime version body.
// Recovery is deliberately independent of the expired candidate QA verifier.
export function prepareCandidateBaselineAssetInput(options) {
  const input = baselineInput(options);
  return {
    q: input.run.q,
    accountId: input.installed.accountId,
    scriptName: input.installed.scriptName,
    baselineSha256: options.baselineSha256,
    assetRootSha256: input.assetRootSha256,
    entries: input.records
      .filter((f) => f.kind === "asset")
      .map((f) => ({
        path: `assets/${f.path}`,
        bytes: input.supplied.get(`asset:${f.path}`),
      })),
  };
}

export function prepareCandidateBaselineUpload(options) {
  try {
    requireEvidence(
      keys(
        options,
        "identity,profile,profileSha256,baseline,baselineSha256,files,assetsTicket,now",
      ),
    );
    const { assetsTicket, ...rest } = options;
    const { run, installed, b, bindings, records, supplied, hasAssets, assetRootSha256 } =
      baselineInput(rest);
    const canonical = b;
    const ticket = structuredClone(assetsTicket);
    if (hasAssets) {
      requireEvidence(
        keys(ticket, "q,baselineSha256,assetRootSha256,jwt") &&
          ticket.q === run.q &&
          ticket.baselineSha256 === options.baselineSha256 &&
          ticket.assetRootSha256 === assetRootSha256 &&
          typeof ticket.jwt === "string" &&
          ticket.jwt.length <= 8192 &&
          /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket.jwt),
      );
    } else requireEvidence(ticket === null);
    const body = JSON.stringify({
      main_module: b.mainModule,
      compatibility_date: b.compatibilityDate,
      compatibility_flags: canonical.compatibilityFlags,
      placement: canonical.placement,
      annotations: canonical.annotations,
      bindings: bindings.map((v) =>
        ["secret_text", "secret_key"].includes(v.type)
          ? { name: v.name, type: "inherit", version_id: b.versionId }
          : v,
      ),
      modules: records
        .filter((f) => f.kind === "module")
        .map((f) => ({
          name: f.path,
          content_type: f.contentType,
          content_base64: supplied.get(`module:${f.path}`).toString("base64"),
        })),
      ...(hasAssets ? { assets: { jwt: ticket.jwt, config: { run_worker_first: true } } } : {}),
    });
    // Only the Workers API supports a full version_id for inherit. Never use
    // the classic scripts endpoint, omit the pin, or deploy in this request.
    const url = `https://api.cloudflare.com/client/v4/accounts/${installed.accountId}/workers/workers/${installed.scriptName}/versions?deploy=false`;
    return Object.freeze({
      url,
      method: "POST",
      body,
      proof: Object.freeze({
        schema: "two.candidate-baseline-upload-request.v1",
        promotable: false,
        recoveryScope: "inert-baseline-request-only",
        q: run.q,
        profileSha256: options.profileSha256,
        baselineSha256: options.baselineSha256,
        baselineVersionId: b.versionId,
        assetRootSha256,
        requestSha256: digest([url, candidateSha256(body)]),
        preparedAt: options.now,
      }),
    });
  } catch {
    throw new Error(ERROR);
  }
}
