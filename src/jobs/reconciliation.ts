// Dormant persistence only: no handler or queue settlement is wired to this store.
import type postgres from "postgres";
import { diagnosticCode } from "../bot/diagnostic-code";
import { CALL_INTERNAL_ACTION, LEDGER_DB_TIMEOUT_MS } from "./constants";
import type { TxClient } from "./types";

export const SYNC_RECONCILIATION_MARKER = "request requires reconciliation";

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

type AnnouncementSendClaim = {
  kind: "claimed" | "sending" | "closed";
  attempts: number;
  startedAt: Date;
};

type AnnouncementSendRow = {
  send_attempts: number;
  started_at_ms: number;
  state: "sending" | "retryable" | "closed";
};

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
    typeof input.idempotencyKey !== "string" ||
    !UUID.test(input.idempotencyKey) ||
    !VERBS.has(input.verb) ||
    typeof input.subject !== "string" ||
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

  async function insert(tx: TxClient, intent: ReconciliationIntent): Promise<void> {
    const rows = await tx`insert into bot_reconciliation_intents
          (idempotency_key, verb, subject, attempts, last_code, last_status)
          values (${intent.idempotencyKey}::uuid, ${intent.verb}, ${intent.subject},
            ${intent.attempts}, ${intent.lastCode}, ${intent.lastStatus})
          on conflict (idempotency_key) do update set
            last_attempt_at = now(),
            attempts = greatest(bot_reconciliation_intents.attempts, excluded.attempts),
            last_code = coalesce(excluded.last_code, bot_reconciliation_intents.last_code),
            last_status = coalesce(excluded.last_status, bot_reconciliation_intents.last_status)
          where bot_reconciliation_intents.resolved_at is null
            and bot_reconciliation_intents.verb = excluded.verb
            and bot_reconciliation_intents.subject = excluded.subject
          returning idempotency_key`;
    if (rows.length !== 1) throw new Error("Reconciliation key is not an open matching intent");
  }

  async function finishAnnouncement(
    tx: TxClient,
    key: string,
    attempts: number,
    state: "retryable" | "closed",
  ): Promise<boolean> {
    const rows = await tx`update announcement_send_claims set state = ${state}
      where idempotency_key = ${key}::uuid and state = 'sending' and send_attempts = ${attempts}
      returning idempotency_key`;
    return rows.length === 1;
  }

  return {
    /** Only a committed claim grants a send. An old 'sending' row is never reclaimed. */
    async claimAnnouncement(key: string): Promise<AnnouncementSendClaim> {
      if (typeof key !== "string" || !UUID.test(key)) throw new Error("Invalid announcement key");
      return bounded(async (tx) => {
        const [claimed]: AnnouncementSendRow[] = await tx`insert into announcement_send_claims
          (idempotency_key, send_attempts, state, started_at) values (${key}::uuid, 1, 'sending', clock_timestamp())
          on conflict (idempotency_key) do update set
            send_attempts = announcement_send_claims.send_attempts + 1,
            state = 'sending', started_at = clock_timestamp()
          where announcement_send_claims.state = 'retryable'
            and announcement_send_claims.send_attempts < ${CALL_INTERNAL_ACTION.tries}
          returning send_attempts, state,
            (extract(epoch from started_at) * 1000)::double precision as started_at_ms`;
        if (claimed)
          return {
            kind: "claimed",
            attempts: claimed.send_attempts,
            startedAt: new Date(claimed.started_at_ms),
          };

        // A separate statement sees the winning insert even if it committed while the upsert waited.
        const [current]: AnnouncementSendRow[] = await tx`select send_attempts, state,
            (extract(epoch from started_at) * 1000)::double precision as started_at_ms
          from announcement_send_claims where idempotency_key = ${key}::uuid`;
        if (!current || current.state === "retryable")
          throw new Error("Announcement claim unavailable");
        return {
          kind: current.state,
          attempts: current.send_attempts,
          startedAt: new Date(current.started_at_ms),
        };
      });
    },
    /** Fence stale completions. The last attempt can close but cannot reopen for a send. */
    async finishAnnouncement(
      key: string,
      attempts: number,
      state: "retryable" | "closed",
    ): Promise<boolean> {
      if (
        typeof key !== "string" ||
        !UUID.test(key) ||
        !Number.isSafeInteger(attempts) ||
        attempts < 1 ||
        attempts > 2147483647 ||
        (state !== "retryable" && state !== "closed") ||
        (state === "retryable" && attempts >= CALL_INTERNAL_ACTION.tries)
      ) {
        throw new Error("Invalid announcement claim settlement");
      }
      return bounded((tx) => finishAnnouncement(tx, key, attempts, state));
    },
    /** A hard stop or orphaned claim closes only when its scalar evidence commits. */
    async recordAnnouncement(input: Omit<ReconciliationIntent, "verb">): Promise<void> {
      const intent = reconciliationIntent({ ...input, verb: "announcement.post" });
      await bounded(async (tx) => {
        if (!(await finishAnnouncement(tx, intent.idempotencyKey, intent.attempts, "closed"))) {
          throw new Error("Announcement claim changed before reconciliation");
        }
        await insert(tx, intent);
      });
    },
    async record(input: ReconciliationIntent): Promise<void> {
      const intent = reconciliationIntent(input);
      await bounded((tx) => insert(tx, intent));
    },
    async recordSync(input: ReconciliationIntent): Promise<void> {
      const intent = reconciliationIntent(input);
      await bounded(async (tx) => {
        const rows = await tx`update event_sync_attempts a
          set terminal_reason = ${SYNC_RECONCILIATION_MARKER}
          from events e where a.event_id = e.id and e.event_key = ${intent.subject}
            and a.idempotency_key = ${intent.idempotencyKey}::uuid
            and a.action = ${intent.verb} and a.state = 'pending'
            and a.request_attempts = ${intent.attempts} and a.next_attempt_at is null
            and (a.terminal_reason is null or a.terminal_reason = ${SYNC_RECONCILIATION_MARKER})
          returning a.idempotency_key`;
        if (rows.length !== 1) throw new Error("Sync claim changed before reconciliation");
        await insert(tx, intent);
      });
    },

    /** The receipt is mandatory and commits atomically with the resolution. */
    async resolve(
      key: string,
      actor: string,
      resolution: string,
      receipt: (tx: TxClient) => Promise<void>,
    ): Promise<boolean> {
      if (
        typeof key !== "string" ||
        !UUID.test(key) ||
        typeof actor !== "string" ||
        !ACTOR.test(actor) ||
        !RESOLUTIONS.has(resolution)
      ) {
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
