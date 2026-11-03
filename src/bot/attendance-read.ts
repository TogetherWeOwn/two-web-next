// Site-side reader for the bot's `event.attendance.read` verb
// (bot-live-voice-contract §4). The site pulls attendance after an event
// window closes and, on a `final:true` payload, writes one `event_echoes`
// row. `final:false` and `not_found` never write — until the operator flips
// the bot flag, `not_found` is the honest answer for every event.
//
// Wire discipline mirrors `event.read` (src/bot/event-read.ts): signed POST
// over the same transport, 2.5 s budget, no redirects, canonical JSON,
// fail-closed parsing. The relay strips free-text messages, so callers see
// the typed code table only — never a bot message, body or credential.
import { encodeCanonicalJson, INTERNAL_ACTIONS_PATH, newNonce, signInternalAction } from "./signer";

export type AttendanceMember = {
  discord_id: string;
  minutes: number;
  sessions: number;
  first_joined_at: string | null;
};

export type AttendanceRoom = { channel_id: string; name_at_close: string };

export type AttendancePayload = {
  v: number;
  event_key: string;
  window: { starts_at: string; ends_at: string };
  threshold_minutes: number;
  peak_concurrent: number;
  rooms: AttendanceRoom[];
  members: AttendanceMember[];
  final: boolean;
};

export type AttendanceResult =
  | { ok: true; attendance: AttendancePayload }
  | { ok: false; code: string };

export type AttendanceReader = (eventKey: string) => Promise<AttendanceResult>;

export type AttendanceReadConfig = { baseUrl?: string; keyId?: string; secret?: string };

// Observation budget: one attempt, fetch AND body reading, owned settlement
// even when the transport ignores abort (precedent: src/discord-http.ts,
// src/bot/event-read.ts).
const ATTENDANCE_READ_BUDGET_MS = 2_500;
/** Maximum buffered response body before parsing (256 KiB provider-buffer
 * convention, src/discord-http.ts:9). Cumulative across chunks; exactly the
 * ceiling is accepted, one byte over is refused. */
const ATTENDANCE_READ_MAX_RESPONSE_BYTES = 262_144;
class AttendanceReadTimeoutError extends Error {
  constructor() {
    super("Bot event.attendance.read observation timed out");
    this.name = "TimeoutError";
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const SNOWFLAKE = /^\d{1,20}$/;
const ISO_ZULU = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// Caps mirror the contract's fail-closed site parser discipline (cf.
// voice.snapshot caps in contract §1): at most 100 rooms, at most 500
// members, names at most 100 characters, snowflake shapes. A malformed
// payload is discarded whole, never partially rendered.
const MAX_ROOMS = 100;
const MAX_MEMBERS = 500;
const MAX_ROOM_NAME = 100;

/** Fail-closed parse of the relayed `event.attendance.read` result. Returns
 * null on anything that is not exactly the contract shape. */
export function parseAttendanceResult(result: unknown, eventKey: string): AttendancePayload | null {
  if (!object(result)) return null;
  if (result.v !== 1) return null;
  if (result.event_key !== eventKey) return null;
  if (!object(result.window)) return null;
  const startsAt = result.window.starts_at;
  const endsAt = result.window.ends_at;
  if (
    typeof startsAt !== "string" ||
    typeof endsAt !== "string" ||
    !ISO_ZULU.test(startsAt) ||
    !ISO_ZULU.test(endsAt) ||
    !(Date.parse(endsAt) > Date.parse(startsAt))
  )
    return null;
  if (
    typeof result.threshold_minutes !== "number" ||
    !Number.isInteger(result.threshold_minutes) ||
    result.threshold_minutes <= 0
  )
    return null;
  if (
    typeof result.peak_concurrent !== "number" ||
    !Number.isInteger(result.peak_concurrent) ||
    result.peak_concurrent < 0
  )
    return null;
  if (!Array.isArray(result.rooms) || result.rooms.length > MAX_ROOMS) return null;
  const rooms: AttendanceRoom[] = [];
  for (const room of result.rooms) {
    if (!object(room)) return null;
    if (typeof room.channel_id !== "string" || !SNOWFLAKE.test(room.channel_id)) return null;
    if (
      typeof room.name_at_close !== "string" ||
      room.name_at_close.length === 0 ||
      room.name_at_close.length > MAX_ROOM_NAME
    )
      return null;
    rooms.push({ channel_id: room.channel_id, name_at_close: room.name_at_close });
  }
  if (!Array.isArray(result.members) || result.members.length > MAX_MEMBERS) return null;
  const members: AttendanceMember[] = [];
  for (const member of result.members) {
    if (!object(member)) return null;
    if (typeof member.discord_id !== "string" || !SNOWFLAKE.test(member.discord_id)) return null;
    if (
      typeof member.minutes !== "number" ||
      !Number.isInteger(member.minutes) ||
      member.minutes < 0
    )
      return null;
    if (
      typeof member.sessions !== "number" ||
      !Number.isInteger(member.sessions) ||
      member.sessions < 1
    )
      return null;
    const firstJoined = member.first_joined_at;
    if (
      firstJoined !== null &&
      firstJoined !== undefined &&
      (typeof firstJoined !== "string" || !ISO_ZULU.test(firstJoined))
    )
      return null;
    members.push({
      discord_id: member.discord_id,
      minutes: member.minutes,
      sessions: member.sessions,
      first_joined_at: typeof firstJoined === "string" ? firstJoined : null,
    });
  }
  if (typeof result.final !== "boolean") return null;
  return {
    v: 1,
    event_key: eventKey,
    window: { starts_at: startsAt, ends_at: endsAt },
    threshold_minutes: result.threshold_minutes,
    peak_concurrent: result.peak_concurrent,
    rooms,
    members,
    final: result.final,
  };
}

/** Uses the existing byte-parity signer. No direct Discord reads, retries,
 * redirect-following or alternate credentials; malformed replies fail closed.
 * Owns the 2.5 s deadline across fetch and body reading even when the
 * transport ignores abort, caps buffered bytes before parsing, attempts
 * cancellation without awaiting it, and never lets late outcomes change the
 * settled answer. */
export function signedAttendanceReader(
  cfg: AttendanceReadConfig,
  fetcher: typeof fetch = fetch,
): AttendanceReader {
  return async (eventKey) => {
    const unreachable: AttendanceResult = { ok: false, code: "bot_unreachable" };
    if (!cfg.baseUrl || !cfg.keyId || !cfg.secret) return unreachable;
    try {
      const url = new URL(INTERNAL_ACTIONS_PATH, cfg.baseUrl);
      if (url.protocol !== "https:" || url.username || url.password) return unreachable;
      const body = encodeCanonicalJson({ action: "event.attendance.read", event_key: eventKey });
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
          reject(new AttendanceReadTimeoutError());
        }, ATTENDANCE_READ_BUDGET_MS);
      });
      const cancelBody = (target: { cancel?: () => unknown } | null | undefined) => {
        // Never await uncooperative cleanup: a hook that never settles,
        // rejects, or throws cannot delay or poison the settled answer.
        // Called synchronously so fake-timer assertions observe it without
        // an extra flush; rejections are swallowed to avoid unhandled noise.
        try {
          const pending = target?.cancel?.() as Promise<void> | void;
          void (pending as Promise<void>)?.catch?.(() => {});
        } catch (error) {
          void error;
        }
      };
      const parseDoc = (doc: unknown, statusOk: boolean): AttendanceResult => {
        if (!object(doc) || !("ok" in doc)) return unreachable;
        if (!statusOk || doc.ok !== true) {
          // Return only the typed code, never a bot message/body/credential.
          return object(doc.error) &&
            typeof doc.error.code === "string" &&
            /^[a-z0-9_:-]{1,64}$/.test(doc.error.code)
            ? { ok: false, code: doc.error.code }
            : unreachable;
        }
        const attendance = parseAttendanceResult(doc.result, eventKey);
        return attendance ? { ok: true, attendance } : unreachable;
      };
      const operation: Promise<AttendanceResult> = (async () => {
        const response = await fetcher(url.toString(), {
          method: "POST",
          body,
          // Workers fetch rejects redirect "error"; "manual" hands back the 3xx, refused below.
          redirect: "manual",
          signal: controller.signal,
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
        });
        // A non-cooperative transport may deliver headers after the race was lost.
        if (controller.signal.aborted) {
          cancelBody(response.body);
          throw new AttendanceReadTimeoutError();
        }
        if (response.status >= 300 && response.status < 400) {
          cancelBody(response.body);
          return unreachable;
        }
        if (!response.body) {
          let text: string;
          try {
            text = await response.text();
          } catch (error) {
            void error;
            return unreachable;
          }
          if (controller.signal.aborted) throw new AttendanceReadTimeoutError();
          if (new TextEncoder().encode(text).byteLength > ATTENDANCE_READ_MAX_RESPONSE_BYTES)
            return unreachable;
          let doc: unknown;
          try {
            doc = JSON.parse(text);
          } catch (error) {
            void error;
            return unreachable;
          }
          return parseDoc(doc, response.ok);
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (controller.signal.aborted) throw new AttendanceReadTimeoutError();
            size += value.byteLength;
            // Cap buffered bytes before parsing: overflow fails closed without
            // waiting for close or the deadline.
            if (size > ATTENDANCE_READ_MAX_RESPONSE_BYTES) {
              cancelBody(reader);
              return unreachable;
            }
            chunks.push(value);
          }
        } catch (error) {
          if (controller.signal.aborted) throw new AttendanceReadTimeoutError();
          void error;
          return unreachable;
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
          return unreachable;
        }
        let doc: unknown;
        try {
          doc = JSON.parse(text);
        } catch (error) {
          void error;
          return unreachable;
        }
        return parseDoc(doc, response.ok);
      })();
      // Attach a no-op handler so a late transport rejection after the race
      // was lost can never surface as an unhandled rejection; the race keeps
      // its own handler, this only guards runtimes that track each branch.
      operation.catch(() => {});
      try {
        const result = await Promise.race([operation, timeout]);
        complete = true;
        return result;
      } catch (error) {
        void error;
        return unreachable;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (!complete) {
          controller.abort();
          // Do not await cancellation: the underlying source may itself be stuck.
          if (reader !== undefined) cancelBody(reader);
        }
        try {
          reader?.releaseLock();
        } catch (error) {
          void error;
        }
      }
    } catch {
      return unreachable;
    }
  };
}
