import { HUB_INGEST_URL, liveIngressConfig } from "./ingress";
import { LiveSequence, type LiveWatermarks } from "./sequence";
import { HUB_SOCKET_URL, type LiveSocketEnv } from "./socket-route";
import { LiveSockets } from "./sockets";
import { reduceLiveState } from "./state";
import { signedLiveSnapshot } from "./transport";
import { decodeLiveDelta, type LiveDelta, type LiveState, snapshotTopics } from "./wire";

const WATERMARKS = "live-watermarks-v1";

/** Binding-only Durable Object; durable storage never holds guild payloads. */
export class LiveGuildHub {
  readonly #guildId?: string;
  readonly #sequence?: LiveSequence<LiveState, LiveDelta>;
  readonly #sockets: LiveSockets;

  constructor(
    ctx: DurableObjectState,
    private readonly env: LiveSocketEnv,
  ) {
    this.#sockets = new LiveSockets(ctx, env);
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
    const load = signedLiveSnapshot(config.snapshot, (topics) =>
      snapshotTopics(topics, config.guildId),
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
    const outcome = await this.#sequence.ingest(delta.seq, delta);
    return new Response(null, {
      status: outcome === "unavailable" ? 409 : outcome === "invalid" ? 400 : 204,
    });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> | void {
    if (!this.#sequence) return socket.close(1008);
    return this.#sockets.message(socket, message);
  }

  webSocketClose(socket: WebSocket): void {
    if (socket.readyState === WebSocket.CLOSING) socket.close(1000);
  }

  webSocketError(socket: WebSocket): void {
    if (socket.readyState === WebSocket.OPEN) socket.close(1011);
  }

  alarm(): Promise<void> {
    return this.#sockets.expire();
  }
}
