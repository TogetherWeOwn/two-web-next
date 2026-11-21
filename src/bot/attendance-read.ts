import { diagnosticCode } from "./diagnostic-code";
import { encodeCanonicalJson, INTERNAL_ACTIONS_PATH, newNonce, signInternalAction } from "./signer";

export type AttendanceMember = {
  discord_id: string;
  minutes: number;
  sessions: number;
  first_joined_at: string | null;
};
export type AttendanceRoom = { channel_id: string; name_at_close: string };
export type AttendancePayload = {
  v: 1;
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

const BUDGET_MS = 2_500;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ROOMS = 100;
const MAX_MEMBERS = 500;
const MAX_ROOM_NAME = 100;
const SNOWFLAKE = /^\d{1,20}$/;
const ISO_ZULU = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const UNREACHABLE = { ok: false, code: "bot_unreachable" } as const;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const snowflake = (value: unknown): value is string =>
  typeof value === "string" && SNOWFLAKE.test(value);
const integer = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_ZULU.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace("Z", ".000Z");
}

/** Reject malformed known fields; project only v1 fields from additive replies. */
export function parseAttendanceResult(result: unknown, eventKey: string): AttendancePayload | null {
  if (!object(result) || result.v !== 1 || result.event_key !== eventKey) return null;
  const { window, threshold_minutes, peak_concurrent, final } = result;
  if (
    !object(window) ||
    !timestamp(window.starts_at) ||
    !timestamp(window.ends_at) ||
    window.ends_at <= window.starts_at ||
    !integer(threshold_minutes, 1) ||
    !integer(peak_concurrent, 0) ||
    typeof final !== "boolean" ||
    !Array.isArray(result.rooms) ||
    result.rooms.length > MAX_ROOMS ||
    !Array.isArray(result.members) ||
    result.members.length > MAX_MEMBERS
  )
    return null;

  const rooms: AttendanceRoom[] = [];
  for (const room of result.rooms) {
    if (
      !object(room) ||
      !snowflake(room.channel_id) ||
      typeof room.name_at_close !== "string" ||
      room.name_at_close.length === 0 ||
      room.name_at_close.length > MAX_ROOM_NAME
    )
      return null;
    rooms.push({ channel_id: room.channel_id, name_at_close: room.name_at_close });
  }
  const members: AttendanceMember[] = [];
  for (const member of result.members) {
    if (
      !object(member) ||
      !snowflake(member.discord_id) ||
      !integer(member.minutes, 0) ||
      !integer(member.sessions, 1) ||
      (member.first_joined_at != null && !timestamp(member.first_joined_at))
    )
      return null;
    members.push({
      discord_id: member.discord_id,
      minutes: member.minutes,
      sessions: member.sessions,
      first_joined_at: member.first_joined_at ?? null,
    });
  }
  return {
    v: 1,
    event_key: eventKey,
    window: { starts_at: window.starts_at, ends_at: window.ends_at },
    threshold_minutes,
    peak_concurrent,
    rooms,
    members,
    final,
  };
}

function parseReply(doc: unknown, statusOk: boolean, eventKey: string): AttendanceResult {
  if (!object(doc)) return UNREACHABLE;
  if (doc.ok === false && object(doc.error)) {
    // A syntactically valid but unknown code could still contain private data.
    const code = doc.error.code === "not_found" ? "not_found" : diagnosticCode(doc.error.code);
    return code === "unknown" ? UNREACHABLE : { ok: false, code };
  }
  if (!statusOk || doc.ok !== true) return UNREACHABLE;
  const attendance = parseAttendanceResult(doc.result, eventKey);
  return attendance ? { ok: true, attendance } : UNREACHABLE;
}

function cancelBody(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>) {
  // Do not let even a stuck cancellation extend the read deadline.
  void body.cancel().catch(() => undefined);
}

/** One keyless, signed read. No callers, retries or redirect following. */
export function signedAttendanceReader(
  cfg: AttendanceReadConfig,
  fetcher: typeof fetch = fetch,
): AttendanceReader {
  return async (eventKey) => {
    if (!cfg.baseUrl || !cfg.keyId || !cfg.secret) return UNREACHABLE;
    try {
      const url = new URL(INTERNAL_ACTIONS_PATH, cfg.baseUrl);
      if (url.protocol !== "https:" || url.username || url.password) return UNREACHABLE;
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
      let drained = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<AttendanceResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(UNREACHABLE);
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
        if (!response.body) return UNREACHABLE;
        if (controller.signal.aborted || (response.status >= 300 && response.status < 400)) {
          cancelBody(response.body);
          return UNREACHABLE;
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
        const parts: string[] = [];
        let size = 0;
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) return UNREACHABLE;
          if (done) {
            drained = true;
            parts.push(decoder.decode());
            return parseReply(JSON.parse(parts.join("")), response.ok, eventKey);
          }
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) return UNREACHABLE;
          if (value.byteLength > 0) parts.push(decoder.decode(value, { stream: true }));
        }
        return UNREACHABLE;
      };
      try {
        // Settlement is independent of whether fetch/body honor abort.
        return await Promise.race([read(), deadline]);
      } finally {
        clearTimeout(timer);
        if (reader) {
          if (!drained) cancelBody(reader);
          reader.releaseLock();
        }
      }
    } catch {
      return UNREACHABLE;
    }
  };
}
