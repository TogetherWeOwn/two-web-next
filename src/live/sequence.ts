export type LiveSnapshot<State> = Readonly<{ seq: number; state: State }>;
type IngestResult = "applied" | "duplicate" | "invalid" | "resynced" | "unavailable";

/** One guild's in-memory cursor. The caller validates and authenticates both
 * inputs. The reducer returns a new state or null when continuity cannot be
 * proven; the loader must be bounded. */
export class LiveSequence<State, Delta> {
  #current: LiveSnapshot<State> | null = null;
  #applied = 0;
  #minimum = 0;
  #recovering: Promise<boolean> | null = null;

  constructor(
    private readonly load: () => Promise<LiveSnapshot<State> | null>,
    private readonly reduce: (state: State, delta: Delta) => State | null,
  ) {}

  get current(): LiveSnapshot<State> | null {
    return this.#current;
  }

  async synchronize(): Promise<boolean> {
    if (this.#current) return true;
    return this.#recovering ?? this.#recover();
  }

  async ingest(seq: number, delta: Delta): Promise<IngestResult> {
    if (!Number.isSafeInteger(seq) || seq < 1) return "invalid";
    if (seq <= this.#applied) return "duplicate";
    const current = this.#current;
    if (current && seq === current.seq + 1) {
      try {
        const next = this.reduce(current.state, delta);
        if (next !== null) {
          this.#current = { seq, state: next };
          this.#applied = seq;
          return "applied";
        }
      } catch {
        this.#current = null;
      }
    }

    // Losing a delta can also mean losing a permission revocation. Stop
    // serving the old state immediately, even when the resync later fails.
    this.#current = null;
    this.#minimum = Math.max(this.#minimum, seq);
    return (await this.synchronize()) ? "resynced" : "unavailable";
  }

  #recover(): Promise<boolean> {
    this.#recovering = Promise.resolve().then(async () => {
      try {
        const snapshot = await this.load();
        // Check against the latest observed gap, not the gap at request time.
        if (!snapshot || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < this.#minimum) {
          return false;
        }
        this.#current = snapshot;
        this.#applied = snapshot.seq;
        return true;
      } catch {
        return false;
      } finally {
        this.#recovering = null;
      }
    });
    return this.#recovering;
  }
}
