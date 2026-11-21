import { encodeCanonicalJson, INTERNAL_ACTIONS_PATH, newNonce, signInternalAction } from "./signer";

export type AttendanceMember = {
  discord_id: string;
  minutes: number;
  sessions: number;
  first_joined_at: string | null;
};
export type AttendanceRoom = { channel_id: string; name_at_close: string };
export type AttendancePayload = NonNullable<ReturnType<typeof parseAttendanceResult>>;
export type AttendanceResult =
  | { ok: true; attendance: AttendancePayload }
  | { ok: false; code: string };
export type AttendanceReader = (eventKey: string) => Promise<AttendanceResult>;
export type AttendanceReadConfig = { baseUrl?: string; keyId?: string; secret?: string };

const BUDGET_MS = 2_500;
const MAX_RESPONSE_BYTES = 256 * 1024;
const ISO_ZULU = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const snowflake = (v: unknown): v is string => typeof v === "string" && /^\d{1,20}$/.test(v);
const integer = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_ZULU.test(value)) return false;
  const time = Date.parse(value);
  const canonical = value.length === 20 ? value.replace("Z", ".000Z") : value;
  return Number.isFinite(time) && new Date(time).toISOString() === canonical;
}

/** Reject malformed known fields; project only v1 fields from additive replies. */
export function parseAttendanceResult(result: unknown, eventKey: string) {
  if (!object(result) || result.v !== 1 || result.event_key !== eventKey) return null;
  const { window, threshold_minutes, peak_concurrent, final } = result;
  if (
    !object(window) ||
    !timestamp(window.starts_at) ||
    !timestamp(window.ends_at) ||
    Date.parse(window.ends_at) <= Date.parse(window.starts_at) ||
    !integer(threshold_minutes, 1) ||
    !integer(peak_concurrent, 0) ||
    typeof final !== "boolean" ||
    !Array.isArray(result.rooms) ||
    !Array.isArray(result.members) ||
    (final && !result.members.length)
  )
    return null;
  // The transport byte cap bounds both lists; the producer has no per-list cap.
  const rooms = new Map<string, AttendanceRoom>();
  for (const room of result.rooms) {
    if (!object(room)) return null;
    const { channel_id, name_at_close } = room;
    if (!snowflake(channel_id) || rooms.has(channel_id)) return null;
    if (typeof name_at_close !== "string" || !/^.{1,100}$/su.test(name_at_close)) return null;
    rooms.set(channel_id, { channel_id, name_at_close });
  }
  const members = new Map<string, AttendanceMember>();
  for (const member of result.members) {
    if (!object(member)) return null;
    const { discord_id, minutes, sessions, first_joined_at } = member;
    if (
      !snowflake(discord_id) ||
      members.has(discord_id) ||
      !integer(minutes, 0) ||
      !integer(sessions, 1) ||
      (first_joined_at !== null && !timestamp(first_joined_at))
    )
      return null;
    members.set(discord_id, { discord_id, minutes, sessions, first_joined_at });
  }
  return {
    v: 1 as const,
    event_key: eventKey,
    window: { starts_at: window.starts_at, ends_at: window.ends_at },
    threshold_minutes,
    peak_concurrent,
    rooms: [...rooms.values()],
    members: [...members.values()],
    final,
  };
}

// Retain only documented status/code pairs; never project provider text.
const ERROR_STATUS = new Map<string, number>([
  ["malformed", 400],
  ["unauthorized", 401],
  ["stale_request", 401],
  ["action_not_allowed", 403],
  ["not_found", 404],
  ["replayed", 409],
  ["in_progress", 409],
  ["needs_reconciliation", 409],
  ["discord_rejected", 422],
  ["rate_limited", 429],
  ["internal", 500],
  ["discord_unavailable", 502],
  ["busy", 503],
  ["upstream_timeout", 504],
]);
function parseReply(doc: unknown, status: number, eventKey: string): AttendanceResult | null {
  if (!object(doc)) return null;
  if (doc.ok === false && object(doc.error) && !("result" in doc)) {
    const { code } = doc.error;
    if (typeof code === "string" && ERROR_STATUS.get(code) === status) return { ok: false, code };
  }
  if (status !== 200 || doc.ok !== true || "error" in doc) return null;
  const attendance = parseAttendanceResult(doc.result, eventKey);
  return attendance ? { ok: true, attendance } : null;
}

function cancelBody(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>) {
  // Do not let even a stuck cancellation extend the read deadline.
  void body.cancel().catch(() => undefined);
}

/** One keyless, signed read. No retries or redirect following. */
export function signedAttendanceReader(
  cfg: AttendanceReadConfig,
  fetcher = fetch,
): AttendanceReader {
  return async (eventKey) => {
    const unavailable = { ok: false, code: "bot_unreachable" } as const;
    const { baseUrl, keyId, secret } = cfg;
    if (!baseUrl || !keyId || !secret) return unavailable;
    try {
      const url = new URL(INTERNAL_ACTIONS_PATH, baseUrl);
      if (url.protocol !== "https:" || url.username || url.password) return unavailable;
      const body = encodeCanonicalJson({ action: "event.attendance.read", event_key: eventKey });
      const ts = Math.floor(Date.now() / 1000);
      const headers = await signInternalAction(keyId, secret, body, ts, newNonce());
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const expiresAt = performance.now() + BUDGET_MS;
      const deadline = new Promise<AttendanceResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(unavailable);
        }, BUDGET_MS);
      });
      const read = async (): Promise<AttendanceResult> => {
        const response = await fetcher(url.toString(), {
          method: "POST",
          body,
          headers: { ...headers, "Content-Type": "application/json" },
          redirect: "manual",
          signal: controller.signal,
        });
        const { body: stream, redirected, status } = response;
        if (!stream) return unavailable;
        if (controller.signal.aborted || redirected || (status >= 300 && status < 400)) {
          cancelBody(stream);
          return unavailable;
        }
        reader = stream.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
        let text = "";
        let size = 0;
        for (let reads = 1; !controller.signal.aborted; reads++) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) return unavailable;
          if (done)
            return parseReply(JSON.parse(text + decoder.decode()), status, eventKey) ?? unavailable;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) return unavailable;
          if (value.byteLength) text += decoder.decode(value, { stream: true });
          // Let the deadline run even if reads resolve without I/O.
          if (reads % 256 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        return unavailable;
      };
      try {
        const result = await Promise.race([read(), deadline]);
        return performance.now() < expiresAt ? result : unavailable;
      } finally {
        clearTimeout(timer);
        if (reader) cancelBody(reader);
        reader?.releaseLock();
      }
    } catch {
      return unavailable;
    }
  };
}
