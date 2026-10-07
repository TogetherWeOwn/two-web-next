// Ports. The Rust bot's HTTP client and the events store land in later slices; the queue and cron
// logic below is written against these so it tests without either.

export type EventUpsert = {
  eventKey: string;
  name: string;
  startsAt: string;
  endsAt: string | null;
  location: string;
  description: string | null;
};

export type Announcement = { channelKey: string; body: string };
export type RoleAssignment = { userId: string; roleKey: string };

export type BotFailure = {
  ok: false;
  code: string;
  status: number;
  requestId: string | null;
  message: string;
  /** The bot's `retryable` flag is authoritative, never the HTTP status. */
  retryable: boolean;
  retryAfterSeconds: number | null;
};
export type BotSuccess<T> = { ok: true; requestId: string | null } & T;

/** Could not ask (bot down): a wait, never a failure. */
export class BotTransportError extends Error {}
/** Missing secret / payload the bot would call malformed: terminal. */
export class BotTerminalError extends Error {}
/** Known retry result could not be committed; the durable claim remains closed. */
export class SyncRetryPersistenceError extends Error {
  readonly nextAttemptAt: Date | null;
  constructor(nextAttemptAt: Date | null, cause: unknown) {
    super("sync retry result could not be persisted; request remains fenced", { cause });
    this.nextAttemptAt = nextAttemptAt;
  }
}

export interface BotClient {
  upsertEvent(
    p: EventUpsert,
    idempotencyKey: string,
  ): Promise<BotSuccess<{ discordEventId: string }> | BotFailure>;
  cancelEvent(
    p: { eventKey: string },
    idempotencyKey: string,
  ): Promise<BotSuccess<{ discordEventId: string }> | BotFailure>;
  postAnnouncement(
    a: Announcement,
    idempotencyKey: string,
  ): Promise<BotSuccess<{ messageId: string; replayed: boolean }> | BotFailure>;
  assignRole(r: RoleAssignment): Promise<BotSuccess<{ outcome: string }> | BotFailure>;
}

export type SyncAttempt = {
  idempotencyKey: string;
  eventKey: string;
  revision: number;
  mirroredAt: Date;
  /** `failed` is definitive refusal; `obsolete` was retired before any request. */
  state: "pending" | "succeeded" | "failed" | "obsolete";
  requestAttempts: number;
  /** Null while a claim's result is unsettled, or after retirement/exhaustion. */
  nextAttemptAt: Date | null;
} & (
  | { action: "event.upsert"; payload: EventUpsert }
  | { action: "event.cancel"; payload: { eventKey: string } }
);

export interface EventStore {
  /** Snapshot at first attempt, not dispatch. Retries return the persisted request. */
  prepareSync(
    eventKey: string,
    idempotencyKey: string,
    mirroredAt: Date,
  ): Promise<SyncAttempt | { waiting: true } | null>;
  /** Atomically settle the attempt and acknowledge only its revision/RSVP cutoff. */
  completeSync(attempt: SyncAttempt, discordEventId: string): Promise<void>;
  /** Fence a due request until its result commits, or retire an obsolete snapshot. */
  claimSync(attempt: SyncAttempt, now: Date): Promise<SyncAttempt | null>;
  deferSync(attempt: SyncAttempt, nextAttemptAt: Date | null): Promise<void>;
  /** Settle only a definitive refusal. */
  failSync(idempotencyKey: string): Promise<void>;
  needsSync(eventKey: string): Promise<boolean>;
  /** Recovery preserves request identity, eligibility and attempts across carriers. */
  pendingSync(eventKey: string): Promise<SyncAttempt | null>;
  /**
   * True when the current `sync_revision` carries a `failed` (definitive
   * refusal) snapshot. `needsSync` is false for both clean and refused
   * revisions, so reconciliation must check this before treating a clean
   * read as obsolete — deleting the only ledger evidence of an event that
   * never reached Discord is forbidden (docs/runbook.md).
   */
  hasFailedSync?(eventKey: string): Promise<boolean>;
  /** Published events past ends_at -> past. Returns rows changed. */
  closeFinished(now: Date): Promise<number>;
  /** Top up every live series (draft/published parent). Returns rows created; idempotent. */
  materializeSeries(): Promise<number>;
  /** Initiating-eligible dirty revisions and attempted pending recovery candidates. */
  staleEventKeys(): Promise<string[]>;
}

/**
 * Query surface a single-flight job body runs on: the reserved transaction
 * client (postgres.js `TransactionSql`). Awaited tagged-template queries
 * only — the flight owns the transaction, so no nested `begin`/`reserve`/`end`
 * (postgres.js rejects `begin` on a transaction client at runtime).
 *
 * `any[]` parameters are deliberate: both the pool client and the transaction
 * client are assignable here, so bodies compile unchanged against either.
 */
export type TxClient = (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;

/** One age-pruned table (Laravel MassPrunable): mass delete older than cutoff, returns rows removed. */
export interface AgePrunedTable {
  pruneOlderThan(cutoff: Date): Promise<number>;
}

/** web_sessions expiry sweep: delete rows reads can no longer see (expires_at <= now). */
export interface SessionSweeper {
  sweepExpired(now: Date): Promise<number>;
}

/** Every table the daily model:prune pass owns (routes/console.php ×3 + web_sessions GC). */
export interface PruneStores {
  accessLog: AgePrunedTable;
  joinAttempts: AgePrunedTable;
  idempotencyKeys: AgePrunedTable;
  searchLog: AgePrunedTable;
  sessions: SessionSweeper;
}

/** ShouldBeUnique: acquire returns an ownership token, or null while a holder's lock is live. */
export interface UniqueLock {
  acquire(key: string, ttlSeconds: number): Promise<string | null>;
  /** Compare-and-delete: an expired carrier cannot release a successor's lease. */
  release(key: string, leaseToken: string): Promise<void>;
}

/** Originating web request, not the bot response ID or a deduplication key. */
type QueueCorrelation = { requestId?: string };

export type QueueMessage = QueueCorrelation &
  // Optional only for pre-fencing messages: those finish without releasing a lock (TTL recovers it).
  (
    | {
        kind: "sync-event";
        eventKey: string;
        idempotencyKey: string;
        leaseToken?: string;
        jobId?: string;
      }
    | { kind: "announcement"; idempotencyKey: string; action: Announcement; jobId?: string }
    | { kind: "role-assign"; idempotencyKey: null; action: RoleAssignment; jobId?: string }
    | { kind: "alert-probe"; probeId?: string; jobId?: never }
  );

/**
 * N3 (TOG-9895): the countable side of the queue. Cloudflare Queues carries the
 * messages but has no depth API, so dispatch and consume mirror every message's
 * lifecycle into Postgres (`queue_jobs`/`queue_failed_jobs`) — the same
 * `jobs`/`failed_jobs` pair the legacy `queue:check-depth` probe counted.
 * Every method is best-effort from the caller's side: a ledger outage must not
 * stall job processing (the /up probe reports `unknown` for the same outage).
 */
export interface QueueLedger {
  /** A message was accepted by the queue. `availableAt` includes the debounce delay. */
  enqueued(job: {
    jobId: string;
    kind: string;
    key: string | null;
    availableAt: Date;
  }): Promise<void>;
  /** A consumer picked the message up. */
  reserved(jobId: string): Promise<void>;
  /** The message went back to the queue (retry outcome or redelivery). */
  released(jobId: string, availableAt: Date): Promise<void>;
  /** Terminal success: remove the row. */
  dequeued(jobId: string): Promise<void>;
  /** Terminal failure: move the row into `queue_failed_jobs` (legacy `failed_jobs`). */
  failed(jobId: string, kind: string, key: string | null, reason: string): Promise<void>;
}
