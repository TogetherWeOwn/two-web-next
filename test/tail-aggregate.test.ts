import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  AlertAggregator,
  DeliveryMute,
  HEALTH_COOLDOWN_MS,
  HEALTH_DOWN_MS,
  HealthTracker,
  SPIKE_COOLDOWN_MS,
  SPIKE_MIN_CRASHES,
  SPIKE_MIN_ERRORS,
  createTailWorker,
  shaFromVersionTag,
} from "../tail/worker";
// @ts-expect-error JSONC comment/trailing-comma stripper has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";

// Scheduled runs on a five-minute boundary also probe the synthetic main
// flows; health fixtures answer those paths healthily so only /up drives
// the assertions. Returns null for the /up probe itself.
const healthySynthetic = (target: string): Response | null => {
  const path = new URL(target).pathname;
  if (path === "/up") return null;
  if (path === "/login") {
    return new Response(null, { status: 302, headers: { location: "/auth/discord" } });
  }
  return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
};

const t0 = Date.parse("2026-10-01T00:00:00Z");
const sha = "0123456789abcdef0123456789abcdef01234567";
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const env = { OPS_ALERT_WEBHOOK_URL: secret };

const fetchTrace = (status: number, at = t0, scriptName = "two-web-next", tag: string = sha) => ({
  scriptName,
  scriptVersion: { tag },
  outcome: "ok",
  exceptions: [],
  eventTimestamp: at,
  event: {
    request: { method: "GET", url: "https://example.test/private?token=never-send" },
    response: { status },
  },
  logs: [],
});

const crashTrace = (at = t0, scriptName = "two-web-next") => ({
  scriptName,
  scriptVersion: { tag: sha },
  outcome: "exception",
  exceptions: [{ name: "BoomError", message: "password=never-send", timestamp: at }],
  eventTimestamp: at,
  event: { queue: "private-queue", batchSize: 1 },
  logs: [],
});

// A runtime-killed fetch invocation: no exceptions entry and no response.
const killedFetchTrace = (outcome: string, at = t0) => ({
  scriptName: "two-web-next",
  scriptVersion: { tag: sha },
  outcome,
  eventTimestamp: at,
  event: {
    request: { method: "GET", url: "https://example.test/private?token=never-send" },
  },
  logs: [],
});

function fixture(nowStart = t0) {
  let now = nowStart;
  const send = vi.fn(async () => new Response(null, { status: 200 }));
  const sink = vi.fn();
  const tracker = new AggregateTracker(() => now);
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink,
    mute: new DeliveryMute(() => now),
    tracker,
    now: () => now,
    sleep: async () => {},
  });
  const posts = () =>
    (send.mock.calls as unknown as [string, RequestInit][]).filter(
      ([url]) => url === `${secret}?wait=true`,
    );
  const contents = () =>
    posts().map(([, init]) => JSON.parse(JSON.parse(init.body as string).content));
  return {
    worker,
    send,
    sink,
    tracker,
    posts,
    contents,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe("shaFromVersionTag", () => {
  it("accepts the staging tag (a bare SHA) and the production tag (SHA-run-attempt)", () => {
    expect(shaFromVersionTag(sha)).toBe(sha);
    expect(shaFromVersionTag(`${sha}-123456789-2`)).toBe(sha);
  });

  it.each([undefined, "", "manual-tag", sha.toUpperCase(), `${sha}extra`, `v1-${sha}`])(
    "rejects a non-SHA tag %j instead of forwarding arbitrary text",
    (tag) => {
      expect(shaFromVersionTag(tag)).toBeUndefined();
    },
  );
});

describe("aggregate 5xx/error-rate spike alert", () => {
  it("pages once when at least the minimum errors are at least half of requests in the window", async () => {
    const { worker, contents, sink } = fixture();
    await worker.tail(
      Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500)),
      env,
    );
    expect(contents()).toEqual([
      {
        event: "error.spike",
        script: "two-web-next",
        build_sha: sha,
        logs: "Workers & Pages > two-web-next > Observability > Logs",
        window_seconds: 300,
        requests: SPIKE_MIN_ERRORS,
        errors: SPIKE_MIN_ERRORS,
        crashes: 0,
        error_rate: 1,
        timestamp: "2026-10-01T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(contents())).not.toMatch(/never-send|example\.test/);
    expect(JSON.parse(sink.mock.calls.at(-1)![0])).toMatchObject({
      event: "error.spike",
      build_sha: sha,
      delivery: "ops.alert.delivered",
    });
  });

  it("takes build_sha from release-tagged log lines when traces carry no version tag", async () => {
    // Live Cloudflare traces do not populate scriptVersion.tag: in the
    // 2026-10-17 staging drill the active version tag was the bare deploy
    // SHA, yet delivered summaries omitted build_sha. The app's own
    // http.request line carries a validated build_sha instead.
    const { worker, contents } = fixture();
    const liveTrace = () => ({
      scriptName: "two-web-next",
      outcome: "ok",
      exceptions: [],
      eventTimestamp: t0,
      event: {
        request: { method: "GET", url: "https://example.test/private?token=never-send" },
        response: { status: 500 },
      },
      logs: [
        {
          level: "info",
          timestamp: t0,
          message: [
            JSON.stringify({ event: "http.request", status: 500, build_sha: sha, release: sha }),
          ],
        },
      ],
    });
    await worker.tail(Array.from({ length: SPIKE_MIN_ERRORS }, liveTrace), env);
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toMatchObject({ event: "error.spike", build_sha: sha });
    expect(JSON.stringify(contents())).not.toMatch(/never-send|example\.test/);
  });

  it("omits build_sha when log lines carry no valid 40-hex value", async () => {
    const { worker, contents } = fixture();
    const bogusTrace = () => ({
      scriptName: "two-web-next",
      outcome: "ok",
      exceptions: [],
      eventTimestamp: t0,
      event: {
        request: { method: "GET", url: "https://example.test/" },
        response: { status: 500 },
      },
      logs: [
        {
          level: "info",
          timestamp: t0,
          message: [
            JSON.stringify({ event: "http.request", build_sha: "manual-never-send" }),
            // A 40-hex build_sha without the app's equal release pair is
            // not an app release line and must not be trusted either.
            JSON.stringify({ event: "http.request", build_sha: sha, release: "f".repeat(40) }),
          ],
        },
      ],
    });
    await worker.tail(Array.from({ length: SPIKE_MIN_ERRORS }, bogusTrace), env);
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).not.toHaveProperty("build_sha");
    expect(JSON.stringify(contents())).not.toContain("manual-never-send");
  });

  it("omits build_sha when the triggering batch has no valid tag, instead of blaming the previous build", async () => {
    const f = fixture();
    // Below-threshold errors from a tagged build record its SHA...
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_ERRORS - 1 }, () => fetchTrace(500)),
      env,
    );
    // ...then a redeploy without a valid version tag crosses the threshold.
    await f.worker.tail([fetchTrace(500, t0, "two-web-next", "manual-tag")], env);
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).not.toHaveProperty("build_sha");
  });

  it("stays silent below the error minimum, and when errors are a small share of traffic", async () => {
    const below = fixture();
    await below.worker.tail(
      Array.from({ length: SPIKE_MIN_ERRORS - 1 }, () => fetchTrace(503)),
      env,
    );
    expect(below.contents()).toEqual([]);

    const diluted = fixture();
    await diluted.worker.tail(
      [
        ...Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500)),
        ...Array.from({ length: SPIKE_MIN_ERRORS * 4 }, () => fetchTrace(200)),
      ],
      env,
    );
    expect(diluted.contents()).toEqual([]);
  });

  it("4xx responses are traffic, not errors", async () => {
    const { worker, contents } = fixture();
    await worker.tail(
      Array.from({ length: 10 }, () => fetchTrace(404)),
      env,
    );
    expect(contents()).toEqual([]);
  });

  it("cools down after a spike, then can page again after the cooldown", async () => {
    const f = fixture();
    const burst = (at: number) =>
      Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, at));
    await f.worker.tail(burst(t0), env);
    f.advance(60_000);
    await f.worker.tail(burst(t0 + 60_000), env);
    expect(f.contents()).toHaveLength(1);
    const later = t0 + SPIKE_COOLDOWN_MS + 60_000;
    f.advance(later - f.now());
    await f.worker.tail(burst(later), env);
    expect(f.contents()).toHaveLength(2);
    expect(f.contents()[1].timestamp).toBe(new Date(later).toISOString());
  });

  it("tracks each app script separately and ignores foreign Workers", async () => {
    const f = fixture();
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, t0, "other-worker")),
      env,
    );
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_ERRORS - 1 }, () => fetchTrace(500, t0, "two-web-jobs")),
      env,
    );
    expect(f.contents()).toEqual([]);
    await f.worker.tail([fetchTrace(500, t0, "two-web-jobs")], env);
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0].script).toBe("two-web-jobs");
  });
});

describe("unhandled-exception / crash-loop coverage", () => {
  it("pages on repeated exception outcomes even when no error.alert line or fetch response exists", async () => {
    const f = fixture();
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_CRASHES }, () => crashTrace()),
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      event: "error.spike",
      crashes: SPIKE_MIN_CRASHES,
      requests: 0,
      errors: 0,
      error_rate: 0,
    });
    expect(JSON.stringify(f.contents())).not.toMatch(/never-send|BoomError|private-queue/);
  });

  it("a single crash does not page the aggregate alarm", async () => {
    const f = fixture();
    await f.worker.tail([crashTrace()], env);
    expect(f.contents()).toEqual([]);
  });

  it.each(["exception", "exceededCpu", "exceededMemory", "scriptNotFound"])(
    "pages when fetch invocations end with outcome %s and carry no exceptions entry",
    async (outcome) => {
      const f = fixture();
      await f.worker.tail(
        Array.from({ length: SPIKE_MIN_CRASHES }, () => killedFetchTrace(outcome)),
        env,
      );
      expect(f.contents()).toHaveLength(1);
      expect(f.contents()[0]).toMatchObject({
        event: "error.spike",
        crashes: SPIKE_MIN_CRASHES,
        errors: SPIKE_MIN_CRASHES,
        requests: SPIKE_MIN_CRASHES,
        error_rate: 1,
      });
      expect(JSON.stringify(f.contents())).not.toMatch(/never-send|example\.test/);
    },
  );

  it.each(["canceled", "responseStreamDisconnected"])(
    "never pages on the client-disconnect outcome %s",
    async (outcome) => {
      const f = fixture();
      await f.worker.tail(
        Array.from({ length: SPIKE_MIN_CRASHES * 2 }, () => killedFetchTrace(outcome)),
        env,
      );
      expect(f.contents()).toEqual([]);
    },
  );
});

describe("release tagging on the existing summaries", () => {
  it("error.alert summaries carry the allowlisted script, logs path and deployed SHA", async () => {
    const f = fixture();
    const line = JSON.stringify({
      level: "critical",
      event: "error.alert",
      fingerprint: "TypeError@/join",
      route: "/join",
      exception: "TypeError",
    });
    await f.worker.tail(
      [
        {
          ...fetchTrace(200, t0, "two-web-next-production", `${sha}-123456789-1`),
          logs: [{ message: [line], timestamp: t0, level: "error" }],
        },
      ],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      event: "error.alert",
      script: "two-web-next-production",
      build_sha: sha,
      logs: "Workers & Pages > two-web-next-production > Observability > Logs",
      route: "/join",
    });
  });

  it("an arbitrary version tag is omitted, never forwarded", async () => {
    const f = fixture();
    const line = JSON.stringify({
      level: "critical",
      event: "queue.failing",
      job: "SyncEventToDiscord",
      attempts: 3,
      exception: "refused",
    });
    await f.worker.tail(
      [
        {
          scriptName: "two-web-jobs",
          scriptVersion: { tag: "manual-never-send" },
          logs: [{ message: [line], timestamp: t0, level: "error" }],
        },
      ],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({ event: "queue.failing", script: "two-web-jobs" });
    expect(f.contents()[0]).not.toHaveProperty("build_sha");
    expect(JSON.stringify(f.contents())).not.toMatch(/never-send/);
  });
});

describe("health red for more than two minutes", () => {
  const upEnv = {
    OPS_ALERT_WEBHOOK_URL: secret,
    UPTIME_URL: "https://next.togetherweown.com/up",
  };
  const event = { cron: "* * * * *", scheduledTime: t0, noRetry() {} };

  function healthFixture(probeStatus: () => Response) {
    let now = t0;
    const send = vi.fn(async (...args: [string, RequestInit?]) => {
      const [target, init] = args;
      if (init?.method === "POST") return new Response(null, { status: 200 });
      return healthySynthetic(target) ?? probeStatus();
    });
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => now),
      tracker: new AggregateTracker(() => now),
      now: () => now,
      sleep: async () => {},
    });
    const posts = () =>
      (send.mock.calls as unknown as [string, RequestInit][]).filter(
        ([, init]) => init?.method === "POST",
      );
    return {
      worker,
      sink,
      posts,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("does not page on the first red runs; pages once health has been red over two minutes", async () => {
    const f = healthFixture(() => new Response(null, { status: 503 }));
    await f.worker.scheduled(event, upEnv);
    f.advance(60_000);
    await f.worker.scheduled(event, upEnv);
    expect(f.posts()).toHaveLength(0);
    f.advance(HEALTH_DOWN_MS - 60_000 + 1_000);
    await f.worker.scheduled(event, upEnv);
    expect(f.posts()).toHaveLength(1);
    const content = JSON.parse(JSON.parse(f.posts()[0]![1].body as string).content);
    expect(content).toMatchObject({ event: "uptime.down", status: 503 });
    expect(content.down_seconds).toBeGreaterThanOrEqual(120);
    // Still down one minute later: no re-page inside the cooldown.
    f.advance(60_000);
    await f.worker.scheduled(event, upEnv);
    expect(f.posts()).toHaveLength(1);
  });

  it("a healthy run clears the red window, so a later blip starts over", async () => {
    let healthy = false;
    const f = healthFixture(() =>
      healthy
        ? new Response(null, { status: 200, headers: { "x-two-origin": "two-web-next" } })
        : new Response(null, { status: 500 }),
    );
    await f.worker.scheduled(event, upEnv);
    f.advance(HEALTH_DOWN_MS + 1_000);
    healthy = true;
    await f.worker.scheduled(event, upEnv);
    healthy = false;
    await f.worker.scheduled(event, upEnv);
    expect(f.posts()).toHaveLength(0);
  });
});

describe("durable aggregator (Durable Object)", () => {
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

  it("keeps counts across instances through storage, so isolate churn cannot split a spike", async () => {
    const { state, store } = fakeState();
    const post = (aggregator: AlertAggregator, body: unknown) =>
      aggregator.fetch(
        new Request("https://aggregator.invalid/observe", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    const batch = {
      script: "two-web-next",
      buildSha: sha,
      at: t0,
      requests: 3,
      errors: 3,
      crashes: 0,
    };
    const first = new AlertAggregator(state as never);
    expect(await (await post(first, batch)).json()).toBeNull();
    const revived = new AlertAggregator(state as never);
    const alert = (await (await post(revived, { ...batch, requests: 2, errors: 2 })).json()) as {
      event: string;
      errors: number;
    };
    expect(alert).toMatchObject({ event: "error.spike", errors: SPIKE_MIN_ERRORS });
    expect(store.size).toBeGreaterThan(0);
  });

  it("rejects unknown routes and malformed batches without recording them", async () => {
    const { state } = fakeState();
    const aggregator = new AlertAggregator(state as never);
    expect((await aggregator.fetch(new Request("https://aggregator.invalid/nope"))).status).toBe(
      404,
    );
    const bad = await aggregator.fetch(
      new Request("https://aggregator.invalid/observe", { method: "POST", body: "{nope" }),
    );
    expect(bad.status).toBe(400);
    const badShape = await aggregator.fetch(
      new Request("https://aggregator.invalid/observe", {
        method: "POST",
        body: JSON.stringify({ script: "evil", at: t0, requests: -1, errors: 0, crashes: 0 }),
      }),
    );
    expect(badShape.status).toBe(400);
  });

  it("a failing aggregator binding never breaks the existing per-fingerprint paging", async () => {
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = vi.fn();
    const worker = createTailWorker({ fetch: send as unknown as typeof fetch, sink });
    const line = JSON.stringify({
      level: "critical",
      event: "error.alert",
      fingerprint: "TypeError@/join",
      route: "/join",
    });
    const broken = {
      OPS_ALERT_WEBHOOK_URL: secret,
      ALERT_AGGREGATOR: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async () => {
            throw new Error("aggregator down");
          },
        }),
      },
    };
    await expect(
      worker.tail(
        [
          {
            scriptName: "two-web-next",
            logs: [{ message: [line], timestamp: t0, level: "error" }],
          },
        ],
        broken as never,
      ),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  // Observe calls fail over to the per-isolate tracker, but result calls reach
  // the recovered Durable Object. The local pending marker must still clear,
  // or a failed delivery could not retry until it ages out.
  function flappyAggregatorEnv() {
    return {
      OPS_ALERT_WEBHOOK_URL: secret,
      UPTIME_URL: "https://next.togetherweown.com/up",
      ALERT_AGGREGATOR: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (url: string) =>
            url.endsWith("/observe") || url.endsWith("/health")
              ? new Response(null, { status: 503 })
              : new Response("{}", { status: 200 }),
        }),
      },
    };
  }

  it("a recovered spike-result call clears the local pending marker, so a failed delivery retries", async () => {
    let now = t0;
    let posts = 0;
    const send = vi.fn(async () => {
      posts += 1;
      return new Response(null, { status: posts === 1 ? 500 : 200 });
    });
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => now),
      tracker: new AggregateTracker(() => now),
      now: () => now,
      sleep: async () => {},
    });
    const flappy = flappyAggregatorEnv();
    const burst = (at: number) =>
      Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, at));
    await worker.tail(burst(t0), flappy as never);
    now = t0 + 60_000;
    await worker.tail(burst(t0 + 60_000), flappy as never);
    const receipts = sink.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(receipts).toMatchObject([
      { event: "error.spike", delivery: "ops.alert.delivery_failed" },
      { event: "error.spike", delivery: "ops.alert.delivered" },
    ]);
  });

  it("a recovered health-result call clears the local pending marker, so a failed delivery retries", async () => {
    let now = t0;
    let posts = 0;
    const send = vi.fn(async (...args: [string, RequestInit?]) => {
      const [target, init] = args;
      if (init?.method !== "POST") {
        return healthySynthetic(target) ?? new Response(null, { status: 503 });
      }
      posts += 1;
      return new Response(null, { status: posts === 1 ? 500 : 200 });
    });
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => now),
      tracker: new AggregateTracker(() => now),
      health: new HealthTracker(() => now),
      now: () => now,
      sleep: async () => {},
    });
    const flappy = flappyAggregatorEnv();
    const event = { cron: "* * * * *", scheduledTime: t0, noRetry() {} };
    await worker.scheduled(event, flappy as never);
    now += 61_000;
    await worker.scheduled(event, flappy as never);
    now += 60_000;
    await worker.scheduled(event, flappy as never); // 121 s red: page attempt, POST 500.
    now += 60_000;
    await worker.scheduled(event, flappy as never);
    const receipts = sink.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(receipts).toMatchObject([
      { event: "uptime.down", delivery: "ops.alert.delivery_failed" },
      { event: "uptime.down", delivery: "ops.alert.delivered" },
    ]);
  });

  // The first result call to the real Durable Object fails in flight; the
  // pending marker it would clear must not suppress the delivery retry.
  function failingResultEnv(resultPath: string) {
    const { state } = fakeState();
    const aggregator = new AlertAggregator(state as never);
    let failed = false;
    return {
      OPS_ALERT_WEBHOOK_URL: secret,
      UPTIME_URL: "https://next.togetherweown.com/up",
      ALERT_AGGREGATOR: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            if (url.endsWith(resultPath) && !failed) {
              failed = true;
              return new Response(null, { status: 503 });
            }
            return aggregator.fetch(new Request(url, init));
          },
        }),
      },
    };
  }

  it("retries a failed spike-result call, so a failed delivery pages again on the next burst", async () => {
    let now = t0;
    let posts = 0;
    const send = vi.fn(async () => {
      posts += 1;
      return new Response(null, { status: posts === 1 ? 500 : 200 });
    });
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => now),
      tracker: new AggregateTracker(() => now),
      now: () => now,
      sleep: async () => {},
    });
    const aggEnv = failingResultEnv("/spike-result");
    const burst = (at: number) =>
      Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, at));
    await worker.tail(burst(t0), aggEnv as never);
    now = t0 + 60_000;
    await worker.tail(burst(t0 + 60_000), aggEnv as never);
    const receipts = sink.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(receipts).toMatchObject([
      { event: "error.spike", delivery: "ops.alert.delivery_failed" },
      { event: "error.spike", delivery: "ops.alert.delivered" },
    ]);
  });

  it("retries a failed health-result call, so a failed delivery re-pages on the next red run", async () => {
    let now = t0;
    let posts = 0;
    const send = vi.fn(async (...args: [string, RequestInit?]) => {
      const [target, init] = args;
      if (init?.method !== "POST") {
        return healthySynthetic(target) ?? new Response(null, { status: 503 });
      }
      posts += 1;
      return new Response(null, { status: posts === 1 ? 500 : 200 });
    });
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => now),
      tracker: new AggregateTracker(() => now),
      health: new HealthTracker(() => now),
      now: () => now,
      sleep: async () => {},
    });
    const aggEnv = failingResultEnv("/health-result");
    const event = { cron: "* * * * *", scheduledTime: t0, noRetry() {} };
    await worker.scheduled(event, aggEnv as never);
    now += 61_000;
    await worker.scheduled(event, aggEnv as never);
    now += 60_000;
    await worker.scheduled(event, aggEnv as never); // 121 s red: page attempt, POST 500.
    now += 60_000;
    await worker.scheduled(event, aggEnv as never);
    const receipts = sink.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(receipts).toMatchObject([
      { event: "uptime.down", delivery: "ops.alert.delivery_failed" },
      { event: "uptime.down", delivery: "ops.alert.delivered" },
    ]);
  });
});

describe("delivery-failure and boundary semantics", () => {
  function failingFirstFixture() {
    let now = t0;
    let posts = 0;
    const send = vi.fn(async (...args: [string, RequestInit?]) => {
      const [target, init] = args;
      if (init?.method !== "POST") {
        return healthySynthetic(target) ?? new Response(null, { status: 503 });
      }
      posts += 1;
      return new Response(null, { status: posts === 1 ? 500 : 200 });
    });
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => now),
      tracker: new AggregateTracker(() => now),
      now: () => now,
      sleep: async () => {},
    });
    const receipts = () => sink.mock.calls.map(([line]) => JSON.parse(line as string));
    return {
      worker,
      receipts,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("a failed spike delivery does not consume the cooldown: the next burst retries", async () => {
    const f = failingFirstFixture();
    const burst = (at: number) =>
      Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, at));
    await f.worker.tail(burst(t0), env);
    expect(f.receipts()).toMatchObject([
      { event: "error.spike", delivery: "ops.alert.delivery_failed" },
    ]);
    await f.worker.tail(burst(t0 + 60_000), env);
    expect(f.receipts()[1]).toMatchObject({
      event: "error.spike",
      delivery: "ops.alert.delivered",
    });
  });

  it("a failed uptime delivery re-pages on the next red run instead of waiting out the cooldown", async () => {
    const f = failingFirstFixture();
    const upEnv = {
      OPS_ALERT_WEBHOOK_URL: secret,
      UPTIME_URL: "https://next.togetherweown.com/up",
    };
    const event = { cron: "* * * * *", scheduledTime: t0, noRetry() {} };
    await f.worker.scheduled(event, upEnv);
    f.advance(61_000);
    await f.worker.scheduled(event, upEnv);
    f.advance(60_000);
    await f.worker.scheduled(event, upEnv); // 121 s red: page attempt, POST 500.
    expect(f.receipts()).toMatchObject([
      { event: "uptime.down", delivery: "ops.alert.delivery_failed" },
    ]);
    f.advance(60_000);
    await f.worker.scheduled(event, upEnv);
    expect(f.receipts()[1]).toMatchObject({
      event: "uptime.down",
      delivery: "ops.alert.delivered",
    });
  });

  it("exactly two minutes red does not page yet (the gate is over, not at)", async () => {
    const f = failingFirstFixture();
    const upEnv = {
      OPS_ALERT_WEBHOOK_URL: secret,
      UPTIME_URL: "https://next.togetherweown.com/up",
    };
    const event = { cron: "* * * * *", scheduledTime: t0, noRetry() {} };
    await f.worker.scheduled(event, upEnv);
    f.advance(60_000);
    await f.worker.scheduled(event, upEnv);
    f.advance(60_000); // Exactly 120 s red.
    await f.worker.scheduled(event, upEnv);
    expect(f.receipts()).toEqual([]);
    f.advance(1_000);
    await f.worker.scheduled(event, upEnv);
    expect(f.receipts()[0]).toMatchObject({ event: "uptime.down", down_seconds: 121 });
  });
});

describe("health pending age-out", () => {
  it("an unresolved page attempt stops blocking after one cooldown, like the spike pending", () => {
    const health = new HealthTracker(() => t0);
    expect(health.observe(false, t0)).toBeNull();
    const due = t0 + HEALTH_DOWN_MS + 1_000;
    expect(health.observe(false, due)).toBe(HEALTH_DOWN_MS + 1_000);
    // Result never arrives (lost RPC): still blocked while the attempt is fresh...
    expect(health.observe(false, due + 60_000)).toBeNull();
    // ...but after one cooldown the stale pending ages out and a page is due again.
    expect(health.observe(false, due + HEALTH_COOLDOWN_MS + 1_000)).toBe(
      HEALTH_DOWN_MS + HEALTH_COOLDOWN_MS + 2_000,
    );
  });
});

describe("tail wrangler wiring for the aggregate alarm", () => {
  const tail = readWranglerConfig(readFileSync("tail/wrangler.jsonc", "utf8")) as Record<
    string,
    unknown
  >;

  it("probes health every minute so a two-minute outage is detected in minutes", () => {
    expect(tail.triggers).toEqual({ crons: ["* * * * *"] });
  });

  it("binds the AlertAggregator Durable Object in staging and production with one migration tag", () => {
    const binding = [{ name: "ALERT_AGGREGATOR", class_name: "AlertAggregator" }];
    expect((tail.durable_objects as { bindings: unknown }).bindings).toEqual(binding);
    const production = (tail.env as Record<string, Record<string, unknown>>).production;
    expect((production?.durable_objects as { bindings: unknown } | undefined)?.bindings).toEqual(
      binding,
    );
    expect(tail.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["AlertAggregator"] }]);
    expect(production?.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["AlertAggregator"] },
    ]);
  });
});
