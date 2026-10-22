// Worker delivery of dashboard settings writes (moderation slice).
//
// The dashboard queues one settings-set carrier per accepted write; the
// consumer posts it to the bot's settings.set and dispositions like every
// other internal action (deadline, backoff, terminal-vs-retryable). The
// envelope admits exactly the dashboard's carrier shape: any other verb,
// key shape, or version type is a malformed carrier, discarded without
// reaching the bot.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_INTERNAL_ACTION } from "../src/jobs/constants";
import { consume } from "../src/jobs/consumer";
import { isQueueMessage, toQueueMessage } from "../src/jobs/envelope";
import { handleSettingsSet } from "../src/jobs/settings-set";
import { BotTerminalError, BotTransportError } from "../src/jobs/types";
import type {
  BotClient,
  BotFailure,
  EventStore,
  QueueLedger,
  QueueMessage,
  SettingsWriter,
  UniqueLock,
} from "../src/jobs/types";

const KEY = "TWO_AUTOMOD_MENTION_LIMIT";
const GUILD = "326474832151838730";
const ACTOR = "dashboard:100000000000000103";

function carrier(
  overrides: Record<string, unknown> = {},
): Extract<QueueMessage, { kind: "settings-set" }> {
  return {
    kind: "settings-set",
    idempotencyKey: crypto.randomUUID(),
    guildId: GUILD,
    actor: ACTOR,
    action: { verb: "settings.set", key: KEY, value: "8", expected_version: 7 },
    ...overrides,
  } as Extract<QueueMessage, { kind: "settings-set" }>;
}

function okWriter(seen: unknown[] = []): SettingsWriter {
  return {
    setSetting: async (req, idempotencyKey) => {
      seen.push({ req, idempotencyKey });
      return { ok: true, requestId: null, replayed: false };
    },
  };
}

function fail(code: string, retryable: boolean, retryAfterSeconds: number | null = null) {
  return async (): Promise<never> => {
    const failure: BotFailure = {
      ok: false,
      code,
      status: retryable ? 429 : 409,
      requestId: null,
      message: "",
      retryable,
      retryAfterSeconds,
    };
    return failure as never;
  };
}

function msg(body: unknown, attempts = 1) {
  const r = { body, attempts, acked: false, retried: undefined as number | undefined | "now" };
  return Object.assign(r, {
    ack() {
      r.acked = true;
    },
    retry(o?: { delaySeconds?: number }) {
      r.retried = o?.delaySeconds ?? "now";
    },
  });
}
const memLock = (): UniqueLock => ({ acquire: async () => "lease", release: async () => {} });
function memLedger() {
  const rows = new Map<string, { state: string; reason?: string }>();
  const ledger: QueueLedger = {
    enqueued: async (j) => void rows.set(j.jobId, { state: "pending" }),
    reserved: async (id) => void rows.set(id, { state: "reserved" }),
    released: async (id) => void rows.set(id, { state: "released" }),
    dequeued: async (id) => void rows.delete(id),
    failed: async (id, _k, _key, reason) => void rows.set(id, { state: "failed", reason }),
  };
  return { ledger, rows };
}
const store = (): EventStore => ({
  prepareSync: async () => null,
  completeSync: async () => {},
  claimSync: async () => null,
  deferSync: async () => {},
  failSync: async () => {},
  needsSync: async () => false,
  pendingSync: async () => null,
  closeFinished: async () => 0,
  materializeSeries: async () => 0,
  staleEventKeys: async () => [],
});
const unusedBot = {} as BotClient;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("settings-set envelope", () => {
  it("admits the dashboard carrier", () => {
    const msg = carrier();
    expect(isQueueMessage(msg)).toBe(true);
    expect(toQueueMessage(msg)).toEqual(msg);
  });

  it.each([
    ["wrong verb", { action: { verb: "settings.get", key: KEY, value: "8", expected_version: 7 } }],
    ["missing verb", { action: { key: KEY, value: "8", expected_version: 7 } }],
    ["non-UUID key", { idempotencyKey: "not-a-uuid" }],
    ["null key", { idempotencyKey: null }],
    [
      "string version",
      { action: { verb: "settings.set", key: KEY, value: "8", expected_version: "7" } },
    ],
    ["missing key", { action: { verb: "settings.set", value: "8", expected_version: 7 } }],
    [
      "non-string value",
      { action: { verb: "settings.set", key: KEY, value: 8, expected_version: 7 } },
    ],
    ["missing guild", { guildId: undefined }],
    ["missing actor", { actor: undefined }],
    ["non-record action", { action: "settings.set" }],
  ])("rejects a carrier with %s", (_name, overrides) => {
    expect(isQueueMessage(carrier(overrides))).toBe(false);
    expect(toQueueMessage(carrier(overrides))).toBeNull();
  });
});

describe("handleSettingsSet", () => {
  it("posts the queued write once with its carrier key", async () => {
    const seen: unknown[] = [];
    const msg = carrier();
    const outcome = await handleSettingsSet(msg, 1, okWriter(seen));
    expect(outcome).toEqual({ done: true });
    expect(seen).toEqual([
      {
        req: { key: KEY, value: "8", expectedVersion: 7, actor: ACTOR, guildId: GUILD },
        idempotencyKey: msg.idempotencyKey,
      },
    ]);
  });

  it("a definitive refusal fails with the verb and code, never the provider text", async () => {
    const writer: SettingsWriter = { setSetting: fail("action_not_allowed", false) };
    const outcome = await handleSettingsSet(carrier(), 1, writer);
    expect(outcome).toEqual({ failed: expect.stringContaining("settings.set") });
    expect(outcome).toEqual({ failed: expect.stringContaining("action_not_allowed") });
  });

  it("an off-vocabulary code is dropped to unknown, not echoed", async () => {
    const writer: SettingsWriter = { setSetting: fail("version_mismatch", false) };
    expect(await handleSettingsSet(carrier(), 1, writer)).toEqual({
      failed: "The bot refused settings.set with `unknown`",
    });
  });

  it("a retryable refusal waits with backoff, then exhausts terminally", async () => {
    const writer: SettingsWriter = { setSetting: fail("rate_limited", true) };
    expect(await handleSettingsSet(carrier(), 1, writer)).toEqual({ retryInSeconds: 5 });
    expect(await handleSettingsSet(carrier(), CALL_INTERNAL_ACTION.tries, writer)).toEqual({
      failed: expect.stringContaining("settings.set"),
    });
  });

  it("admits the bot's retry delay, falling back to backoff on garbage", async () => {
    const honest: SettingsWriter = { setSetting: fail("rate_limited", true, 42) };
    expect(await handleSettingsSet(carrier(), 1, honest)).toEqual({ retryInSeconds: 42 });
    const lying: SettingsWriter = { setSetting: fail("rate_limited", true, Number.NaN) };
    expect(await handleSettingsSet(carrier(), 1, lying)).toEqual({ retryInSeconds: 5 });
  });

  it("a hung writer fails as a transport wait, bounded by the shared deadline", async () => {
    vi.useFakeTimers();
    const writer: SettingsWriter = { setSetting: () => new Promise(() => {}) };
    const pending = handleSettingsSet(carrier(), 1, writer);
    const assertion = expect(pending).resolves.toEqual({ retryInSeconds: 5 });
    await vi.advanceTimersByTimeAsync(11_000);
    await assertion;
  });

  it("a terminal throw fails without retry", async () => {
    const writer: SettingsWriter = {
      setSetting: async () => {
        throw new BotTerminalError("unconfigured");
      },
    };
    const outcome = await handleSettingsSet(carrier(), 1, writer);
    expect(outcome).toEqual({ failed: expect.any(String) });
  });

  it("a transport throw retries below the cap and fails at it", async () => {
    const writer: SettingsWriter = {
      setSetting: async () => {
        throw new BotTransportError("bot unreachable");
      },
    };
    expect(await handleSettingsSet(carrier(), 1, writer)).toEqual({ retryInSeconds: 5 });
    expect(await handleSettingsSet(carrier(), CALL_INTERNAL_ACTION.tries, writer)).toEqual({
      failed: expect.stringContaining("gave up after"),
    });
  });
});

describe("consume() settings-set dispatch", () => {
  it("delivers the carrier to the writer and acks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: unknown[] = [];
    const first = msg(carrier(), 1);
    await consume(
      { messages: [first] },
      {
        bot: unusedBot,
        events: store(),
        lock: memLock(),
        ledger: memLedger().ledger,
        settings: okWriter(seen),
      },
    );
    expect(first.acked).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("fails closed without a configured writer, never calling the bot", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = msg({ ...carrier(), jobId: crypto.randomUUID() }, 1);
    const { ledger, rows } = memLedger();
    await consume(
      { messages: [first] },
      { bot: unusedBot, events: store(), lock: memLock(), ledger },
    );
    expect(first.acked).toBe(true);
    expect([...rows.values()].some((r) => r.state === "failed")).toBe(true);
    expect(error).toHaveBeenCalled();
  });

  it("discards a malformed settings carrier without reaching the writer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: unknown[] = [];
    const first = msg(carrier({ idempotencyKey: "not-a-uuid" }), 1);
    await consume(
      { messages: [first] },
      {
        bot: unusedBot,
        events: store(),
        lock: memLock(),
        ledger: memLedger().ledger,
        settings: okWriter(seen),
      },
    );
    expect(first.acked).toBe(true);
    expect(seen).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("queue malformed message discarded");
  });
});
