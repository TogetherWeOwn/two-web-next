// Independent observation of the bot's mapped event, never a local receipt
// disguised as Discord evidence (legacy AgentEventService::observe).
import { encodeCanonicalJson, INTERNAL_ACTIONS_PATH, newNonce, signInternalAction } from "./signer";

export type ObservationEvent = { event_key: string; discord_event_id: string | null };
export type EventObservation = {
  event_id: string;
  name: string;
  starts_at: string;
  location: string | null;
  status: string;
  observed_at: string;
};
export type ReadResult = { ok: true; event: EventObservation } | { ok: false; code: string };
export type EventReader = (eventKey: string) => Promise<ReadResult>;
export type Observation =
  | EventObservation
  | { unavailable: "verification_unavailable"; reason: string };

export async function observeDiscordEvent(
  event: ObservationEvent,
  read?: EventReader,
): Promise<Observation> {
  const unavailable = (reason: string): Observation => ({
    unavailable: "verification_unavailable",
    reason,
  });
  if (event.discord_event_id === null) return unavailable("never_mirrored");
  if (!read) return unavailable("bot_unreachable");
  try {
    const answer = await read(event.event_key);
    if (!answer.ok) return unavailable(answer.code);
    if (answer.event.event_id !== event.discord_event_id) return unavailable("mirror_mismatch");
    return answer.event;
  } catch {
    return unavailable("bot_unreachable");
  }
}

export type EventReadConfig = { baseUrl?: string; keyId?: string; secret?: string };
// Observation budget: one attempt, fetch AND body reading, owned settlement
// even when the transport ignores abort (precedent: src/discord-http.ts).
const EVENT_READ_BUDGET_MS = 2_500;
/** Maximum buffered response body before parsing (256 KiB provider-buffer
 * convention, src/discord-http.ts:9). Cumulative across chunks; exactly the
 * ceiling is accepted, one byte over is refused. */
const EVENT_READ_MAX_RESPONSE_BYTES = 262_144;
class EventReadTimeoutError extends Error {
  constructor() {
    super("Bot event.read observation timed out");
    this.name = "TimeoutError";
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** Uses the existing byte-parity signer. No direct Discord reads, retries,
 * redirect-following or alternate credentials; malformed replies fail closed.
 * Owns the 2.5 s deadline across fetch and body reading even when the
 * transport ignores abort, caps buffered bytes before parsing, attempts
 * cancellation without awaiting it, and never lets late outcomes change the
 * settled answer. */
export function signedEventReader(
  cfg: EventReadConfig,
  fetcher: typeof fetch = fetch,
): EventReader {
  return async (eventKey) => {
    const unreachable: ReadResult = { ok: false, code: "bot_unreachable" };
    if (!cfg.baseUrl || !cfg.keyId || !cfg.secret) return unreachable;
    try {
      const url = new URL(INTERNAL_ACTIONS_PATH, cfg.baseUrl);
      if (url.protocol !== "https:" || url.username || url.password) return unreachable;
      const body = encodeCanonicalJson({ action: "event.read", event_key: eventKey });
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
          reject(new EventReadTimeoutError());
        }, EVENT_READ_BUDGET_MS);
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
      const parseDoc = (doc: unknown, statusOk: boolean): ReadResult => {
        if (!object(doc) || !("ok" in doc)) return unreachable;
        if (!statusOk || doc.ok !== true) {
          // Return only the typed code, never a bot message/body/credential.
          return object(doc.error) &&
            typeof doc.error.code === "string" &&
            /^[a-z0-9_:-]{1,64}$/.test(doc.error.code)
            ? { ok: false, code: doc.error.code }
            : unreachable;
        }
        const result = doc.result;
        if (
          !object(result) ||
          !["event_id", "name", "starts_at", "status", "observed_at"].every((key) =>
            scalar(result[key]),
          ) ||
          (result.location !== undefined && result.location !== null && !scalar(result.location))
        )
          return unreachable;
        return {
          ok: true,
          event: {
            event_id: String(result.event_id),
            name: String(result.name),
            starts_at: String(result.starts_at),
            status: String(result.status),
            observed_at: String(result.observed_at),
            location:
              result.location === undefined || result.location === null
                ? null
                : String(result.location),
          },
        };
      };
      const operation: Promise<ReadResult> = (async () => {
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
          throw new EventReadTimeoutError();
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
          if (controller.signal.aborted) throw new EventReadTimeoutError();
          if (new TextEncoder().encode(text).byteLength > EVENT_READ_MAX_RESPONSE_BYTES)
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
            if (controller.signal.aborted) throw new EventReadTimeoutError();
            size += value.byteLength;
            // Cap buffered bytes before parsing: overflow fails closed without
            // waiting for close or the deadline.
            if (size > EVENT_READ_MAX_RESPONSE_BYTES) {
              cancelBody(reader);
              return unreachable;
            }
            chunks.push(value);
          }
        } catch (error) {
          if (controller.signal.aborted) throw new EventReadTimeoutError();
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
