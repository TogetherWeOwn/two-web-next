import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAnnouncement, dispatchRoleAssign, handleCallInternalAction } from "../src/jobs/call-internal-action";
import type { BotClient, QueueMessage } from "../src/jobs/types";

const ANN_KEY_1 = "11111111-1111-4111-8111-111111111111";
const ANN_KEY_2 = "22222222-2222-4222-8222-222222222222";
const UUID_RE = /^[0-9a-f-]{36}$/;

// Fixture helper local to this file: deterministic synthetic crypto.randomUUID
// with no global leakage (caller restores via the returned function, typically
// in try/finally). Values are consumed in order; exhaustion throws so an
// unexpected third mint fails loudly instead of returning undefined.
function syntheticUuids(values: string[]) {
  const pending = [...values];
  const spy = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    const next = pending.shift();
    if (next === undefined) throw new Error("synthetic crypto exhausted");
    return next as `${string}-${string}-${string}-${string}-${string}`;
  });
  return spy;
}

function syntheticCryptoFailure() {
  return vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    throw new Error("synthetic crypto failure");
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("internal-action producer identity", () => {
  it("two announcement dispatches mint distinct dispatch-time keys; replay reuses the captured key", async () => {
    const spy = syntheticUuids([ANN_KEY_1, ANN_KEY_2]);
    try {
      const sent: QueueMessage[] = [];
      const queue = { send: async (b: unknown) => void sent.push(b as QueueMessage) };
      const action = { channelKey: "c", body: "b" };

      await dispatchAnnouncement(queue, action);
      await dispatchAnnouncement(queue, action);

      expect(sent).toHaveLength(2);
      const anns = sent as Array<Extract<QueueMessage, { kind: "announcement" }>>;
      const first = anns[0]!;
      const second = anns[1]!;
      for (const m of [first, second]) {
        expect(m.kind).toBe("announcement");
        expect(m.action).toEqual(action);
        expect(m.idempotencyKey).toMatch(UUID_RE);
      }
      expect(first.idempotencyKey).toBe(ANN_KEY_1);
      expect(second.idempotencyKey).toBe(ANN_KEY_2);
      expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
      expect(spy).toHaveBeenCalledTimes(2);

      // Replay of the captured carrier reuses its key: handling the same body
      // twice must not mint anything new.
      const seenKeys: string[] = [];
      const bot = {
        postAnnouncement: async (_a: unknown, key: string) => {
          seenKeys.push(key);
          return { ok: true, requestId: null, messageId: "m1", replayed: seenKeys.length > 1 };
        },
      } as unknown as BotClient;
      await handleCallInternalAction(first, 1, bot);
      await handleCallInternalAction(first, 2, bot);
      expect(seenKeys).toEqual([ANN_KEY_1, ANN_KEY_1]);
      // No new mints during replay of the captured carrier.
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
    // No global leakage: real crypto is back and mints outside the synthetic set.
    const real = crypto.randomUUID();
    expect(real).toMatch(UUID_RE);
    expect([ANN_KEY_1, ANN_KEY_2]).not.toContain(real);
  });

  it("role.assign producer sends an explicit null idempotencyKey and mints nothing", async () => {
    // Throw on any mint: role.assign must not touch crypto at all.
    const spy = syntheticCryptoFailure();
    try {
      const sent: QueueMessage[] = [];
      const queue = { send: async (b: unknown) => void sent.push(b as QueueMessage) };
      const action = { userId: "u", roleKey: "r" };

      await dispatchRoleAssign(queue, action);

      expect(sent).toHaveLength(1);
      const [msg] = sent as Array<Extract<QueueMessage, { kind: "role-assign" }>>;
      expect(msg).toBeDefined();
      expect(msg!.kind).toBe("role-assign");
      expect(msg!.action).toEqual(action);
      expect("idempotencyKey" in msg!).toBe(true);
      expect(msg!.idempotencyKey).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(crypto.randomUUID()).toMatch(UUID_RE);
  });

  it("queue-send rejection surfaces and sends exactly once", async () => {
    const spy = syntheticUuids([ANN_KEY_1]);
    try {
      let calls = 0;
      const queue = {
        send: async (_b: unknown) => {
          calls++;
          return Promise.reject(new Error("queue down"));
        },
      };
      await expect(dispatchAnnouncement(queue, { channelKey: "c", body: "b" })).rejects.toThrow("queue down");
      expect(calls).toBe(1);

      let roleCalls = 0;
      const roleQueue = {
        send: async (_b: unknown) => {
          roleCalls++;
          return Promise.reject(new Error("queue down"));
        },
      };
      await expect(dispatchRoleAssign(roleQueue, { userId: "u", roleKey: "r" })).rejects.toThrow("queue down");
      expect(roleCalls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("crypto failure sends nothing", async () => {
    const spy = syntheticCryptoFailure();
    try {
      const send = vi.fn(async (_b: unknown) => {});
      await expect(dispatchAnnouncement({ send }, { channelKey: "c", body: "b" })).rejects.toThrow(
        "synthetic crypto failure",
      );
      expect(send).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(crypto.randomUUID()).toMatch(UUID_RE);
  });
});
