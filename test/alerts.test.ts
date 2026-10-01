import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALERT_WINDOW_MS, AlertRateLimit, alertQueueFailing, alertRequestError, fingerprintOf, shouldReport } from "../src/alerts";
import { registerErrorHandlers } from "../src/errors";
import { consume } from "../src/jobs/consumer";
import { CALL_INTERNAL_ACTION, SYNC_EVENT } from "../src/jobs/constants";
import { BotTerminalError } from "../src/jobs/types";
import type { BotClient, EventStore, QueueLedger, UniqueLock } from "../src/jobs/types";

class BoomError extends Error {}

afterEach(() => vi.restoreAllMocks());

describe("dont-report list", () => {
  it("stays silent for 404/403/429 and validation, reports 5xx and plain errors", () => {
    expect(shouldReport(new HTTPException(404))).toBe(false);
    expect(shouldReport(new HTTPException(403))).toBe(false);
    expect(shouldReport(new HTTPException(429))).toBe(false);
    expect(shouldReport(Object.assign(new Error("invalid"), { name: "ZodError" }))).toBe(false);
    expect(shouldReport(new HTTPException(502))).toBe(true);
    expect(shouldReport(new BoomError("x"))).toBe(true);
    expect(shouldReport("string")).toBe(true);
  });
});

describe("rate limit", () => {
  it("one line per fingerprint per 5 minutes, independent across fingerprints", () => {
    let t = 1_000;
    const rl = new AlertRateLimit(ALERT_WINDOW_MS, () => t);
    const lines: string[] = [];
    const sink = (l: string) => void lines.push(l);
    const req = { method: "GET", route: "/a" };
    expect(alertRequestError(new BoomError("x"), req, { limiter: rl, sink })).toBe(true);
    expect(alertRequestError(new BoomError("y"), req, { limiter: rl, sink })).toBe(false);
    expect(alertRequestError(new BoomError("y"), { method: "GET", route: "/b" }, { limiter: rl, sink })).toBe(true);
    t += ALERT_WINDOW_MS - 1;
    expect(alertRequestError(new BoomError("z"), req, { limiter: rl, sink })).toBe(false);
    t += 1;
    expect(alertRequestError(new BoomError("z"), req, { limiter: rl, sink })).toBe(true);
    expect(lines).toHaveLength(3);
  });

  it("emits one single-line JSON critical with the class@route fingerprint and no message", () => {
    const lines: string[] = [];
    alertRequestError(new BoomError("secret INSERT values"), { method: "POST", route: "/join" }, {
      limiter: new AlertRateLimit(),
      sink: (l) => void lines.push(l),
    });
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]).not.toContain("secret");
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "critical",
      event: "error.alert",
      fingerprint: "BoomError@/join",
      exception: "BoomError",
      method: "POST",
      route: "/join",
    });
    expect(fingerprintOf(new BoomError(), "/join")).toBe("BoomError@/join");
  });

  it("stays bounded", () => {
    const rl = new AlertRateLimit(ALERT_WINDOW_MS, () => 1);
    for (let i = 0; i < 2000; i++) rl.allow(`f${i}`);
    expect((rl as unknown as { last: Map<string, number> }).last.size).toBeLessThanOrEqual(500);
  });
});

describe("app wiring", () => {
  it("a throwing route alerts once; a 404 and an HTTPException(403) do not", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new Hono();
    registerErrorHandlers(app as never);
    app.get("/wiring-boom", () => {
      throw new BoomError("nope");
    });
    app.get("/wiring-forbidden", () => {
      throw new HTTPException(403);
    });
    const alerts = () => err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"error.alert"'));

    expect((await app.request("/wiring-boom")).status).toBe(500);
    expect((await app.request("/wiring-boom")).status).toBe(500);
    await app.request("/wiring-forbidden");
    await app.request("/missing");
    expect(alerts()).toHaveLength(1);
    expect(JSON.parse(alerts()[0]!).fingerprint).toBe("BoomError@/wiring-boom");
  });
});

describe("queue.failing", () => {
  const lock: UniqueLock = { acquire: async () => true, release: async () => {} };
  const events = {} as EventStore;
  const ledger = { released: async () => {}, dequeued: async () => {}, failed: async () => {} } as unknown as QueueLedger;
  const msg = (body: unknown, attempts: number) => ({ body, attempts, ack() {}, retry() {} });
  const ann = { kind: "announcement", idempotencyKey: "k", action: { channelKey: "c", body: "b" } };
  const failingLines = (spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] =>
    spy.mock.calls.map((c) => String(c[0])).filter((l: string) => l.includes('"queue.failing"')).map((l: string) => JSON.parse(l));

  it("logs connection/queue/job/attempts/exception on a terminal failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bot = { postAnnouncement: async () => { throw new BotTerminalError("missing secret"); } } as unknown as BotClient;
    await consume({ messages: [msg(ann, 2)] }, { bot, events, lock, ledger });
    expect(failingLines(spy)).toEqual([
      {
        level: "critical",
        event: "queue.failing",
        connection: "cloudflare-queues",
        queue: "two-internal-action",
        job: "CallInternalAction",
        attempts: 2,
        exception: "missing secret",
      },
    ]);
  });

  it("a redeliverable throw alerts only on the final attempt", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bot = { postAnnouncement: async () => { throw new TypeError("boom"); } } as unknown as BotClient;
    await consume({ messages: [msg(ann, CALL_INTERNAL_ACTION.tries - 1)] }, { bot, events, lock, ledger });
    expect(failingLines(spy)).toHaveLength(0);
    await consume({ messages: [msg(ann, CALL_INTERNAL_ACTION.tries)] }, { bot, events, lock, ledger });
    expect(failingLines(spy)).toMatchObject([{ attempts: CALL_INTERNAL_ACTION.tries, exception: "TypeError" }]);
  });

  it("sync-event failures name the sync queue and job", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = () => { throw new TypeError("x"); };
    const store = { find: boom } as unknown as EventStore;
    await consume(
      { messages: [msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k" }, SYNC_EVENT.tries)] },
      { bot: {} as BotClient, events: store, lock, ledger },
    );
    expect(failingLines(spy)).toMatchObject([{ queue: "two-sync-event", job: "SyncEventToDiscord" }]);
  });

  it("alertQueueFailing writes one JSON line", () => {
    const lines: string[] = [];
    alertQueueFailing({ connection: "c", queue: "q", job: "J", attempts: 1, exception: "e" }, (l) => void lines.push(l));
    expect(lines).toHaveLength(1);
  });
});
