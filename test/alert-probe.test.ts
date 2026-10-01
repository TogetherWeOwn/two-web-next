// route-inventory: POST /__probe/alert
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { QA_HEADER, STAGING_APP_URL } from "../src/qa";
import { consume } from "../src/jobs/consumer";
import type { Env } from "../src/env";
import type { BotClient, EventStore, QueueLedger, UniqueLock } from "../src/jobs/types";
import { createTailWorker } from "../tail/worker";
import { env as baseEnv } from "./helpers/member-data";

const token = "test-only-probe-token";
const staging = { ...baseEnv, APP_URL: STAGING_APP_URL, QA_AUTH_TOKEN: token };
afterEach(() => vi.restoreAllMocks());

function request(env: Env, headers: Record<string, string> = {}, method = "POST") {
  return app.request(new URL("/__probe/alert", env.APP_URL).toString(), {
    method, headers: { origin: new URL(env.APP_URL).origin, [QA_HEADER]: token, ...headers },
  }, env);
}

const noDependencies = () => ({
  // Any accidental DB, lock or bot operation fails this local-fixture test.
  bot: {} as BotClient, events: {} as EventStore, lock: {} as UniqueLock, ledger: {} as QueueLedger,
});

describe("staging alert probe gates", () => {
  it.each([
    { ...staging, APP_URL: "https://togetherweown.com" },
    { ...staging, APP_URL: "https://next.togetherweown.com.evil.test" },
    { ...staging, APP_URL: `${STAGING_APP_URL}/` },
    { ...staging, QA_AUTH_TOKEN: undefined },
    { ...staging, QA_AUTH_TOKEN: "" },
  ])("returns 404 with QA disabled, without sending any job %#", async (env) => {
    const send = vi.fn();
    const res = await request({ ...env, INTERNAL_ACTION_QUEUE: { send } as unknown as Queue });
    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("wrong and absent tokens are byte-identical 404s; GET never probes", async () => {
    const send = vi.fn();
    const env = { ...staging, INTERNAL_ACTION_QUEUE: { send } as unknown as Queue };
    const wrong = await request(env, { [QA_HEADER]: "wrong" });
    const absent = await request(env, { [QA_HEADER]: "" });
    expect(wrong.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await wrong.text()).toBe(await absent.text());
    expect((await request(env, {}, "GET")).status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it("the QA token never bypasses same-origin; deny before queue effects", async () => {
    const send = vi.fn();
    const res = await request({ ...staging, INTERNAL_ACTION_QUEUE: { send } as unknown as Queue }, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross_origin" });
    expect(send).not.toHaveBeenCalled();
  });

  it("throttles authorized probes, while disabled/bad-token calls never reach the counter", async () => {
    const send = vi.fn();
    const store = vi.fn(async () => (async () => [{ n: 10, wait: 30 }]) as never);
    const env = { ...staging, THROTTLE_STORE: store, INTERNAL_ACTION_QUEUE: { send } as unknown as Queue };
    const res = await request(env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(send).not.toHaveBeenCalled();
    expect(store).toHaveBeenCalledOnce();
    store.mockClear();
    expect((await request(env, { [QA_HEADER]: "wrong" })).status).toBe(404);
    expect((await request({ ...env, APP_URL: "https://togetherweown.com" })).status).toBe(404);
    expect(store).not.toHaveBeenCalled();
  });

  it("missing queue is an explicit 503, not a successful probe", async () => {
    expect((await request(staging)).status).toBe(503);
  });
});

describe("local end-to-end probe chain", () => {
  it("real 500 handler + real poisoned consumer produce two redacted delivery receipts", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const queued: unknown[] = [];
    const send = vi.fn(async (body: unknown) => { queued.push(body); });
    const env = { ...staging, INTERNAL_ACTION_QUEUE: { send } as unknown as Queue };
    const response = await request(env);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).not.toContain(token);
    expect(queued).toEqual([{ kind: "alert-probe" }]);

    const ack = vi.fn(), retry = vi.fn();
    await consume({ messages: [{ body: queued[0], attempts: 1, ack, retry }] }, { ...noDependencies(), probeEnabled: true });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    const lines = errors.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('{"level":"critical"'));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "error.alert", fingerprint: "AlertProbeError@/__probe/alert", route: "/__probe/alert" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ event: "queue.failing", job: "AlertProbe", attempts: 1, exception: "AlertProbeError" });

    const webhook = vi.fn(async () => new Response(null, { status: 200 }));
    const receipt = vi.fn();
    const tail = createTailWorker({ fetch: webhook as unknown as typeof fetch, sink: receipt });
    await tail.tail([{ scriptName: "two-web-next", logs: [{ level: "error", message: lines, timestamp: Date.now() }] }],
      { OPS_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789/test-token" });
    expect(webhook).toHaveBeenCalledTimes(2);
    expect(receipt.mock.calls.map(([line]) => JSON.parse(line))).toMatchObject([
      { event: "error.alert", route: "/__probe/alert", delivery: "ops.alert.delivered" },
      { event: "queue.failing", job: "AlertProbe", delivery: "ops.alert.delivered" },
    ]);
  });

  it("a queued synthetic job is silently acked when the consumer QA gate is off", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ack = vi.fn(), retry = vi.fn();
    await consume({ messages: [{ body: { kind: "alert-probe" }, attempts: 1, ack, retry }] }, noDependencies());
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });
});
