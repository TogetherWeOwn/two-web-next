// Acceptance contract: error.spike omits misleading mixed-build attribution.
//
// The aggregate spike alarm sums every counted trace in the rolling
// window, regardless of which deploy produced it. Its optional build_sha
// must therefore be honest about the whole counted window, not about the
// newest batch: build_sha is emitted only when every counted observation
// in the window (every retained bucket contributing requests, errors or
// crashes to the alert totals) carries the same validated 40-hex SHA.
// A window mixing two validated builds, or containing any counted
// observation with unknown attribution (no valid version tag and no
// valid release log pair, an invalid tag, or a restored legacy bucket
// written before provenance existed), pages with no build_sha at all
// rather than assigning every failure to the latest build.
//
// The alarm itself does not change: thresholds, counts, error rate,
// timing, pending/retry and cooldown stay script-wide and are never
// split by version, the alert shape gains no new field, SHA validation
// and redaction are unchanged, per-trace fingerprint summaries keep
// their own trace's build_sha, and provenance state stays bounded (no
// unbounded list of SHAs) and expires with the buckets it describes.
//
// These tests are hermetic: the real AggregateTracker, AlertAggregator
// over fake storage, and createTailWorker with a fake webhook fetch.
// No Durable Object service, webhook, database, or network is touched.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  AlertAggregator,
  DeliveryMute,
  SPIKE_COOLDOWN_MS,
  SPIKE_MIN_CRASHES,
  SPIKE_MIN_ERRORS,
  SPIKE_WINDOW_MS,
  createTailWorker,
  type TraceBatch,
} from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const BUCKET_MS = 30_000;
const MAIN = "two-web-next";
const JOBS = "two-web-jobs";
const shaA = "0123456789abcdef0123456789abcdef01234567";
const shaB = "fedcba9876543210fedcba9876543210fedcba98";
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const env = { OPS_ALERT_WEBHOOK_URL: secret };

const errBatch = (at: number, n: number, buildSha?: string, script = MAIN): TraceBatch => ({
  script,
  at,
  requests: n,
  errors: n,
  crashes: 0,
  ...(buildSha !== undefined ? { buildSha } : {}),
});

const okBatch = (at: number, n: number, buildSha?: string, script = MAIN): TraceBatch => ({
  script,
  at,
  requests: n,
  errors: 0,
  crashes: 0,
  ...(buildSha !== undefined ? { buildSha } : {}),
});

const crashBatch = (at: number, n: number, buildSha?: string): TraceBatch => ({
  script: MAIN,
  at,
  requests: 0,
  errors: 0,
  crashes: n,
  ...(buildSha !== undefined ? { buildSha } : {}),
});

const spikeShape = (over: Record<string, unknown>) => ({
  event: "error.spike",
  script: MAIN,
  logs: "Workers & Pages > two-web-next > Observability > Logs",
  window_seconds: SPIKE_WINDOW_MS / 1000,
  requests: SPIKE_MIN_ERRORS,
  errors: SPIKE_MIN_ERRORS,
  crashes: 0,
  error_rate: 1,
  timestamp: new Date(t0).toISOString(),
  ...over,
});

describe("mixed-build windows page without build_sha (tracker, separate batches)", () => {
  it("positive control: homogeneous separate batches emit their one validated build_sha", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 2, shaA))).toBeNull();
    const alert = tracker.observe(errBatch(t0, 2, shaA));
    expect(alert).toEqual(spikeShape({ build_sha: shaA }));
    expect(Object.keys(alert!)).toEqual([
      "event",
      "script",
      "build_sha",
      "logs",
      "window_seconds",
      "requests",
      "errors",
      "crashes",
      "error_rate",
      "timestamp",
    ]);
  });

  it("errors from build A plus errors from build B page once, script-wide, with no build_sha", () => {
    const tracker = new AggregateTracker(() => t0);
    // Neither build reaches the floor alone: the budget is not split.
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 2, shaA))).toBeNull();
    const alert = tracker.observe(errBatch(t0 + BUCKET_MS, 2, shaB));
    expect(alert).toEqual(spikeShape({ timestamp: new Date(t0 + BUCKET_MS).toISOString() }));
    expect(alert).not.toHaveProperty("build_sha");
    expect(JSON.stringify(alert)).not.toContain(shaA);
    expect(JSON.stringify(alert)).not.toContain(shaB);
  });

  it("reversed build order (B first, then A) also omits build_sha", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 2, shaB))).toBeNull();
    const alert = tracker.observe(errBatch(t0 + BUCKET_MS, 2, shaA));
    expect(alert).toMatchObject({ requests: SPIKE_MIN_ERRORS, errors: SPIKE_MIN_ERRORS });
    expect(alert).not.toHaveProperty("build_sha");
  });

  it("a healthy request from another build inside the counted window makes attribution mixed", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 1, shaA))).toBeNull();
    expect(tracker.observe(okBatch(t0 + BUCKET_MS, 1, shaB))).toBeNull();
    const alert = tracker.observe(errBatch(t0 + 2 * BUCKET_MS, 1, shaA));
    // The healthy B request is part of the counted totals, so the window
    // is mixed even though every error came from A and A triggered.
    expect(alert).toEqual(
      spikeShape({
        requests: SPIKE_MIN_ERRORS + 1,
        error_rate: 0.833,
        timestamp: new Date(t0 + 2 * BUCKET_MS).toISOString(),
      }),
    );
    expect(alert).not.toHaveProperty("build_sha");
  });

  it("an unknown-attribution batch earlier in the window omits build_sha when a tagged batch triggers", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 1))).toBeNull();
    const alert = tracker.observe(errBatch(t0 + BUCKET_MS, 1, shaA));
    expect(alert).toMatchObject({ requests: SPIKE_MIN_ERRORS, errors: SPIKE_MIN_ERRORS });
    expect(alert).not.toHaveProperty("build_sha");
  });

  it("positive control: an unknown triggering batch after tagged errors omits build_sha", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 1, shaA))).toBeNull();
    const alert = tracker.observe(errBatch(t0 + BUCKET_MS, 1));
    expect(alert).toMatchObject({ requests: SPIKE_MIN_ERRORS, errors: SPIKE_MIN_ERRORS });
    expect(alert).not.toHaveProperty("build_sha");
  });

  it("an invalid build tag earlier in the window is unknown attribution, never forwarded", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 1, "never-send"))).toBeNull();
    const alert = tracker.observe(errBatch(t0 + BUCKET_MS, 1, shaA));
    expect(alert).toMatchObject({ requests: SPIKE_MIN_ERRORS, errors: SPIKE_MIN_ERRORS });
    expect(alert).not.toHaveProperty("build_sha");
    expect(JSON.stringify(alert)).not.toContain("never-send");
  });

  it("two builds landing in the same 30-second bucket make that bucket mixed", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 2, shaA))).toBeNull();
    const alert = tracker.observe(errBatch(t0 + 10_000, 2, shaB));
    expect(alert).toMatchObject({ requests: SPIKE_MIN_ERRORS, errors: SPIKE_MIN_ERRORS });
    expect(alert).not.toHaveProperty("build_sha");
  });

  it("the crash gate sums crashes across builds and omits build_sha", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(crashBatch(t0, SPIKE_MIN_CRASHES - 2, shaA))).toBeNull();
    const alert = tracker.observe(crashBatch(t0 + BUCKET_MS, 2, shaB));
    expect(alert).toEqual(
      spikeShape({
        requests: 0,
        errors: 0,
        crashes: SPIKE_MIN_CRASHES,
        error_rate: 0,
        timestamp: new Date(t0 + BUCKET_MS).toISOString(),
      }),
    );
    expect(alert).not.toHaveProperty("build_sha");
  });

  it("positive control: healthy traffic from another build still dilutes the script-wide rate", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(okBatch(t0, SPIKE_MIN_ERRORS * 4, shaB))).toBeNull();
    // 5 errors in 25 counted requests is below the rate gate, whichever
    // build produced which share.
    expect(tracker.observe(errBatch(t0 + BUCKET_MS, SPIKE_MIN_ERRORS, shaA))).toBeNull();
  });

  it("bare and production-suffixed tags for the same SHA are one homogeneous build", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 2, shaA))).toBeNull();
    const alert = tracker.observe(errBatch(t0 + BUCKET_MS, 2, `${shaA}-123456789-2`));
    expect(alert).toMatchObject({ build_sha: shaA, errors: SPIKE_MIN_ERRORS });
  });

  it("mixed provenance is isolated per script: a homogeneous script still emits its build_sha", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 1, shaA, MAIN))).toBeNull();
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 1, shaB, JOBS))).toBeNull();
    const jobs = tracker.observe(errBatch(t0 + BUCKET_MS, 1, shaB, JOBS));
    expect(jobs).toMatchObject({ script: JOBS, build_sha: shaB, errors: SPIKE_MIN_ERRORS });
    const main = tracker.observe(errBatch(t0 + BUCKET_MS, 1, shaB, MAIN));
    expect(main).toMatchObject({ script: MAIN, errors: SPIKE_MIN_ERRORS });
    expect(main).not.toHaveProperty("build_sha");
  });
});

describe("provenance expires with the window and settlement semantics are unchanged", () => {
  it("at the window edge the earlier build still counts, so the page is mixed", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 1, shaA))).toBeNull();
    const alert = tracker.observe(errBatch(t0 + SPIKE_WINDOW_MS, 1, shaB));
    expect(alert).toMatchObject({ requests: SPIKE_MIN_ERRORS, errors: SPIKE_MIN_ERRORS });
    expect(alert).not.toHaveProperty("build_sha");
  });

  it("one bucket past the window the earlier build has expired and the new build is emitted", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 1, shaA))).toBeNull();
    const at = t0 + SPIKE_WINDOW_MS + BUCKET_MS;
    const alert = tracker.observe(errBatch(at, SPIKE_MIN_ERRORS, shaB));
    expect(alert).toEqual(spikeShape({ build_sha: shaB, timestamp: new Date(at).toISOString() }));
  });

  it("a failed delivery re-offers with recomputed totals, and a build counted since makes it mixed", () => {
    const tracker = new AggregateTracker(() => t0);
    const first = tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS, shaA));
    expect(first).toMatchObject({ build_sha: shaA, errors: SPIKE_MIN_ERRORS });
    tracker.resolve(MAIN, false);
    const reoffered = tracker.observe(okBatch(t0 + BUCKET_MS, 1, shaB));
    expect(reoffered).toEqual(
      spikeShape({
        requests: SPIKE_MIN_ERRORS + 1,
        error_rate: 0.833,
        timestamp: new Date(t0 + BUCKET_MS).toISOString(),
      }),
    );
    expect(reoffered).not.toHaveProperty("build_sha");
  });

  it("a delivered mixed page arms the same cooldown, then a homogeneous burst pages with its SHA", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 1, shaA))).toBeNull();
    const mixed = tracker.observe(errBatch(t0, 1, shaB));
    expect(mixed).not.toHaveProperty("build_sha");
    tracker.resolve(MAIN, true);
    expect(tracker.observe(errBatch(t0 + 60_000, SPIKE_MIN_ERRORS, shaA))).toBeNull();
    const after = t0 + SPIKE_COOLDOWN_MS + BUCKET_MS;
    const again = tracker.observe(errBatch(after, SPIKE_MIN_ERRORS, shaA));
    expect(again).toEqual(
      spikeShape({ build_sha: shaA, timestamp: new Date(after).toISOString() }),
    );
  });
});

describe("restored state: legacy buckets are unknown, new provenance round-trips", () => {
  const legacyBuckets = [
    { at: t0, requests: SPIKE_MIN_ERRORS - 1, errors: SPIKE_MIN_ERRORS - 1, crashes: 0 },
  ];

  it("legacy buckets without any provenance restore counts but not attribution", () => {
    const tracker = new AggregateTracker(() => t0);
    tracker.restore(
      JSON.parse(JSON.stringify({ [MAIN]: { buckets: legacyBuckets, cooldownUntil: 0 } })),
    );
    const alert = tracker.observe(errBatch(t0 + BUCKET_MS, 1, shaA));
    // Counts survive the upgrade exactly; only the claim about which
    // build produced them is withheld.
    expect(alert).toMatchObject({ requests: SPIKE_MIN_ERRORS, errors: SPIKE_MIN_ERRORS });
    expect(alert).not.toHaveProperty("build_sha");
  });

  it("a legacy snapshot's newest-batch buildSha is not proof the restored buckets are one build", () => {
    const tracker = new AggregateTracker(() => t0);
    tracker.restore(
      JSON.parse(
        JSON.stringify({
          [MAIN]: { buckets: legacyBuckets, cooldownUntil: 0, buildSha: shaA },
        }),
      ),
    );
    const alert = tracker.observe(errBatch(t0 + BUCKET_MS, 1, shaA));
    expect(alert).toMatchObject({ requests: SPIKE_MIN_ERRORS, errors: SPIKE_MIN_ERRORS });
    expect(alert).not.toHaveProperty("build_sha");
  });

  it("once legacy buckets expire, a homogeneous new window emits build_sha again", () => {
    const tracker = new AggregateTracker(() => t0);
    tracker.restore(
      JSON.parse(JSON.stringify({ [MAIN]: { buckets: legacyBuckets, cooldownUntil: 0 } })),
    );
    const at = t0 + SPIKE_WINDOW_MS + BUCKET_MS;
    const alert = tracker.observe(errBatch(at, SPIKE_MIN_ERRORS, shaA));
    expect(alert).toEqual(spikeShape({ build_sha: shaA, timestamp: new Date(at).toISOString() }));
  });

  it("positive control: homogeneous provenance survives a snapshot/restore round-trip", () => {
    const first = new AggregateTracker(() => t0);
    expect(first.observe(errBatch(t0, SPIKE_MIN_ERRORS - 1, shaA))).toBeNull();
    const revived = new AggregateTracker(() => t0);
    revived.restore(JSON.parse(JSON.stringify(first.snapshot())));
    const alert = revived.observe(errBatch(t0 + BUCKET_MS, 1, shaA));
    expect(alert).toMatchObject({
      build_sha: shaA,
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
    });
  });

  it("a different build triggering on restored homogeneous counts pages without build_sha", () => {
    const first = new AggregateTracker(() => t0);
    expect(first.observe(errBatch(t0, SPIKE_MIN_ERRORS - 1, shaA))).toBeNull();
    const revived = new AggregateTracker(() => t0);
    revived.restore(JSON.parse(JSON.stringify(first.snapshot())));
    const alert = revived.observe(errBatch(t0 + BUCKET_MS, 1, shaB));
    expect(alert).toMatchObject({ requests: SPIKE_MIN_ERRORS, errors: SPIKE_MIN_ERRORS });
    expect(alert).not.toHaveProperty("build_sha");
  });

  it("provenance state stays bounded under many distinct builds in few buckets", () => {
    const tracker = new AggregateTracker(() => t0);
    const distinctSha = (i: number) => i.toString(16).padStart(40, "0");
    for (let i = 1; i <= 120; i++) {
      tracker.observe(okBatch(t0 + (i % 2) * BUCKET_MS, 1, distinctSha(i)));
    }
    const snapshot = tracker.snapshot();
    const buckets = snapshot[MAIN]?.buckets ?? [];
    expect(buckets.length).toBeLessThanOrEqual(40);
    expect(buckets.reduce((n, b) => n + b.requests, 0)).toBe(120);
    // No unbounded SHA collection: stored 40-hex values are bounded by
    // the retained bucket count, however many builds were seen.
    const stored = new Set(JSON.stringify(snapshot).match(/[0-9a-f]{40}/g) ?? []);
    expect(stored.size).toBeLessThanOrEqual(40);
  });
});

describe("durable aggregator (Durable Object) applies the same rule", () => {
  function fakeState() {
    const store = new Map<string, unknown>();
    return {
      store,
      state: {
        storage: {
          get: async (key: string) => store.get(key),
          put: async (key: string, value: unknown) => {
            store.set(key, structuredClone(value));
          },
        },
      },
    };
  }

  const post = (aggregator: AlertAggregator, body: unknown) =>
    aggregator.fetch(
      new Request("https://aggregator.invalid/observe", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );

  it("positive control: homogeneous batches across instances emit build_sha", async () => {
    const { state } = fakeState();
    const first = new AlertAggregator(state as never);
    expect(
      await (
        await post(first, {
          script: MAIN,
          buildSha: shaA,
          at: t0,
          requests: SPIKE_MIN_ERRORS - 2,
          errors: SPIKE_MIN_ERRORS - 2,
          crashes: 0,
        })
      ).json(),
    ).toBeNull();
    const revived = new AlertAggregator(state as never);
    const alert = (await (
      await post(revived, {
        script: MAIN,
        buildSha: shaA,
        at: t0 + BUCKET_MS,
        requests: 2,
        errors: 2,
        crashes: 0,
      })
    ).json()) as Record<string, unknown>;
    expect(alert).toMatchObject({
      event: "error.spike",
      build_sha: shaA,
      errors: SPIKE_MIN_ERRORS,
    });
  });

  it("mixed batches across instances page with script-wide totals and no build_sha", async () => {
    const { state } = fakeState();
    const first = new AlertAggregator(state as never);
    expect(
      await (
        await post(first, {
          script: MAIN,
          buildSha: shaA,
          at: t0,
          requests: SPIKE_MIN_ERRORS - 2,
          errors: SPIKE_MIN_ERRORS - 2,
          crashes: 0,
        })
      ).json(),
    ).toBeNull();
    const revived = new AlertAggregator(state as never);
    const alert = (await (
      await post(revived, {
        script: MAIN,
        buildSha: shaB,
        at: t0 + BUCKET_MS,
        requests: 2,
        errors: 2,
        crashes: 0,
      })
    ).json()) as Record<string, unknown>;
    expect(alert).toMatchObject({
      event: "error.spike",
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
    });
    expect(alert).not.toHaveProperty("build_sha");
    expect(JSON.stringify(alert)).not.toContain(shaA);
    expect(JSON.stringify(alert)).not.toContain(shaB);
  });

  it("an untagged batch followed by a tagged triggering batch omits build_sha", async () => {
    const { state } = fakeState();
    const aggregator = new AlertAggregator(state as never);
    expect(
      await (
        await post(aggregator, {
          script: MAIN,
          at: t0,
          requests: SPIKE_MIN_ERRORS - 1,
          errors: SPIKE_MIN_ERRORS - 1,
          crashes: 0,
        })
      ).json(),
    ).toBeNull();
    const alert = (await (
      await post(aggregator, {
        script: MAIN,
        buildSha: shaA,
        at: t0 + BUCKET_MS,
        requests: 1,
        errors: 1,
        crashes: 0,
      })
    ).json()) as Record<string, unknown>;
    expect(alert).toMatchObject({ event: "error.spike", errors: SPIKE_MIN_ERRORS });
    expect(alert).not.toHaveProperty("build_sha");
  });

  it("persisted legacy buckets in aggregator storage count toward the page but not its build", async () => {
    const { state, store } = fakeState();
    store.set("scripts", {
      [MAIN]: {
        buckets: [
          { at: t0, requests: SPIKE_MIN_ERRORS - 1, errors: SPIKE_MIN_ERRORS - 1, crashes: 0 },
        ],
        cooldownUntil: 0,
        buildSha: shaA,
      },
    });
    const aggregator = new AlertAggregator(state as never);
    const alert = (await (
      await post(aggregator, {
        script: MAIN,
        buildSha: shaA,
        at: t0 + BUCKET_MS,
        requests: 1,
        errors: 1,
        crashes: 0,
      })
    ).json()) as Record<string, unknown>;
    expect(alert).toMatchObject({
      event: "error.spike",
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
    });
    expect(alert).not.toHaveProperty("build_sha");
  });
});

describe("one tail invocation merging same-script traces", () => {
  function fixture() {
    let now = t0;
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => now),
      tracker: new AggregateTracker(() => now),
      now: () => now,
      sleep: async () => {},
    });
    const contents = () =>
      (send.mock.calls as unknown as [string, RequestInit][])
        .filter(([url]) => url === `${secret}?wait=true`)
        .map(([, init]) => JSON.parse(JSON.parse(init.body as string).content));
    return { worker, sink, contents };
  }

  // tag: undefined defaults to build A; null omits the version tag entirely.
  const fetchTrace = (
    status: number,
    opts: {
      at?: number;
      tag?: string | null;
      logs?: { level: string; timestamp: number; message: string[] }[];
    } = {},
  ) => ({
    scriptName: MAIN,
    ...(opts.tag !== null ? { scriptVersion: { tag: opts.tag ?? shaA } } : {}),
    outcome: "ok",
    exceptions: [],
    eventTimestamp: opts.at ?? t0,
    event: {
      request: { method: "GET", url: "https://example.test/private?token=never-send" },
      response: { status },
    },
    logs: opts.logs ?? [],
  });

  const releaseLog = (logSha: string) => [
    {
      level: "info",
      timestamp: t0,
      message: [
        JSON.stringify({ event: "http.request", status: 500, build_sha: logSha, release: logSha }),
      ],
    },
  ];

  it("five errors from build A followed by a healthy request from B do not label the spike B", async () => {
    const f = fixture();
    await f.worker.tail(
      [
        ...Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, { tag: shaA })),
        fetchTrace(200, { tag: shaB }),
      ],
      env,
    );
    expect(f.contents()).toEqual([
      spikeShape({ requests: SPIKE_MIN_ERRORS + 1, error_rate: 0.833 }),
    ]);
    expect(f.contents()[0]).not.toHaveProperty("build_sha");
    expect(JSON.stringify(f.contents())).not.toContain(shaA);
    expect(JSON.stringify(f.contents())).not.toContain(shaB);
    const receipt = JSON.parse(f.sink.mock.calls.at(-1)![0] as string);
    expect(receipt).toMatchObject({ event: "error.spike", delivery: "ops.alert.delivered" });
    expect(receipt).not.toHaveProperty("build_sha");
  });

  it("a healthy request from B before five errors from A still omits build_sha", async () => {
    const f = fixture();
    await f.worker.tail(
      [
        fetchTrace(200, { tag: shaB }),
        ...Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, { tag: shaA })),
      ],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      requests: SPIKE_MIN_ERRORS + 1,
      errors: SPIKE_MIN_ERRORS,
    });
    expect(f.contents()[0]).not.toHaveProperty("build_sha");
  });

  it("an untagged error trace in the same invocation does not leave the earlier tag in place", async () => {
    const f = fixture();
    await f.worker.tail(
      [
        ...Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, { tag: shaA })),
        fetchTrace(500, { tag: null }),
      ],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      requests: SPIKE_MIN_ERRORS + 1,
      errors: SPIKE_MIN_ERRORS + 1,
      error_rate: 1,
    });
    expect(f.contents()[0]).not.toHaveProperty("build_sha");
  });

  it("an untagged error trace before tagged errors in one invocation omits build_sha", async () => {
    const f = fixture();
    await f.worker.tail(
      [
        fetchTrace(500, { tag: null }),
        ...Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, { tag: shaA })),
      ],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).not.toHaveProperty("build_sha");
  });

  it("an invalid-tag trace merged with tagged errors omits build_sha and forwards nothing", async () => {
    const f = fixture();
    await f.worker.tail(
      [
        ...Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, { tag: shaA })),
        fetchTrace(500, { tag: "manual-never-send" }),
      ],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).not.toHaveProperty("build_sha");
    expect(JSON.stringify(f.contents())).not.toContain("never-send");
  });

  it("positive control: bare and suffixed tags of one SHA in one invocation emit that SHA", async () => {
    const f = fixture();
    await f.worker.tail(
      [
        ...Array.from({ length: SPIKE_MIN_ERRORS - 2 }, () => fetchTrace(500, { tag: shaA })),
        ...Array.from({ length: 2 }, () => fetchTrace(500, { tag: `${shaA}-123456789-1` })),
      ],
      env,
    );
    expect(f.contents()).toEqual([spikeShape({ build_sha: shaA })]);
  });

  it("release-log attribution mixing two builds in one invocation omits build_sha", async () => {
    const f = fixture();
    await f.worker.tail(
      [
        ...Array.from({ length: SPIKE_MIN_ERRORS - 2 }, () =>
          fetchTrace(500, { tag: null, logs: releaseLog(shaA) }),
        ),
        ...Array.from({ length: 2 }, () => fetchTrace(500, { tag: null, logs: releaseLog(shaB) })),
      ],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
    });
    expect(f.contents()[0]).not.toHaveProperty("build_sha");
  });

  it("positive control: version-tag and release-log traces agreeing on one SHA emit it", async () => {
    const f = fixture();
    await f.worker.tail(
      [
        ...Array.from({ length: SPIKE_MIN_ERRORS - 2 }, () => fetchTrace(500, { tag: shaA })),
        ...Array.from({ length: 2 }, () => fetchTrace(500, { tag: null, logs: releaseLog(shaA) })),
      ],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({ build_sha: shaA, errors: SPIKE_MIN_ERRORS });
  });

  it("separate invocations from two builds sum into one page with no build_sha", async () => {
    const f = fixture();
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_ERRORS - 2 }, () => fetchTrace(500, { tag: shaA })),
      env,
    );
    expect(f.contents()).toEqual([]);
    await f.worker.tail(
      Array.from({ length: 2 }, () => fetchTrace(500, { tag: shaB, at: t0 + BUCKET_MS })),
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
      timestamp: new Date(t0 + BUCKET_MS).toISOString(),
    });
    expect(f.contents()[0]).not.toHaveProperty("build_sha");
  });

  it("positive control: per-trace fingerprint summaries keep their own trace's build_sha", async () => {
    const f = fixture();
    const alertTrace = (tag: string, fingerprint: string, route: string) => ({
      ...fetchTrace(200, { tag }),
      logs: [
        {
          level: "error",
          timestamp: t0,
          message: [
            JSON.stringify({
              level: "critical",
              event: "error.alert",
              fingerprint,
              route,
              exception: "TypeError",
            }),
          ],
        },
      ],
    });
    await f.worker.tail(
      [
        alertTrace(shaA, "TypeError@/join", "/join"),
        alertTrace(shaB, "TypeError@/login", "/login"),
      ],
      env,
    );
    const summaries = f.contents().filter((c) => c.event === "error.alert");
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ build_sha: shaA, route: "/join" });
    expect(summaries[1]).toMatchObject({ build_sha: shaB, route: "/login" });
    expect(f.contents().some((c) => c.event === "error.spike")).toBe(false);
  });
});

describe("alerts runbook explains the two page shapes", () => {
  it("the error.spike section distinguishes homogeneous from mixed or unknown windows", () => {
    const runbook = readFileSync("docs/runbook-alerts.md", "utf8");
    const start = runbook.indexOf("Aggregate spike alarm");
    const end = runbook.indexOf("Scheduled `/up` prober", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = runbook.slice(start, end);
    expect(section).toMatch(/build_sha/);
    expect(section).toMatch(/homogeneous|single build|one build|same build/i);
    expect(section).toMatch(/mixed/i);
    expect(section).toMatch(/omit/i);
  });
});
