import { describe, expect, it } from "vitest";
import { handleCallInternalAction } from "../src/jobs/call-internal-action";
import { CALL_INTERNAL_ACTION } from "../src/jobs/constants";
import { consume } from "../src/jobs/consumer";
import { admitRetryDelay, MAX_RETRY_DELAY_SECONDS } from "../src/jobs/retry-delay";
import type { BotClient, BotFailure, QueueLedger, UniqueLock } from "../src/jobs/types";

const FALLBACK = 5; // backoffFor(CALL_INTERNAL_ACTION.backoffSeconds, 1)

const fail = (retryAfterSeconds: unknown): BotFailure => ({
  ok: false,
  code: "rate_limited",
  status: 429,
  requestId: null,
  message: "slow down",
  retryable: true,
  retryAfterSeconds: retryAfterSeconds as number | null,
});

const ann = { kind: "announcement", idempotencyKey: "k", action: { channelKey: "c", body: "b" } } as const;

function botWith(retryAfterSeconds: unknown): BotClient {
  return {
    postAnnouncement: async () => fail(retryAfterSeconds),
    assignRole: async () => fail(retryAfterSeconds),
  } as unknown as BotClient;
}

function memLedger() {
  const rows = new Map<string, { state: string; availableAt?: Date }>();
  const ledger: QueueLedger = {
    enqueued: async (j) => void rows.set(j.jobId, { state: "pending", availableAt: j.availableAt }),
    reserved: async (id) => void rows.set(id, { ...rows.get(id), state: "reserved" } as never),
    released: async (id, at) => void rows.set(id, { ...rows.get(id), state: "released", availableAt: at } as never),
    dequeued: async (id) => void rows.delete(id),
    failed: async (id) => void rows.set(id, { state: "failed" }),
  };
  return { ledger, rows };
}
function memLock(): UniqueLock {
  return { acquire: async () => null, release: async () => {} };
}
function msg(body: unknown, attempts = 1, jobId?: string) {
  const r = { body: jobId ? { ...(body as object), jobId } : body, attempts, acked: false, retried: undefined as number | undefined };
  return Object.assign(r, {
    ack() { r.acked = true; },
    retry(o?: { delaySeconds?: number }) { r.retried = o?.delaySeconds; },
  });
}
const store = () => ({
  prepareSync: async () => null,
  completeSync: async () => {},
  claimSync: async () => null,
  deferSync: async () => {},
  failSync: async () => {},
  needsSync: async () => false,
  pendingSync: async () => null,
  find: async () => null,
  recordMirrored: async () => {},
  closeFinished: async () => 0,
  materializeSeries: async () => 0,
  staleEventKeys: async () => [],
});

describe("admitRetryDelay", () => {
  it("documents the Cloudflare retry bound", () => {
    expect(MAX_RETRY_DELAY_SECONDS).toBe(86400);
  });

  it("passes valid provider delays through", async () => {
    expect(admitRetryDelay(1, FALLBACK)).toBe(1);
    expect(admitRetryDelay(42, FALLBACK)).toBe(42);
    expect(admitRetryDelay(86400, FALLBACK)).toBe(86400);
  });

  it("rounds fractional delays up, never sooner than asked", () => {
    expect(admitRetryDelay(2.2, FALLBACK)).toBe(3);
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["negative", -5],
    ["zero (outside the retry transport range)", 0],
    ["string", "30"],
    ["object", { seconds: 30 }],
    ["above the documented range", 86401],
  ])("falls back on %s", async (_label, candidate) => {
    expect(admitRetryDelay(candidate, FALLBACK)).toBe(FALLBACK);
  });
});

describe("handleCallInternalAction retry admission (TOG-11629)", () => {
  it("keeps Retry-After precedence over backoff for valid delays", async () => {
    const outcome = await handleCallInternalAction({ ...ann }, 1, botWith(42));
    expect(outcome).toEqual({ retryInSeconds: 42 });
  });

  it("ceils fractional provider delays", async () => {
    const outcome = await handleCallInternalAction({ ...ann }, 1, botWith(2.2));
    expect(outcome).toEqual({ retryInSeconds: 3 });
  });

  it.each([[NaN], [Infinity], [-5], [0], [86401], ["30"], [null]])(
    "falls back to this attempt's backoff for %s",
    async (candidate) => {
      const outcome = await handleCallInternalAction({ ...ann }, 1, botWith(candidate));
      expect(outcome).toEqual({ retryInSeconds: FALLBACK });
    },
  );

  it("admits the role.assign path the same way", async () => {
    const role = { kind: "role-assign", idempotencyKey: null, action: { userId: "u", roleKey: "r" } } as const;
    expect(await handleCallInternalAction({ ...role }, 1, botWith(NaN))).toEqual({ retryInSeconds: FALLBACK });
    expect(await handleCallInternalAction({ ...role }, 2, botWith(30))).toEqual({ retryInSeconds: 30 });
  });

  it("feeds one admitted value to both the ledger and Queue.retry", async () => {
    const { ledger, rows } = memLedger();
    const m = msg(ann, 1, "j1");
    const before = Date.now();
    await consume(
      { messages: [m] },
      { bot: botWith(NaN), events: store(), lock: memLock(), ledger },
    );
    // Same admitted fallback in both sinks: consumer retries with it and the
    // ledger availability Date is built from it.
    expect(m.retried).toBe(FALLBACK);
    const at = rows.get("j1")?.availableAt?.getTime() ?? NaN;
    expect(at).toBeGreaterThanOrEqual(before + FALLBACK * 1000);
    expect(at).toBeLessThan(before + FALLBACK * 1000 + 10_000);
  });

  it("leaves terminal caps, idempotency keys and backoff constants unchanged", async () => {
    expect(CALL_INTERNAL_ACTION).toEqual({ tries: 5, backoffSeconds: [5, 15, 60, 180] });
    // Attempt 5 with a poisoned delay still fails terminally, not retries.
    const outcome = await handleCallInternalAction({ ...ann }, 5, botWith(NaN));
    expect("failed" in outcome).toBe(true);
  });
});
