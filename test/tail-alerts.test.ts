import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ALERT_ROUTES,
  APP_SCRIPT_NAMES,
  DeliveryMute,
  MUTE_MS,
  createTailWorker,
  parseAlert,
} from "../tail/worker";
// @ts-expect-error JSONC comment/trailing-comma stripper has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import { ALERT_WINDOW_MS, AlertRateLimit, alertRequestError } from "../src/alerts";

const timestamp = Date.parse("2026-10-01T00:00:00Z");
const requestAlert = {
  level: "critical",
  event: "error.alert",
  fingerprint: "TypeError@/join",
  route: "/join",
  exception: "TypeError",
  method: "POST",
  message: "password=never-send",
  body: { token: "never-send" },
};
const queueAlert = {
  level: "critical",
  event: "queue.failing",
  job: "CallInternalAction",
  attempts: 6,
  exception: "refused: password=never-send",
  action: { body: "private-message" },
  queue: "private-queue",
};
const trace = (lines: unknown[], at = timestamp, scriptName = "two-web-next", level = "error") => ({
  scriptName,
  logs: [
    {
      message: lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))),
      timestamp: at,
      level,
    },
  ],
});
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const env = { OPS_ALERT_WEBHOOK_URL: secret };

function fixture(status = 200) {
  let now = timestamp;
  const send = vi.fn(async () => new Response(null, { status }));
  const sink = vi.fn();
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink,
    mute: new DeliveryMute(() => now),
  });
  return {
    worker,
    send,
    sink,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Tail alert parser and redaction", () => {
  it("rebuilds the request summary; hashes fingerprints and never copies messages/bodies", async () => {
    const alert = await parseAlert(JSON.stringify(requestAlert), timestamp);
    expect(alert).toEqual({
      event: "error.alert",
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      route: "/join",
      timestamp: "2026-10-01T00:00:00.000Z",
    });
    expect(JSON.stringify(alert)).not.toMatch(/never-send|TypeError|exception|POST/);
    expect(
      await parseAlert(JSON.stringify({ ...requestAlert, message: "different" }), timestamp),
    ).toEqual(alert);
  });

  it("redacts raw paths, query strings, unknown routes and forged fingerprints", async () => {
    for (const route of [
      "/members/private-user",
      "/join?token=never-send",
      "/unknown/never-send",
    ]) {
      const alert = await parseAlert(
        JSON.stringify({ ...requestAlert, route, fingerprint: `never-send@${route}` }),
        timestamp,
      );
      expect(alert?.route).toBe("[redacted]");
      expect(JSON.stringify(alert)).not.toContain("never-send");
    }
  });

  it("queue summaries do not expose refusal messages, queue names or job payloads", async () => {
    expect(await parseAlert(JSON.stringify(queueAlert), timestamp)).toEqual({
      event: "queue.failing",
      fingerprint: "queue.failing@CallInternalAction",
      job: "CallInternalAction",
      attempts: 6,
      timestamp: "2026-10-01T00:00:00.000Z",
    });
  });

  it("preserves reviewed templates but never wildcard middleware paths", () => {
    const inventory = JSON.parse(readFileSync("test/fixtures/route-inventory.json", "utf8")) as {
      path: string;
    }[];
    expect([...ALERT_ROUTES].sort()).toEqual(
      [...new Set(inventory.map((r) => r.path).filter((p) => !p.includes("*")))].sort(),
    );
  });

  it.each([
    null,
    {},
    "not JSON",
    "[]",
    "null",
    "{}",
    JSON.stringify({ ...requestAlert, level: "info" }),
    JSON.stringify({ ...requestAlert, event: "unhandled error" }),
    JSON.stringify({ ...requestAlert, fingerprint: 42 }),
    JSON.stringify({ ...requestAlert, fingerprint: "" }),
    JSON.stringify({ ...requestAlert, route: null }),
    JSON.stringify({ ...queueAlert, job: "private-job-never-send" }),
    JSON.stringify({ ...queueAlert, attempts: -1 }),
    JSON.stringify({ ...queueAlert, attempts: 1.5 }),
    JSON.stringify({ ...queueAlert, attempts: "1" }),
    "x".repeat(16_385),
  ])("ignores malformed or noncritical argument %#", async (line) => {
    expect(await parseAlert(line, timestamp)).toBeNull();
  });

  it.each([NaN, Infinity, 1e20])("rejects invalid timestamps %s", async (at) => {
    expect(await parseAlert(JSON.stringify(requestAlert), at)).toBeNull();
  });
});

describe("Tail delivery", () => {
  it("POSTs only summaries with mentions disabled, confirmation and a bounded timeout", async () => {
    const { worker, send, sink } = fixture();
    await worker.tail(
      [trace(["unhandled error: password=never-send", requestAlert, queueAlert])],
      env,
    );
    expect(send).toHaveBeenCalledTimes(2);
    const calls = send.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe(`${secret}?wait=true`);
    for (const [, init] of calls) {
      expect(init).toMatchObject({
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const payload = JSON.parse(init.body as string);
      expect(payload.allowed_mentions).toEqual({ parse: [] });
      expect(JSON.parse(payload.content)).toMatchObject({
        fingerprint: expect.any(String),
        timestamp: expect.any(String),
      });
      expect(payload.content).not.toMatch(
        /never-send|private-message|private-queue|exception|test-only-token/,
      );
    }
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls.map(([line]) => JSON.parse(line).delivery)).toEqual([
      "ops.alert.delivered",
      "ops.alert.delivered",
    ]);
  });

  it("takes build_sha from the alert line's release fields when the trace has no version tag", async () => {
    // Live traces do not populate scriptVersion.tag (staging drill
    // 2026-10-17): summaries omitted build_sha while the active version
    // tag was the bare deploy SHA. The release-tagged critical line is
    // the surviving SHA source; only an exact 40-hex value passes.
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const { worker, send } = fixture();
    await worker.tail([trace([{ ...requestAlert, build_sha: sha, release: sha }])], env);
    const summary = JSON.parse(
      JSON.parse((send.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
        .content,
    );
    expect(summary.build_sha).toBe(sha);

    const bogus = fixture();
    await bogus.worker.tail([trace([{ ...requestAlert, build_sha: "manual-never-send" }])], env);
    const bogusBody = (bogus.send.mock.calls[0] as unknown as [string, RequestInit])[1]
      .body as string;
    expect(JSON.parse(JSON.parse(bogusBody).content)).not.toHaveProperty("build_sha");
    expect(bogusBody).not.toContain("manual-never-send");
  });

  it("outbound summaries carry only the allowlisted fields for one request and one queue alert", async () => {
    const { worker, send } = fixture();
    await worker.tail([trace([requestAlert, queueAlert])], env);
    expect(send).toHaveBeenCalledTimes(2);
    const summaries = (send.mock.calls as unknown as [string, RequestInit][]).map(([, init]) =>
      JSON.parse(JSON.parse(init.body as string).content),
    );
    const [request, queue] = summaries;
    expect(Object.keys(request).sort()).toEqual([
      "event",
      "fingerprint",
      "logs",
      "route",
      "script",
      "timestamp",
    ]);
    expect(request).toMatchObject({
      event: "error.alert",
      route: "/join",
      script: "two-web-next",
      logs: "Workers & Pages > two-web-next > Observability > Logs",
    });
    // This fixture trace carries no version tag and its log lines carry no
    // release fields, so no SHA is claimed.
    expect(request).not.toHaveProperty("build_sha");
    expect(request.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(queue).sort()).toEqual([
      "attempts",
      "event",
      "fingerprint",
      "job",
      "logs",
      "script",
      "timestamp",
    ]);
    expect(queue).toMatchObject({
      event: "queue.failing",
      fingerprint: "queue.failing@CallInternalAction",
      job: "CallInternalAction",
      attempts: 6,
    });
    for (const summary of summaries) {
      for (const banned of [
        "exception",
        "message",
        "method",
        "stack",
        "request_id",
        "probeId",
        "connection",
        "queue",
        "body",
        "token",
        "headers",
        "url",
        "trace",
      ]) {
        expect(summary).not.toHaveProperty(banned);
      }
      expect(JSON.stringify(summary)).not.toMatch(/never-send|private-message|private-queue/);
    }
  });

  it("mutes each fingerprint for exactly five minutes of source log time, ignoring JSON timestamp fields", async () => {
    const { worker, send, advance } = fixture();
    await worker.tail([trace([requestAlert, requestAlert, queueAlert, queueAlert])], env);
    expect(send).toHaveBeenCalledTimes(2);
    advance(MUTE_MS * 2); // Tail processing clock is not the source window.
    await worker.tail(
      [
        trace(
          [{ ...requestAlert, timestamp: timestamp + 1e9 }, queueAlert],
          timestamp + MUTE_MS - 1,
        ),
      ],
      env,
    );
    expect(send).toHaveBeenCalledTimes(2);
    await worker.tail([trace([requestAlert, queueAlert], timestamp + MUTE_MS)], env);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it.each([0, 3000])(
    "coordinates expiry with the real source limiter despite %i ms processing and 2s delivery delay",
    async (processingDelay) => {
      let sourceTime = timestamp,
        tailTime = timestamp;
      const limiter = new AlertRateLimit(ALERT_WINDOW_MS, () => sourceTime);
      const send = vi.fn(async () => {
        tailTime += 2000;
        return new Response(null, { status: 200 });
      });
      const worker = createTailWorker({
        fetch: send as unknown as typeof fetch,
        sink: vi.fn(),
        mute: new DeliveryMute(() => tailTime),
      });
      const emit = async () => {
        const lines: string[] = [];
        const emitted = alertRequestError(
          new TypeError("private"),
          { method: "POST", route: "/join" },
          {
            limiter,
            sink: (line) => {
              lines.push(line);
            },
          },
        );
        tailTime = sourceTime + processingDelay;
        if (emitted) await worker.tail([trace(lines, sourceTime)], env);
        return emitted;
      };
      expect(await emit()).toBe(true);
      expect(send).toHaveBeenCalledOnce();
      sourceTime += ALERT_WINDOW_MS - 1;
      expect(await emit()).toBe(false);
      sourceTime++;
      expect(await emit()).toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
      sourceTime += ALERT_WINDOW_MS;
      expect(await emit()).toBe(true);
      expect(send).toHaveBeenCalledTimes(3);
    },
  );

  it("concurrent invocations share the in-flight mute", async () => {
    const { worker, send } = fixture();
    await Promise.all([
      worker.tail([trace([requestAlert])], env),
      worker.tail([trace([requestAlert])], env),
    ]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not mute a failed HTTP delivery, and never records it as delivered", async () => {
    const { worker, send, sink } = fixture(429);
    await worker.tail([trace([requestAlert])], env);
    await worker.tail([trace([requestAlert])], env);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      sink.mock.calls.every(([line]) => JSON.parse(line).delivery === "ops.alert.delivery_failed"),
    ).toBe(true);
  });

  it("keeps probe correlation receipt-only and never splits the fixed mute fingerprint", async () => {
    const probeId = "11111111-1111-4111-8111-111111111111";
    const otherId = "22222222-2222-4222-8222-222222222222";
    const lines = (id: string) => [
      {
        ...requestAlert,
        route: "/__probe/alert",
        fingerprint: "AlertProbeError@/__probe/alert",
        probeId: id,
      },
      { ...queueAlert, job: "AlertProbe", probeId: id },
    ];
    const { worker, send, sink } = fixture();
    await worker.tail([trace(lines(probeId))], env);
    expect(sink.mock.calls.map(([line]) => JSON.parse(line).probeId)).toEqual([probeId, probeId]);
    const calls = send.mock.calls as unknown as [string, RequestInit][];
    expect(
      calls.every(
        ([, init]) =>
          !String(init.body).includes(probeId) && !String(init.body).includes("probeId"),
      ),
    ).toBe(true);
    await worker.tail([trace(lines(otherId), timestamp + 1000)], env);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenCalledTimes(2);
    await worker.tail([trace(lines(otherId), timestamp + MUTE_MS)], env);
    expect(send).toHaveBeenCalledTimes(4);
    expect(sink.mock.calls.slice(2).map(([line]) => JSON.parse(line).probeId)).toEqual([
      otherId,
      otherId,
    ]);
  });

  it("drops invalid or unrelated correlation fields from both receipts and payloads", async () => {
    const { worker, send, sink } = fixture();
    await worker.tail(
      [
        trace([
          { ...requestAlert, probeId: "11111111-1111-4111-8111-111111111111" },
          { ...queueAlert, probeId: "11111111-1111-4111-8111-111111111111" },
          {
            ...requestAlert,
            route: "/__probe/alert",
            fingerprint: "AlertProbeError@/__probe/alert",
            probeId: "secret=private",
          },
          { ...queueAlert, job: "AlertProbe", probeId: "secret=private" },
        ]),
      ],
      env,
    );
    expect(send).toHaveBeenCalledTimes(4);
    expect(sink.mock.calls.every(([line]) => !JSON.parse(line).probeId)).toBe(true);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("private");
  });

  it("swallows transport exceptions without leaking webhook credentials", async () => {
    const sink = vi.fn();
    const send = vi.fn(async () => {
      throw new Error(`failed fetching ${secret}`);
    });
    const worker = createTailWorker({ fetch: send as unknown as typeof fetch, sink });
    await expect(worker.tail([trace([queueAlert])], env)).resolves.toBeUndefined();
    expect(sink.mock.calls[0]![0]).not.toMatch(/test-only-token|never-send/);
    expect(JSON.parse(sink.mock.calls[0]![0]).delivery).toBe("ops.alert.delivery_failed");
  });

  it.each([
    undefined,
    "",
    "broken",
    "http://discord.com/api/webhooks/1/token",
    "https://evil.test/api/webhooks/1/token",
    "https://user:pass@discord.com/api/webhooks/1/token",
    "https://discord.com:444/api/webhooks/1/token",
    "https://discord.com/api/webhooks/1/token/messages/2",
  ])("missing/invalid secret is a silent no-op %#", async (OPS_ALERT_WEBHOOK_URL) => {
    const { worker, send, sink } = fixture();
    await worker.tail([trace([requestAlert, queueAlert])], { OPS_ALERT_WEBHOOK_URL });
    expect(send).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it("ignores foreign Workers, Tail recursion and non-error console levels", async () => {
    const { worker, send } = fixture();
    await worker.tail(
      [
        trace([requestAlert], timestamp, "two-web-next-alerts"),
        trace([requestAlert], timestamp, "other"),
        trace([requestAlert], timestamp, "two-web-next", "log"),
      ],
      env,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("pages production script traces exactly like staging ones", async () => {
    const { worker, send } = fixture();
    await worker.tail([trace([requestAlert], timestamp, "two-web-next-production")], env);
    expect(send).toHaveBeenCalledTimes(1);
    const calls = send.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe(`${secret}?wait=true`);
    expect(JSON.parse(JSON.parse(calls[0]![1].body as string).content)).toMatchObject({
      event: "error.alert",
      route: "/join",
    });
  });

  it("accepts only the staging, production and jobs app scripts, never a prefix of them", async () => {
    expect([...APP_SCRIPT_NAMES].sort()).toEqual([
      "two-web-jobs",
      "two-web-jobs-production",
      "two-web-next",
      "two-web-next-production",
    ]);
    const { worker, send } = fixture();
    await worker.tail(
      [
        trace([requestAlert], timestamp, "two-web-next-production-evil"),
        trace([requestAlert], timestamp, "two-web-nextx"),
        trace([requestAlert], timestamp, "other"),
      ],
      env,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
describe("Tail scheduled uptime prober", () => {
  const uptime = "https://next.togetherweown.com/up";
  const upEnv = { OPS_ALERT_WEBHOOK_URL: secret, UPTIME_URL: uptime };
  type Probe = {
    status?: number;
    origin?: string | null;
    contentType?: string | null;
    location?: string | null;
    throw?: unknown;
  };

  // Healthy synthetic answers per path, mirroring the verified staging
  // responses. There is deliberately no /auth/discord answer: the prober
  // must never request that state-minting hop (the healthy-run test below
  // pins the exact probed path list).
  const healthySynthetic = (path: string): Probe => {
    if (path === "/login") return { status: 302, location: "/auth/discord" };
    return { status: 200, contentType: "text/html; charset=UTF-8" };
  };

  function uptimeFixture(probes: Probe[], synthetic: Partial<Record<string, Probe[]>> = {}) {
    let now = timestamp;
    const sleeps: number[] = [];
    const queue = [...probes];
    let last: Probe = { status: 500 };
    const syntheticQueues = new Map(
      Object.entries(synthetic).map(([path, list]) => [path, [...(list ?? [])]]),
    );
    const send = vi.fn(async (...args: [string, RequestInit?]) => {
      const [target, init] = args;
      if (init?.method === "POST") return new Response(null, { status: 200 });
      const path = new URL(target).pathname;
      let next: Probe;
      if (path === "/up") {
        // Later cron runs repeat the last probe shape: health stays as set up.
        next = queue.shift() ?? last;
        last = next;
      } else {
        next = syntheticQueues.get(path)?.shift() ?? healthySynthetic(path);
      }
      if (next.throw) throw next.throw;
      const headers: Record<string, string> = {};
      if (next.origin != null) headers["x-two-origin"] = next.origin;
      if (next.contentType != null) headers["content-type"] = next.contentType;
      if (next.location != null) headers.location = next.location;
      return new Response(null, {
        status: next.status ?? 200,
        headers: Object.keys(headers).length ? headers : undefined,
      });
    });
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => now),
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const event = { cron: "* * * * *", scheduledTime: timestamp, noRetry() {} };
    return {
      worker,
      send,
      sink,
      sleeps,
      event,
      advance: (ms: number) => {
        now += ms;
        event.scheduledTime += ms; // The next cron slot is later by the same step.
      },
    };
  }

  const probeGets = (send: ReturnType<typeof vi.fn>) =>
    (send.mock.calls as unknown as [string, RequestInit][]).filter(
      ([, init]) => init?.method !== "POST",
    );
  const getsFor = (send: ReturnType<typeof vi.fn>, path: string) =>
    probeGets(send).filter(([target]) => new URL(target).pathname === path);
  const pagePosts = (send: ReturnType<typeof vi.fn>) =>
    (send.mock.calls as unknown as [string, RequestInit][]).filter(
      ([, init]) => init?.method === "POST",
    );

  // Three failing one-minute runs: health red for 121 s, past the >2 min gate.
  async function runDownPastGate(fx: ReturnType<typeof uptimeFixture>) {
    await fx.worker.scheduled(fx.event, upEnv);
    fx.advance(60_000);
    await fx.worker.scheduled(fx.event, upEnv);
    fx.advance(61_000);
    await fx.worker.scheduled(fx.event, upEnv);
  }

  it("one failure then a success sends no page, with the retry at least 10 s later", async () => {
    const { worker, send, sink, sleeps, event } = uptimeFixture([
      { status: 500 },
      { status: 200, origin: "two-web-next" },
    ]);
    await worker.scheduled(event, upEnv);
    expect(getsFor(send, "/up")).toHaveLength(2);
    expect(pagePosts(send)).toHaveLength(0);
    expect(sleeps).toEqual([10_000]);
    expect(sink).not.toHaveBeenCalled();
  });

  it("health red for over two minutes sends one allowlisted page", async () => {
    const fx = uptimeFixture([{ status: 500 }, { status: 503 }]);
    const { send, sink } = fx;
    await fx.worker.scheduled(fx.event, upEnv);
    expect(pagePosts(send)).toHaveLength(0); // First red run: window just opened.
    fx.advance(60_000);
    await fx.worker.scheduled(fx.event, upEnv);
    expect(pagePosts(send)).toHaveLength(0);
    fx.advance(61_000);
    await fx.worker.scheduled(fx.event, upEnv);
    const pages = pagePosts(send);
    expect(pages).toHaveLength(1);
    expect(pages[0]![0]).toBe(`${secret}?wait=true`);
    const payload = JSON.parse(pages[0]![1].body as string);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.parse(payload.content)).toEqual({
      event: "uptime.down",
      status: 503,
      down_seconds: 121,
      timestamp: expect.any(String),
    });
    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.parse(sink.mock.calls[0]![0])).toMatchObject({
      event: "uptime.down",
      delivery: "ops.alert.delivered",
    });
  });

  it("a still-red run inside the cooldown does not re-page", async () => {
    const fx = uptimeFixture([{ status: 500 }, { status: 500 }]);
    await runDownPastGate(fx);
    expect(pagePosts(fx.send)).toHaveLength(1);
    fx.advance(60_000);
    await fx.worker.scheduled(fx.event, upEnv);
    expect(pagePosts(fx.send)).toHaveLength(1);
  });

  it.each([
    { OPS_ALERT_WEBHOOK_URL: undefined, UPTIME_URL: uptime },
    { OPS_ALERT_WEBHOOK_URL: secret },
    {},
  ])("missing webhook or target is a silent no-op %#: no probing, no logging", async (env) => {
    const { worker, send, sink, event } = uptimeFixture([{ status: 200, origin: "two-web-next" }]);
    await worker.scheduled(event, env);
    expect(send).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it("a timeout counts as a failure", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const fx = uptimeFixture([{ throw: timeout }, { throw: timeout }]);
    await runDownPastGate(fx);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    expect(JSON.parse(JSON.parse(pages[0]![1].body as string).content)).toEqual({
      event: "uptime.down",
      status: 0,
      down_seconds: 121,
      timestamp: expect.any(String),
    });
  });

  it.each([
    { status: 200, origin: null, label: "missing x-two-origin" },
    { status: 200, origin: "evil.test", label: "wrong x-two-origin" },
    { status: 503, origin: "two-web-next", label: "non-200 status" },
  ])(
    "a 200 without the origin header or $label pages once red over two minutes",
    async ({ status, origin }) => {
      const fx = uptimeFixture([
        { status, origin },
        { status, origin },
      ]);
      await runDownPastGate(fx);
      const pages = pagePosts(fx.send);
      expect(pages).toHaveLength(1);
      expect(JSON.parse(JSON.parse(pages[0]![1].body as string).content).status).toBe(status);
    },
  );

  it("a healthy first probe makes no second attempt", async () => {
    const { worker, send, sleeps, event } = uptimeFixture([
      { status: 200, origin: "two-web-next" },
    ]);
    await worker.scheduled(event, upEnv);
    expect(getsFor(send, "/up")).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it("a fully healthy run probes /up and every synthetic check once and stays silent", async () => {
    const { worker, send, sink, sleeps, event } = uptimeFixture([
      { status: 200, origin: "two-web-next" },
    ]);
    await worker.scheduled(event, upEnv);
    expect(probeGets(send).map(([target]) => new URL(target).pathname)).toEqual([
      "/up",
      "/",
      "/events",
      "/join",
      "/login",
    ]);
    // Every probe is an anonymous GET that never follows a redirect into a
    // login flow, and the sign-in check stops at /login: /auth/discord
    // mints OAuth state (throttle hit + journey row), so probing it would
    // not stay passive in production. The conversion check likewise stops
    // at the /join page and never requests /join/discord.
    for (const [, init] of probeGets(send)) {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
    }
    expect(pagePosts(send)).toHaveLength(0);
    expect(sink).not.toHaveBeenCalled();
    expect(sleeps).toHaveLength(0);
  });

  it("one synthetic failure then a success sends no page, retrying only that check", async () => {
    const { worker, send, sink, sleeps, event } = uptimeFixture(
      [{ status: 200, origin: "two-web-next" }],
      { "/events": [{ status: 500 }, { status: 200, contentType: "text/html" }] },
    );
    await worker.scheduled(event, upEnv);
    expect(getsFor(send, "/events")).toHaveLength(2);
    expect(getsFor(send, "/")).toHaveLength(1);
    expect(getsFor(send, "/login")).toHaveLength(1);
    expect(sleeps).toEqual([10_000]);
    expect(pagePosts(send)).toHaveLength(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it("a synthetic check failing twice pages synthetic.down with the target host", async () => {
    const { worker, send, sink, event } = uptimeFixture([{ status: 200, origin: "two-web-next" }], {
      "/events": [{ status: 500 }, { status: 503 }],
    });
    await worker.scheduled(event, upEnv);
    const pages = pagePosts(send);
    expect(pages).toHaveLength(1);
    expect(pages[0]![0]).toBe(`${secret}?wait=true`);
    const payload = JSON.parse(pages[0]![1].body as string);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.parse(payload.content)).toEqual({
      event: "synthetic.down",
      check: "/events",
      target: "next.togetherweown.com",
      status: 503,
      timestamp: expect.any(String),
    });
    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.parse(sink.mock.calls[0]![0])).toMatchObject({
      event: "synthetic.down",
      check: "/events",
      delivery: "ops.alert.delivered",
    });
  });

  it.each([
    {
      path: "/login",
      probe: { status: 302, location: "/" },
      label: "login redirecting somewhere other than the Discord sign-in entry",
    },
    {
      path: "/login",
      probe: { status: 200, contentType: "text/html" },
      label: "login no longer redirecting to sign-in",
    },
    {
      path: "/login",
      probe: {
        status: 302,
        location: "https://evil.example/auth/discord?state=fixture-state-value",
      },
      label: "login redirecting the sign-in entry to a foreign host",
    },
    {
      path: "/",
      probe: { status: 200, contentType: "application/json" },
      label: "homepage answering non-HTML",
    },
  ])("$label pages synthetic.down for $path", async ({ path, probe }) => {
    const { worker, send, sink, event } = uptimeFixture([{ status: 200, origin: "two-web-next" }], {
      [path]: [probe, probe],
    });
    await worker.scheduled(event, upEnv);
    const pages = pagePosts(send);
    expect(pages).toHaveLength(1);
    const content = JSON.parse(pages[0]![1].body as string).content as string;
    expect(JSON.parse(content)).toMatchObject({ event: "synthetic.down", check: path });
    // Nothing from a Location header's query ever leaves the account:
    // not in the page, not in the delivery receipt.
    expect(content).not.toContain("fixture-state-value");
    expect(sink.mock.calls[0]![0]).not.toContain("fixture-state-value");
  });

  it("each persistently failing synthetic check pages once, independently muted", async () => {
    const { worker, send, event } = uptimeFixture(
      [
        { status: 200, origin: "two-web-next" },
        { status: 200, origin: "two-web-next" },
      ],
      {
        "/": [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }],
        "/events": [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }],
      },
    );
    await worker.scheduled(event, upEnv);
    await worker.scheduled(event, upEnv);
    const pages = pagePosts(send);
    expect(pages).toHaveLength(2);
    const checks = pages.map(
      (page) => JSON.parse(JSON.parse(page[1].body as string).content).check,
    );
    expect(checks.sort()).toEqual(["/", "/events"]);
  });

  it("a synthetic check flapping to a different failing status within the mute window stays muted", async () => {
    const { worker, send, sink, event } = uptimeFixture(
      [
        { status: 200, origin: "two-web-next" },
        { status: 200, origin: "two-web-next" },
      ],
      {
        "/events": [{ status: 500 }, { status: 500 }, { status: 503 }, { status: 503 }],
      },
    );
    await worker.scheduled(event, upEnv);
    const firstPages = pagePosts(send);
    expect(firstPages).toHaveLength(1);
    expect(JSON.parse(JSON.parse(firstPages[0]![1].body as string).content)).toEqual({
      event: "synthetic.down",
      check: "/events",
      target: "next.togetherweown.com",
      status: 500,
      timestamp: expect.any(String),
    });

    // Same check, still inside the mute window, now failing as 503: the
    // status carried in the page must not split the mute, or one flapping
    // check re-pages on every status change.
    await worker.scheduled(event, upEnv);
    expect(getsFor(send, "/events")).toHaveLength(4);
    expect(pagePosts(send)).toHaveLength(1);
    expect(sink).toHaveBeenCalledOnce();
  });

  it("a flapped synthetic check pages again once the mute window expires", async () => {
    const fx = uptimeFixture(
      [
        { status: 200, origin: "two-web-next" },
        { status: 200, origin: "two-web-next" },
        { status: 200, origin: "two-web-next" },
      ],
      {
        "/events": [
          { status: 500 },
          { status: 500 },
          { status: 503 },
          { status: 503 },
          { status: 503 },
          { status: 503 },
        ],
      },
    );
    await fx.worker.scheduled(fx.event, upEnv);
    await fx.worker.scheduled(fx.event, upEnv);
    expect(pagePosts(fx.send)).toHaveLength(1);

    fx.advance(MUTE_MS);
    await fx.worker.scheduled(fx.event, upEnv);
    expect(getsFor(fx.send, "/events")).toHaveLength(6);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(2);
    expect(JSON.parse(JSON.parse(pages[1]![1].body as string).content)).toEqual({
      event: "synthetic.down",
      check: "/events",
      target: "next.togetherweown.com",
      status: 503,
      timestamp: expect.any(String),
    });
    expect(fx.sink).toHaveBeenCalledTimes(2);
  });

  it("synthetic checks still run and page when /up is down", async () => {
    const fx = uptimeFixture([{ status: 500 }, { status: 500 }], {
      "/login": [
        { status: 302, location: "/" },
        { status: 302, location: "/" },
      ],
    });
    // The synthetic page lands on the first (five-minute-boundary) run; the
    // uptime page follows once health has stayed red for over two minutes.
    await runDownPastGate(fx);
    const events = pagePosts(fx.send).map(
      (page) => JSON.parse(JSON.parse(page[1].body as string).content).event,
    );
    expect(events.sort()).toEqual(["synthetic.down", "uptime.down"]);
  });

  it("a run off the five-minute boundary probes /up only, not the synthetics", async () => {
    const fx = uptimeFixture([{ status: 200, origin: "two-web-next" }]);
    fx.advance(60_000); // 00:01 — inside the five-minute synthetic interval.
    await fx.worker.scheduled(fx.event, upEnv);
    expect(probeGets(fx.send).map(([target]) => new URL(target).pathname)).toEqual(["/up"]);
    expect(pagePosts(fx.send)).toHaveLength(0);
  });

  it("a boundary run that starts late still probes the synthetics, keyed to the scheduled slot", async () => {
    const fx = uptimeFixture([{ status: 200, origin: "two-web-next" }]);
    fx.advance(60_000); // Handler starts at 00:01 for the 00:00 cron slot.
    await fx.worker.scheduled({ ...fx.event, scheduledTime: timestamp }, upEnv);
    expect(probeGets(fx.send).map(([target]) => new URL(target).pathname)).toEqual([
      "/up",
      "/",
      "/events",
      "/join",
      "/login",
    ]);
  });
});

describe("Tail delivery memory accounting", () => {
  it("caps memory, evicts old sent entries and expires the window", () => {
    let now = 0;
    const mute = new DeliveryMute(() => now);
    for (let i = 0; i < 501; i++) {
      expect(mute.begin(`f${i}`)).toBe(true);
      mute.finish(`f${i}`, true);
    }
    expect(mute.begin("f0")).toBe(true); // Oldest successful entry evicted.
    mute.finish("f0", false);
    for (let i = 0; i < 500; i++) expect(mute.begin(`pending${i}`)).toBe(true);
    expect(mute.begin("overflow")).toBe(false);
    mute.finish("pending0", false);
    expect(mute.begin("overflow")).toBe(true);
    mute.finish("overflow", false);
    now += MUTE_MS;
    expect(mute.begin("f500")).toBe(true);
  });
});

describe("Production Tail pager wiring", () => {
  it("env.production consumes the production alerts Worker, not the staging one", () => {
    const app = readWranglerConfig(readFileSync("wrangler.jsonc", "utf8")) as Record<
      string,
      unknown
    >;
    const production = (app.env as Record<string, Record<string, unknown> | undefined>).production;
    expect(production?.tail_consumers).toEqual([{ service: "two-web-next-alerts-production" }]);
    // The top-level staging consumer is untouched by the production wiring.
    expect(app.tail_consumers).toEqual([{ service: "two-web-next-alerts" }]);
  });

  it("the production alerts Worker exists under its own name with no staging leakage", () => {
    const tail = readWranglerConfig(readFileSync("tail/wrangler.jsonc", "utf8")) as Record<
      string,
      unknown
    >;
    expect(tail.name).toBe("two-web-next-alerts");
    const production = (tail.env as Record<string, Record<string, unknown> | undefined>).production;
    expect(production?.name).toBe("two-web-next-alerts-production");
    expect(production?.tail_consumers).toBeUndefined();
    expect(production?.workers_dev).toBe(false);
  });

  it("the production prober targets the apex /up, never the staging URL", () => {
    const tail = readWranglerConfig(readFileSync("tail/wrangler.jsonc", "utf8")) as Record<
      string,
      unknown
    >;
    const production = (tail.env as Record<string, Record<string, unknown> | undefined>).production;
    expect((production?.vars as Record<string, unknown> | undefined)?.UPTIME_URL).toBe(
      "https://togetherweown.com/up",
    );
    // Wrangler does not inherit top-level vars: the staging default stays
    // staging-only and cannot leak into production.
    expect((tail.vars as Record<string, unknown> | undefined)?.UPTIME_URL).toBe(
      "https://next.togetherweown.com/up",
    );
  });

  it("the staging jobs Worker pages through the staging alerts Worker", async () => {
    const jobs = readWranglerConfig(readFileSync("wrangler.jobs.jsonc", "utf8")) as Record<
      string,
      unknown
    >;
    expect(jobs.tail_consumers).toEqual([{ service: "two-web-next-alerts" }]);
    // The jobs script name is accepted, so its queue.failing traces page.
    expect([...APP_SCRIPT_NAMES]).toContain("two-web-jobs");
    const { worker, send } = fixture();
    await worker.tail([trace([queueAlert], timestamp, "two-web-jobs")], env);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("CI dry-run builds the production Tail Worker with --env production", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const checkJob = ci.slice(ci.indexOf("  check:\n"));
    const scope =
      "if: (needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.draft != 'true') && (needs.scope.outputs.full == 'true' || needs.scope.outputs.app == 'true' || needs.scope.outputs.worker == 'true')";
    // Both dry runs share the same scope: the production env builds on
    // app/worker/full runs only, never on docs-only or draft fast passes.
    expect(checkJob).toContain(
      `${scope}\n        run: npx wrangler deploy --config tail/wrangler.jsonc --dry-run --outdir ../dist-tail`,
    );
    expect(checkJob).toContain(
      `${scope}\n        run: npx wrangler deploy --config tail/wrangler.jsonc --env production --dry-run --outdir ../dist-tail-production`,
    );
  });
});
