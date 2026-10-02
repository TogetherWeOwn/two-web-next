import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ALERT_ROUTES, DeliveryMute, MUTE_MS, createTailWorker, parseAlert } from "../tail/worker";
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
        redirect: "error",
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
