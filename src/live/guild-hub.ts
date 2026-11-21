import { HUB_INGEST_URL, liveIngressConfig } from "./ingress";
import { encodeLiveProjection } from "./projection";
import { LiveSequence, type LiveWatermarks } from "./sequence";
import { HUB_SOCKET_URL, type LiveSocketEnv } from "./socket-route";
import { LiveSockets } from "./sockets";
import { reduceLiveState } from "./state";
import { signedLiveSnapshot } from "./transport";
import { decodeLiveDelta, type LiveDelta, liveId, type LiveState, snapshotTopics } from "./wire";

const WATERMARKS = "live-watermarks-v1";
const SOCKET_PULL_AFTER = "live-socket-pull-after-v1";
const SOCKET_RECOVERY_INTERVAL_MS = 5_000;
const PUBLIC_VOICE_PAGE = "public-voice";

function publicVoiceRooms(raw = ""): ReadonlySet<string> | null {
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
  // Only a browser command can activate the public lease. The raw guild may
  // recover independently, including on a restricted-only wake.
  #publicUntil = 0;
  #pullingPublic = false;

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
      if (!this.#sequence || this.env.DISCORD_LIVE_SOCKET_ENABLED !== "true") {
        return new Response(null, { status: 503 });
      }
      return this.#sockets.accept(request);
    }
    if (request.method !== "POST" || request.url !== HUB_INGEST_URL) {
      return new Response(null, { status: 404 });
    }
    if (!this.#sequence || !this.#guildId) return new Response(null, { status: 503 });
    // Only the Worker binding makes this request, from capped and verified bytes.
    const delta = decodeLiveDelta(await request.arrayBuffer(), this.#guildId);
    if (!delta) return new Response(null, { status: 400 });
    const active = this.#publicUntil > Date.now();
    const ingested = this.#sequence.ingest(delta.seq, delta);
    // A warm gap could hide a permission revocation; invalidate before the
    // pull yields. A cold producer wake only restores raw guild state.
    if (active && !this.#sequence.current) {
      this.#publicUntil = 0;
      this.#sockets.invalidate();
    }
    const outcome = await ingested;
    if (active && outcome === "applied") this.ctx.waitUntil(this.#sockets.publish());
    return new Response(null, {
      status: outcome === "unavailable" ? 409 : outcome === "invalid" ? 400 : 204,
    });
  }

  #publicVoice(): { value: string; until: number } | null {
    const current = this.#sequence?.current;
    const guildId = this.#guildId;
    const until = this.#publicUntil;
    const now = Date.now();
    if (!guildId || !current || until <= now || !this.#publicRooms) return null;
    const value = encodeLiveProjection(
      {
        state: current.state,
        guildId,
        pageId: PUBLIC_VOICE_PAGE,
        sourceUntil: until,
        viewer: { kind: "public" },
        page: {
          guildId,
          pageId: PUBLIC_VOICE_PAGE,
          viewerId: null,
          validUntil: until,
          publicRoomIds: this.#publicRooms,
        },
        now,
      },
      "voice",
    );
    return value === null ? null : { value, until };
  }

  async #refreshPublic(): Promise<boolean> {
    if (!this.#sequence || !this.#publicRooms || this.#pullingPublic) return false;
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    if (now < (kv.get<number>(SOCKET_PULL_AFTER) ?? 0)) return false;
    // Producer activity must not reset the browser pull budget on re-entry.
    kv.put(SOCKET_PULL_AFTER, now + SOCKET_RECOVERY_INTERVAL_MS);
    this.#pullingPublic = true;
    try {
      const snapshot = await this.#sequence.refresh();
      if (!snapshot?.validUntil) return false;
      await this.#sockets.scheduleSource(snapshot.validUntil);
      // Do not bless a replacement from producer recovery during the await.
      if (snapshot !== this.#sequence.current) return false;
      this.#publicUntil = snapshot.validUntil;
      this.ctx.waitUntil(this.#sockets.publish());
      return true;
    } finally {
      this.#pullingPublic = false;
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.#sequence) return socket.close(1008);
    await this.#sockets.message(socket, message, () => this.#refreshPublic());
  }

  webSocketClose(socket: WebSocket): void {
    if (socket.readyState === WebSocket.CLOSING) socket.close(1000);
  }

  webSocketError(socket: WebSocket): void {
    if (socket.readyState === WebSocket.OPEN) socket.close(1011);
  }

  alarm(): Promise<void> {
    if (this.#publicUntil <= Date.now()) this.#publicUntil = 0;
    return this.#sockets.expire(this.#publicUntil);
  }
}
