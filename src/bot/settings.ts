// Signed guild-settings verbs (dashboard moderation slice). The bot already
// speaks settings.get/settings.set into guild_settings (parent spec section
// 4.3); this module is the web side of that path: live reads for display
// (readGuildSettings) plus the queued write the worker delivers
// (applyGuildSetting, behind createSettingsWriter).
//
// Reads fail closed to { ok: false } on any transport, budget, or shape
// failure — the page answers 503, never a partial setting. Writes throw
// BotTransportError (a wait: retry/backoff) or BotTerminalError (refused
// before sending: malformed key, missing config), and map a bot refusal to
// the shared BotFailure shape with the bot's retryable verdict, exactly
// like the client-transport verbs. No function here logs bot detail: failure
// lines carry the caller-supplied idempotency key and the closed-vocabulary
// code only.
import { parseRetryAfterSeconds } from "../jobs/retry-delay";
import { BotTerminalError, BotTransportError } from "../jobs/types";
import type { BotFailure, SettingsWriter } from "../jobs/types";
import { parseEnvelope } from "./client-serialization";
import { diagnosticCode } from "./diagnostic-code";
import { encodeCanonicalJson, INTERNAL_ACTIONS_PATH, newNonce, signInternalAction } from "./signer";

/** Live display reads reuse the bot's verb; the bot returns its guild's rows. */
export const SETTINGS_READ_VERB = "settings.get";
/** Queued dashboard writes reuse the bot's verb, never a new path. */
export const SETTINGS_WRITE_VERB = "settings.set";

export type SettingsBotConfig = { baseUrl: string; keyId: string; secret: string };

export function settingsBotConfig(env: {
  BOT_ENDPOINT_URL?: string;
  BOT_KEY_ID?: string;
  BOT_SHARED_SECRET?: string;
}): SettingsBotConfig | null {
  if (!env.BOT_ENDPOINT_URL || !env.BOT_KEY_ID || !env.BOT_SHARED_SECRET) return null;
  return {
    baseUrl: env.BOT_ENDPOINT_URL,
    keyId: env.BOT_KEY_ID,
    secret: env.BOT_SHARED_SECRET,
  };
}

/** One guild_settings row as the dashboard renders it (spec section 3.1). */
export type GuildSetting = {
  key: string;
  value: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
};

export type SettingsReadResult = { ok: true; settings: GuildSetting[] } | { ok: false };

export type SettingsWriteRequest = {
  key: string;
  value: string;
  expectedVersion: number;
  actor: string;
  guildId: string;
};

export type SettingsWriteResult =
  | { ok: true; replayed: boolean }
  | { ok: false; failure: BotFailure };

// Observation budget, one attempt: fetch AND body reading, owned settlement
// even when the transport ignores abort (precedent: signedEventReader).
const SETTINGS_READ_BUDGET_MS = 2_500;
/** Maximum buffered response body before parsing (256 KiB provider-buffer
 * convention, src/discord-http.ts:9). Cumulative across chunks; exactly the
 * ceiling is accepted, one byte over is refused. */
const SETTINGS_MAX_RESPONSE_BYTES = 262_144;
class SettingsReadTimeoutError extends Error {
  constructor() {
    super("Bot settings observation timed out");
    this.name = "TimeoutError";
  }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

function endpointOf(cfg: SettingsBotConfig): string {
  const url = new URL(INTERNAL_ACTIONS_PATH, cfg.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new BotTransportError("bot endpoint refused");
  }
  return url.toString();
}

/**
 * One signed attempt with an owned deadline and a capped body. Throws
 * BotTransportError on every transport, budget, redirect, over-limit, or
 * non-JSON failure; malformed envelopes are the caller's parseEnvelope to
 * classify. Cancellation is never awaited: a hook that never settles,
 * rejects, or throws cannot delay or poison the settled answer.
 */
async function sendSettingsRequest(
  cfg: SettingsBotConfig,
  payload: Record<string, unknown>,
  idempotencyKey: string | null,
  fetcher: typeof fetch,
): Promise<{ status: number; replayed: boolean; retryAfter: string | null; json: unknown }> {
  const endpoint = endpointOf(cfg);
  const body = encodeCanonicalJson(payload);
  const headers = await signInternalAction(
    cfg.keyId,
    cfg.secret,
    body,
    Math.floor(Date.now() / 1000),
    newNonce(),
  );
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SettingsReadTimeoutError());
    }, SETTINGS_READ_BUDGET_MS);
  });
  const cancelBody = (target: { cancel?: () => unknown } | null | undefined) => {
    try {
      const pending = target?.cancel?.() as Promise<void> | void;
      void (pending as Promise<void>)?.catch?.(() => {});
    } catch (error) {
      void error;
    }
  };
  const operation: Promise<{
    status: number;
    replayed: boolean;
    retryAfter: string | null;
    json: unknown;
  }> = (async () => {
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        body,
        // Workers fetch rejects redirect "error"; "manual" hands back the 3xx, refused below.
        redirect: "manual",
        signal: controller.signal,
        headers: {
          ...headers,
          "Content-Type": "application/json",
          ...(idempotencyKey === null ? {} : { "Idempotency-Key": idempotencyKey }),
        },
      });
    } catch (error) {
      // The rejection text is untrusted, input-derived material, so it never
      // reaches the message. Fixed string; the original rides as `cause`.
      throw new BotTransportError("bot unreachable", { cause: error });
    }
    if (controller.signal.aborted) {
      cancelBody(response.body);
      throw new SettingsReadTimeoutError();
    }
    if (response.status >= 300 && response.status < 400) {
      cancelBody(response.body);
      throw new BotTransportError(
        `bot answered with a redirect (${response.status}); not followed`,
      );
    }
    const replayed = response.headers.get("Idempotent-Replay") === "true";
    const retryAfter = response.headers.get("Retry-After");
    if (!response.body) {
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        void error;
        throw new BotTransportError("bot answered with an unreadable body");
      }
      if (controller.signal.aborted) throw new SettingsReadTimeoutError();
      if (new TextEncoder().encode(text).byteLength > SETTINGS_MAX_RESPONSE_BYTES) {
        throw new BotTransportError("bot answered with a body that is too large");
      }
      try {
        return { status: response.status, replayed, retryAfter, json: JSON.parse(text) };
      } catch (error) {
        void error;
        throw new BotTransportError("bot answered with a body that is not JSON");
      }
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (controller.signal.aborted) throw new SettingsReadTimeoutError();
        size += value.byteLength;
        if (size > SETTINGS_MAX_RESPONSE_BYTES) {
          cancelBody(reader);
          throw new BotTransportError("bot answered with a body that is too large");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (controller.signal.aborted) throw new SettingsReadTimeoutError();
      if (error instanceof BotTransportError) throw error;
      void error;
      throw new BotTransportError("bot answered with an unreadable body");
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder().decode(bytes);
    } catch (error) {
      void error;
      throw new BotTransportError("bot answered with an unreadable body");
    }
    try {
      return { status: response.status, replayed, retryAfter, json: JSON.parse(text) };
    } catch (error) {
      void error;
      throw new BotTransportError("bot answered with a body that is not JSON");
    }
  })();
  // Attach a no-op handler so a late transport rejection after the race was
  // lost can never surface as an unhandled rejection.
  operation.catch(() => {});
  try {
    const result = await Promise.race([operation, timeout]);
    complete = true;
    return result;
  } catch (error) {
    if (error instanceof BotTransportError) throw error;
    void error;
    throw new BotTransportError("bot unreachable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!complete) {
      controller.abort();
      if (reader !== undefined) cancelBody(reader);
    }
    try {
      reader?.releaseLock();
    } catch (error) {
      void error;
    }
  }
}

function parseGuildSetting(row: unknown): GuildSetting | null {
  if (!object(row)) return null;
  if (typeof row["key"] !== "string" || row["key"].length === 0) return null;
  if (!scalar(row["value"])) return null;
  if (typeof row["version"] !== "number" || !Number.isInteger(row["version"])) return null;
  if (typeof row["updated_by"] !== "string" || typeof row["updated_at"] !== "string") return null;
  return {
    key: row["key"],
    value: String(row["value"]),
    version: row["version"],
    updatedBy: row["updated_by"],
    updatedAt: row["updated_at"],
  };
}

/**
 * Live display read over the existing byte-parity signer. No retries,
 * redirect-following, or alternate credentials; every failure answers
 * { ok: false } with no bot detail, so the page can 503 without leaking.
 */
export async function readGuildSettings(
  cfg: SettingsBotConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<SettingsReadResult> {
  const unavailable: SettingsReadResult = { ok: false };
  if (!cfg) return unavailable;
  let answer: { status: number; json: unknown };
  try {
    answer = await sendSettingsRequest(
      cfg,
      { action: SETTINGS_READ_VERB },
      crypto.randomUUID(),
      fetcher,
    );
  } catch {
    return unavailable;
  }
  const statusOk = answer.status >= 200 && answer.status < 300;
  if (!statusOk || !object(answer.json) || answer.json["ok"] !== true) return unavailable;
  const result = answer.json["result"];
  if (!object(result) || !Array.isArray(result["settings"])) return unavailable;
  const settings: GuildSetting[] = [];
  for (const row of result["settings"]) {
    const parsed = parseGuildSetting(row);
    if (!parsed) {
      // One malformed row must not 503 the page; the key name is config,
      // never member data or a secret, so it is safe to name.
      console.warn("bot settings read skipped a malformed row", {
        key: object(row) && typeof row["key"] === "string" ? row["key"] : "(unknown)",
      });
      continue;
    }
    settings.push(parsed);
  }
  return { ok: true, settings };
}

/**
 * Deliver one queued dashboard write. Throws BotTransportError on transport
 * failures (the queue waits) and BotTerminalError when refused before
 * sending (malformed key, missing config); maps a bot refusal to the shared
 * failure shape with the bot's retryable verdict.
 */
export async function applyGuildSetting(
  cfg: SettingsBotConfig | null,
  req: SettingsWriteRequest,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<SettingsWriteResult> {
  if (!cfg) {
    throw new BotTerminalError("A settings.set needs a configured bot endpoint.");
  }
  if (!UUID_RE.test(idempotencyKey)) {
    throw new BotTerminalError(
      "An Idempotency-Key must be a UUID; the bot answers a malformed one with a non-retryable `malformed`.",
    );
  }
  const answer = await sendSettingsRequest(
    cfg,
    {
      action: SETTINGS_WRITE_VERB,
      guild_id: req.guildId,
      key: req.key,
      value: req.value,
      expected_version: req.expectedVersion,
      updated_by: req.actor,
    },
    idempotencyKey,
    fetcher,
  );
  const parsed = parseEnvelope(answer.status, answer.replayed, answer.json);
  if (!parsed.ok && parsed.failure.code === "rate_limited" && answer.status === 429) {
    parsed.failure.retryAfterSeconds = parseRetryAfterSeconds(answer.retryAfter) ?? null;
  }
  // Diagnostics never carry provider text: correlation uses the
  // caller-supplied key, the code uses the closed vocabulary.
  if (parsed.ok) {
    console.info("bot settings.set succeeded", {
      idempotency_key: idempotencyKey,
      status: answer.status,
      replayed: parsed.replayed,
    });
  } else {
    console.warn("bot settings.set refused", {
      idempotency_key: idempotencyKey,
      status: answer.status,
      code: diagnosticCode(parsed.failure.code),
      retryable: parsed.failure.retryable,
    });
  }
  if (!parsed.ok) return { ok: false, failure: parsed.failure };
  return { ok: true, replayed: parsed.replayed };
}

/** Adapt the transport to the queue consumer's writer seam. */
export function createSettingsWriter(
  cfg: SettingsBotConfig | null,
  fetcher: typeof fetch = fetch,
): SettingsWriter {
  return {
    setSetting: async (req, idempotencyKey) => {
      const res = await applyGuildSetting(cfg, req, idempotencyKey, fetcher);
      if (!res.ok) return res.failure;
      return { ok: true, requestId: null, replayed: res.replayed };
    },
  };
}
