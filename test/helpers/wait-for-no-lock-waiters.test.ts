import { describe, expect, it } from "vitest";
import { waitForNoLockWaiters } from "./wait-for-no-lock-waiters";

// Deterministic pins for the polling branches: the DB-gated sites always
// resolve on read #1, so without these a single-shot or always-true mutant
// keeps the full suite green. No DATABASE_URL gate here on purpose — a
// scripted readCount exercises retry and timeout without Postgres.
describe("waitForNoLockWaiters", () => {
  it("retries a nonzero count until zero", async () => {
    const scripted = [2, 1, 0];
    let reads = 0;
    const result = await waitForNoLockWaiters(async () => scripted[reads++]!, {
      timeoutMs: 800,
      intervalMs: 5,
    });
    expect(result).toBe(true);
    expect(reads).toBe(3);
  });

  it("returns false when the count never reaches zero", async () => {
    let reads = 0;
    const result = await waitForNoLockWaiters(
      async () => {
        reads += 1;
        return 1;
      },
      { timeoutMs: 30, intervalMs: 5 },
    );
    expect(result).toBe(false);
    expect(reads).toBeGreaterThan(1);
  });
});
