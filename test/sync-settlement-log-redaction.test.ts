// Sync-settlement failure log line is class-only.
//
// `consume()` settles a definitive refusal via `failSync`. That settlement is
// correctness-critical (never ack while it still blocks future revisions), but
// its throw can carry SQL or connection secrets, so the diagnostic line must
// carry the bounded exception class, never the raw message. Mirrors
// `test/queue-error-redaction.test.ts` / `test/bot-client-no-secret-log.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { BotTerminalError } from "../src/jobs/types";
import type { BotClient, EventStore, QueueLedger, UniqueLock } from "../src/jobs/types";

const TOK = "***synthetic-settlement-token-7t3q***";
const SQL = "***synthetic-settlement-sql-2w8m***";

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

function depsWithFailingSettlement(throwValue: unknown): {
  bot: BotClient;
  events: EventStore;
  lock: UniqueLock;
  ledger: QueueLedger;
} {
  const attempt = {
    idempotencyKey: "k-settle",
    eventKey: "e1",
    revision: 1,
    action: "event.upsert" as const,
    payload: {
      eventKey: "e1",
      name: "n",
      startsAt: "s",
      endsAt: null,
      location: "l",
      description: null,
    },
    mirroredAt: new Date(0),
    state: "pending" as const,
    requestAttempts: 0,
    // Due now: `handleSyncEvent` claims and reaches the bot, which throws
    // `BotTerminalError` for a definitive failure that must call `failSync`.
    nextAttemptAt: new Date(0),
  };
  const events: EventStore = {
    prepareSync: async () => attempt,
    claimSync: async () => attempt,
    completeSync: async () => {},
    deferSync: async () => {},
    failSync: async () => {
      throw throwValue;
    },
    needsSync: async () => false,
    pendingSync: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
  };
  const lock: UniqueLock = { acquire: async () => "lease", release: async () => {} };
  const ledger: QueueLedger = {
    enqueued: async () => {},
    reserved: async () => {},
    released: async () => {},
    dequeued: async () => {},
    failed: async () => {},
  };
  // `BotTerminalError` settles definitively without logging its own message,
  // so the only secret carrier in this delivery is the `failSync` throw.
  const bot = {
    upsertEvent: async () => {
      throw new BotTerminalError("terminal trigger");
    },
    cancelEvent: async () => {
      throw new BotTerminalError("terminal trigger");
    },
  } as unknown as BotClient;
  return { bot, events, lock, ledger };
}

afterEach(() => vi.restoreAllMocks());

describe("sync settlement failure log line is class-only", () => {
  it("a throwing failSync retries without logging its SQL/token message", async () => {
    const lines = capture();
    const d = depsWithFailingSettlement(new Error(`settlement down ${SQL} ${TOK}`));
    const m = {
      body: { kind: "sync-event", eventKey: "e1", idempotencyKey: "k-settle" },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consume({ messages: [m] }, { ...d });

    // Settlement failure is correctness-critical: retry, never ack.
    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();

    const settlement = lines.filter((l) => l.includes("sync attempt settlement failed"));
    expect(settlement).toHaveLength(1);
    expect(settlement[0]).toContain('"exception":"Error"');
    for (const line of lines) {
      expect(line).not.toContain(TOK);
      expect(line).not.toContain(SQL);
    }
  });

  it("a non-Error failSync rejection stays class-only too", async () => {
    const lines = capture();
    const d = depsWithFailingSettlement(`settlement down ${SQL} ${TOK}`);
    const m = {
      body: { kind: "sync-event", eventKey: "e1", idempotencyKey: "k-settle" },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consume({ messages: [m] }, { ...d });

    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.includes("sync attempt settlement failed"))).toHaveLength(1);
    for (const line of lines) {
      expect(line).not.toContain(TOK);
      expect(line).not.toContain(SQL);
    }
  });
});
