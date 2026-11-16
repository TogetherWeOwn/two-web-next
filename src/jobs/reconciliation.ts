// Dormant persistence only: no handler or queue settlement is wired to this store.
import type postgres from "postgres";
import { diagnosticCode } from "../bot/diagnostic-code";
import { LEDGER_DB_TIMEOUT_MS } from "./constants";
import type { TxClient } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERBS = new Set([
  "announcement.post",
  "event.upsert",
  "event.cancel",
  "reminder.send",
  "place_offer.send",
]);
const SUBJECT = /^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,199}$/;
const ACTOR = /^[0-9]{1,20}$/;
const RESOLUTIONS = new Set(["confirmed", "not_applied", "superseded"]);

export type ReconciliationIntent = {
  idempotencyKey: string;
  verb: string;
  subject: string;
  attempts: number;
  lastCode: string | null;
  lastStatus: number | null;
};

/** Validate again at the persistence boundary, not just at a future caller. */
export function reconciliationIntent(input: ReconciliationIntent): ReconciliationIntent {
  if (
    !UUID.test(input.idempotencyKey) ||
    !VERBS.has(input.verb) ||
    !SUBJECT.test(input.subject) ||
    !Number.isInteger(input.attempts) ||
    input.attempts < 1 ||
    input.attempts > 2147483647 ||
    (input.lastStatus !== null &&
      (!Number.isInteger(input.lastStatus) || input.lastStatus < 100 || input.lastStatus > 599))
  ) {
    throw new Error("Invalid reconciliation intent");
  }
  return {
    idempotencyKey: input.idempotencyKey,
    verb: input.verb,
    subject: input.subject,
    attempts: input.attempts,
    lastCode: input.lastCode === null ? null : diagnosticCode(input.lastCode),
    lastStatus: input.lastStatus,
  };
}

/**
 * Record an unresolved key or refresh the same open intent. A reused key with
 * a different identity, or a resolved key, fails closed instead of appearing
 * persisted. Database errors propagate to the future caller.
 */
export function pgReconciliationStore(sql: ReturnType<typeof postgres>) {
  async function bounded<T>(work: (tx: TxClient) => Promise<T>): Promise<T> {
    return sql.begin(async (transaction) => {
      const tx = transaction as unknown as TxClient;
      await tx`select set_config('lock_timeout', ${`${LEDGER_DB_TIMEOUT_MS}ms`}, true),
        set_config('statement_timeout', ${`${LEDGER_DB_TIMEOUT_MS}ms`}, true)`;
      return work(tx);
    }) as Promise<T>;
  }

  return {
    async record(input: ReconciliationIntent): Promise<void> {
      const intent = reconciliationIntent(input);
      await bounded(async (tx) => {
        const rows = await tx`insert into bot_reconciliation_intents
          (idempotency_key, verb, subject, attempts, last_code, last_status)
          values (${intent.idempotencyKey}::uuid, ${intent.verb}, ${intent.subject},
            ${intent.attempts}, ${intent.lastCode}, ${intent.lastStatus})
          on conflict (idempotency_key) do update set
            last_attempt_at = now(),
            attempts = greatest(bot_reconciliation_intents.attempts, excluded.attempts),
            last_code = excluded.last_code, last_status = excluded.last_status
          where bot_reconciliation_intents.resolved_at is null
            and bot_reconciliation_intents.verb = excluded.verb
            and bot_reconciliation_intents.subject = excluded.subject
          returning idempotency_key`;
        if (rows.length !== 1) throw new Error("Reconciliation key is not an open matching intent");
      });
    },

    /** The receipt is mandatory and commits atomically with the resolution. */
    async resolve(
      key: string,
      actor: string,
      resolution: string,
      receipt: (tx: TxClient) => Promise<void>,
    ): Promise<boolean> {
      if (!UUID.test(key) || !ACTOR.test(actor) || !RESOLUTIONS.has(resolution)) {
        throw new Error("Invalid reconciliation resolution");
      }
      if (typeof receipt !== "function") throw new Error("Reconciliation receipt is required");
      return bounded(async (tx) => {
        const rows = await tx`update bot_reconciliation_intents
          set resolved_at = now(), resolved_by = ${actor}, resolution = ${resolution}
          where idempotency_key = ${key}::uuid and resolved_at is null
          returning idempotency_key`;
        if (rows.length === 0) return false;
        await receipt(tx);
        return true;
      });
    },
  };
}
