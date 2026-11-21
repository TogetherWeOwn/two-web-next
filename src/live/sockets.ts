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
  voiceUntil: z.number().int().nonnegative(),
  // Comparison only: this is the public count, never a source for a send.
  voicePrevious: z
    .string()
    .regex(/^\{"count":(?:null|[1-9][0-9]{0,5})\}$/)
    .nullable(),
});

type SocketMeta = z.infer<typeof attachment>;

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
  readonly #publishing = new WeakSet<WebSocket>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: LiveSocketEnv,
    private readonly projectVoice: () => { value: string; until: number } | null,
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
        voiceUntil: 0,
        voicePrevious: null,
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

  async message(
    socket: WebSocket,
    message: string | ArrayBuffer,
    refreshVoice: () => Promise<boolean>,
  ): Promise<boolean> {
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
      const current = attachment.parse(socket.deserializeAttachment());
      current.topics ??= incoming.topics;
      current.nextResync = Date.now() + RESYNC_INTERVAL_MS;
      socket.serializeAttachment(current);
      for (const item of incoming.topics) {
        if (item !== "voice") this.#unavailable(socket, item);
      }
      if (!incoming.topics.includes("voice")) return false;
      if (incoming.type === "subscribe" && this.#voice(socket, current, true)) return true;

      // An explicit resync must not take a raw-cache shortcut after producer activity.
      const hadVoice = current.voiceUntil > Date.now();
      if (!hadVoice) this.#clearVoice(socket, current);
      const refreshed = await refreshVoice();
      if (!(await this.#authorize(socket, current))) return false;
      const latest = attachment.parse(socket.deserializeAttachment());
      if (refreshed && this.#voice(socket, latest, true)) return true;
      if (hadVoice && latest.voiceUntil) this.#clearVoice(socket, latest);
      return false;
    } catch {
      return this.#close(socket, 1011);
    } finally {
      this.#sending.delete(socket);
    }
  }

  async #authorize(socket: WebSocket, meta: SocketMeta): Promise<boolean> {
    if (meta.ref !== null) {
      const row = await readLiveSocketSession(this.env, meta.ref);
      if (!row || !Number.isFinite(row.validUntil) || row.validUntil <= Date.now()) {
        return this.#close(socket, 1008);
      }
    }
    if (meta.until <= Date.now()) return this.#close(socket, 1008);
    return socket.readyState === WebSocket.OPEN;
  }

  #close(socket: WebSocket, code: number): false {
    if (socket.readyState === WebSocket.OPEN) socket.close(code);
    return false;
  }

  #unavailable(socket: WebSocket, topic: string): void {
    socket.send(JSON.stringify({ v: 1, type: "unavailable", topic }));
  }

  #voice(socket: WebSocket, meta: SocketMeta, force: boolean): boolean {
    const projection = this.projectVoice(); // Read current proof after any auth await.
    if (projection === null) return false;
    const { value, until } = projection;
    const live = meta.voiceUntil > Date.now();
    if (!force && !live) return false;
    const changed = !live || value !== meta.voicePrevious;
    if (!changed && !force) return true;
    if (changed && meta.voiceSeq >= MAX_VOICE_REVISIONS) return this.#close(socket, 1012);
    const type = force ? "snapshot" : "patch";
    if (changed) meta.voiceSeq++;
    meta.voicePrevious = value;
    // Another viewer's command cannot renew this socket's lease.
    meta.voiceUntil = force ? until : Math.min(meta.voiceUntil, until);
    socket.serializeAttachment(meta);
    socket.send(`{"v":1,"type":"${type}","topic":"voice","seq":${meta.voiceSeq},"value":${value}}`);
    return true;
  }

  #clearVoice(socket: WebSocket, meta: SocketMeta): void {
    meta.voiceUntil = 0;
    meta.voicePrevious = null;
    socket.serializeAttachment(meta);
    this.#unavailable(socket, "voice");
  }

  invalidate(): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const meta = attachment.safeParse(socket.deserializeAttachment()).data;
      if (meta?.voiceUntil) this.#withdrawVoice(socket, meta);
    }
  }

  #withdrawVoice(socket: WebSocket, meta: SocketMeta): void {
    try {
      // Do not send on a session-bearing socket without a live row read.
      if (meta.ref !== null || meta.until <= Date.now()) this.#close(socket, 1012);
      else this.#clearVoice(socket, meta);
    } catch {
      this.#close(socket, 1011);
    }
  }

  async publish(): Promise<void> {
    if (this.env.DISCORD_LIVE_SOCKET_ENABLED !== "true") return;
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const preview = this.projectVoice();
    if (preview === null) return;
    await Promise.all(
      sockets.map(async (socket) => {
        if (
          socket.readyState !== WebSocket.OPEN ||
          this.#sending.has(socket) ||
          this.#publishing.has(socket)
        )
          return;
        const meta = attachment.safeParse(socket.deserializeAttachment()).data;
        if (!meta?.voiceUntil || preview.value === meta.voicePrevious) return;
        this.#publishing.add(socket);
        try {
          if ((await this.#authorize(socket, meta)) && !this.#sending.has(socket)) {
            this.#voice(socket, attachment.parse(socket.deserializeAttachment()), false);
          }
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

  expire(sourceUntil: number): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      let next = sourceUntil > now ? sourceUntil : Infinity;
      for (const socket of this.ctx.getWebSockets()) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        const meta = attachment.safeParse(socket.deserializeAttachment()).data;
        if (!meta || meta.until <= now) {
          socket.close(1008);
          continue;
        }
        if (meta.voiceUntil && meta.voiceUntil <= now) this.#withdrawVoice(socket, meta);
        if (socket.readyState !== WebSocket.OPEN) continue;
        next = Math.min(next, meta.until, meta.voiceUntil || Infinity);
      }
      // The firing alarm has been consumed. Do not compare it to the next lease.
      if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    });
  }
}
