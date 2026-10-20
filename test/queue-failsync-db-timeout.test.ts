// Builder-owned proof for the Paperclip Review finding on PR #1178: racing
// `failSync` in the consumer only stops the wait, so the UPDATE must also be
// cancelled by Postgres or it keeps the handler pool's single connection and
// the next message's `prepareSync` still stalls. This pins the server-side
// bound (transaction-scoped lock_timeout/statement_timeout before the UPDATE).
import { describe, expect, it } from "vitest";
import { FAIL_SYNC_DB_TIMEOUT_MS, pgEventStore } from "../src/jobs/events";
import type { TxClient } from "../src/jobs/types";

const KEY = "11111111-1111-4111-8111-111111111111";

// The consumer races `failSync` against its 2s ledger bound
// (`LEDGER_TIMEOUT_MS` in src/jobs/consumer.ts). The DB-side cap must stay on
// that same bound; drift reopens the stall one message later.
describe("failSync server-side bound", () => {
  it("keeps the DB cap on the consumer's 2s ledger bound", () => {
    expect(FAIL_SYNC_DB_TIMEOUT_MS).toBe(2000);
  });

  it("pool path: scopes lock/statement timeouts in a transaction before the UPDATE", async () => {
    const poolCalls: string[] = [];
    const txCalls: string[] = [];
    let began = false;
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      txCalls.push(`${strings.join("?")} :: ${JSON.stringify(values)}`);
      return Promise.resolve([]);
    }) as unknown as TxClient;
    const pool = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        poolCalls.push(`${strings.join("?")} :: ${JSON.stringify(values)}`);
        return Promise.resolve([]);
      },
      {
        begin: async (fn: (tx: TxClient) => Promise<void>) => {
          began = true;
          await fn(tx);
        },
      },
    );

    await pgEventStore(pool as never).failSync(KEY);

    expect(began).toBe(true);
    // Nothing runs on the pool outside the transaction: session settings leak
    // to the next holder of a pooled connection otherwise.
    expect(poolCalls).toEqual([]);
    expect(txCalls).toHaveLength(2);
    expect(txCalls[0]).toContain("set_config");
    expect(txCalls[0]).toContain("lock_timeout");
    expect(txCalls[0]).toContain("statement_timeout");
    expect(txCalls[0]).toContain(`${FAIL_SYNC_DB_TIMEOUT_MS}ms`);
    expect(txCalls[1]).toContain("update event_sync_attempts");
    expect(txCalls[1]).toContain(KEY);
  });

  it("transaction path: scopes the timeouts without a nested BEGIN", async () => {
    const calls: string[] = [];
    const txClient = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`${strings.join("?")} :: ${JSON.stringify(values)}`);
      return Promise.resolve([]);
    }) as unknown as TxClient;

    await pgEventStore(txClient).failSync(KEY);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("set_config");
    expect(calls[0]).toContain(`${FAIL_SYNC_DB_TIMEOUT_MS}ms`);
    expect(calls[1]).toContain("update event_sync_attempts");
  });
});
