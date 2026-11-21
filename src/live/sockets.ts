import { z } from "zod";
import {
  type LiveSocketEnv,
  readLiveSocketSession,
  SESSION_REF,
  SESSION_REF_PATTERN,
  SESSION_UNTIL,
} from "./socket-route";
import { readTimedSocketSession } from "./socket-session";

const MAX_SOCKETS = 64;
const MAX_MESSAGE_BYTES = 512;
// Workers do not expose bufferedAmount for hibernating sockets. Bound total
// data frames per connection as well as relying on the runtime's send limit.
const MAX_VOICE_REVISIONS = 1_024;
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
  voiceSeq: z.number().int().nonnegative(),
  voiceLive: z.boolean(),
});

type SocketMeta = z.infer<typeof attachment>;

function decode(message: string | ArrayBuffer) {
  if (typeof message !== "string" || message.length > MAX_MESSAGE_BYTES) return null;
  if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) return null;
  try {
    return command.safeParse(JSON.parse(message)).data ?? null;
  } catch {
    return null;
  }
}

export class LiveSockets {
  readonly #sending = new WeakSet<WebSocket>();
  readonly #publishing = new WeakSet<WebSocket>();
  // Current public projection only. Never serialize it into an attachment.
  readonly #lastVoice = new WeakMap<WebSocket, string>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: LiveSocketEnv,
    private readonly projectVoice: () => string | null,
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
      const meta = attachment.safeParse({
        v: 1,
        ref,
        until,
        topics: null,
        nextResync: 0,
        voiceSeq: 0,
        voiceLive: false,
      });
      if (!meta.success || (ref === null) !== (expiry === null) || until <= now) {
        return new Response(null, { status: 400 });
      }
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS)
        return new Response(null, { status: 429 });
      await this.#schedule(until);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(meta.data);
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  async message(socket: WebSocket, message: string | ArrayBuffer): Promise<boolean> {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (this.env.DISCORD_LIVE_SOCKET_ENABLED !== "true") return this.#close(socket, 1008);
    const meta = attachment.safeParse(socket.deserializeAttachment()).data;
    const incoming = decode(message);
    const now = Date.now();
    if (!meta || !incoming || meta.until <= now || this.#sending.has(socket)) {
      return this.#close(socket, 1008);
    }
    if (incoming.type === "subscribe") {
      if (meta.topics !== null) return this.#close(socket, 1008);
    } else if (
      !meta.topics ||
      !incoming.topics.every((item) => meta.topics?.includes(item)) ||
      now < meta.nextResync
    ) {
      return this.#close(socket, 1008);
    }

    this.#sending.add(socket);
    try {
      if (!(await this.#authorize(socket, meta))) return false;
      // A producer event can clear the previous baseline while the row read is pending.
      const current = this.#active(socket);
      if (!current) return false;
      current.topics ??= incoming.topics;
      current.nextResync = Date.now() + RESYNC_INTERVAL_MS;
      socket.serializeAttachment(current);
      for (const item of incoming.topics) {
        if (item === "voice") this.#voice(socket, current, true);
        else this.#unavailable(socket, item);
      }
      return incoming.topics.includes("voice");
    } catch {
      return this.#close(socket, 1011);
    } finally {
      this.#sending.delete(socket);
    }
  }

  async #authorize(socket: WebSocket, meta: SocketMeta): Promise<boolean> {
    if (meta.ref === null) return true;
    const row = await readTimedSocketSession(meta.ref, (ref) =>
      readLiveSocketSession(this.env, ref),
    );
    if (!row) return this.#close(socket, 1008);
    if (row.validUntil >= meta.until) return true;
    // Shorten the hibernating lease without overwriting a concurrent update.
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = this.#active(socket);
      if (!current) return false;
      if (row.validUntil <= Date.now()) return this.#close(socket, 1008);
      if (row.validUntil < current.until) {
        current.until = row.validUntil;
        socket.serializeAttachment(current);
        await this.#schedule(current.until);
      }
      return true;
    });
  }

  #active(socket: WebSocket): SocketMeta | false {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const meta = attachment.parse(socket.deserializeAttachment());
    return meta.until <= Date.now() ? this.#close(socket, 1008) : meta;
  }

  #close(socket: WebSocket, code: number): false {
    if (socket.readyState === WebSocket.OPEN) socket.close(code);
    return false;
  }

  #unavailable(socket: WebSocket, topic: string): void {
    socket.send(JSON.stringify({ v: 1, type: "unavailable", topic }));
  }

  #voice(socket: WebSocket, meta: SocketMeta, force: boolean): void {
    const value = this.projectVoice(); // Read current source and lease after any auth await.
    if (value === null) {
      if (meta.voiceLive) this.#clearVoice(socket, meta);
      else if (force) this.#unavailable(socket, "voice");
      return;
    }
    const changed = !meta.voiceLive || value !== this.#lastVoice.get(socket);
    if (!changed && !force) return;
    if (changed && meta.voiceSeq >= MAX_VOICE_REVISIONS) {
      this.#close(socket, 1012);
      return;
    }
    const type = force || !meta.voiceLive ? "snapshot" : "patch";
    if (changed) meta.voiceSeq++;
    this.#lastVoice.set(socket, value);
    meta.voiceLive = true;
    socket.serializeAttachment(meta);
    socket.send(`{"v":1,"type":"${type}","topic":"voice","seq":${meta.voiceSeq},"value":${value}}`);
  }

  #clearVoice(socket: WebSocket, meta: SocketMeta): void {
    meta.voiceLive = false;
    this.#lastVoice.delete(socket);
    socket.serializeAttachment(meta);
    this.#unavailable(socket, "voice");
  }

  invalidate(): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const meta = attachment.safeParse(socket.deserializeAttachment()).data;
      if (!meta?.voiceLive) continue;
      try {
        // A loss of source is synchronous. Close authenticated streams without
        // a frame instead of waiting for a row read before clearing old state.
        if (meta.ref !== null || meta.until <= Date.now()) this.#close(socket, 1012);
        else this.#clearVoice(socket, meta);
      } catch {
        this.#close(socket, 1011);
      }
    }
  }

  async publish(): Promise<void> {
    if (this.env.DISCORD_LIVE_SOCKET_ENABLED !== "true") return;
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const preview = this.projectVoice();
    if (preview === null) return this.invalidate();
    await Promise.all(
      sockets.map(async (socket) => {
        if (socket.readyState !== WebSocket.OPEN || this.#publishing.has(socket)) return;
        const meta = attachment.safeParse(socket.deserializeAttachment()).data;
        if (!meta?.topics?.includes("voice") || preview === this.#lastVoice.get(socket)) return;
        this.#publishing.add(socket);
        try {
          if (!(await this.#authorize(socket, meta))) return;
          const current = this.#active(socket);
          if (current) this.#voice(socket, current, false);
        } catch {
          this.#close(socket, 1011);
        } finally {
          this.#publishing.delete(socket);
        }
      }),
    );
  }

  async #schedule(until: number): Promise<void> {
    const next = await this.ctx.storage.getAlarm();
    if (next === null || until < next) await this.ctx.storage.setAlarm(until);
  }

  scheduleSource(until: number): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.#schedule(until));
  }

  async expire(sourceUntil: number): Promise<void> {
    const now = Date.now();
    let next = sourceUntil;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const meta = attachment.safeParse(socket.deserializeAttachment()).data;
      if (!meta || meta.until <= now) socket.close(1008);
      else next = Math.min(next, meta.until);
    }
    if (Number.isFinite(next)) await this.scheduleSource(next);
  }
}
