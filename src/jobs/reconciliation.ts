// Dormant persistence only: no handler or queue settlement is wired to this store.
import type postgres from "postgres";
import { diagnosticCode } from "../bot/diagnostic-code";
import {
  ANNOUNCEMENT_RECONCILIATION_REASON,
  CALL_INTERNAL_ACTION,
  LEDGER_DB_LOCK_TIMEOUT_MS,
  LEDGER_DB_TIMEOUT_MS,
} from "./constants";
import { stampQueueFailure } from "./postgres";
import { MAX_RETRY_DELAY_SECONDS } from "./retry-delay";
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

const CHANNEL_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$/;
const SEND_LEASE_SECONDS = 30; // Room for the 10s bot deadline and bounded DB settlement.
const CARRIER_AGE_HOURS = 720; // Elapsed time: longer than queue retention, unaffected by DST.

export function validAnnouncementIdentity(key: unknown, alias: unknown): boolean {
  return (
    typeof key === "string" &&
    UUID.test(key) &&
    typeof alias === "string" &&
    CHANNEL_ALIAS.test(alias)
  );
}

type SendClaim =
  | { kind: "claimed" | "sending" | "abandoned" | "closed"; attempts: number; claimUntil: Date }
  | { kind: "waiting"; attempts: number; retryInSeconds: number }
  | { kind: "unavailable" };

type AnnouncementSendRow = {
  channel_alias: string;
  send_attempts: number;
  claim_until_ms: number;
  retry_in_seconds: number;
  kind: "sending" | "abandoned" | "retryable" | "closed";
};

function validAnnouncementAttempt(key: string, attempts: number): boolean {
  return (
    typeof key === "string" &&
    UUID.test(key) &&
    Number.isInteger(attempts) &&
    attempts >= 1 &&
    attempts <= CALL_INTERNAL_ACTION.tries
  );
}

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
    return sql.begin("isolation level read committed", async (transaction) => {
      const tx = transaction as unknown as TxClient;
      await tx`select set_config('lock_timeout', ${`${LEDGER_DB_LOCK_TIMEOUT_MS}ms`}, true),
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

  async function settleClaim(
    tx: TxClient,
    key: string,
    attempts: number,
    retryInSeconds: number | null,
    orphan = false,
  ): Promise<string | undefined> {
    const state = retryInSeconds === null ? "closed" : "retryable";
    // A lock-only waiter need not recheck UPDATE predicates. Read the clock after locking.
    const [locked] = await tx`select 1 from announcement_send_claims
      where idempotency_key = ${key}::uuid for update`;
    if (!locked) return undefined;
    // In retryable state this timestamp is the next eligible send, not a lease.
    const [row] = await tx`update announcement_send_claims set state = ${state},
        claim_until = case when ${retryInSeconds}::int is null then claim_until
          else clock_timestamp() + make_interval(secs => ${retryInSeconds}) end
      where idempotency_key = ${key}::uuid and state = 'sending' and send_attempts = ${attempts}
        and (claim_until <= clock_timestamp()) = ${orphan}
      returning channel_alias`;
    return row?.channel_alias as string | undefined;
  }

  return {
    /** Pass the original queue timestamp, not a retry time or a body field. */
    async claimAnnouncement(key: string, alias: string, queuedAt: Date): Promise<SendClaim> {
      if (
        !validAnnouncementIdentity(key, alias) ||
        !(queuedAt instanceof Date) ||
        !Number.isFinite(queuedAt.getTime())
      )
        throw new Error("Invalid announcement carrier");
      return bounded(async (tx) => {
        const [claimed] = await tx`insert into announcement_send_claims as claim
          (idempotency_key, channel_alias, send_attempts, state, claim_until)
          select ${key}::uuid, ${alias}, 1, 'sending', clock_timestamp() + make_interval(secs => ${SEND_LEASE_SECONDS})
          where ${queuedAt.toISOString()}::timestamptz > statement_timestamp() - make_interval(hours => ${CARRIER_AGE_HOURS})
            and ${queuedAt.toISOString()}::timestamptz <= statement_timestamp() + interval '5 seconds'
            and not exists (select 1 from bot_reconciliation_intents where idempotency_key = ${key}::uuid)
          on conflict (idempotency_key) do update set
            send_attempts = claim.send_attempts + 1, state = 'sending',
            claim_until = clock_timestamp() + make_interval(secs => ${SEND_LEASE_SECONDS})
          where claim.state = 'retryable' and claim.channel_alias = excluded.channel_alias
            and claim.send_attempts < ${CALL_INTERNAL_ACTION.tries}
            and claim.claim_until <= clock_timestamp()
          returning send_attempts, (extract(epoch from claim_until) * 1000)::double precision as claim_until_ms`;
        if (claimed) {
          const { send_attempts: attempts, claim_until_ms: deadline } = claimed;
          return { kind: "claimed", attempts, claimUntil: new Date(deadline) };
        }

        // A separate statement sees a winning insert that committed while the upsert waited.
        const [current]: AnnouncementSendRow[] = await tx`select channel_alias, send_attempts,
            case when state = 'sending' and claim_until <= clock_timestamp() then 'abandoned' else state end as kind,
            (extract(epoch from claim_until) * 1000)::double precision as claim_until_ms,
            least(${MAX_RETRY_DELAY_SECONDS}::int,
              greatest(1, ceil(extract(epoch from claim_until - clock_timestamp()))))::int as retry_in_seconds
          from announcement_send_claims where idempotency_key = ${key}::uuid
            and (state <> 'retryable' or (send_attempts < ${CALL_INTERNAL_ACTION.tries}
              and ${queuedAt.toISOString()}::timestamptz > statement_timestamp() - make_interval(hours => ${CARRIER_AGE_HOURS})
              and ${queuedAt.toISOString()}::timestamptz <= statement_timestamp() + interval '5 seconds'))`;
        if (!current || current.channel_alias !== alias) return { kind: "unavailable" };
        if (current.kind === "retryable")
          return {
            kind: "waiting",
            attempts: current.send_attempts,
            retryInSeconds: current.retry_in_seconds,
          };
        return {
          kind: current.kind,
          attempts: current.send_attempts,
          claimUntil: new Date(current.claim_until_ms),
        };
      });
    },
    /** Fence stale completions. The last attempt can close but cannot reopen for a send. */
    async finishAnnouncement(
      key: string,
      attempts: number,
      settlement:
        | "closed"
        | { done: true; jobId: string | null }
        | { retryInSeconds: number }
        | { failed: string; jobId: string | null },
    ): Promise<boolean> {
      const detail = typeof settlement === "object" && settlement !== null ? settlement : null;
      const refusal = detail && "failed" in detail ? detail : null;
      const retry = detail && "retryInSeconds" in detail ? detail : null;
      const success = detail && "done" in detail && detail.done === true ? detail : null;
      if (
        !validAnnouncementAttempt(key, attempts) ||
        (settlement !== "closed" &&
          (retry
            ? !Number.isInteger(retry.retryInSeconds) ||
              retry.retryInSeconds < 1 ||
              retry.retryInSeconds > MAX_RETRY_DELAY_SECONDS ||
              attempts >= CALL_INTERNAL_ACTION.tries
            : !success && typeof refusal?.failed !== "string"))
      ) {
        throw new Error("Invalid announcement claim settlement");
      }
      return bounded(async (tx) => {
        if ((await settleClaim(tx, key, attempts, retry?.retryInSeconds ?? null)) === undefined)
          return false;
        if (refusal) {
          // Tracked deliveries use the original ledger ID. Legacy carriers have only the key.
          const jobId = refusal.jobId && UUID.test(refusal.jobId) ? refusal.jobId : key;
          await stampQueueFailure(tx, jobId, "announcement", null, refusal.failed);
        }
        if (success?.jobId && UUID.test(success.jobId))
          await tx`delete from queue_jobs where job_id = ${success.jobId}::uuid`;
        return true;
      });
    },
    /** Null evidence recovers an abandoned claim: a reservation does not prove a wire send. */
    async recordAnnouncement(
      key: string,
      attempts: number,
      evidence: Pick<ReconciliationIntent, "lastCode" | "lastStatus"> | null,
      jobId?: string | null,
    ): Promise<void> {
      if (!validAnnouncementAttempt(key, attempts)) throw new Error("Invalid announcement claim");
      await bounded(async (tx) => {
        const alias = await settleClaim(tx, key, attempts, null, evidence === null);
        if (alias === undefined)
          throw new Error("Announcement claim changed before reconciliation");
        await insert(
          tx,
          reconciliationIntent({
            idempotencyKey: key,
            verb: "announcement.post",
            attempts,
            subject: alias,
            lastCode: evidence?.lastCode ?? null,
            lastStatus: evidence?.lastStatus ?? null,
          }),
        );
        if (jobId !== undefined) {
          await stampQueueFailure(
            tx,
            jobId && UUID.test(jobId) ? jobId : key,
            "announcement",
            null,
            ANNOUNCEMENT_RECONCILIATION_REASON,
          );
        }
      });
    },
    /** Owner-only maintenance, unscheduled until integration. Never delete unresolved evidence. */
    // Retire by lease end to cover enqueue clock skew and in-flight admission statements.
    async pruneClosedAnnouncements(): Promise<number> {
      return bounded(async (tx) => {
        const rows = await tx`delete from announcement_send_claims where idempotency_key in (
          select c.idempotency_key from announcement_send_claims c
          where c.state = 'closed' and c.claim_until <= statement_timestamp() - make_interval(hours => ${CARRIER_AGE_HOURS})
            and not exists (select 1 from bot_reconciliation_intents i
              where i.idempotency_key = c.idempotency_key and i.resolved_at is null)
          order by c.claim_until, c.idempotency_key limit 1000 for update skip locked
        ) returning idempotency_key`;
        return rows.length;
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
