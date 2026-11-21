import { createLiveTopic, type TopicFrame } from "../../../src/live/client-topic";

type Topic = "voice" | "channels" | "members" | "events";
const MAX_FRAME_CHARS = 1024 * 1024;

function decode<T>(raw: unknown, topic: Topic, parseValue: (value: unknown) => T): TopicFrame<T> {
  const invalid = () => new Error("Invalid realtime frame");
  if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) throw invalid();
  const msg: unknown = JSON.parse(raw);
  if (!msg || typeof msg !== "object" || !("topic" in msg) || msg.topic !== topic) throw invalid();
  if (!("v" in msg) || msg.v !== 1 || !("type" in msg)) throw invalid();
  if (msg.type === "reset" && Object.keys(msg).length === 3) return { kind: "reset" };
  if (
    (msg.type !== "snapshot" && msg.type !== "patch") ||
    Object.keys(msg).length !== 6 ||
    !("stream" in msg) ||
    typeof msg.stream !== "string" ||
    !msg.stream ||
    !("seq" in msg) ||
    typeof msg.seq !== "number" ||
    !("value" in msg)
  ) {
    throw invalid();
  }
  return { kind: msg.type, stream: msg.stream, seq: msg.seq, value: parseValue(msg.value) };
}

/** Starts no I/O in SSR. The caller supplies its own audience-safe poll and DTO validator. */
export function createBrowserLiveTopic<T>(
  topic: Topic,
  initial: T | null,
  parseValue: (value: unknown) => T,
  poll: (signal: AbortSignal) => Promise<T | null>,
) {
  return createLiveTopic(initial, {
    open() {
      const url = new URL("/api/realtime/v1/ws", window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ v: 1, type: "subscribe", topics: [topic] }));
        }
      });
      return socket;
    },
    decode: (raw) => decode(raw, topic, parseValue),
    resync: (socket) => socket.send(JSON.stringify({ v: 1, type: "resync", topic })),
    poll,
  });
}
