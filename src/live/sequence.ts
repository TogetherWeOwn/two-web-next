export type LiveSnapshot<State> = Readonly<{ seq: number; state: State; validUntil?: number }>;

function fresh({ validUntil }: LiveSnapshot<unknown>): boolean {
  return validUntil === undefined || (Number.isFinite(validUntil) && validUntil > Date.now());
}
type IngestResult = "applied" | "duplicate" | "invalid" | "resynced" | "unavailable";
export type LiveWatermarks = Readonly<{ applied: number; minimum: number }>;
type Checkpoint = { initial: LiveWatermarks; write: (watermarks: LiveWatermarks) => void };

/** One guild's in-memory cursor. The caller validates and authenticates both
 * inputs. The reducer returns a new state or null when continuity cannot be
 * proven; the loader must be bounded. */
export class LiveSequence<State, Delta> {
  #current: LiveSnapshot<State> | null = null;
  #saved: LiveWatermarks;
  #minimum: number;
  #recovering: Promise<boolean> | null = null;

  constructor(
    private readonly load: () => Promise<LiveSnapshot<State> | null>,
    private readonly reduce: (state: State, delta: Delta) => State | null,
    private readonly checkpoint?: Checkpoint,
  ) {
    this.#saved = checkpoint?.initial ?? { applied: 0, minimum: 0 };
    this.#minimum = this.#saved.minimum;
  }

  #save(applied: number, minimum: number): void {
    if (applied === this.#saved.applied && minimum === this.#saved.minimum) return;
    const watermarks = { applied, minimum };
    this.checkpoint?.write(watermarks);
    this.#saved = watermarks;
  }

  #publish(snapshot: LiveSnapshot<State>): void {
    this.#save(snapshot.seq, snapshot.seq);
    this.#minimum = snapshot.seq;
    this.#current = snapshot;
  }

  get current(): LiveSnapshot<State> | null {
    return this.#current && fresh(this.#current) ? this.#current : null;
  }

  expire(): void {
    this.#current = null;
  }

  // Browser recovery reads a new observation, not a producer-triggered pull
  // or a warm raw cursor. Both paths must cover the same latest watermark.
  async refresh(): Promise<LiveSnapshot<State> | null> {
    return this.#install(await this.#load());
  }

  #load(): Promise<LiveSnapshot<State> | null> {
    return Promise.resolve()
      .then(() => this.load())
      .catch(() => null);
  }

  #install(snapshot: LiveSnapshot<State> | null): LiveSnapshot<State> | null {
    if (
      !snapshot ||
      !Number.isSafeInteger(snapshot.seq) ||
      snapshot.seq < this.#minimum ||
      !fresh(snapshot)
    ) {
      return null;
    }
    this.#publish(snapshot);
    return snapshot;
  }

  async synchronize(): Promise<boolean> {
    if (this.current) return true;
    // Commit the latest observed gap before external I/O can yield or fail.
    this.#save(this.#saved.applied, this.#minimum);
    return this.#recovering ?? this.#recover();
  }

  async ingest(seq: number, delta: Delta): Promise<IngestResult> {
    if (!Number.isSafeInteger(seq) || seq < 1) return "invalid";
    if (seq <= this.#saved.applied) return "duplicate";
    const current = this.current;
    // A missed delta might revoke access. Invalidate before reducing or checkpointing.
    this.#current = null;
    this.#minimum = Math.max(this.#minimum, seq);
    if (current && seq === current.seq + 1) {
      let next: State | null;
      try {
        next = this.reduce(current.state, delta);
      } catch {
        next = null;
      }
      if (next !== null) {
        this.#publish({ ...current, seq, state: next });
        return "applied";
      }
    }

    return (await this.synchronize()) ? "resynced" : "unavailable";
  }

  #recover(): Promise<boolean> {
    this.#recovering = Promise.resolve().then(async () => {
      try {
        const snapshot = await this.#load();
        // An independent refresh may already have covered the latest gap.
        return this.current !== null || this.#install(snapshot) !== null;
      } finally {
        this.#recovering = null;
      }
    });
    return this.#recovering;
  }
}
