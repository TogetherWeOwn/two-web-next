// Needs-reconciliation kernel (contract v2 §7.4/§11).
//
// Keyed bot mutations (announcement.post, event.upsert/event.cancel, and the
// future notify verbs reminder.send/place_offer.send) carry exactly one UUID
// per logical intent, minted at dispatch and retried only with that key. When
// the bot answers `needs_reconciliation` (409, never retryable) the site must
// hard-stop: no retry, no re-key, persist the stuck intent, and surface it to
// moderators/admins for reconciliation by hand. Retryable unknowns
// (transport loss, upstream_timeout, in_progress) retry with the same key to
// their budget, then escalate to the same surface instead of a member error.
//
// This module owns the closed vocabulary, the stuck-intent shape (scalars
// only — never DM bodies), and the Postgres store behind the admin surface.
// Handlers (sync-event, call-internal-action) derive the intent; the consumer
// records it before any terminal settlement, so a record failure retries the
// same carrier instead of settling first and losing the surface row.
import type postgres from "postgres";
import { diagnosticCode } from "../bot/diagnostic-code";
import { LEDGER_DB_TIMEOUT_MS } from "./constants";
import { queueExceptionClass } from "./queue-error";
import type { TxClient } from "./types";

/** Wire code the bot returns when its key log disagrees with the request. */
export const NEEDS_RECONCILIATION_CODE = "needs_reconciliation";

/** Hard stop on the code alone — never the HTTP status, never the retryable flag. */
export function isNeedsReconciliation(code: unknown): boolean {
  return code === NEEDS_RECONCILIATION_CODE;
}

/** Last wire outcome for the operator surface.
 *
 * Own-data scalar reads only: observation must never execute input accessors
 * (a hostile answer object stays inert), and the code is classified through
 * the closed diagnostic vocabulary instead of retained raw — provider strings
 * can echo secrets, and the row persists to Postgres and renders on the admin
 * page. The result always validates: it never throws, so a garbage wire
 * answer escalates like any other unknown instead of wedging the carrier.
 * Nulls mean no wire answer was ever obtained (transport loss); a refused or
 * garbage answer classifies (members of the vocabulary round-trip, anything
 * else is "unknown"). */
export function lastWireOutcome(answer: unknown): {
  code: string;
  status: number | null;
  requestId: string | null;
} {
  const field = (key: string): unknown => {
    try {
      if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return undefined;
      return Object.getOwnPropertyDescriptor(answer, key)?.value;
    } catch {
      return undefined;
    }
  };
  const code = field("code");
  const status = field("status");
  const requestId = field("requestId");
  return {
    code: diagnosticCode(typeof code === "string" ? code : undefined),
    status: typeof status === "number" && Number.isInteger(status) && status >= 0 ? status : null,
    requestId:
      typeof requestId === "string" &&
      requestId.length > 0 &&
      requestId.length <= CODE_MAX &&
      !/[\r\n\0]/.test(requestId)
        ? requestId
        : null,
  };
}

/** Keyed verbs that carry a site-minted idempotency key. Keyless verbs retry freely. */
export type KeyedMutationVerb =
  | "announcement.post"
  | "event.upsert"
  | "event.cancel"
  | "reminder.send"
  | "place_offer.send";

const VERBS: ReadonlySet<string> = new Set([
  "announcement.post",
  "event.upsert",
  "event.cancel",
  "reminder.send",
  "place_offer.send",
]);

export class InvalidStuckIntentError extends Error {}

/** Exactly one UUID per logical intent; the store keys on it, never a re-key. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route-param gate: a string UUID, or null for anything else (never throws). */
export function parseStuckKey(raw: unknown): string | null {
  return typeof raw === "string" && UUID_RE.test(raw) ? raw : null;
}
const SUBJECT_MAX = 200;
const CODE_MAX = 100;
const RESOLUTION_MAX = 500;

/** Scalar-only subject: event_key, channel_key, member scalar — never a DM body. */
function assertSubject(subject: string): void {
  if (typeof subject !== "string" || subject.length === 0 || subject.length > SUBJECT_MAX)
    throw new InvalidStuckIntentError(
      "A stuck intent needs a scalar subject under 200 characters.",
    );
  // Bodies are multi-line; subjects are single-line keys. Refuse anything shaped
  // like a body rather than truncating it into a misleading key.
  if (/[\r\n\0]/.test(subject))
    throw new InvalidStuckIntentError("A stuck intent subject is a single-line key, never a body.");
}

function assertCode(code: string | null): void {
  if (code === null) return;
  if (code.length === 0 || code.length > CODE_MAX || /[\r\n\0]/.test(code))
    throw new InvalidStuckIntentError("A stuck intent code is a short scalar or null.");
}

/** One terminal-without-confirmation keyed intent, as the handler derived it. */
export type StuckIntent = {
  idempotencyKey: string;
  verb: KeyedMutationVerb;
  /** Scalar only: event_key, channel_key, or member scalar. Never a DM body. */
  subject: string;
  /** Last wire outcome; nulls when no wire answer was ever obtained (transport loss). */
  lastCode: string | null;
  lastStatus: number | null;
  lastRequestId: string | null;
  attempts: number;
};

export function stuckIntent(intent: {
  idempotencyKey: string;
  verb: string;
  subject: string;
  lastCode: string | null;
  lastStatus: number | null;
  lastRequestId: string | null;
  attempts: number;
}): StuckIntent {
  if (typeof intent.idempotencyKey !== "string" || !UUID_RE.test(intent.idempotencyKey))
    throw new InvalidStuckIntentError("A stuck intent is keyed by the carrier UUID.");
  if (!VERBS.has(intent.verb))
    throw new InvalidStuckIntentError(`Unknown keyed verb: ${intent.verb}.`);
  assertSubject(intent.subject);
  assertCode(intent.lastCode);
  if (intent.lastStatus !== null && (!Number.isInteger(intent.lastStatus) || intent.lastStatus < 0))
    throw new InvalidStuckIntentError("A stuck intent status is a non-negative integer or null.");
  if (
    intent.lastRequestId !== null &&
    (typeof intent.lastRequestId !== "string" || intent.lastRequestId.length > CODE_MAX)
  )
    throw new InvalidStuckIntentError("A stuck intent request id is a short scalar or null.");
  if (!Number.isSafeInteger(intent.attempts) || intent.attempts < 1)
    throw new InvalidStuckIntentError("A stuck intent records at least one attempt.");
  return {
    idempotencyKey: intent.idempotencyKey,
    verb: intent.verb as KeyedMutationVerb,
    subject: intent.subject,
    lastCode: intent.lastCode,
    lastStatus: intent.lastStatus,
    lastRequestId: intent.lastRequestId,
    attempts: intent.attempts,
  };
}

/** Persisted stuck intent: the intent plus queue bookkeeping. */
export type StuckIntentRecord = StuckIntent & {
  firstSeenAt: Date;
  lastAttemptAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolution: string | null;
};

/** Bounded operator surface over the stuck-intent table. */
export interface ReconciliationStore {
  /**
   * Insert-or-touch keyed by idempotency key: first writer wins first_seen_at,
   * later redeliveries refresh the last outcome while the row stays open.
   * Never overwrites a resolved row and never mints a key.
   */
  recordStuck(intent: StuckIntent, now?: Date): Promise<StuckIntentRecord>;
  /** Open rows, oldest stuck first, at most `limit`. */
  listOpen(limit: number): Promise<StuckIntentRecord[]>;
  /** Recently resolved rows, newest first, at most `limit`. */
  listResolved(limit: number): Promise<StuckIntentRecord[]>;
  getStuck(idempotencyKey: string): Promise<StuckIntentRecord | null>;
  /**
   * Reconcile by hand: stamps the open row resolved with the moderator and
   * their note. Returns null when the key is unknown or already resolved.
   * Never deletes: the row stays as the audit evidence.
   */
  resolveStuck(
    idempotencyKey: string,
    resolution: { by: string; note: string },
    now?: Date,
  ): Promise<StuckIntentRecord | null>;
}

type StuckRow = {
  idempotency_key: string;
  verb: string;
  subject: string;
  first_seen_at: Date;
  last_attempt_at: Date;
  attempts: number;
  last_code: string | null;
  last_status: string | number | null;
  last_request_id: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution: string | null;
};

function recordFrom(row: StuckRow): StuckIntentRecord {
  return {
    idempotencyKey: row.idempotency_key,
    verb: row.verb as KeyedMutationVerb,
    subject: row.subject,
    lastCode: row.last_code,
    lastStatus: row.last_status === null ? null : Number(row.last_status),
    lastRequestId: row.last_request_id,
    attempts: Number(row.attempts),
    firstSeenAt: row.first_seen_at,
    lastAttemptAt: row.last_attempt_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolution: row.resolution,
  };
}

export function pgReconciliationStore(
  sql: ReturnType<typeof postgres> | TxClient,
): ReconciliationStore {
  // Same server-side bound posture as the sync store: a stuck statement is
  // cancelled by Postgres instead of holding the handler pool's connection
  // past the consumer's client-side race.
  const bound = async <T>(work: (tx: TxClient) => Promise<T>): Promise<T> => {
    const pool = sql as unknown as { begin?: (fn: (tx: TxClient) => Promise<T>) => Promise<T> };
    const run = async (tx: TxClient): Promise<T> => {
      await tx`select set_config('lock_timeout', ${`${LEDGER_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${LEDGER_DB_TIMEOUT_MS}ms`}, true)`;
      return work(tx);
    };
    try {
      return typeof pool.begin === "function" ? await pool.begin(run) : await run(sql);
    } catch (error) {
      // Class-only: store errors can carry SQL or member data.
      console.warn("reconciliation store operation failed", {
        exception: queueExceptionClass(error),
      });
      throw error;
    }
  };
  return {
    async recordStuck(intent, now = new Date()) {
      return bound(async (tx) => {
        const [row] = (await tx`insert into bot_reconciliation_intents
          (idempotency_key, verb, subject, first_seen_at, last_attempt_at, attempts,
           last_code, last_status, last_request_id)
          values (${intent.idempotencyKey}::uuid, ${intent.verb}, ${intent.subject},
            ${now}, ${now}, ${intent.attempts},
            ${intent.lastCode}, ${intent.lastStatus}, ${intent.lastRequestId})
          on conflict (idempotency_key) do update set
            last_attempt_at = excluded.last_attempt_at,
            attempts = greatest(bot_reconciliation_intents.attempts, excluded.attempts),
            last_code = excluded.last_code,
            last_status = excluded.last_status,
            last_request_id = excluded.last_request_id
          where bot_reconciliation_intents.resolved_at is null
          returning *`) as unknown as StuckRow[];
        if (!row) {
          // Conflict on an already-resolved row: the intent is reconciled, the
          // audit row stands. Return the standing row unchanged.
          const [existing] = (await tx`select * from bot_reconciliation_intents
            where idempotency_key = ${intent.idempotencyKey}::uuid`) as unknown as StuckRow[];
          if (!existing) throw new Error("stuck intent record lost its conflict row");
          return recordFrom(existing);
        }
        return recordFrom(row);
      });
    },
    async listOpen(limit) {
      const capped = Math.floor(limit);
      if (!Number.isFinite(capped) || capped < 1) return [];
      return bound(async (tx) => {
        const rows = (await tx`select * from bot_reconciliation_intents
          where resolved_at is null order by first_seen_at asc limit ${Math.min(capped, 500)}`) as unknown as StuckRow[];
        return rows.map(recordFrom);
      });
    },
    async listResolved(limit) {
      const capped = Math.floor(limit);
      if (!Number.isFinite(capped) || capped < 1) return [];
      return bound(async (tx) => {
        const rows = (await tx`select * from bot_reconciliation_intents
          where resolved_at is not null order by resolved_at desc limit ${Math.min(capped, 500)}`) as unknown as StuckRow[];
        return rows.map(recordFrom);
      });
    },
    async getStuck(idempotencyKey) {
      if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) return null;
      return bound(async (tx) => {
        const [row] = (await tx`select * from bot_reconciliation_intents
          where idempotency_key = ${idempotencyKey}::uuid`) as unknown as StuckRow[];
        return row ? recordFrom(row) : null;
      });
    },
    async resolveStuck(idempotencyKey, resolution, now = new Date()) {
      if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) return null;
      const by = resolution.by.trim().slice(0, 200);
      const note = resolution.note.trim();
      if (by.length === 0 || note.length === 0 || note.length > RESOLUTION_MAX) return null;
      return bound(async (tx) => {
        const [row] = (await tx`update bot_reconciliation_intents
          set resolved_at = ${now}, resolved_by = ${by}, resolution = ${note}
          where idempotency_key = ${idempotencyKey}::uuid and resolved_at is null
          returning *`) as unknown as StuckRow[];
        return row ? recordFrom(row) : null;
      });
    },
  };
}
