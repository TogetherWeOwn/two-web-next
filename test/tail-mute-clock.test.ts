// Acceptance contract: a trace timestamp from the future must not
// control the Tail delivery mute. Mute decisions are bounded by the
// local (Tail processing) clock: a far-future source timestamp pages
// once and then mutes for at most the documented window (MUTE_MS,
// plus at most a bounded skew allowance smaller than one window),
// never until the source clock catches up.
//
// Pre-fix red proof: DeliveryMute records the raw trace timestamp as
// the sent time, so a log stamped a year ahead (a) suppresses every
// later on-time alert for that fingerprint for a year, (b) breaks an
// active legitimate mute because future-minus-sent exceeds the
// window, and (c) pages once per far-apart future timestamp even
// when the traces arrive seconds apart locally. The four tests in
// the first describe fail for exactly those reasons before the fix.
//
// What must not change (positive controls, green before and after):
// on-time and past source timestamps keep the existing source-time
// window semantics (a duplicate MUTE_MS-1 of source time after a
// delivered page stays muted even if the local clock has run far
// ahead, and source time exactly MUTE_MS later pages again);
// pending-attempt fencing still holds while a delivery is in
// flight; only delivered pages start the cooldown; a trace whose
// timestamp is absent or not finite is dropped without paging and
// without muting anything; each fingerprint mutes independently;
// and the delivered payload still carries the original source
// timestamp — clamping the mute decision must not rewrite the page.
//
// The clamp may live wherever the implementation puts it (inside
// DeliveryMute via its injected clock, or at the trace call site via
// the worker clock): every assertion here is on observable page
// delivery through the worker, with both clocks injected from the
// same fake local time. Expiry after a skewed page is asserted at
// local + 2 * MUTE_MS so any bounded-skew allowance under one full
// window satisfies the suite; suppression inside the window is
// asserted at local + MUTE_MS - 1, which holds for a strict
// min(source, now) clamp and for a skew-allowance clamp alike.
//
// Everything is hermetic: injected fetch, a fake local clock, no
// webhook, database or network contact.
import { describe, expect, it, vi } from "vitest";
import { DeliveryMute, MUTE_MS, createTailWorker } from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

const requestAlert = {
  level: "critical",
  event: "error.alert",
  fingerprint: "TypeError@/join",
  route: "/join",
};
const queueAlert = {
  level: "critical",
  event: "queue.failing",
  job: "CallInternalAction",
  attempts: 6,
};

const trace = (lines: unknown[], sourceAt: number) => ({
  scriptName: "two-web-next",
  logs: [
    {
      message: lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))),
      timestamp: sourceAt,
      level: "error",
    },
  ],
});

const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const env = { OPS_ALERT_WEBHOOK_URL: secret };

function fixture(status = 200) {
  let now = t0;
  const send = vi.fn(async () => new Response(null, { status }));
  const sink = vi.fn();
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink,
    mute: new DeliveryMute(() => now),
    now: () => now,
  });
  return {
    worker,
    send,
    sink,
    setNow: (at: number) => {
      now = at;
    },
  };
}

describe("far-future trace timestamps cannot stretch the mute (RED before the clamp)", () => {
  it("a year-ahead page mutes for at most one window of local time, and its payload keeps the source timestamp", async () => {
    const { worker, send, sink, setNow } = fixture();
    const future = t0 + YEAR_MS;
    await worker.tail([trace([requestAlert], future)], env);
    expect(send).toHaveBeenCalledTimes(1);
    // The page itself is unchanged: operators still see when the
    // source claimed the error happened.
    expect(JSON.parse(sink.mock.calls[0]![0])).toMatchObject({
      timestamp: new Date(future).toISOString(),
      delivery: "ops.alert.delivered",
    });

    setNow(t0 + MUTE_MS - 1);
    await worker.tail([trace([requestAlert], t0 + MUTE_MS - 1)], env);
    expect(send).toHaveBeenCalledTimes(1); // Still inside the one allowed window.

    setNow(t0 + 2 * MUTE_MS);
    await worker.tail([trace([requestAlert], t0 + 2 * MUTE_MS)], env);
    expect(send).toHaveBeenCalledTimes(2); // Not muted until the source year arrives.
  });

  it("a far-future duplicate cannot break an active legitimate mute or poison its expiry", async () => {
    const { worker, send, setNow } = fixture();
    await worker.tail([trace([requestAlert], t0)], env);
    expect(send).toHaveBeenCalledTimes(1);

    setNow(t0 + 1000);
    await worker.tail([trace([requestAlert], t0 + YEAR_MS)], env);
    expect(send).toHaveBeenCalledTimes(1); // One second later locally: still the same mute.

    setNow(t0 + 2 * MUTE_MS);
    await worker.tail([trace([requestAlert], t0 + 2 * MUTE_MS)], env);
    expect(send).toHaveBeenCalledTimes(2); // Expiry is the honest page's, not the future stamp's.
  });

  it("repeated far-apart future timestamps arriving seconds apart locally page only once per window", async () => {
    const { worker, send, setNow } = fixture();
    await worker.tail([trace([requestAlert], t0 + DAY_MS)], env);
    setNow(t0 + 1000);
    await worker.tail([trace([requestAlert], t0 + 30 * DAY_MS)], env);
    setNow(t0 + 2000);
    await worker.tail([trace([requestAlert], t0 + YEAR_MS)], env);
    expect(send).toHaveBeenCalledTimes(1);

    setNow(t0 + 2 * MUTE_MS);
    await worker.tail([trace([requestAlert], t0 + 2 * MUTE_MS)], env);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sustained red keeps paging once per window after a future-stamped trace", async () => {
    const { worker, send, setNow } = fixture();
    await worker.tail([trace([requestAlert], t0 + YEAR_MS)], env);
    expect(send).toHaveBeenCalledTimes(1);

    setNow(t0 + 2 * MUTE_MS);
    await worker.tail([trace([requestAlert], t0 + 2 * MUTE_MS)], env);
    expect(send).toHaveBeenCalledTimes(2);

    setNow(t0 + 3 * MUTE_MS - 1);
    await worker.tail([trace([requestAlert], t0 + 3 * MUTE_MS - 1)], env);
    expect(send).toHaveBeenCalledTimes(2); // Duplicate inside the second window.

    setNow(t0 + 4 * MUTE_MS);
    await worker.tail([trace([requestAlert], t0 + 4 * MUTE_MS)], env);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe("mute behavior the clamp must not change (positive controls)", () => {
  it("on-time duplicates keep source-time window semantics: MUTE_MS - 1 of source time stays muted, exactly MUTE_MS pages", async () => {
    const { worker, send, setNow } = fixture();
    await worker.tail([trace([requestAlert], t0)], env);
    expect(send).toHaveBeenCalledTimes(1);

    // The local clock running far ahead does not shorten a mute that
    // source time says is still inside its window.
    setNow(t0 + 10 * MUTE_MS);
    await worker.tail([trace([requestAlert], t0 + MUTE_MS - 1)], env);
    expect(send).toHaveBeenCalledTimes(1);

    await worker.tail([trace([requestAlert], t0 + MUTE_MS)], env);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("far-past timestamps keep source-time spacing: the clamp bounds only the future", async () => {
    const { worker, send, setNow } = fixture();
    const past = t0 - DAY_MS;
    await worker.tail([trace([requestAlert], past)], env);
    expect(send).toHaveBeenCalledTimes(1);

    setNow(t0 + DAY_MS);
    await worker.tail([trace([requestAlert], past + MUTE_MS - 1)], env);
    expect(send).toHaveBeenCalledTimes(1);

    await worker.tail([trace([requestAlert], past + MUTE_MS)], env);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a small future skew behaves like on-time: muted inside the window, paging after it", async () => {
    const { worker, send, setNow } = fixture();
    await worker.tail([trace([requestAlert], t0 + 120_000)], env);
    expect(send).toHaveBeenCalledTimes(1);

    setNow(t0 + 60_000);
    await worker.tail([trace([requestAlert], t0 + 60_000)], env);
    expect(send).toHaveBeenCalledTimes(1);

    setNow(t0 + 2 * MUTE_MS);
    await worker.tail([trace([requestAlert], t0 + 2 * MUTE_MS)], env);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a failed delivery of a future-stamped alert starts no cooldown: the on-time retry is attempted", async () => {
    const { worker, send, sink, setNow } = fixture(429);
    await worker.tail([trace([requestAlert], t0 + YEAR_MS)], env);
    setNow(t0 + 1000);
    await worker.tail([trace([requestAlert], t0 + 1000)], env);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      sink.mock.calls.every(([line]) => JSON.parse(line).delivery === "ops.alert.delivery_failed"),
    ).toBe(true);
  });

  it("pending-attempt fencing still holds: a future-stamped duplicate cannot start a second in-flight delivery", async () => {
    let now = t0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await gate;
      return new Response(null, { status: 200 });
    });
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink: vi.fn(),
      mute: new DeliveryMute(() => now),
      now: () => now,
    });

    const first = worker.tail([trace([requestAlert], t0)], env);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    now = t0 + 1000;
    await worker.tail([trace([requestAlert], t0 + YEAR_MS)], env);
    expect(send).toHaveBeenCalledTimes(1); // Fenced by the pending attempt, future stamp or not.

    release();
    await first;

    await worker.tail([trace([requestAlert], t0 + 2000)], env);
    expect(send).toHaveBeenCalledTimes(1); // Delivered once; the window now runs.
  });

  it("absent or non-finite trace timestamps page nothing and mute nothing", async () => {
    const { worker, send, sink } = fixture();
    await worker.tail([trace([requestAlert], Number.NaN)], env);
    await worker.tail(
      [
        {
          scriptName: "two-web-next",
          logs: [{ message: [JSON.stringify(requestAlert)], level: "error" }],
        },
      ] as never,
      env,
    );
    expect(send).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();

    await worker.tail([trace([requestAlert], t0)], env);
    expect(send).toHaveBeenCalledTimes(1); // The dropped traces left no mute behind.
  });

  it("a future-stamped page for one fingerprint does not mute another fingerprint", async () => {
    const { worker, send, setNow } = fixture();
    await worker.tail([trace([requestAlert], t0 + YEAR_MS)], env);
    setNow(t0 + 1000);
    await worker.tail([trace([queueAlert], t0 + 1000)], env);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
