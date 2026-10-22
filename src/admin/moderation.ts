// Dashboard moderation page orchestration (moderation slice).
//
// The page is a UI over the bot's settings verbs: live reads reuse
// settings.get for display, accepted writes queue one settings.set carrier
// each (UUID idempotency key, dashboard:<user-id> attribution, session
// guild scope) for the worker to deliver. Reads use the session bit only;
// writes additionally pass a live Discord role re-check at write time.
//
// Key registry (spec sections 2.1/3.1, decisions B5+B7 — nothing invented):
// exactly one pinned hot key is dashboard-editable; the bot-owned families
// classify errors but are never edited from here; reach/identity keys are
// read-only status; warn/strike escalation and mute-role config do not exist
// in the bot and render "not available" with zero submittable controls.
import type { Db } from "../db/index";
import type { Env } from "../env";
import type { GuildSetting, SettingsReadResult } from "../bot/settings";
import { readGuildSettings, settingsBotConfig } from "../bot/settings";
import type { QueueMessage } from "../jobs/types";
import { parseModeratorRoleIds, recomputeModerator } from "../roles";
import { audit, boundModeratorWrite } from "./store-shared";

/** The one dashboard-editable hot key (spec section 6 live check). */
export const MODERATION_HOT_KEYS = ["TWO_AUTOMOD_MENTION_LIMIT"] as const;

/**
 * Bot-owned key families (the real key names live in the bot; per-key
 * liveness is proven by the staging live check, not here). Used only to
 * classify refused writes precisely — never to admit them.
 */
export const MODERATION_KEY_FAMILIES = [
  "TWO_AUTOMOD_",
  "TWO_RAID_",
  "TWO_JOIN_RISK_",
  "TWO_ANTI_NUKE_",
  "LOG_CHANNEL_ID",
] as const;

/** Reach/identity keys: operator-only, dashboard shows read-only status. */
export const MODERATION_ENVONLY_KEYS = [
  "TWO_MODERATION",
  "TWO_MODERATION_PROTECTED_ROLE_IDS",
  "TWO_ONBOARDING_MODE",
  "TWO_OWEN_USER_ID",
] as const;
export const MODERATION_ENVONLY_PREFIXES = [
  "TWO_INTERNAL_",
  "TWO_ASSISTANT_",
  "TWO_TEMP_VOICE_SYNTHETIC_HUMAN_IDS",
] as const;

export function familyOf(key: string): string | null {
  for (const prefix of MODERATION_KEY_FAMILIES) {
    if (key.includes(prefix)) return prefix;
  }
  return null;
}

export function isEnvOnlyKey(key: string): boolean {
  if ((MODERATION_ENVONLY_KEYS as readonly string[]).includes(key)) return true;
  return MODERATION_ENVONLY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export type ModerationSubmission = { key: string; value: string; expectedVersion: number };
export type ModerationParse =
  | { ok: true; submission: ModerationSubmission }
  | { ok: false; status: 422; detail: string };

const FORM_FIELDS = new Set<string>([...MODERATION_HOT_KEYS, "expected_version", "guild_id"]);

/**
 * Refuse forged or malformed submissions before anything is dispatched.
 * The forged guild field is explicitly ignored (single-guild site: the
 * dispatch always carries the session guild); every other unknown field,
 * EnvOnly key, missing version, or non-threshold value is a 422.
 */
export function parseModerationSubmission(fields: Record<string, unknown>): ModerationParse {
  const refuse = (detail: string): ModerationParse => ({ ok: false, status: 422, detail });
  for (const name of Object.keys(fields)) {
    if (isEnvOnlyKey(name)) {
      return refuse(
        `${name} is read-only: operator-only keys are shown for status and never written from the dashboard.`,
      );
    }
  }
  for (const name of Object.keys(fields)) {
    if (!FORM_FIELDS.has(name)) {
      const family = familyOf(name);
      return refuse(
        family
          ? `Unknown setting: only ${MODERATION_HOT_KEYS.join(", ")} is dashboard-editable. ` +
              `The submitted key belongs to the ${family} family, which the bot owns and this dashboard does not edit.`
          : `Unknown setting: only ${MODERATION_HOT_KEYS.join(", ")} is dashboard-editable.`,
      );
    }
  }
  const rawVersion = fields["expected_version"];
  if (typeof rawVersion !== "string" || !/^\d+$/.test(rawVersion)) {
    return refuse("A version is required: reload the form and try again.");
  }
  const expectedVersion = Number(rawVersion);
  if (!Number.isSafeInteger(expectedVersion)) {
    return refuse("A version is required: reload the form and try again.");
  }
  const present = MODERATION_HOT_KEYS.filter((key) => key in fields);
  if (present.length === 0) {
    return refuse("Nothing to write: submit exactly one hot-key value with its version.");
  }
  if (present.length > 1) {
    return refuse("One setting per save: submit exactly one hot-key value with its version.");
  }
  const key = present[0]!;
  const value = fields[key];
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return refuse(`${key} must be a non-negative whole number.`);
  }
  return { ok: true, submission: { key, value, expectedVersion } };
}

export type ModerationPageModel = {
  hotKeys: Array<{
    key: string;
    value: string;
    version: number;
    updatedBy: string;
    updatedAt: string;
  }>;
  envOnly: Array<{ key: string; value: string }>;
};

/**
 * Shape the live settings into the page model. Null when the live response
 * omits the pinned hot key: without a live value + version there is no
 * versioned form to render, so the route fails closed instead of inventing
 * one. EnvOnly rows render from the same live response, never from a copy.
 */
export function moderationPageModel(settings: GuildSetting[]): ModerationPageModel | null {
  const hotKeys: ModerationPageModel["hotKeys"] = [];
  for (const key of MODERATION_HOT_KEYS) {
    const row = settings.find((s) => s.key === key);
    if (!row) return null;
    hotKeys.push({
      key: row.key,
      value: row.value,
      version: row.version,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    });
  }
  return {
    hotKeys,
    envOnly: settings
      .filter((s) => isEnvOnlyKey(s.key))
      .map((s) => ({ key: s.key, value: s.value })),
  };
}

/** Live display read for the page. Reads use the session bit only. */
export function readModerationSettings(env: Env): Promise<SettingsReadResult> {
  return readGuildSettings(settingsBotConfig(env));
}

/**
 * Live Discord role re-check at write time, strictly scoped to the session
 * guild. Fails closed: any lookup failure or blank allowlist/token refuses
 * the write. The login-time session bit is never enough for a mutation.
 */
export function verifyModeratorLive(env: Env, guildId: string, userId: string): Promise<boolean> {
  return recomputeModerator({
    guildId,
    userId,
    botToken: env.DISCORD_BOT_TOKEN,
    moderatorRoleIds: parseModeratorRoleIds(env.DISCORD_MODERATOR_ROLE_IDS),
  });
}

export type SettingsSetCarrier = Extract<QueueMessage, { kind: "settings-set" }>;

/**
 * Build the attributed carrier the worker delivers. One fresh UUID
 * idempotency key per dispatch; the guild is always the session guild the
 * caller passes in, never a form field.
 */
export function buildSettingsSetMessage(args: {
  key: string;
  value: string;
  expectedVersion: number;
  actorId: string;
  guildId: string;
}): SettingsSetCarrier {
  return {
    kind: "settings-set",
    idempotencyKey: crypto.randomUUID(),
    guildId: args.guildId,
    actor: `dashboard:${args.actorId}`,
    action: {
      verb: "settings.set",
      key: args.key,
      value: args.value,
      expected_version: args.expectedVersion,
    },
  };
}

/** True when the worker can queue a settings write at all. */
export function isModerationDispatchBound(env: Env): boolean {
  return !!env.INTERNAL_ACTION_QUEUE;
}

/**
 * Queue the carrier. False when the binding is missing (a misconfigured
 * worker answers 503, never throws into a 500); the caller audits first, so
 * a mid-flight send failure still leaves the attempt on record.
 */
export async function dispatchSettingsSet(env: Env, msg: SettingsSetCarrier): Promise<boolean> {
  const queue = env.INTERNAL_ACTION_QUEUE;
  if (!queue) {
    console.warn("moderation write accepted but the dispatch queue is not bound", {
      key: msg.action.key,
    });
    return false;
  }
  await queue.send(msg);
  return true;
}

/**
 * Exactly one attributable activity row per accepted write, in the bounded
 * moderator-write transaction like every other admin mutation.
 */
export async function auditModerationWrite(
  db: Db,
  args: { actorId: string; key: string; before: string; after: string; expectedVersion: number },
): Promise<void> {
  await db.transaction(async (tx) => {
    await boundModeratorWrite(tx);
    await audit(tx, {
      subjectType: "moderation_setting",
      subjectId: args.key,
      causerId: args.actorId,
      description:
        `Dashboard moderation write: ${args.key} set to ${args.after} ` +
        `(expected version ${args.expectedVersion})`,
      properties: { [args.key]: { before: args.before, after: args.after } },
    });
  });
}
