import { HUB_INGEST_URL, liveIngressConfig } from "./ingress";
import { encodeLiveProjection } from "./projection";
import { LiveSequence, type LiveSnapshot, type LiveWatermarks } from "./sequence";
import { HUB_SOCKET_URL, type LiveSocketEnv } from "./socket-route";
import { LiveSockets } from "./sockets";
import { reduceLiveState } from "./state";
import { signedLiveSnapshot } from "./transport";
import { decodeLiveDelta, type LiveDelta, liveId, type LiveState, snapshotTopics } from "./wire";

const WATERMARKS = "live-watermarks-v1";
const SOCKET_RECOVERY_INTERVAL_MS = 5_000;
const PUBLIC_VOICE_PAGE = "public-voice";

export function publicVoiceRooms(raw = ""): ReadonlySet<string> | null {
  if (!raw || raw.length > 2_099) return null;
  const rooms = raw.split(",");
  const unique = new Set(rooms);
  return rooms.length <= 100 &&
    unique.size === rooms.length &&
    rooms.every((id) => liveId.safeParse(id).success)
    ? unique
    : null;
}

/** Binding-only Durable Object; durable storage never holds guild payloads. */
export class LiveGuildHub {
  readonly #guildId?: string;
  readonly #sequence?: LiveSequence<LiveState, LiveDelta>;
  readonly #sockets: LiveSockets;
  readonly #publicRooms: ReadonlySet<string> | null;
  #leased: LiveSnapshot<LiveState> | null = null;
  #sourceUntil = 0;
  #nextSocketPull = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: LiveSocketEnv,
    fetchSnapshot: typeof fetch = fetch,
  ) {
    this.#publicRooms =
      env.DISCORD_LIVE_SOCKET_ENABLED === "true"
        ? publicVoiceRooms(env.DISCORD_LIVE_PUBLIC_VOICE_ROOM_IDS)
        : null;
    this.#sockets = new LiveSockets(ctx, env, () => this.#publicVoice());
    // Guild state and the last emitted value are both in memory only.
    this.#sockets.invalidate();
    const config = liveIngressConfig(env);
    if (!config) return;
    this.#guildId = config.guildId;
    const kv = ctx.storage.kv; // Synchronous SQLite KV and the DO output gate order publication.
    const initial = kv.get<LiveWatermarks>(WATERMARKS) ?? { applied: 0, minimum: 0 };
    if (
      !Number.isSafeInteger(initial.applied) ||
      !Number.isSafeInteger(initial.minimum) ||
      initial.applied < 0 ||
      initial.minimum < initial.applied
    )
      throw new Error("Invalid live watermarks");
    const load = signedLiveSnapshot(
      config.snapshot,
      (topics) => snapshotTopics(topics, config.guildId),
      fetchSnapshot,
    );
    this.#sequence = new LiveSequence(load, reduceLiveState, {
      initial,
      write: (watermarks) => kv.put(WATERMARKS, watermarks),
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.url === HUB_SOCKET_URL) {
      return this.#sequence && this.env.DISCORD_LIVE_SOCKET_ENABLED === "true"
        ? this.#sockets.accept(request)
        : new Response(null, { status: 503 });
    }
    if (request.method !== "POST" || request.url !== HUB_INGEST_URL) {
      return new Response(null, { status: 404 });
    }
    if (!this.#sequence || !this.#guildId) return new Response(null, { status: 503 });
    // Only the Worker binding makes this request, from capped and verified bytes.
    const delta = decodeLiveDelta(await request.arrayBuffer(), this.#guildId);
    if (!delta) return new Response(null, { status: 400 });
    this.#expireSource();
    const ingested = this.#sequence.ingest(delta.seq, delta);
    // ingest() clears a gap synchronously, before its signed pull can resolve.
    if (this.#leased && !this.#sequence.current) {
      this.#leased = null;
      this.#sourceUntil = 0;
      this.#sockets.invalidate();
    }
    const armed = this.#leaseCurrent();
    const outcome = await ingested;
    const newlyArmed = await armed;
    if (newlyArmed || outcome === "applied" || outcome === "resynced") await this.#publish();
    return new Response(null, {
      status: outcome === "unavailable" ? 409 : outcome === "invalid" ? 400 : 204,
    });
  }

  #expireSource(): void {
    if (!this.#leased || this.#sourceUntil > Date.now()) return;
    this.#sequence?.expire();
    this.#leased = null;
    this.#sourceUntil = 0;
    this.#sockets.invalidate();
  }

  async #leaseCurrent(): Promise<boolean> {
    const current = this.#sequence?.current;
    if (!this.#publicRooms || current?.validUntil === undefined || current === this.#leased)
      return false;
    const newlyArmed = current.validUntil !== this.#sourceUntil;
    if (newlyArmed) {
      await this.#sockets.scheduleExpiry(current.validUntil);
      // The source may expire or be replaced while storage is pending.
      if (current !== this.#sequence?.current || current === this.#leased) return false;
      this.#sourceUntil = current.validUntil;
    }
    this.#leased = current;
    return newlyArmed;
  }

  async #publish(): Promise<void> {
    await this.#leaseCurrent();
    if (this.#publicRooms) this.ctx.waitUntil(this.#sockets.publish());
  }

  #publicVoice(): string | null {
    const current = this.#sequence?.current;
    const guildId = this.#guildId;
    if (!guildId || !current || current !== this.#leased || !this.#publicRooms) return null;
    return encodeLiveProjection(
      {
        state: current.state,
        guildId,
        pageId: PUBLIC_VOICE_PAGE,
        sourceUntil: this.#sourceUntil,
        viewer: { kind: "public" },
        page: {
          guildId,
          pageId: PUBLIC_VOICE_PAGE,
          viewerId: null,
          validUntil: this.#sourceUntil,
          publicRoomIds: this.#publicRooms,
        },
        now: Date.now(),
      },
      "voice",
    );
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.#sequence) return socket.close(1008);
    this.#expireSource();
    if (!(await this.#sockets.message(socket, message))) return;
    const now = Date.now();
    if (!this.#publicRooms || this.#sequence.current || now < this.#nextSocketPull) return;
    this.#nextSocketPull = now + SOCKET_RECOVERY_INTERVAL_MS;
    if (await this.#sequence.synchronize()) await this.#publish();
  }

  webSocketClose(socket: WebSocket): void {
    if (socket.readyState === WebSocket.CLOSING) socket.close(1000);
  }

  webSocketError(socket: WebSocket): void {
    if (socket.readyState === WebSocket.OPEN) socket.close(1011);
  }

  alarm(): Promise<void> {
    this.#expireSource();
    return this.#sockets.expire(this.#leased ? this.#sourceUntil : Infinity);
  }
}
