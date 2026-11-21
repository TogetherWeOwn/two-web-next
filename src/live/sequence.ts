export type LiveSnapshot<State> = Readonly<{ seq: number; state: State }>;
type IngestResult = "applied" | "duplicate" | "invalid" | "resynced" | "unavailable";

/** One guild's in-memory cursor. The caller validates and authenticates both
 * inputs. The reducer must return a new state and the loader must be bounded. */
export class LiveSequence<State, Delta> {
  #current: LiveSnapshot<State> | null = null;
  #minimum = 0;
  #recovering: Promise<boolean> | null = null;

  constructor(
    private readonly load: () => Promise<LiveSnapshot<State> | null>,
    private readonly reduce: (state: State, delta: Delta) => State,
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
    const current = this.#current;
    if (current && seq <= current.seq) return "duplicate";
    if (current && seq === current.seq + 1) {
      this.#current = { seq, state: this.reduce(current.state, delta) };
      return "applied";
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
