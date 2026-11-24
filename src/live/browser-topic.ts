import { createLiveTopic, type TopicFrame } from "./client-topic";

type PublicVoiceCount = { count: number | null };

function parseCount(value: unknown): PublicVoiceCount {
  if (value && typeof value === "object" && Object.keys(value).length === 1 && "count" in value) {
    const { count } = value;
    if (count === null) return { count };
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 5) return { count };
  }
  throw new Error("Invalid public voice count");
}

function decode(raw: unknown): TopicFrame<PublicVoiceCount> {
  const invalid = () => new Error("Invalid public voice frame");
  if (typeof raw !== "string" || raw.length > 128) throw invalid();
  const msg = JSON.parse(raw) as Record<string, unknown> | null;
  if (msg?.v !== 1 || msg.topic !== "voice") throw invalid();
  const { type, seq, value } = msg;
  const fields = Object.keys(msg).length;
  if (type === "unavailable" && fields === 3) return { kind: type };
  if ((type !== "snapshot" && type !== "patch") || fields !== 5 || value === undefined)
    throw invalid();
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || seq > 1024)
    throw invalid();
  return { kind: type, seq, value: parseCount(value) };
}

/** The caller supplies an independently authorized, projected same-origin fallback. */
export function createBrowserLiveTopic(
  initial: PublicVoiceCount | null,
  poll?: (signal: AbortSignal) => Promise<unknown>,
) {
  async function read(signal: AbortSignal) {
    const value = await poll?.(signal);
    return value === null ? null : parseCount(value);
  }
  return createLiveTopic(initial, {
    open() {
      const browser = globalThis as { location?: { origin: string } };
      const url = new URL("/api/discord-live/v1", browser.location?.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(url.href);
    },
    command: (socket, type) => socket.send(JSON.stringify({ v: 1, type, topics: ["voice"] })),
    decode,
    poll: poll && read,
  });
}
