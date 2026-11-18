import type postgres from "postgres";
import { LEDGER_DB_TIMEOUT_MS } from "../jobs/constants";
import type { TxClient } from "../jobs/types";
import type { pgReconciliationReads } from "./reconciliation-reads";

type Reads = ReturnType<typeof pgReconciliationReads>;
type ReadAction = "list_open" | "list_resolved" | "view";
type ReadReceipt = (actorId: string, action: ReadAction, key: string | null) => Promise<void>;

/** Record only the access action and, for an existing row, its original key. */
export function reconciliationReadReceipt(sql: ReturnType<typeof postgres>): ReadReceipt {
  return async (actorId, action, key) => {
    await sql.begin(async (transaction) => {
      const tx = transaction as unknown as TxClient;
      await tx`select set_config('lock_timeout', ${`${LEDGER_DB_TIMEOUT_MS}ms`}, true),
        set_config('statement_timeout', ${`${LEDGER_DB_TIMEOUT_MS}ms`}, true)`;
      await tx`insert into activity_log
        (log_name, description, subject_type, subject_id, causer_type, causer_id, event, properties)
        values ('operations', 'bot-reconciliation.read', 'bot_reconciliation_intents', ${key},
          'User', ${actorId}, ${action}, '{}'::jsonb)`;
    });
  };
}

/** Do not release reconciliation data until its access receipt is recorded. */
export function auditedReconciliationReads(reads: Reads, receipt: ReadReceipt, actorId: string) {
  return {
    async listOpen() {
      const rows = await reads.listOpen();
      await receipt(actorId, "list_open", null);
      return rows;
    },
    async listResolved() {
      const rows = await reads.listResolved();
      await receipt(actorId, "list_resolved", null);
      return rows;
    },
    async get(key: string) {
      const row = await reads.get(key);
      await receipt(actorId, "view", row?.idempotencyKey ?? null);
      return row;
    },
  };
}
