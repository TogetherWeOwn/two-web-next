// The jobs worker sends through the real signed bot client (TOG-12401).
//
// Announcement and role-assign go through the actual `handleQueue` entry point
// with fetch and SQL doubles. Sync-event needs an event store, so it runs the same
// `botClientFor(env)` through `consume` with a fake store. Missing BOT_* config
// must end as a terminal, alerting failure, never a success ack.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobsEnv } from "../src/env";
import { consume } from "../src/jobs/consumer";
import type { EventStore, QueueLedger, SyncAttempt, UniqueLock } from "../src/jobs/types";
import { botClientFor, handleQueue } from "../src/jobs/worker";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("postgres", () => ({
  default: () => ({
    begin: (run: (tx: typeof query) => unknown) => run(query),
    end: async () => {},
  }),
}));

const configured = {
  BOT_ENDPOINT_URL: "https://bot-staging.internal.example",
  BOT_KEY_ID: "web-staging",
  BOT_SHARED_SECRET: "fixture-secret",
};
const uuid = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";
const eventKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const envWith = (extra: Partial<JobsEnv> = {}) =>
  ({
    DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
    ...extra,
  }) as unknown as JobsEnv;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
const refusal = (status: number, code: string, retryable: boolean) =>
  json(status, {
    ok: false,
    request_id: "r1",
    error: { code, message: "m", retryable },
  });

function fetchDouble(...responses: Response[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no stubbed response left");
    return next;
  });
  return { fn, seen };
}

const delivery = (body: unknown, attempts = 1) => ({
  body,
  timestamp: new Date(),
  attempts,
  ack: vi.fn(),
  retry: vi.fn(),
});
const announcement = () => ({
  kind: "announcement",
  idempotencyKey: uuid,
  action: { channelKey: "general", body: "hello" },
});
const roleAssign = () => ({
  kind: "role-assign",
  idempotencyKey: null,
  action: { userId: "900000000000009999", roleKey: "rocketleague" },
});
const batch = (...messages: ReturnType<typeof delivery>[]) =>
  ({ messages }) as unknown as MessageBatch<unknown>;

let errors: string[];
const claimRow = { send_attempts: 1, claim_until_ms: 0, channel_alias: "general" };
function claimQuery(text: string) {
  if (text.includes("insert into announcement_send_claims"))
    return [{ ...claimRow, claim_until_ms: Date.now() + 30_000 }];
  if (text.includes("from announcement_send_claims")) return [{}];
  if (text.includes("update announcement_send_claims")) return [claimRow];
  return [];
}
beforeEach(() => {
  query
    .mockReset()
    .mockImplementation(async (parts: TemplateStringsArray) => claimQuery(parts.join("?")));
  errors = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const queueFailingAlerts = () => errors.filter((l) => l.includes('"event":"queue.failing"'));

describe("handleQueue with the live bot client", () => {
  it("signs and sends an announcement with its idempotency key, then acks", async () => {
    const { fn, seen } = fetchDouble(
      json(200, { ok: true, request_id: "r1", result: { message_id: "m1" } }),
    );
    vi.stubGlobal("fetch", fn);
    const m = delivery(announcement());

    await handleQueue(batch(m), envWith(configured));

    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://bot-staging.internal.example/internal/actions");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["X-TWO-Key-Id"]).toBe("web-staging");
    expect(headers["X-TWO-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers["Idempotency-Key"]).toBe(uuid);
    expect(seen[0]!.init.body).toBe(
      '{"action":"announcement.post","channel_key":"general","body":"hello"}',
    );
    expect(queueFailingAlerts()).toEqual([]);
  });

  it.each([
    { idempotencyKey: "not-a-uuid" },
    { action: { channelKey: "alias with spaces", body: "hello" } },
  ])("settles an invalid announcement identity without retrying: %j", async (invalid) => {
    const { fn } = fetchDouble();
    vi.stubGlobal("fetch", fn);
    const failed = vi.fn();
    const claim = vi.fn();
    query.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join("?");
      if (text.includes("insert into queue_failed_jobs")) failed(...values);
      if (text.includes("insert into announcement_send_claims")) claim();
      return claimQuery(text);
    });
    const m = delivery({ ...announcement(), ...invalid, jobId: uuid });
    m.ack.mockImplementation(() => expect(failed).toHaveBeenCalledOnce());

    await handleQueue(batch(m), envWith(configured));

    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it("waits on the committed retry delay without sending on an early duplicate", async () => {
    const { fn, seen } = fetchDouble(
      json(
        429,
        { ok: false, error: { code: "rate_limited", retryable: true } },
        {
          "retry-after": "120",
        },
      ),
      json(200, { ok: true, result: { message_id: "m1" } }),
    );
    vi.stubGlobal("fetch", fn);
    let due = false;
    let delayed = false;
    query.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join("?");
      if (text.includes("update announcement_send_claims") && values[0] === "retryable") {
        expect(values).toContain(120);
        delayed = true;
      }
      if (delayed && !due) {
        if (text.includes("insert into announcement_send_claims")) return [];
        if (text.includes("case when state"))
          return [{ ...claimRow, kind: "retryable", retry_in_seconds: 119 }];
      }
      if (due && text.includes("insert into announcement_send_claims"))
        return [{ ...claimRow, send_attempts: 2, claim_until_ms: Date.now() + 30_000 }];
      return claimQuery(text);
    });
    const first = delivery(announcement());
    await handleQueue(batch(first), envWith(configured));
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 120 });

    const early = delivery(announcement(), 2);
    await handleQueue(batch(early), envWith(configured));
    expect(early.retry).toHaveBeenCalledWith({ delaySeconds: 119 });
    expect(early.ack).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledOnce();

    due = true;
    const eligible = delivery(announcement(), 3);
    await handleQueue(batch(eligible), envWith(configured));
    expect(eligible.ack).toHaveBeenCalledOnce();
    expect(
      seen.map(({ init }) => (init.headers as Record<string, string>)["Idempotency-Key"]),
    ).toEqual([uuid, uuid]);
  });

  it.each([false, true])("persists a hard stop before ack; retryable=%s", async (retryable) => {
    const { fn } = fetchDouble(refusal(409, "needs_reconciliation", retryable));
    vi.stubGlobal("fetch", fn);
    let persisted: unknown[] | undefined;
    query.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join("?");
      if (text.includes("insert into bot_reconciliation_intents")) {
        persisted = values;
        return [{ idempotency_key: uuid }];
      }
      if (persisted) {
        if (text.includes("insert into announcement_send_claims")) return [];
        if (text.includes("from announcement_send_claims"))
          return [{ ...claimRow, kind: "closed" }];
      }
      return claimQuery(text);
    });
    const first = delivery(announcement());
    first.ack.mockImplementation(() => {
      expect(persisted).toEqual([
        uuid,
        "announcement.post",
        "general",
        1,
        "needs_reconciliation",
        409,
      ]);
    });
    await handleQueue(batch(first), envWith(configured));
    const duplicate = delivery(announcement(), 2);
    await handleQueue(batch(duplicate), envWith(configured));
    expect(first.ack).toHaveBeenCalledOnce();
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(duplicate.retry).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("does not contact the bot again when the first hard-stop write fails", async () => {
    const { fn } = fetchDouble(refusal(409, "needs_reconciliation", false));
    vi.stubGlobal("fetch", fn);
    let writes = 0;
    let claimUntil = Date.now() + 30_000;
    const failed = vi.fn();
    query.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join("?");
      if (text.includes("insert into queue_failed_jobs")) failed();
      if (text.includes("insert into bot_reconciliation_intents")) {
        if (++writes === 1) throw new Error("write unavailable");
        expect(values).toEqual([uuid, "announcement.post", "general", 1, null, null]);
        return [{ idempotency_key: uuid }];
      }
      if (writes && text.includes("insert into announcement_send_claims")) return [];
      if (writes && text.includes("case when state"))
        return [
          { ...claimRow, claim_until_ms: claimUntil, kind: claimUntil ? "sending" : "abandoned" },
        ];
      return claimQuery(text);
    });
    const body = { ...announcement(), jobId: uuid };
    const first = delivery(body);
    await handleQueue(batch(first), envWith(configured));
    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();

    const waiting = delivery(body, 2);
    await handleQueue(batch(waiting), envWith(configured));
    expect(waiting.retry).toHaveBeenCalledOnce();
    expect(waiting.ack).not.toHaveBeenCalled();
    claimUntil = 0;
    const redelivery = { ...delivery(body, 3), timestamp: first.timestamp };
    await handleQueue(batch(redelivery), envWith(configured));
    expect(fn).toHaveBeenCalledOnce();
    expect(writes).toBe(2);
    expect(redelivery.ack).toHaveBeenCalledOnce();
  });

  it("does not charge failed claim writes against the bot send budget", async () => {
    const { fn } = fetchDouble(
      json(200, { ok: true, result: { outcome: "assigned" } }),
      refusal(409, "in_progress", true),
    );
    vi.stubGlobal("fetch", fn);
    let claimFailures = 0;
    const record = vi.fn(() => [{ idempotency_key: uuid }]);
    query.mockImplementation(async (parts: TemplateStringsArray) => {
      const text = parts.join("?");
      if (text.includes("insert into announcement_send_claims") && claimFailures++ < 5)
        throw new Error("private SQL context");
      return text.includes("insert into bot_reconciliation_intents") ? record() : claimQuery(text);
    });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const m = delivery(announcement(), attempt);
      const following = delivery(roleAssign());
      await handleQueue(batch(...(attempt === 5 ? [m, following] : [m])), envWith(configured));
      if (attempt === 5) expect(following.ack).toHaveBeenCalledOnce();
      expect(m.retry).toHaveBeenCalledOnce();
      expect(m.ack).not.toHaveBeenCalled();
    }
    expect(fn).toHaveBeenCalledOnce(); // Only the following role assignment.
    expect(queueFailingAlerts()).toHaveLength(1);
    expect(errors.join(" ")).not.toContain("private SQL context");
    const recovered = delivery(announcement(), 6);
    await handleQueue(batch(recovered), envWith(configured));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(record).not.toHaveBeenCalled();
    expect(recovered.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect(recovered.ack).not.toHaveBeenCalled();
  });

  it("signs and sends role.assign without an idempotency key", async () => {
    const { fn, seen } = fetchDouble(
      json(200, {
        ok: true,
        request_id: "r1",
        result: { outcome: "assigned" },
      }),
    );
    vi.stubGlobal("fetch", fn);
    const m = delivery(roleAssign());

    await handleQueue(batch(m), envWith(configured));

    expect(m.ack).toHaveBeenCalledOnce();
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
    expect(headers["X-TWO-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(seen[0]!.init.body).toBe(
      '{"action":"role.assign","discord_id":"900000000000009999","role_key":"rocketleague"}',
    );
  });

  it("retries a transient 5xx and does not ack", async () => {
    const { fn } = fetchDouble(refusal(503, "discord_unavailable", true));
    vi.stubGlobal("fetch", fn);
    const m = delivery(announcement());

    await handleQueue(batch(m), envWith(configured));

    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
    expect(queueFailingAlerts()).toEqual([]);
  });

  it("treats a 5xx with no bot envelope as a transport wait", async () => {
    const { fn } = fetchDouble(new Response("<html>bad gateway</html>", { status: 502 }));
    vi.stubGlobal("fetch", fn);
    const m = delivery(roleAssign());

    await handleQueue(batch(m), envWith(configured));

    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
  });

  it("fails a 4xx refusal terminally: acked once, alerted, never retried", async () => {
    const { fn } = fetchDouble(refusal(400, "malformed", false));
    vi.stubGlobal("fetch", fn);
    const m = delivery(announcement());

    await handleQueue(batch(m), envWith(configured));

    expect(m.retry).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledOnce();
    const alerts = queueFailingAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("malformed");
    const writes = query.mock.calls.filter(([parts]) =>
      parts.join("?").includes("insert into queue_failed_jobs"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.slice(1)).toEqual([
      uuid,
      "announcement",
      null,
      expect.stringContaining("malformed"),
      uuid,
    ]);
  });

  it.each([
    ["BOT_ENDPOINT_URL", { ...configured, BOT_ENDPOINT_URL: undefined }],
    ["BOT_KEY_ID", { ...configured, BOT_KEY_ID: undefined }],
    ["BOT_SHARED_SECRET", { ...configured, BOT_SHARED_SECRET: undefined }],
    ["all BOT_* values", {}],
  ])("missing %s is a terminal alerting failure and sends nothing", async (_name, extra) => {
    const { fn } = fetchDouble();
    vi.stubGlobal("fetch", fn);
    const m = delivery(announcement());

    await handleQueue(batch(m), envWith(extra as Partial<JobsEnv>));

    expect(fn).not.toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
    const alerts = queueFailingAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("BotTerminalError");
    // The secret value and the missing-config message never reach the alert line.
    expect(alerts[0]).not.toContain("fixture-secret");
  });
});

describe("sync-event through the live bot client", () => {
  function attemptFor(action: SyncAttempt["action"]): SyncAttempt {
    const base = {
      idempotencyKey: uuid,
      eventKey,
      revision: 1,
      mirroredAt: new Date("2026-10-01T11:00:00Z"),
      state: "pending" as const,
      requestAttempts: 0,
      nextAttemptAt: new Date("2026-10-01T11:00:00Z"),
    };
    return action === "event.cancel"
      ? { ...base, action, payload: { eventKey } }
      : {
          ...base,
          action,
          payload: {
            eventKey,
            name: "Game night",
            startsAt: "2026-10-01T12:00:00.000Z",
            endsAt: "2026-10-01T13:00:00.000Z",
            location: "Discord",
            description: null,
          },
        };
  }
  function deps(action: SyncAttempt["action"], env: Partial<JobsEnv>, fetchFn: typeof fetch) {
    const events = {
      prepareSync: vi.fn(async () => attemptFor(action)),
      claimSync: vi.fn(async (a: SyncAttempt) => a),
      completeSync: vi.fn(async () => {}),
      deferSync: vi.fn(async () => {}),
      failSync: vi.fn(async () => {}),
      needsSync: async () => false,
      pendingSync: async () => null,
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [],
    } as unknown as EventStore;
    const ledger: QueueLedger = {
      enqueued: vi.fn(async () => {}),
      reserved: vi.fn(async () => {}),
      released: vi.fn(async () => {}),
      dequeued: vi.fn(async () => {}),
      failed: vi.fn(async () => {}),
    };
    const lock: UniqueLock = {
      acquire: vi.fn(async () => "lease"),
      release: vi.fn(async () => {}),
    };
    return { bot: botClientFor(env, fetchFn), events, ledger, lock };
  }
  const carrier = () => ({
    kind: "sync-event",
    eventKey,
    idempotencyKey: uuid,
  });

  it("signs and sends event.upsert, then completes the sync", async () => {
    const { fn, seen } = fetchDouble(
      json(200, {
        ok: true,
        request_id: "r1",
        result: { outcome: "created", event_id: "d1" },
      }),
    );
    const d = deps("event.upsert", configured, fn as unknown as typeof fetch);
    const m = delivery(carrier());

    await consume({ messages: [m] }, d);

    expect(m.ack).toHaveBeenCalledOnce();
    expect(d.events.completeSync).toHaveBeenCalledOnce();
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(uuid);
    expect(headers["X-TWO-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(seen[0]!.init.body as string)).toMatchObject({
      action: "event.upsert",
      event_key: eventKey,
      name: "Game night",
    });
  });

  it("signs and sends event.cancel, then completes the sync", async () => {
    const { fn, seen } = fetchDouble(
      json(200, {
        ok: true,
        request_id: "r1",
        result: { outcome: "cancelled", event_id: "d1" },
      }),
    );
    const d = deps("event.cancel", configured, fn as unknown as typeof fetch);
    const m = delivery(carrier());

    await consume({ messages: [m] }, d);

    expect(m.ack).toHaveBeenCalledOnce();
    expect(d.events.completeSync).toHaveBeenCalledOnce();
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(uuid);
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({
      action: "event.cancel",
      event_key: eventKey,
    });
  });

  it("retries a transient 5xx with the same carrier and does not fail the attempt", async () => {
    const { fn } = fetchDouble(refusal(503, "upstream_timeout", true));
    const d = deps("event.upsert", configured, fn as unknown as typeof fetch);
    const m = delivery(carrier());

    await consume({ messages: [m] }, d);

    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
    expect(d.events.failSync).not.toHaveBeenCalled();
    expect(d.events.completeSync).not.toHaveBeenCalled();
  });

  it("fails a 4xx refusal definitively: attempt failed, acked, alerted", async () => {
    const { fn } = fetchDouble(refusal(403, "action_not_allowed", false));
    const d = deps("event.cancel", configured, fn as unknown as typeof fetch);
    const m = delivery(carrier());

    await consume({ messages: [m] }, d);

    expect(m.retry).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalledOnce();
    expect(d.events.failSync).toHaveBeenCalledWith(uuid);
    expect(queueFailingAlerts()).toHaveLength(1);
  });

  it("missing config is a definitive failure that sends nothing and never completes", async () => {
    const { fn } = fetchDouble();
    const d = deps(
      "event.upsert",
      { ...configured, BOT_SHARED_SECRET: "" },
      fn as unknown as typeof fetch,
    );
    const m = delivery(carrier());

    await consume({ messages: [m] }, d);

    expect(fn).not.toHaveBeenCalled();
    expect(d.events.completeSync).not.toHaveBeenCalled();
    expect(d.events.failSync).toHaveBeenCalledWith(uuid);
    expect(m.retry).not.toHaveBeenCalled();
    const alerts = queueFailingAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("BotTerminalError");
  });
});
