// A connect/BEGIN stall must not withhold mandatory sign-in past the 2s
// application bound. This pins the force flag on the runtime-owned close:
// plain end waits on pending I/O (real driver: still pending after 12s
// against a silent socket), forced end settles it in milliseconds. The model
// preserves that causality without a database: begin never settles on its
// own, end({ timeout: 0 }) settles it immediately, plain end hangs until
// test cleanup. DB-free: only Discord transport is stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemorySessionStore } from "../src/sessions";
import {
  CALLERS,
  expectIssued,
  prepareSignin,
  priorSession,
  settledWithin,
  signinEnv,
  stubSigninDiscord,
} from "./helpers/signin-roster";

type StallClient = {
  beginCalls: number;
  endCalls: unknown[];
  ended: boolean;
  beginReject: ((err: unknown) => void) | null;
  plainEndResolve: (() => void) | null;
};

const stall = vi.hoisted(() => {
  let enteredResolve!: () => void;
  let enteredPromise: Promise<void> = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const state = {
    clients: [] as StallClient[],
    get entered(): Promise<void> {
      return enteredPromise;
    },
    reset() {
      state.clients = [];
      enteredPromise = new Promise((resolve) => {
        enteredResolve = resolve;
      });
    },
    markEntered() {
      enteredResolve();
    },
  };
  return state;
});

vi.mock("postgres", () => ({
  default: () => {
    const client: StallClient = {
      beginCalls: 0,
      endCalls: [],
      ended: false,
      beginReject: null,
      plainEndResolve: null,
    };
    const sql = Object.assign(
      () => {
        throw new Error("Unexpected direct query in connect-stall test");
      },
      {
        unsafe: async () => {
          throw new Error("Unexpected unsafe in connect-stall test");
        },
        begin: () => {
          client.beginCalls += 1;
          stall.markEntered();
          // Connect/handshake stall before BEGIN work: never settles unless
          // the owned client is force-ended. The transaction callback never
          // runs, so no SQL timeouts are installed — the application deadline
          // and the forced close are the only bounds.
          return new Promise<never>((_, reject) => {
            client.beginReject = reject as (err: unknown) => void;
          });
        },
        end: async (opts?: { timeout?: number }) => {
          client.endCalls.push(opts);
          if (opts?.timeout === 0) {
            client.ended = true;
            client.beginReject?.(new Error("client ended"));
            return;
          }
          // Plain end waits on pending I/O: hangs until test cleanup settles
          // it. This models postgres 3.4.9 end() still pending after 12s
          // against a stalled socket, where end({ timeout: 0 }) settles in 2ms.
          return new Promise<void>((resolve) => {
            client.plainEndResolve = resolve;
          });
        },
      },
    );
    stall.clients.push(client);
    return sql;
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(CALLERS)("%s connect stall", (caller) => {
  it("settles near the application bound and destroys the owned client when connect/BEGIN never settles", async () => {
    stall.reset();
    const store = createMemorySessionStore();
    const prior = await priorSession(store);
    const env = signinEnv({
      SESSION_STORE: store,
      DATABASE_URL: "postgres://localhost:1/stall-test",
    });
    const calls = stubSigninDiscord();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoke = await prepareSignin(caller, env, prior.cookie);
    // The start request must not touch the roster client; only the callback does.
    expect(stall.clients).toHaveLength(0);
    stall.reset();
    const start = Date.now();
    let pending: Promise<Response> | undefined;
    try {
      pending = invoke();
      const entered = await settledWithin(stall.entered, 2000);
      expect(entered, "optional roster acquisition must begin").not.toBeNull();
      const response = await settledWithin(pending, 5000);
      const elapsed = Date.now() - start;
      expect(
        response,
        "forced roster close must settle issuance near the 2s bound; plain end still withheld it after 5s",
      ).not.toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(1800);
      expect(elapsed).toBeLessThan(4000);
      await expectIssued(response!, caller, store);
      expect(await store.get(prior.hash)).toBeNull();
      expect(stall.clients).toHaveLength(1);
      const client = stall.clients[0]!;
      expect(client.beginCalls).toBe(1);
      expect(client.endCalls).toEqual([{ timeout: 0 }]);
      expect(client.ended).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "roster upsert failed",
        expect.objectContaining({ exception: expect.any(String) }),
      );
      expect(calls).toHaveLength(caller === "qa" ? 0 : 4);
    } finally {
      // Settle hung begin/plain-end even on RED; no orphan crosses tests.
      for (const client of stall.clients) {
        client.beginReject?.(new Error("test cleanup"));
        client.plainEndResolve?.();
      }
      if (pending) await pending;
    }
  });
});
