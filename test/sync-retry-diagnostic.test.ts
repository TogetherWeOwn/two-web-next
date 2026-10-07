import { afterEach, describe, expect, it, vi } from "vitest";
import { alertQueueFailing, type FailedJob } from "../src/alerts";
import { consume } from "../src/jobs/consumer";
import { handleSyncEvent } from "../src/jobs/sync-event";
import { projectSyncRetryDiagnostic, syncRetryDiagnostic } from "../src/jobs/sync-retry-diagnostic";
import { BotTransportError, SYNC_RETRY_PERSISTENCE_REASON } from "../src/jobs/types";
import type {
  BotClient,
  BotFailure,
  EventStore,
  QueueLedger,
  SyncAttempt,
  UniqueLock,
} from "../src/jobs/types";

const clock = 1_000_000;
const leaseToken = "11111111-1111-4111-8111-111111111111";
const sentinels = {
  payload: "PAYLOAD_SENTINEL",
  member: "MEMBER_SENTINEL",
  cookie: "COOKIE_SENTINEL",
  headers: "HEADER_SENTINEL",
  eventKey: "RAW_EVENT_KEY_SENTINEL",
  idempotencyKey: "RAW_REQUEST_KEY_SENTINEL",
  jobId: "RAW_CARRIER_KEY_SENTINEL",
  message: "MESSAGE_SENTINEL",
  body: "RESPONSE_BODY_SENTINEL",
  secret: "SECRET_SENTINEL",
};
const hostileText = Object.values(sentinels).join("\n");
const diagnosticKeys = [
  "queue_carrier_attempts",
  "sync_request_attempts",
  "sync_retry_class",
  "sync_retry_code",
  "sync_snapshot_age_at_claim_seconds",
];
const alertKeys = ["attempts", "connection", "event", "exception", "job", "level", "queue"];
const codes = [
  "in_progress",
  "rate_limited",
  "internal",
  "discord_unavailable",
  "upstream_timeout",
];

function fixture(priorRequests = 0, action: "event.upsert" | "event.cancel" = "event.upsert") {
  const attempt: SyncAttempt = {
    eventKey: sentinels.eventKey,
    idempotencyKey: sentinels.idempotencyKey,
    revision: 1,
    mirroredAt: new Date(clock - 12_500),
    state: "pending",
    requestAttempts: priorRequests,
    nextAttemptAt: new Date(0),
    ...(action === "event.cancel"
      ? { action, payload: { eventKey: sentinels.eventKey } }
      : {
          action,
          payload: {
            eventKey: sentinels.eventKey,
            name: sentinels.member,
            startsAt: "2026-10-01T12:00:00Z",
            endsAt: "2026-10-01T13:00:00Z",
            location: sentinels.payload,
            description: hostileText,
          },
        }),
  };
  const events: EventStore = {
    prepareSync: vi.fn(async () => attempt),
    claimSync: vi.fn(async () => {
      attempt.requestAttempts++;
      attempt.nextAttemptAt = null;
      return attempt;
    }),
    deferSync: vi.fn(async (_attempt, deadline) => {
      attempt.nextAttemptAt = deadline;
    }),
    completeSync: vi.fn(async () => {}),
    failSync: vi.fn(async () => {}),
    needsSync: vi.fn(async () => false),
    pendingSync: vi.fn(async () => attempt),
    closeFinished: vi.fn(async () => 0),
    materializeSeries: vi.fn(async () => 0),
    staleEventKeys: vi.fn(async () => []),
  };
  const ledger: QueueLedger = {
    enqueued: vi.fn(async () => {}),
    reserved: vi.fn(async () => {}),
    released: vi.fn(async () => {}),
    dequeued: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
  };
  const lock: UniqueLock = {
    acquire: vi.fn(async () => leaseToken),
    release: vi.fn(async () => {}),
  };
  return { attempt, events, ledger, lock, now: () => new Date(clock) };
}
function carrier(attempts: number) {
  return {
    body: { kind: "sync-event", ...sentinels, leaseToken, requestId: sentinels.secret },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}
function botFor(code: unknown): BotClient {
  const answer = {
    ...sentinels,
    ok: false,
    code,
    status: 429,
    requestId: sentinels.member,
    message: hostileText,
    retryable: true,
    retryAfterSeconds: 42,
  } as unknown as BotFailure;
  return {
    upsertEvent: vi.fn(async () => answer),
    cancelEvent: vi.fn(async () => answer),
  } as unknown as BotClient;
}
function transportBot(): BotClient {
  const fail = vi.fn(async () => {
    throw Object.assign(new BotTransportError(hostileText), sentinels);
  });
  return { upsertEvent: fail, cancelEvent: fail } as unknown as BotClient;
}
function capture() {
  const calls: unknown[][] = [];
  for (const method of ["error", "warn", "info"] as const)
    vi.spyOn(console, method).mockImplementation((...args) => {
      calls.push(args);
    });
  return calls;
}
function alerts(calls: unknown[][]): Record<string, unknown>[] {
  return calls
    .filter(([first]) => typeof first === "string" && first.startsWith("{"))
    .map(([first]) => JSON.parse(first as string));
}
function assertSafe(calls: unknown[][]) {
  const serialized = JSON.stringify(calls);
  for (const sentinel of Object.values(sentinels)) expect(serialized).not.toContain(sentinel);
  for (const args of calls) {
    for (const arg of args) {
      if (typeof arg === "object" && arg !== null)
        expect(
          Object.keys(arg).every((key) => [...diagnosticKeys, "exception"].includes(key)),
        ).toBe(true);
    }
  }
  for (const line of alerts(calls))
    expect(Object.keys(line).every((key) => [...alertKeys, ...diagnosticKeys].includes(key))).toBe(
      true,
    );
}

afterEach(() => vi.restoreAllMocks());

describe("finite sync retry projection", () => {
  it.each(codes)("admits only the exact retryable code %s", (code) => {
    expect(
      projectSyncRetryDiagnostic({
        ...sentinels,
        sync_retry_class: "BotFailure",
        sync_retry_code: code,
      }),
    ).toEqual({ sync_retry_class: "BotFailure", sync_retry_code: code });
  });
  it.each([
    undefined,
    null,
    42,
    true,
    {},
    [],
    new String("rate_limited"),
    "RATE_LIMITED",
    "rate_limited ",
    hostileText,
  ])("uses a constant fallback for missing/unknown/malformed code %#", (code) => {
    expect(
      projectSyncRetryDiagnostic({
        ...sentinels,
        sync_retry_class: "BotFailure",
        sync_retry_code: code,
      }),
    ).toEqual({ sync_retry_class: "BotFailure", sync_retry_code: "unknown" });
  });
  it("omits non-object receipts and never reflects an unknown class or a transport code", () => {
    for (const value of [undefined, null, hostileText, 42, []])
      expect(projectSyncRetryDiagnostic(value)).toEqual({});
    expect(
      projectSyncRetryDiagnostic({ sync_retry_class: hostileText, sync_retry_code: hostileText }),
    ).toEqual({ sync_retry_class: "unknown" });
    expect(
      projectSyncRetryDiagnostic({
        sync_retry_class: "BotTransportError",
        sync_retry_code: "internal",
      }),
    ).toEqual({ sync_retry_class: "BotTransportError" });
  });
  it.each([undefined, null, "6", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, {}])(
    "omits malformed counters and ages %#",
    (value) => {
      expect(
        projectSyncRetryDiagnostic({
          sync_retry_class: "BotFailure",
          queue_carrier_attempts: value,
          sync_request_attempts: value,
          sync_snapshot_age_at_claim_seconds: value,
        }),
      ).toEqual({ sync_retry_class: "BotFailure", sync_retry_code: "unknown" });
    },
  );
  it("keeps zero durable claims/age, not a zero carrier count", () => {
    expect(
      projectSyncRetryDiagnostic({
        sync_retry_class: "BotTransportError",
        queue_carrier_attempts: 0,
        sync_request_attempts: 0,
        sync_snapshot_age_at_claim_seconds: 0,
      }),
    ).toEqual({
      sync_retry_class: "BotTransportError",
      sync_request_attempts: 0,
      sync_snapshot_age_at_claim_seconds: 0,
    });
  });
  it.each([
    undefined,
    null,
    "2026-10-01",
    new Date(NaN),
    new Date(clock + 1),
    Object.create(Date.prototype),
    new Proxy(new Date(clock - 1_000), {}),
  ])("omits unavailable/invalid/future snapshot time %#", (mirroredAt) => {
    const receipt = syncRetryDiagnostic(
      "BotFailure",
      "internal",
      6,
      { requestAttempts: 2, mirroredAt: mirroredAt as Date },
      new Date(clock),
    );
    expect(receipt).toEqual({
      sync_retry_class: "BotFailure",
      sync_retry_code: "internal",
      queue_carrier_attempts: 6,
      sync_request_attempts: 2,
    });
  });
  it.each([
    "queue_carrier_attempts",
    "sync_request_attempts",
    "sync_snapshot_age_at_claim_seconds",
  ])("omits accessor-backed %s without executing it in logs or alerts", (key) => {
    const toJSON = vi.fn(() => sentinels);
    for (const privateValue of [hostileText, { ...sentinels, toJSON }]) {
      for (const surface of ["projection", "alert"]) {
        const read = vi.fn().mockReturnValueOnce(6).mockReturnValue(privateValue);
        const input = Object.defineProperty({ sync_retry_class: "BotTransportError" }, key, {
          get: read,
          enumerable: true,
        });
        const calls: unknown[][] = [];
        if (surface === "projection") {
          const fields = projectSyncRetryDiagnostic(input);
          expect(fields).toEqual({ sync_retry_class: "BotTransportError" });
          calls.push([fields]);
        } else {
          alertQueueFailing(
            {
              connection: "cloudflare-queues",
              queue: "two-sync-event",
              job: "SyncEventToDiscord",
              attempts: 6,
              exception: "constant",
              syncRetry: input,
            } as FailedJob,
            (line) => calls.push([line]),
          );
          expect(alerts(calls)).toHaveLength(1);
          expect(alerts(calls)[0]).toMatchObject({ sync_retry_class: "BotTransportError" });
          expect(alerts(calls)[0]).not.toHaveProperty(key);
        }
        expect(read).not.toHaveBeenCalled();
        expect(toJSON).not.toHaveBeenCalled();
        assertSafe(calls);
      }
    }
  });
  it.each(diagnosticKeys)("a throwing %s accessor cannot suppress the failure alert", (key) => {
    const read = vi.fn(() => {
      throw new Error(hostileText);
    });
    const input = Object.defineProperty(
      {
        sync_retry_class: "BotFailure",
        sync_retry_code: "internal",
        queue_carrier_attempts: 6,
        sync_request_attempts: 2,
        sync_snapshot_age_at_claim_seconds: 12,
      },
      key,
      { get: read, enumerable: true },
    );
    const calls: unknown[][] = [];
    expect(() =>
      alertQueueFailing(
        {
          connection: "cloudflare-queues",
          queue: "two-sync-event",
          job: "SyncEventToDiscord",
          attempts: 6,
          exception: "constant",
          syncRetry: input,
        } as FailedJob,
        (line) => calls.push([line]),
      ),
    ).not.toThrow();
    expect(alerts(calls)).toHaveLength(1);
    expect(alerts(calls)[0]).toMatchObject({ event: "queue.failing", exception: "constant" });
    expect(read).not.toHaveBeenCalled();
    assertSafe(calls);
  });
  it.each(diagnosticKeys)(
    "a throwing %s descriptor trap cannot suppress the failure alert",
    (key) => {
      const input = new Proxy(
        {
          sync_retry_class: "BotFailure",
          sync_retry_code: "internal",
          queue_carrier_attempts: 6,
          sync_request_attempts: 2,
          sync_snapshot_age_at_claim_seconds: 12,
        },
        {
          getOwnPropertyDescriptor(target, property) {
            if (property === key) throw new Error(hostileText);
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
        },
      );
      const calls: unknown[][] = [];
      expect(() =>
        alertQueueFailing(
          {
            connection: "cloudflare-queues",
            queue: "two-sync-event",
            job: "SyncEventToDiscord",
            attempts: 6,
            exception: "constant",
            syncRetry: input,
          } as FailedJob,
          (line) => calls.push([line]),
        ),
      ).not.toThrow();
      expect(alerts(calls)).toHaveLength(1);
      expect(alerts(calls)[0]).toMatchObject({ event: "queue.failing", exception: "constant" });
      assertSafe(calls);
    },
  );
  it("a revoked receipt proxy cannot suppress the failure alert", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(projectSyncRetryDiagnostic(proxy)).toEqual({});
    const calls: unknown[][] = [];
    expect(() =>
      alertQueueFailing(
        {
          connection: "cloudflare-queues",
          queue: "two-sync-event",
          job: "SyncEventToDiscord",
          attempts: 6,
          exception: "constant",
          syncRetry: proxy,
        } as FailedJob,
        (line) => calls.push([line]),
      ),
    ).not.toThrow();
    expect(alerts(calls)).toHaveLength(1);
    for (const key of diagnosticKeys) expect(alerts(calls)[0]).not.toHaveProperty(key);
    assertSafe(calls);
  });
  it("an optional receipt accessor cannot suppress the failure alert or execute private code", () => {
    const read = vi.fn(() => {
      throw new Error(hostileText);
    });
    const job = Object.defineProperty(
      {
        connection: "cloudflare-queues",
        queue: "two-sync-event",
        job: "SyncEventToDiscord",
        attempts: 6,
        exception: "constant",
      },
      "syncRetry",
      { get: read, enumerable: true },
    );
    const calls: unknown[][] = [];
    expect(() => alertQueueFailing(job, (line) => calls.push([line]))).not.toThrow();
    expect(alerts(calls)).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    for (const key of diagnosticKeys) expect(alerts(calls)[0]).not.toHaveProperty(key);
    assertSafe(calls);
  });
  it.each([Object.create(Date.prototype), new Proxy(new Date(clock), {})])(
    "omits only age for an invalid Date-shaped claim clock %#",
    (claimedAt) => {
      expect(
        syncRetryDiagnostic(
          "BotFailure",
          "internal",
          6,
          { requestAttempts: 2, mirroredAt: new Date(clock - 1_000) },
          claimedAt,
        ),
      ).toEqual({
        sync_retry_class: "BotFailure",
        sync_retry_code: "internal",
        queue_carrier_attempts: 6,
        sync_request_attempts: 2,
      });
    },
  );
  it("projects both alert levels explicitly; injected extras and toJSON cannot escape", () => {
    const toJSON = vi.fn(() => sentinels);
    const lines: string[] = [];
    alertQueueFailing(
      {
        ...sentinels,
        toJSON,
        connection: "cloudflare-queues",
        queue: "two-sync-event",
        job: "SyncEventToDiscord",
        attempts: 6,
        exception: "constant",
        requestId: sentinels.secret,
        syncRetry: {
          ...sentinels,
          toJSON,
          sync_retry_class: "BotFailure",
          sync_retry_code: hostileText,
          queue_carrier_attempts: 6,
          sync_request_attempts: 2,
          sync_snapshot_age_at_claim_seconds: 12,
        },
      } as unknown as FailedJob,
      (line) => {
        lines.push(line);
      },
    );
    expect(toJSON).not.toHaveBeenCalled();
    expect(Object.keys(JSON.parse(lines[0]!)).sort()).toEqual(
      [...alertKeys, ...diagnosticKeys].sort(),
    );
    assertSafe(lines.map((line) => [line]));
  });
});

describe("retry diagnostics preserve behavior and survive carrier exhaustion", () => {
  for (const action of ["event.upsert", "event.cancel"] as const) {
    it.each([...codes, undefined, null, hostileText, "future_code"])(
      `${action} keeps refusal cause and privacy at exhaustion (%#)`,
      async (code) => {
        const calls = capture();
        const d = fixture(1, action);
        const m = carrier(6);
        const bot = botFor(code);
        await consume({ messages: [m] }, { ...d, bot });
        const receipt = {
          sync_retry_class: "BotFailure",
          sync_retry_code: codes.includes(code as string) ? code : "unknown",
          queue_carrier_attempts: 6,
          sync_request_attempts: 2,
          sync_snapshot_age_at_claim_seconds: 12,
        };
        expect(calls.find(([label]) => label === "sync retry classified")?.[1]).toEqual(receipt);
        expect(calls.find(([label]) => label === "job failed")).toEqual([
          "job failed",
          "sync-event",
          "carrier exhausted; unresolved identity retained",
        ]);
        expect(alerts(calls)).toEqual([
          {
            level: "critical",
            event: "queue.failing",
            connection: "cloudflare-queues",
            queue: "two-sync-event",
            job: "SyncEventToDiscord",
            attempts: 6,
            exception: "carrier exhausted; unresolved identity retained",
            ...receipt,
          },
        ]);
        expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(
          d.attempt,
          new Date(clock + 42_000),
        );
        expect(d.attempt.state).toBe("pending");
        expect(d.events.failSync).not.toHaveBeenCalled();
        expect(d.events.completeSync).not.toHaveBeenCalled();
        expect(m.ack).toHaveBeenCalledOnce();
        expect(m.retry).not.toHaveBeenCalled();
        expect(d.lock.release).toHaveBeenCalledExactlyOnceWith(
          `sync-event:${sentinels.eventKey}`,
          leaseToken,
        );
        expect(d.ledger.failed).toHaveBeenCalledExactlyOnceWith(
          sentinels.jobId,
          "sync-event",
          `sync-event:${sentinels.eventKey}`,
          "carrier exhausted; unresolved identity retained",
        );
        expect(
          action === "event.upsert" ? bot.upsertEvent : bot.cancelEvent,
        ).toHaveBeenCalledExactlyOnceWith(d.attempt.payload, sentinels.idempotencyKey);
        assertSafe(calls);
      },
    );
    it.each([
      [6, 1],
      [1, 5],
    ])(
      `${action} distinguishes transport with independently exhausted budgets (%s/%s)`,
      async (carrierAttempts, priorRequests) => {
        const calls = capture();
        const d = fixture(priorRequests, action);
        const m = carrier(carrierAttempts);
        await consume({ messages: [m] }, { ...d, bot: transportBot() });
        expect(alerts(calls)[0]).toMatchObject({
          sync_retry_class: "BotTransportError",
          queue_carrier_attempts: carrierAttempts,
          sync_request_attempts: priorRequests + 1,
          sync_snapshot_age_at_claim_seconds: 12,
        });
        expect(alerts(calls)[0]).not.toHaveProperty("sync_retry_code");
        expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(
          d.attempt,
          priorRequests === 5 ? null : new Date(clock + 3_600_000),
        );
        expect(d.attempt.state).toBe("pending");
        expect(d.events.failSync).not.toHaveBeenCalled();
        expect(d.events.completeSync).not.toHaveBeenCalled();
        expect(m.ack).toHaveBeenCalledOnce();
        expect(m.retry).not.toHaveBeenCalled();
        assertSafe(calls);
      },
    );
  }
  for (const path of ["refusal", "transport"] as const) {
    it(`${path} retains the backoff ladder, identity, and retry/ack semantics`, async () => {
      const calls = capture();
      for (const [index, delay] of [10, 60, 300, 900, 3600].entries()) {
        const d = fixture(index);
        const m = carrier(index + 1);
        const bot = path === "refusal" ? botFor("internal") : transportBot();
        if (path === "refusal")
          vi.mocked(bot.upsertEvent).mockResolvedValue({
            ok: false,
            code: "internal",
            status: 500,
            requestId: null,
            message: hostileText,
            retryable: true,
            retryAfterSeconds: null,
          });
        await consume({ messages: [m] }, { ...d, bot });
        expect(m.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: delay });
        expect(m.ack).not.toHaveBeenCalled();
        expect(d.lock.release).not.toHaveBeenCalled();
        expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(
          d.attempt,
          new Date(clock + delay * 1000),
        );
        expect(d.attempt.idempotencyKey).toBe(sentinels.idempotencyKey);
        expect(d.attempt.state).toBe("pending");
      }
      expect(alerts(calls)).toEqual([]);
      assertSafe(calls);
    });
  }
  it.each([false, true])(
    "preserves the known refusal and absolute deadline across persistence failures (%s)",
    async (bothWritesFail) => {
      const calls = capture();
      const d = fixture(1);
      const m = carrier(6);
      const persistenceError = new BotTransportError(hostileText);
      vi.mocked(d.events.deferSync).mockRejectedValueOnce(persistenceError);
      if (bothWritesFail) vi.mocked(d.events.deferSync).mockRejectedValueOnce(persistenceError);
      await consume({ messages: [m] }, { ...d, bot: botFor("rate_limited") });
      expect(d.events.deferSync).toHaveBeenCalledTimes(2);
      expect(vi.mocked(d.events.deferSync).mock.calls.map(([, deadline]) => deadline)).toEqual([
        new Date(clock + 42_000),
        new Date(clock + 42_000),
      ]);
      expect(alerts(calls)[0]).toMatchObject({
        sync_retry_class: "BotFailure",
        sync_retry_code: "rate_limited",
        queue_carrier_attempts: 6,
        sync_request_attempts: 2,
        exception: bothWritesFail ? SYNC_RETRY_PERSISTENCE_REASON : "BotTransportError",
      });
      expect(d.events.failSync).not.toHaveBeenCalled();
      expect(d.events.completeSync).not.toHaveBeenCalled();
      expect(d.attempt.nextAttemptAt).toEqual(bothWritesFail ? null : new Date(clock + 42_000));
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.retry).not.toHaveBeenCalled();
      assertSafe(calls);
    },
  );
  it("does not infer a previous cause or count for a waiting delivery, including a batch sibling", async () => {
    const calls = capture();
    const d = fixture(1);
    vi.mocked(d.events.prepareSync)
      .mockResolvedValueOnce(d.attempt)
      .mockResolvedValueOnce({ waiting: true });
    await consume({ messages: [carrier(6), carrier(6)] }, { ...d, bot: botFor("internal") });
    expect(alerts(calls)).toHaveLength(2);
    for (const key of diagnosticKeys) expect(alerts(calls)[1]).not.toHaveProperty(key);
    expect(alerts(calls)[1]).toMatchObject({
      exception: "waiting carrier exhausted; request remains recoverable",
    });
    assertSafe(calls);
  });
  it.each(["refusal", "transport"])(
    "a throwing diagnostic observer cannot change %s policy",
    async (path) => {
      const d = fixture(1);
      const onRetryDiagnostic = vi.fn(() => {
        throw new BotTransportError(hostileText);
      });
      await expect(
        handleSyncEvent(
          { eventKey: sentinels.eventKey, idempotencyKey: sentinels.idempotencyKey },
          1,
          {
            ...d,
            bot: path === "refusal" ? botFor("internal") : transportBot(),
            onRetryDiagnostic,
          },
        ),
      ).resolves.toEqual({ retryInSeconds: path === "refusal" ? 42 : 60 });
      expect(onRetryDiagnostic).toHaveBeenCalledOnce();
      expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(
        d.attempt,
        new Date(clock + (path === "refusal" ? 42_000 : 60_000)),
      );
      expect(d.attempt.state).toBe("pending");
    },
  );
  it.each([false, true])(
    "a throwing code getter cannot replace the refusal wait (observer %s)",
    async (observed) => {
      const d = fixture(1);
      const readCode = vi.fn(() => {
        throw new BotTransportError(hostileText);
      });
      const answer = {
        ok: false,
        get code() {
          return readCode();
        },
        status: 429,
        requestId: null,
        message: hostileText,
        retryable: true,
        retryAfterSeconds: 42,
      } satisfies BotFailure;
      const bot = botFor("rate_limited");
      vi.mocked(bot.upsertEvent).mockResolvedValue(answer);
      const onRetryDiagnostic = observed ? vi.fn() : undefined;
      await expect(
        handleSyncEvent(
          { eventKey: sentinels.eventKey, idempotencyKey: sentinels.idempotencyKey },
          1,
          { ...d, bot, onRetryDiagnostic },
        ),
      ).resolves.toEqual({ retryInSeconds: 42 });
      expect(readCode).not.toHaveBeenCalled();
      if (onRetryDiagnostic)
        expect(onRetryDiagnostic).toHaveBeenCalledExactlyOnceWith({
          sync_retry_class: "BotFailure",
          sync_retry_code: "unknown",
          queue_carrier_attempts: 1,
          sync_request_attempts: 2,
          sync_snapshot_age_at_claim_seconds: 12,
        });
      expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(
        d.attempt,
        new Date(clock + 42_000),
      );
    },
  );
  it("retains prototype dependency ports instead of dropping them during observation", async () => {
    const calls = capture();
    const d = fixture(1);
    const bot = botFor("internal");
    const deps = Object.assign(
      Object.create({
        get events() {
          return d.events;
        },
        get bot() {
          return bot;
        },
        get now() {
          return d.now;
        },
      }),
      { ledger: d.ledger, lock: d.lock },
    );
    const m = carrier(1);
    await consume({ messages: [m] }, deps);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 42 });
    expect(m.ack).not.toHaveBeenCalled();
    expect(bot.upsertEvent).toHaveBeenCalledExactlyOnceWith(
      d.attempt.payload,
      sentinels.idempotencyKey,
    );
    expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(d.attempt, new Date(clock + 42_000));
    expect(calls.find(([label]) => label === "sync retry classified")?.[1]).toMatchObject({
      sync_retry_class: "BotFailure",
      sync_request_attempts: 2,
    });
    assertSafe(calls);
  });
  it.each(["refusal", "transport"])("contains rejected asynchronous %s observers", async (path) => {
    const d = fixture(1);
    const unhandled = vi.fn();
    const onRetryDiagnostic = vi.fn(async () => {
      throw new BotTransportError(hostileText);
    });
    process.on("unhandledRejection", unhandled);
    try {
      await expect(
        handleSyncEvent(
          { eventKey: sentinels.eventKey, idempotencyKey: sentinels.idempotencyKey },
          1,
          {
            ...d,
            bot: path === "refusal" ? botFor("internal") : transportBot(),
            onRetryDiagnostic,
          },
        ),
      ).resolves.toEqual({ retryInSeconds: path === "refusal" ? 42 : 60 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(onRetryDiagnostic).toHaveBeenCalledOnce();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
  it("does not await a diagnostic observer that never settles", async () => {
    const d = fixture(1);
    const onRetryDiagnostic = vi.fn(() => new Promise<void>(() => {}));
    await expect(
      handleSyncEvent(
        { eventKey: sentinels.eventKey, idempotencyKey: sentinels.idempotencyKey },
        1,
        { ...d, bot: botFor("internal"), onRetryDiagnostic },
      ),
    ).resolves.toEqual({ retryInSeconds: 42 });
    expect(onRetryDiagnostic).toHaveBeenCalledOnce();
    expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(d.attempt, new Date(clock + 42_000));
  });
  it.each(["event.upsert", "event.cancel"] as const)(
    "%s retains cause/counts when the snapshot property is unreadable",
    async (action) => {
      const calls = capture();
      const d = fixture(1, action);
      const read = vi.fn(() => {
        throw new Error(hostileText);
      });
      Object.defineProperty(d.attempt, "mirroredAt", { get: read });
      const m = carrier(6);
      await consume({ messages: [m] }, { ...d, bot: botFor("internal") });
      expect(alerts(calls)[0]).toMatchObject({
        sync_retry_class: "BotFailure",
        sync_retry_code: "internal",
        queue_carrier_attempts: 6,
        sync_request_attempts: 2,
      });
      expect(alerts(calls)[0]).not.toHaveProperty("sync_snapshot_age_at_claim_seconds");
      expect(read).not.toHaveBeenCalled();
      expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(
        d.attempt,
        new Date(clock + 42_000),
      );
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.retry).not.toHaveBeenCalled();
      assertSafe(calls);
    },
  );
  it("diagnostic accessors cannot mutate the authoritative wait or request budget", async () => {
    const d = fixture(1);
    const read = vi.fn(() => {
      answer.retryAfterSeconds = 0;
      d.attempt.requestAttempts = 100;
      return "internal";
    });
    const answer: BotFailure = {
      ok: false,
      get code() {
        return read();
      },
      status: 429,
      requestId: null,
      message: hostileText,
      retryable: true,
      retryAfterSeconds: 42,
    };
    const bot = botFor("internal");
    vi.mocked(bot.upsertEvent).mockResolvedValue(answer);
    const onRetryDiagnostic = vi.fn();
    await expect(
      handleSyncEvent(
        { eventKey: sentinels.eventKey, idempotencyKey: sentinels.idempotencyKey },
        1,
        { ...d, bot, onRetryDiagnostic },
      ),
    ).resolves.toEqual({ retryInSeconds: 42 });
    expect(read).not.toHaveBeenCalled();
    expect(d.attempt.requestAttempts).toBe(2);
    expect(d.events.deferSync).toHaveBeenCalledExactlyOnceWith(d.attempt, new Date(clock + 42_000));
    expect(onRetryDiagnostic).toHaveBeenCalledExactlyOnceWith({
      sync_retry_class: "BotFailure",
      sync_retry_code: "unknown",
      queue_carrier_attempts: 1,
      sync_request_attempts: 2,
      sync_snapshot_age_at_claim_seconds: 12,
    });
  });
  it("keeps the handler outcome contract unchanged and uses the existing claim clock", async () => {
    const d = fixture(1);
    const now = vi.fn(d.now);
    const onRetryDiagnostic = vi.fn();
    await expect(
      handleSyncEvent(
        { eventKey: sentinels.eventKey, idempotencyKey: sentinels.idempotencyKey },
        1,
        { ...d, bot: botFor("internal"), now, onRetryDiagnostic },
      ),
    ).resolves.toEqual({ retryInSeconds: 42 });
    expect(now).toHaveBeenCalledTimes(4);
    expect(d.events.claimSync).toHaveBeenCalledWith(d.attempt, new Date(clock));
    expect(onRetryDiagnostic).toHaveBeenCalledExactlyOnceWith({
      sync_retry_class: "BotFailure",
      sync_retry_code: "internal",
      queue_carrier_attempts: 1,
      sync_request_attempts: 2,
      sync_snapshot_age_at_claim_seconds: 12,
    });
  });
});
