import { HUB_INGEST_URL, type LiveIngressEnv, liveIngressConfig } from "./ingress";
import { LiveSequence, type LiveWatermarks } from "./sequence";
import { reduceLiveState } from "./state";
import { signedLiveSnapshot } from "./transport";
import { decodeLiveDelta, type LiveDelta, type LiveState, snapshotTopics } from "./wire";

const WATERMARKS = "live-watermarks-v1";

/** Binding-only Durable Object; it never serves the browser or stores payloads. */
export class LiveGuildHub {
  readonly #guildId?: string;
  readonly #sequence?: LiveSequence<LiveState, LiveDelta>;

  constructor(ctx: DurableObjectState, env: LiveIngressEnv) {
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
}
