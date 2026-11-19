// This rendezvous is used only by the loopback Kit browser fixture.
export function createDiscordReadRendezvous({
  now = () => performance.now(),
  pause = () => new Promise((resolve) => setTimeout(resolve, 10)),
} = {}) {
  const pendingReads = new Map();
  const timeout = () => new Error("Timed out waiting for the other Kit Discord read");

  return async (pair, failed) => {
    const arrival = now();
    const first = pendingReads.get(pair);
    if (first) {
      if (arrival >= first.deadline) throw timeout();
      if (first.paired || first.failed === failed) {
        throw new Error("Duplicate mode in Kit Discord read pair");
      }
      first.paired = true;
      return;
    }

    const pending = { deadline: arrival + 10_000, failed, paired: false };
    pendingReads.set(pair, pending);
    try {
      while (!pending.paired) {
        if (now() >= pending.deadline) throw timeout();
        // Workerd cannot share a pending I/O promise across requests.
        // Share only arrival state; wait on a timer owned by this request.
        await pause();
      }
    } finally {
      pendingReads.delete(pair);
    }
  };
}
