// Real signed client -> queue handler -> console, alert and ledger, with fake I/O only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";
import { consume } from "../src/jobs/consumer";
import { CALL_INTERNAL_ACTION } from "../src/jobs/constants";
import type {
  BotClient,
  EventStore,
  QueueLedger,
  QueueMessage,
  SyncAttempt,
} from "../src/jobs/types";
import { captureDiagnosticStream, scanDiagnosticStream } from "./helpers/diagnostic-stream";

const SECRET = "queue-wire-canary-7q3z9w2x";
const BODY = "queue-body-canary-5m8n1p4r";
const UUID = "1e9d2f1a-2b3c-4d5e-8f90-123456789abc";
const LEASE = "5e9d2f1a-2b3c-4d5e-8f90-123456789abc";
const NOW = new Date("2026-10-18T00:00:00Z");
const announcement: QueueMessage = {
  kind: "announcement",
  idempotencyKey: UUID,
  action: { channelKey: "general", body: BODY },
  jobId: "j1",
};
const role: QueueMessage = {
  kind: "role-assign",
  idempotencyKey: null,
  action: { userId: "900000000000009999", roleKey: "rocketleague" },
  jobId: "j1",
};
const sync: QueueMessage = {
  kind: "sync-event",
  eventKey: "e1",
  idempotencyKey: UUID,
  leaseToken: LEASE,
  jobId: "j1",
};

function dependencies(action: "event.upsert" | "event.cancel" = "event.upsert") {
  const attempt: SyncAttempt = {
    idempotencyKey: UUID,
    eventKey: "e1",
    revision: 1,
    mirroredAt: NOW,
    state: "pending",
    requestAttempts: 0,
    nextAttemptAt: NOW,
    discordEventId: "900000000000009998",
    ...(action === "event.cancel"
      ? { action, payload: { eventKey: "e1" } }
      : {
          action,
          payload: {
            eventKey: "e1",
            name: "Fixture",
            startsAt: "2026-10-19T12:00:00Z",
            endsAt: "2026-10-19T13:00:00Z",
            location: "Discord",
            description: BODY,
          },
        }),
  };
  const events = {
    prepareSync: vi.fn<EventStore["prepareSync"]>().mockResolvedValue(attempt),
    claimSync: vi
      .fn<EventStore["claimSync"]>()
      .mockResolvedValue({ ...attempt, requestAttempts: 1 }),
    completeSync: vi.fn<EventStore["completeSync"]>().mockResolvedValue(undefined),
    deferSync: vi.fn<EventStore["deferSync"]>().mockResolvedValue(undefined),
    failSync: vi.fn<EventStore["failSync"]>().mockResolvedValue(undefined),
    needsSync: vi.fn<EventStore["needsSync"]>().mockResolvedValue(false),
    pendingSync: vi.fn<EventStore["pendingSync"]>().mockResolvedValue(null),
    closeFinished: vi.fn<EventStore["closeFinished"]>().mockResolvedValue(0),
    materializeSeries: vi.fn<EventStore["materializeSeries"]>().mockResolvedValue(0),
    staleEventKeys: vi.fn<EventStore["staleEventKeys"]>().mockResolvedValue([]),
  };
  const ledger = {
    enqueued: vi.fn<QueueLedger["enqueued"]>().mockResolvedValue(undefined),
    reserved: vi.fn<QueueLedger["reserved"]>().mockResolvedValue(undefined),
    released: vi.fn<QueueLedger["released"]>().mockResolvedValue(undefined),
    dequeued: vi.fn<QueueLedger["dequeued"]>().mockResolvedValue(undefined),
    failed: vi.fn<QueueLedger["failed"]>().mockResolvedValue(undefined),
  };
  const lock = {
    acquire: vi.fn().mockResolvedValue(LEASE),
    release: vi.fn().mockResolvedValue(undefined),
  };
  return { events, ledger, lock, now: () => NOW };
}

function provider(pick: (init: RequestInit) => string, retryable: boolean, status = 422) {
  let echoed = "";
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    echoed = pick(init!);
    return new Response(
      JSON.stringify({
        ok: false,
        request_id: SECRET,
        error: { code: echoed, message: BODY, retryable },
      }),
      { status, headers: { "content-type": "application/json", "Retry-After": "42" } },
    );
  });
  const bot = createBotClient({
    url: "https://bot.invalid",
    secret: SECRET,
    keyId: "fixture",
    fetchFn,
  });
  return { bot, fetchFn, echoed: () => echoed };
}

const CANARIES: [string, (init: RequestInit) => string][] = [
  ["wire secret", () => SECRET],
  ["body text", () => BODY],
  ["serialized outgoing body", (init) => String(init.body)],
  ["nonce", (init) => new Headers(init.headers).get("X-TWO-Nonce")!],
  ["signature", (init) => new Headers(init.headers).get("X-TWO-Signature")!],
  ["control-bearing code", () => `${SECRET}\r\nforged-record\u0007`],
  ["overlong code", () => `${SECRET}${"x".repeat(4096)}`],
];
const SCENARIOS: {
  label: string;
  body: QueueMessage;
  method: keyof BotClient;
  name: string;
  retryable: boolean;
  attempts: number;
  action?: "event.upsert" | "event.cancel";
}[] = [
  {
    label: "announcement refusal",
    body: announcement,
    method: "postAnnouncement",
    name: "announcement.post",
    retryable: false,
    attempts: 1,
  },
  {
    label: "announcement exhausted",
    body: announcement,
    method: "postAnnouncement",
    name: "announcement.post",
    retryable: true,
    attempts: CALL_INTERNAL_ACTION.tries,
  },
  {
    label: "role refusal",
    body: role,
    method: "assignRole",
    name: "role.assign",
    retryable: false,
    attempts: 1,
  },
  {
    label: "role exhausted",
    body: role,
    method: "assignRole",
    name: "role.assign",
    retryable: true,
    attempts: CALL_INTERNAL_ACTION.tries,
  },
  {
    label: "event upsert refusal",
    body: sync,
    method: "upsertEvent",
    name: "event.upsert for e1",
    retryable: false,
    attempts: 1,
    action: "event.upsert",
  },
  {
    label: "event cancel refusal",
    body: sync,
    method: "cancelEvent",
    name: "event.cancel for e1",
    retryable: false,
    attempts: 1,
    action: "event.cancel",
  },
];

afterEach(() => vi.restoreAllMocks());

describe.each(SCENARIOS)("provider metadata at queue sinks: $label", (scenario) => {
  it.each(CANARIES)(
    "never exposes %s to the failure reason, logs, alert or ledger",
    async (_label, pick) => {
      const records = captureDiagnosticStream();
      const d = dependencies(scenario.action);
      const p = provider(pick, scenario.retryable);
      const call = vi.spyOn(p.bot, scenario.method);
      const m = { body: scenario.body, attempts: scenario.attempts, ack: vi.fn(), retry: vi.fn() };
      await consume({ messages: [m] }, { ...d, bot: p.bot });

      expect(p.fetchFn).toHaveBeenCalledOnce();
      expect(p.echoed().length).toBeGreaterThan(0);
      expect(await call.mock.results[0]!.value).toMatchObject({
        ok: false,
        code: p.echoed(),
        requestId: SECRET,
        retryable: scenario.retryable,
      });
      const reason = scenario.retryable
        ? `The bot refused ${scenario.name} with a retryable \`unknown\` on all ${scenario.attempts} attempts.`
        : `The bot refused ${scenario.name} with \`unknown\``;
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.retry).not.toHaveBeenCalled();
      expect(d.ledger.failed).toHaveBeenCalledExactlyOnceWith(
        "j1",
        scenario.body.kind,
        scenario.action ? "sync-event:e1" : null,
        reason,
      );
      expect(
        records
          .filter((r) => r.channel === "error" && r.args[0] === "job failed")
          .map((r) => r.args),
      ).toEqual([["job failed", scenario.body.kind, reason]]);
      const alerts = records.filter(
        (r) =>
          r.channel === "error" &&
          typeof r.args[0] === "string" &&
          r.args[0].includes('"event":"queue.failing"'),
      );
      expect(alerts).toHaveLength(1);
      expect(JSON.parse(alerts[0]!.args[0] as string)).toMatchObject({
        exception: reason,
        error_class: reason,
        attempts: scenario.attempts,
      });
      expect(scanDiagnosticStream(records, [SECRET, BODY, p.echoed()])).toEqual({
        hits: [],
        incomplete: [],
      });
      expect(d.ledger.released).not.toHaveBeenCalled();
      expect(d.ledger.dequeued).not.toHaveBeenCalled();
      if (scenario.action) {
        expect(d.events.failSync).toHaveBeenCalledExactlyOnceWith(UUID);
        expect(d.lock.release).toHaveBeenCalledExactlyOnceWith("sync-event:e1", LEASE);
      }
    },
  );
});

it.each([SECRET, "rate_limited"])(
  "preserves retry behavior for wire code %s before exhaustion",
  async (code) => {
    const records = captureDiagnosticStream();
    const d = dependencies();
    const p = provider(() => code, true, 429);
    const m = { body: announcement, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await consume({ messages: [m] }, { ...d, bot: p.bot });
    expect(p.fetchFn).toHaveBeenCalledOnce();
    expect(m.retry).toHaveBeenCalledExactlyOnceWith({
      delaySeconds: code === "rate_limited" ? 42 : CALL_INTERNAL_ACTION.backoffSeconds[0],
    });
    expect(m.ack).not.toHaveBeenCalled();
    expect(d.ledger.released).toHaveBeenCalledOnce();
    expect(d.ledger.failed).not.toHaveBeenCalled();
    expect(records.filter((r) => r.channel === "error")).toEqual([]);
    expect(scanDiagnosticStream(records, [SECRET, BODY])).toEqual({ hits: [], incomplete: [] });
  },
);
