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

/**
 * One dashboard settings write, queued by the moderation page and delivered
 * to the bot's settings.set. The verb rides in the carrier so operators can
 * read the payload; the envelope admits exactly "settings.set", never an
 * arbitrary verb smuggled under the kind.
 */
export type SettingsSetAction = {
  verb: "settings.set";
  key: string;
  value: string;
  expected_version: number;
};
export type SettingsSetRequest = {
  key: string;
  value: string;
  expectedVersion: number;
  actor: string;
  guildId: string;
};
export type SettingsSetResult = BotSuccess<{ replayed: boolean }>;
/** Narrow seam for the queued settings writer (src/bot/settings.ts). */
export interface SettingsWriter {
  setSetting(
    r: SettingsSetRequest,
    idempotencyKey: string,
  ): Promise<SettingsSetResult | BotFailure>;
}

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
export const SYNC_RETRY_PERSISTENCE_REASON =
  "sync retry result could not be persisted; request remains fenced";
/** Known retry result could not be committed; the durable claim remains closed. */
export class SyncRetryPersistenceError extends Error {
  readonly nextAttemptAt: Date | null;
  constructor(nextAttemptAt: Date | null, cause: unknown) {
    super(SYNC_RETRY_PERSISTENCE_REASON, { cause });
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
  /**
   * Terminal-intent marker: the redacted definitive reason, recorded while
   * state stays pending so redelivery re-runs settlement without the bot
   * flow. Null until a definitive outcome is noted; absent on older rows.
   */
  terminalReason?: string | null;
  /**
   * Current `events.discord_event_id` at snapshot/claim time. Null means the
   * event was never mirrored to Discord; undefined is a pre-mirror snapshot
   * (hermetic doubles) and is treated as mirrored to preserve the bot path.
   */
  discordEventId?: string | null;
} & (
  | { action: "event.upsert"; payload: EventUpsert }
  | { action: "event.cancel"; payload: { eventKey: string } }
);

/**
 * One bounded page of the reconcile stale set: `keys` holds at most the
 * requested page size in ascending `event_key` order, and `deferred` counts
 * how many matched stale keys were left for later passes.
 */
export type StaleEventKeysPage = { keys: string[]; deferred: number };

export interface EventStore {
  /** Snapshot at first attempt, not dispatch. Retries return the persisted request. */
  prepareSync(
    eventKey: string,
    idempotencyKey: string,
    mirroredAt: Date,
  ): Promise<SyncAttempt | { waiting: true } | null>;
  /**
   * Atomically settle the attempt and acknowledge only its revision/RSVP cutoff.
   * Null keeps the stored `discord_event_id` (never-mirrored local completion):
   * the revision still advances and RSVPs stamp to the attempt's mirrored_at.
   */
  completeSync(attempt: SyncAttempt, discordEventId: string | null): Promise<void>;
  /** Fence a due request until its result commits, or retire an obsolete snapshot. */
  claimSync(attempt: SyncAttempt, now: Date): Promise<SyncAttempt | null>;
  deferSync(attempt: SyncAttempt, nextAttemptAt: Date | null): Promise<void>;
  /** Settle only a definitive refusal. */
  failSync(idempotencyKey: string): Promise<void>;
  /**
   * Record terminal intent for a definitive refusal without settling it:
   * first-writer-wins marker while the attempt stays pending. Optional so
   * older doubles keep compiling; the consumer skips noting when absent.
   */
  noteTerminalIntent?(idempotencyKey: string, reason: string): Promise<void>;
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
  /**
   * Initiating-eligible dirty revisions and attempted pending recovery
   * candidates. A dirty revision parked behind a permanently undispatchable
   * pending request (retry budget spent, or a null deadline that never becomes
   * due) is not stale: the reconcile loop always skips it, so it must not
   * consume page slots ahead of dispatchable keys. Not-yet-due retries stay
   * stale when `dueBefore` is omitted; the loop then owns the exact due check.
   * A supplied `dueBefore` applies that boundary in the selection, before
   * `ORDER BY` / `LIMIT`, using only that instant: recovery requires
   * `next_attempt_at <= dueBefore`, and any pending request still sleeping
   * then also blocks the dirty branch. With a cutoff, `deferred` counts only
   * due-eligible matches that were not returned. Called with a positive limit,
   * resolves one deterministic page: at most `limit` keys in ascending
   * `event_key` order plus how many matched keys were NOT returned (`deferred`
   * is 0 exactly when the page drained the backlog). Called without a limit,
   * resolves every stale key as an ascending ordered array (legacy shape
   * retained for existing single-key-era callers). Deferred keys stay stale
   * for the next pass: nothing marks, skips or reorders them.
   */
  staleEventKeys(limit?: number, dueBefore?: Date): Promise<string[] | StaleEventKeysPage>;
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

/** Run a whole drain on one isolated client; a rejection rolls back all its batches. */
export interface PruneIsolation {
  isolate?<T>(work: (prune: (at: Date) => Promise<number>) => Promise<T>): Promise<T>;
}

/** One age-pruned table (Laravel MassPrunable): mass delete older than cutoff, returns rows removed. */
export interface AgePrunedTable extends PruneIsolation {
  pruneOlderThan(cutoff: Date): Promise<number>;
}

/** web_sessions expiry sweep: delete rows reads can no longer see (expires_at <= now). */
export interface SessionSweeper extends PruneIsolation {
  sweepExpired(now: Date): Promise<number>;
}

/** Tables owned by the daily model:prune pass (audit logs, legacy prunes, web_sessions GC, and job_unique_locks expiry sweep). */
export interface PruneStores {
  agentEventAudits: AgePrunedTable;
  accessLog: AgePrunedTable;
  joinAttempts: AgePrunedTable;
  idempotencyKeys: AgePrunedTable;
  searchLog: AgePrunedTable;
  boardViews: AgePrunedTable;
  sessions: SessionSweeper;
  // Optional so stores built before the lock sweep (older stubs) still run:
  // pruneModelTables drains nothing for a missing sweeper instead of throwing.
  // Production always passes pgPruneStores().jobUniqueLocks.
  jobUniqueLocks?: SessionSweeper;
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
    | {
        kind: "settings-set";
        idempotencyKey: string;
        guildId: string;
        actor: string;
        action: SettingsSetAction;
        jobId?: string;
      }
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
