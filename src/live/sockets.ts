import { z } from "zod";
import {
  type LiveSocketEnv,
  readLiveSocketSession,
  SESSION_REF,
  SESSION_REF_PATTERN,
  SESSION_UNTIL,
} from "./socket-route";

const MAX_SOCKETS = 64;
const MAX_MESSAGE_BYTES = 512;
const LEASE_MS = 5 * 60_000;
const RESYNC_INTERVAL_MS = 2_000;
const topic = z.enum(["voice", "channels", "members", "events"]);
const topics = z
  .array(topic)
  .min(1)
  .max(4)
  .refine((list) => new Set(list).size === list.length);
const command = z.strictObject({ v: z.literal(1), type: z.enum(["subscribe", "resync"]), topics });
const attachment = z.strictObject({
  v: z.literal(1),
  ref: z.string().regex(SESSION_REF_PATTERN).nullable(),
  until: z.number().int().positive(),
  topics: topics.nullable(),
  nextResync: z.number().int().nonnegative(),
});

function decode(message: string | ArrayBuffer) {
  if (
    typeof message !== "string" ||
    message.length > MAX_MESSAGE_BYTES ||
    new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES
  )
    return null;
  try {
    return command.safeParse(JSON.parse(message)).data ?? null;
  } catch {
    return null;
  }
}

export class LiveSockets {
  readonly #sending = new WeakSet<WebSocket>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: LiveSocketEnv,
  ) {}

  async accept(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 400 });
    }
    const ref = request.headers.get(SESSION_REF);
    const expiry = request.headers.get(SESSION_UNTIL);
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const until = Math.min(now + LEASE_MS, expiry === null ? Infinity : Number(expiry));
      const meta = attachment.safeParse({ v: 1, ref, until, topics: null, nextResync: 0 });
      if (!meta.success || (ref === null) !== (expiry === null) || until <= now) {
        return new Response(null, { status: 400 });
      }
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS)
        return new Response(null, { status: 429 });
      const nextAlarm = await this.ctx.storage.getAlarm();
      if (nextAlarm === null || until < nextAlarm) await this.ctx.storage.setAlarm(until);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(meta.data);
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  async message(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (this.env.DISCORD_LIVE_SOCKET_ENABLED !== "true") return socket.close(1008);
    const meta = attachment.safeParse(socket.deserializeAttachment()).data;
    const incoming = decode(message);
    const now = Date.now();
    if (!meta || !incoming || meta.until <= now || this.#sending.has(socket)) {
      return socket.close(1008);
    }
    if (incoming.type === "subscribe") {
      if (meta.topics !== null) return socket.close(1008);
      meta.topics = incoming.topics;
    } else if (
      !meta.topics ||
      !incoming.topics.every((item) => meta.topics?.includes(item)) ||
      now < meta.nextResync
    ) {
      return socket.close(1008);
    }

    this.#sending.add(socket);
    try {
      if (meta.ref !== null) {
        const row = await readLiveSocketSession(this.env, meta.ref);
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!row || !Number.isFinite(row.validUntil) || row.validUntil <= Date.now()) {
          return socket.close(1008);
        }
      }
      if (meta.until <= Date.now()) return socket.close(1008);
      meta.nextResync = Date.now() + RESYNC_INTERVAL_MS;
      socket.serializeAttachment(meta);
      // No policy adapter is wired in this slice. Never infer payload access from admission.
      for (const item of incoming.topics) {
        socket.send(JSON.stringify({ v: 1, type: "unavailable", topic: item }));
      }
    } catch {
      if (socket.readyState === WebSocket.OPEN) socket.close(1011);
    } finally {
      this.#sending.delete(socket);
    }
  }

  async expire(): Promise<void> {
    const now = Date.now();
    let next = Infinity;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const meta = attachment.safeParse(socket.deserializeAttachment()).data;
      if (!meta || meta.until <= now) socket.close(1008);
      else next = Math.min(next, meta.until);
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }
}
