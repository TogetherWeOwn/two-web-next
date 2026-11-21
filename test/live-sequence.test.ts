import { describe, expect, it, vi } from "vitest";
import { type LiveSnapshot, LiveSequence } from "../src/live/sequence";

const loadFixture = () => vi.fn<() => Promise<LiveSnapshot<string> | null>>();
const append = (state: string, delta: string) => state + delta;

describe("live guild sequence", () => {
  it("hydrates a cold object, applies the next delta, and ignores replays", async () => {
    const load = loadFixture().mockResolvedValue({ seq: 4, state: "snapshot" });
    const sequence = new LiveSequence(load, append);

    expect(sequence.current).toBeNull();
    expect(await sequence.ingest(4, "not applied twice")).toBe("resynced");
    expect(await sequence.ingest(5, " + next")).toBe("applied");
    expect(await sequence.ingest(5, "duplicate")).toBe("duplicate");
    expect(await sequence.ingest(3, "older replay")).toBe("duplicate");
    expect(sequence.current).toEqual({ seq: 5, state: "snapshot + next" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid sequence numbers before touching state or pulling a snapshot", async () => {
    const load = loadFixture();
    const sequence = new LiveSequence(load, append);
    for (const seq of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await sequence.ingest(seq, "invalid")).toBe("invalid");
    }
    expect(load).not.toHaveBeenCalled();
    expect(sequence.current).toBeNull();
  });

  it("invalidates state after a failed contiguous reduction and ignores known replays", async () => {
    const load = loadFixture()
      .mockResolvedValueOnce({ seq: 5, state: "old" })
      .mockRejectedValueOnce(new Error("transport offline"))
      .mockResolvedValueOnce({ seq: 5, state: "still behind" })
      .mockResolvedValueOnce({ seq: 7, state: "authoritative" });
    const sequence = new LiveSequence(load, () => {
      throw new Error("invalid transition");
    });
    expect(await sequence.synchronize()).toBe(true);

    const recovery = sequence.ingest(6, "must not expose stale state");
    expect(sequence.current).toBeNull();
    expect(await recovery).toBe("unavailable");
    expect(await sequence.ingest(5, "known replay")).toBe("duplicate");
    expect(load).toHaveBeenCalledTimes(2);
    expect(await sequence.ingest(6, "still behind")).toBe("unavailable");
    expect(sequence.current).toBeNull();
    expect(await sequence.ingest(6, "retry")).toBe("resynced");
    expect(sequence.current).toEqual({ seq: 7, state: "authoritative" });
  });

  it("coalesces overlapping pulls and requires coverage of the newest observed gap", async () => {
    let resolveSnapshot!: (snapshot: LiveSnapshot<string>) => void;
    const pending = new Promise<LiveSnapshot<string>>((resolve) => {
      resolveSnapshot = resolve;
    });
    const load = loadFixture().mockReturnValueOnce(pending).mockResolvedValue(null);
    const sequence = new LiveSequence(load, append);

    const subscription = sequence.synchronize();
    const earlier = sequence.ingest(5, "earlier");
    const later = sequence.ingest(8, "later");
    resolveSnapshot({ seq: 5, state: "already out of date" });
    expect(await Promise.all([subscription, earlier, later])).toEqual([
      false,
      "unavailable",
      "unavailable",
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(sequence.current).toBeNull();
    expect(await sequence.synchronize()).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("allows an empty guild baseline at zero and reuses a valid snapshot", async () => {
    const load = loadFixture().mockResolvedValue({ seq: 0, state: "" });
    const sequence = new LiveSequence(load, append);
    expect(await sequence.synchronize()).toBe(true);
    expect(await sequence.synchronize()).toBe(true);
    expect(await sequence.ingest(1, "first")).toBe("applied");
    expect(sequence.current).toEqual({ seq: 1, state: "first" });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
