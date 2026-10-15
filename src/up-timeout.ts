/** A hung ledger must not hang the probe: past this the read reports `unknown`. */
export const QUEUE_READ_TIMEOUT_MS = 3000;

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error("queue depth read timed out")), ms);
  });
  p.catch(() => {});
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
