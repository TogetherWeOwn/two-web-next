import { isProxy } from "node:util/types";
import { REQUIRED_PRODUCTION_SECRETS } from "./check-production-secrets.mjs";
import { APEX_ORIGIN } from "./operator-constants.mjs";
import { RECOVERY_TARGET, validRecoveryVersionId } from "./pure-hono-recovery-evidence.mjs";

// Reviewed public literals, not observations or fallback values. Changes to
// these or to the binding inventory need review before projection can resume.
const PUBLIC_VARS = {
  APP_URL: APEX_ORIGIN,
  DISCORD_CLIENT_ID: "1539711683898118154",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/4GwEDNRTtx",
  DISCORD_MODERATOR_ROLE_IDS: "1546777855801954408,1546777856984481792",
  FEATURED_IMAGE_HOSTS: "",
};
const HYPERDRIVE_IDS = {
  DB: "7489f6ad630042148cdef83602f27b8a",
  BOT_DB: "14c00d84d1d446c1b117861f3b49473f",
};
const QUEUE_NAMES = {
  INTERNAL_ACTION_QUEUE: "two-web-next-production-internal-action",
  SYNC_EVENT_QUEUE: "two-web-next-production-sync-event",
};
const SECRET_NAMES = [...REQUIRED_PRODUCTION_SECRETS].sort();
const BINDING_NAMES = [
  "ASSETS",
  "CF_VERSION_METADATA",
  ...Object.keys(HYPERDRIVE_IDS),
  ...Object.keys(QUEUE_NAMES),
  ...Object.keys(PUBLIC_VARS),
  ...SECRET_NAMES,
];

function refuse(reason) {
  throw new Error(`pure Hono versioned config refused: ${reason}`);
}

function dataField(record, key) {
  const field = Object.getOwnPropertyDescriptor(record, key);
  return field?.enumerable && Object.hasOwn(field, "value");
}

function hasExactFields(record, keys) {
  return (
    record !== null &&
    typeof record === "object" &&
    !isProxy(record) &&
    Object.getPrototypeOf(record) === Object.prototype &&
    keys.every((key) => dataField(record, key)) &&
    Reflect.ownKeys(record).length === keys.length
  );
}

function reviewedFlags(flags) {
  return (
    !isProxy(flags) &&
    Array.isArray(flags) &&
    Object.getPrototypeOf(flags) === Array.prototype &&
    flags.length === 1 &&
    Reflect.ownKeys(flags).length === 2 &&
    dataField(flags, "0") &&
    flags[0] === "nodejs_compat"
  );
}

function canonicalDate(date) {
  if (typeof date !== "string" || date.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function binding(value, kind, fields = []) {
  if (!hasExactFields(value, ["kind", ...fields]) || value.kind !== kind) refuse("binding shape");
}

// Only accepts an explicitly normalized versioned observation. No defaults,
// filesystem, API access, source-config normalization or raw observation hash.
// The result is not the packager's effectiveConfig Buffer.
export function projectPureHonoVersionedConfig(observation) {
  const fields = [
    "scope",
    "scriptName",
    "versionId",
    "compatibilityDate",
    "compatibilityFlags",
    "bindings",
  ];
  if (!hasExactFields(observation, fields) || observation.scope !== "versioned") {
    refuse("versioned observation shape");
  }
  const { scriptName, versionId, compatibilityDate, compatibilityFlags, bindings } = observation;
  if (
    scriptName !== RECOVERY_TARGET ||
    typeof versionId !== "string" ||
    versionId.length !== 36 ||
    !validRecoveryVersionId(versionId) ||
    versionId === "00000000-0000-0000-0000-000000000000"
  ) {
    refuse("version identity");
  }
  if (!canonicalDate(compatibilityDate) || !reviewedFlags(compatibilityFlags)) {
    refuse("runtime compatibility");
  }
  if (!hasExactFields(bindings, BINDING_NAMES)) refuse("binding inventory");
  binding(bindings.ASSETS, "assets");
  binding(bindings.CF_VERSION_METADATA, "version_metadata");

  const projected = {
    ASSETS: { kind: "assets" },
    CF_VERSION_METADATA: { kind: "version_metadata" },
  };
  for (const [name, id] of Object.entries(HYPERDRIVE_IDS)) {
    binding(bindings[name], "hyperdrive", ["id"]);
    if (bindings[name].id !== id) refuse("Hyperdrive identity");
    projected[name] = { kind: "hyperdrive", id };
  }
  for (const [name, queueName] of Object.entries(QUEUE_NAMES)) {
    binding(bindings[name], "queue", ["queueName"]);
    if (bindings[name].queueName !== queueName) refuse("queue identity");
    projected[name] = { kind: "queue", queueName };
  }
  for (const [name, text] of Object.entries(PUBLIC_VARS)) {
    binding(bindings[name], "plain_text", ["text"]);
    if (bindings[name].text !== text) refuse("unreviewed public value");
    projected[name] = { kind: "plain_text", text };
  }
  for (const name of SECRET_NAMES) {
    binding(bindings[name], "secret_text");
    projected[name] = { kind: "secret_text" };
  }

  const partial = {
    schema: "two.pure-hono-versioned-config.partial.v1",
    scriptName: RECOVERY_TARGET,
    versionId,
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat"],
    bindings: projected,
  };
  return { partialVersionedConfig: Buffer.from(`${JSON.stringify(partial)}\n`, "utf8") };
}
