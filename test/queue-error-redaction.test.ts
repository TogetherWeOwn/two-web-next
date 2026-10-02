// TOG-11627: terminal queue alerts and diagnostics are class-only.
// Bot refusal messages, thrown error messages and provider bodies can carry
// tokens, SQL or personal data, so they never reach console output,
// queue.failing or the ledger. Stable failure codes survive (sanitized).
import { afterEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { CALL_INTERNAL_ACTION, SYNC_EVENT } from "../src/jobs/constants";
import { BotTerminalError, BotTransportError } from "../src/jobs/types";
import type { BotClient, EventStore, QueueLedger, UniqueLock } from "../src/jobs/types";

const TOK = "***synthetic-queue-token-9q2z***";
const SQL = "***synthetic-select-secret-4m7x***";
const PII = "***synthetic-member-mail-6k1p***";

// Newline injection: a hostile event key or provider code must not split a
// diagnostic line or forge alert fields.
const SPLIT = "e1\ninjected-field";

function deps(ledger?: QueueLedger): {
  bot: BotClient;
  events: EventStore;
  lock: UniqueLock;
  ledger: QueueLedger;
  failedReasons: string[];
} {
  const failedReasons: string[] = [];
  const store: EventStore = {
    find: async () => ({
      eventKey: "e1",
      mirrored: true,
      payload: {
        eventKey: "e1",
        name: "n",
        startsAt: "s",
        endsAt: null,
        location: "l",
        description: null,
      },
    }),
    recordMirrored: async () => {},
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
  };
  const lock: UniqueLock = { acquire: async () => "lease", release: async () => {} };
  return {
    bot: {} as BotClient,
    events: store,
    lock,
    ledger: ledger ?? {
      enqueued: async () => {},
      reserved: async () => {},
      released: async () => {},
      dequeued: async () => {},
      failed: async (_id, _kind, _key, reason) => void failedReasons.push(reason),
    },
    failedReasons,
  };
}

function msg(body: unknown, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  return lines;
}

const failingLines = (lines: string[]) =>
  lines
    .filter((l) => l.includes('"queue.failing"'))
    .map((l) => JSON.parse(l.slice(l.indexOf("{"))) as Record<string, unknown>);

const leakFree = (...surfaces: unknown[]) => {
  const text = surfaces.map((s) => (typeof s === "string" ? s : JSON.stringify(s))).join("\n");
  expect(text).not.toContain(TOK);
  expect(text).not.toContain(SQL);
  expect(text).not.toContain(PII);
};

afterEach(() => vi.restoreAllMocks());

describe("terminal queue alerts and diagnostics are class-only", () => {
  it("a terminal refusal keeps its code in the alert but drops the provider message", async () => {
    const lines = capture();
    const d = deps();
    const bot = {
      postAnnouncement: async () => ({
        ok: false,
        code: "action_not_allowed",
        status: 403,
        requestId: null,
        message: `refused: ${TOK} ${SQL} ${PII}`,
        retryable: false,
        retryAfterSeconds: null,
      }),
    } as unknown as BotClient;
    const m = msg({
      kind: "announcement",
      idempotencyKey: "k",
      action: { channelKey: "c", body: "b" },
      jobId: "j1",
    });
    await consume({ messages: [m] }, { ...d, bot });
    expect(m.ack).toHaveBeenCalledOnce();
    const failing = failingLines(lines);
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({
      event: "queue.failing",
      queue: "two-internal-action",
      job: "CallInternalAction",
      exception: "The bot refused announcement.post with `action_not_allowed`",
    });
    leakFree(lines, d.failedReasons);
    // The ledger keeps the same bounded classification (not the raw message).
    expect(d.failedReasons).toEqual([
      "The bot refused announcement.post with `action_not_allowed`",
    ]);
  });

  it("a thrown BotTerminalError alerts as its class, never its message", async () => {
    const lines = capture();
    const d = deps();
    const bot = {
      postAnnouncement: async () => {
        throw new BotTerminalError(`missing secret ${TOK} ${PII}`);
      },
    } as unknown as BotClient;
    const m = msg(
      {
        kind: "announcement",
        idempotencyKey: "k",
        action: { channelKey: "c", body: "b" },
        jobId: "j2",
      },
      2,
    );
    await consume({ messages: [m] }, { ...d, bot });
    expect(m.ack).toHaveBeenCalledOnce();
    expect(failingLines(lines)).toMatchObject([{ exception: "BotTerminalError" }]);
    leakFree(lines, d.failedReasons);
  });

  it("an exhausted unexpected throw alerts as its class across sync-event and internal-action", async () => {
    const lines = capture();
    const d = deps();
    const bot = {
      postAnnouncement: async () => {
        throw new TypeError(`boom ${SQL} ${TOK}\nforged-line`);
      },
      upsertEvent: async () => {
        throw new RangeError(`range ${PII}\nforged-line`);
      },
    } as unknown as BotClient;
    const a = msg(
      {
        kind: "announcement",
        idempotencyKey: "k",
        action: { channelKey: "c", body: "b" },
        jobId: "j3",
      },
      CALL_INTERNAL_ACTION.tries,
    );
    const s = msg(
      { kind: "sync-event", eventKey: "e1", idempotencyKey: "k", jobId: "j4" },
      SYNC_EVENT.tries,
    );
    await consume({ messages: [a, s] }, { ...d, bot });
    expect(a.ack).toHaveBeenCalledOnce();
    expect(s.ack).toHaveBeenCalledOnce();
    const failing = failingLines(lines);
    expect(failing).toHaveLength(2);
    expect(failing[0]).toMatchObject({ exception: "TypeError" });
    expect(failing[1]).toMatchObject({ exception: "RangeError" });
    // No second log line per message, and the throw path keeps job identity + attempts.
    expect(failing[0]).toMatchObject({
      queue: "two-internal-action",
      job: "CallInternalAction",
      attempts: CALL_INTERNAL_ACTION.tries,
    });
    expect(failing[1]).toMatchObject({
      queue: "two-sync-event",
      job: "SyncEventToDiscord",
      attempts: SYNC_EVENT.tries,
    });
    leakFree(lines, d.failedReasons);
    // Every captured diagnostics line is single-line: hostile newlines never split the log.
    for (const line of lines) expect(line).not.toContain("\nforged-line");
  });

  it("a sync-event refusal keeps its code with a sanitized scope and drops the provider message", async () => {
    const lines = capture();
    const d = deps();
    const bot = {
      upsertEvent: async () => ({
        ok: false,
        code: "forbidden\ninject",
        status: 403,
        requestId: null,
        message: `denied: ${TOK} ${PII}`,
        retryable: false,
        retryAfterSeconds: null,
      }),
    } as unknown as BotClient;
    const m = msg({ kind: "sync-event", eventKey: SPLIT, idempotencyKey: "k", jobId: "j5" });
    await consume({ messages: [m] }, { ...d, bot });
    expect(m.ack).toHaveBeenCalledOnce();
    const failing = failingLines(lines);
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({
      queue: "two-sync-event",
      exception: "The bot refused event.upsert for e1_injected-field with `forbidden_inject`",
    });
    leakFree(lines, d.failedReasons);
  });

  it("housekeeping diagnostics (ledger, lock, throw) carry classes, never raw text", async () => {
    const lines = capture();
    const ledger: QueueLedger = {
      enqueued: async () => {},
      reserved: async () => {
        throw new Error(`ledger down ${SQL} ${TOK}`);
      },
      released: async () => {},
      dequeued: async () => {},
      failed: async () => {
        throw new Error(`ledger failed write ${PII}`);
      },
    };
    const lock: UniqueLock = {
      acquire: async () => "lease",
      release: async () => {
        throw new Error(`lock DELETE failed ${SQL}\nforged-line`);
      },
    };
    const store = deps().events;
    // An escaping throw (not a transport wait, which the handler absorbs into
    // a "gave up" outcome) to exercise the consumer's throw path end to end.
    const bot = {
      upsertEvent: async () => {
        throw new TypeError(`boom ${SQL} ${TOK}\nforged-line`);
      },
    } as unknown as BotClient;
    const leaseToken = "11111111-1111-4111-8111-111111111111";
    const m = msg(
      { kind: "sync-event", eventKey: "e1", idempotencyKey: "k", leaseToken, jobId: "j6" },
      SYNC_EVENT.tries,
    );
    await consume({ messages: [m] }, { bot, events: store, lock, ledger });
    expect(m.ack).toHaveBeenCalledOnce();
    leakFree(lines);
    const failing = failingLines(lines);
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({
      queue: "two-sync-event",
      job: "SyncEventToDiscord",
      attempts: SYNC_EVENT.tries,
      exception: "TypeError",
    });
    // Lock/ledger diagnostics use the structured class shape, not raw error text
    // (the lock stub throws a plain Error whose message carries SQL + a token).
    expect(lines.filter((l) => l.includes("queue lock release failed"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("queue lock release failed"))[0]).toContain(
      '"exception":"Error"',
    );
    expect(lines.filter((l) => l.includes("queue ledger reserved failed"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("job threw"))).toHaveLength(1);
    for (const line of lines) expect(line).not.toContain("\nforged-line");
  });

  it("retry/ack decisions are unchanged by the redaction", async () => {
    const d = deps();
    const retryable = {
      postAnnouncement: async () => ({
        ok: false,
        code: "slow_down",
        status: 429,
        requestId: null,
        message: `calm down: ${TOK}`,
        retryable: true,
        retryAfterSeconds: 7,
      }),
    } as unknown as BotClient;
    const attempt = msg(
      { kind: "announcement", idempotencyKey: "k", action: { channelKey: "c", body: "b" } },
      1,
    );
    await consume({ messages: [attempt] }, { ...d, bot: retryable });
    expect(attempt.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 7 });
    expect(attempt.ack).not.toHaveBeenCalled();

    // Without a jobId there is no ledger row, so capture the alert reason instead.
    const d2 = deps();
    const terminal = {
      postAnnouncement: async () => ({
        ok: false,
        code: "slow_down",
        status: 429,
        requestId: null,
        message: `still calm: ${PII}`,
        retryable: true,
        retryAfterSeconds: null,
      }),
    } as unknown as BotClient;
    const last = msg(
      {
        kind: "announcement",
        idempotencyKey: "k",
        action: { channelKey: "c", body: "b" },
        jobId: "j7",
      },
      CALL_INTERNAL_ACTION.tries,
    );
    await consume({ messages: [last] }, { ...d2, bot: terminal });
    expect(last.ack).toHaveBeenCalledOnce();
    expect(last.retry).not.toHaveBeenCalled();
    expect(d2.failedReasons).toEqual([
      `The bot refused announcement.post with a retryable \`slow_down\` on all ${CALL_INTERNAL_ACTION.tries} attempts.`,
    ]);
  });
});
