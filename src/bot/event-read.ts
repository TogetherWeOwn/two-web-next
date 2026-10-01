// Independent observation of the bot's mapped event, never a local receipt
// disguised as Discord evidence (legacy AgentEventService::observe).
import { encodeCanonicalJson, INTERNAL_ACTIONS_PATH, newNonce, signInternalAction } from "./signer";

export type ObservationEvent = { event_key: string; discord_event_id: string | null };
export type EventObservation = {
  event_id: string; name: string; starts_at: string; location: string | null; status: string; observed_at: string;
};
export type ReadResult = { ok: true; event: EventObservation } | { ok: false; code: string };
export type EventReader = (eventKey: string) => Promise<ReadResult>;
export type Observation = EventObservation | { unavailable: "verification_unavailable"; reason: string };

export async function observeDiscordEvent(event: ObservationEvent, read?: EventReader): Promise<Observation> {
  const unavailable = (reason: string): Observation => ({ unavailable: "verification_unavailable", reason });
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
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** Uses the existing byte-parity signer. No direct Discord reads, retries,
 * redirect-following or alternate credentials; malformed replies fail closed. */
export function signedEventReader(cfg: EventReadConfig, fetcher: typeof fetch = fetch): EventReader {
  return async (eventKey) => {
    const unreachable: ReadResult = { ok: false, code: "bot_unreachable" };
    if (!cfg.baseUrl || !cfg.keyId || !cfg.secret) return unreachable;
    try {
      const url = new URL(INTERNAL_ACTIONS_PATH, cfg.baseUrl);
      if (url.protocol !== "https:" || url.username || url.password) return unreachable;
      const body = encodeCanonicalJson({ action: "event.read", event_key: eventKey });
      const headers = await signInternalAction(cfg.keyId, cfg.secret, body, Math.floor(Date.now() / 1000), newNonce());
      const response = await fetcher(url.toString(), {
        method: "POST", body, redirect: "error", signal: AbortSignal.timeout(2500),
        headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      });
      const doc: unknown = await response.json();
      if (!object(doc) || !("ok" in doc)) return unreachable;
      if (!response.ok || doc.ok !== true) {
        // Return only the typed code, never a bot message/body/credential.
        return object(doc.error) && typeof doc.error.code === "string" && /^[a-z0-9_:-]{1,64}$/.test(doc.error.code)
          ? { ok: false, code: doc.error.code } : unreachable;
      }
      const result = doc.result;
      if (!object(result) || !["event_id", "name", "starts_at", "status", "observed_at"].every((key) => scalar(result[key]))
        || (result.location !== undefined && result.location !== null && !scalar(result.location))) return unreachable;
      return { ok: true, event: {
        event_id: String(result.event_id), name: String(result.name), starts_at: String(result.starts_at),
        status: String(result.status), observed_at: String(result.observed_at),
        location: result.location === undefined || result.location === null ? null : String(result.location),
      } };
    } catch {
      return unreachable;
    }
  };
}
