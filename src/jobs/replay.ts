import { SYNC_EVENT } from "./constants";
import { trackingQueue } from "./ledger";
import { sanitizeQueueScope } from "./queue-error";
import type { FailedJob } from "./redrive";
import { dispatchSyncEvent } from "./sync-event";
import type { EventStore, QueueLedger, UniqueLock } from "./types";

type Sendable = { send(body: unknown, opts?: { delaySeconds?: number }): Promise<unknown> };

const SYNC_EVENT_PREFIX = "sync-event:";

/**
 * Rebuildable identity for one dead-letter row. The ledger `key` is
 * `sync-event:<eventKey>` (see `trackingQueue` in ledger.ts). Returns null
 * when the row carries no rebuildable source link: a row alone can never
 * rebuild the message — redispatch always starts from the original authorized
 * source (see docs/queue-redrive-runbook.md).
 */
export function eventKeyFromFailedJob(failed: Pick<FailedJob, "kind" | "key">): string | null {
  if (failed.kind !== "sync-event") return null;
  if (!failed.key?.startsWith(SYNC_EVENT_PREFIX)) return null;
  const eventKey = failed.key.slice(SYNC_EVENT_PREFIX.length);
  return eventKey.length > 0 ? eventKey : null;
}

export type ReplayDisposition =
  | { action: "replay"; eventKey: string; idempotencyKey?: string; reason: string }
  | { action: "discard-stale"; eventKey: string; reason: string }
  | { action: "keep"; eventKey: string | null; reason: string };

/**
 * Narrow store surface reconciliation needs. `hasFailedSync` is required here
 * (not optional as on `EventStore`) because `needsSync === false` covers both
 * a clean source and a definitively refused revision — only the explicit
 * refusal check distinguishes them.
 */
export type ReconcileStore = Pick<EventStore, "needsSync" | "pendingSync"> & {
  hasFailedSync: (eventKey: string) => Promise<boolean>;
};

/**
 * Per-event reconciliation for one kept dead-letter row, before any retry or
 * discard. One row in, one disposition out — never a batch. The caller then
 * runs exactly one follow-up for that row: `replayFailedSyncEvent` (then
 * `discardFailedJob` only after the new message's recovery is confirmed), or
 * `discardFailedJob` for a stale row, or nothing for `keep`.
 *
 * - `replay`: the source is still dirty. A due pending request reuses its
 *   immutable idempotency key (same rule as `reconcileEvents` in cron.ts);
 *   otherwise the caller mints a fresh key via `replayFailedSyncEvent`.
 * - `discard-stale`: the source is clean AND has no failed snapshot and no
 *   live pending request, so the dead row is obsolete and `discardFailedJob`
 *   may remove exactly that row.
 * - `keep`: not a sync-event row, no rebuildable key, a definitive refusal,
 *   or a live request that is not due (unsettled claim, future attempt,
 *   exhausted budget) or that survives on a non-dirty event (e.g. a pending
 *   request on an event since closed to `past`) — leave the row and the live
 *   request to the scheduler/operator. Deleting the only ledger evidence of
 *   an event that never reached Discord is forbidden (docs/runbook.md).
 */
export async function reconcileFailedJob(
  events: ReconcileStore,
  failed: Pick<FailedJob, "kind" | "key">,
  now: () => Date = () => new Date(),
): Promise<ReplayDisposition> {
  if (failed.kind !== "sync-event") {
    return {
      action: "keep",
      eventKey: null,
      reason: "non-sync-event kind is outside this tool",
    };
  }
  const eventKey = eventKeyFromFailedJob(failed);
  if (!eventKey) {
    return {
      action: "keep",
      eventKey: null,
      reason: "dead-row key carries no rebuildable event identity",
    };
  }
  const scope = sanitizeQueueScope(eventKey);
  if (!(await events.needsSync(eventKey))) {
    // `needsSync === false` is ambiguous: the source may be clean, or the
    // current revision may carry a definitive refusal (`failed` snapshot),
    // which `staleKeys` also excludes. A pending request may also survive on
    // a non-dirty event (e.g. closed to `past`). All three must keep the row.
    const pending = await events.pendingSync(eventKey);
    if (pending) {
      return {
        action: "keep",
        eventKey,
        reason: `pending sync request for ${scope} needs operator recovery; preserve dead row and snapshot`,
      };
    }
    if (await events.hasFailedSync(eventKey)) {
      return {
        action: "keep",
        eventKey,
        reason: `definitive refusal for ${scope}; operator recovery required, preserve dead row and snapshot`,
      };
    }
    return {
      action: "discard-stale",
      eventKey,
      reason: `source for ${scope} is clean; dead row is obsolete`,
    };
  }
  const pending = await events.pendingSync(eventKey);
  if (!pending) {
    return {
      action: "replay",
      eventKey,
      reason: `source for ${scope} is still dirty; fresh dispatch`,
    };
  }
  if (pending.requestAttempts >= SYNC_EVENT.tries) {
    return {
      action: "keep",
      eventKey,
      reason: `request budget exhausted for ${scope}; leave to scheduler`,
    };
  }
  if (!pending.nextAttemptAt) {
    return {
      action: "keep",
      eventKey,
      reason: `claim unsettled for ${scope}; result in flight`,
    };
  }
  if (pending.nextAttemptAt > now()) {
    return {
      action: "keep",
      eventKey,
      reason: `pending request for ${scope} is not due; leave to scheduler`,
    };
  }
  // Due recovery candidate: reuse its immutable request identity, the same
  // rule the scheduled reconcile pass applies before dispatching.
  return {
    action: "replay",
    eventKey,
    idempotencyKey: pending.idempotencyKey,
    reason: `due recovery for ${scope}; reuse request identity`,
  };
}

/**
 * One-row retry-once: re-dispatch a reconciled sync-event from its original
 * authorized source through the producer path, which mints a fresh `jobId`.
 * The dead row stays untouched until the new message's recovery is confirmed.
 * Pass the `idempotencyKey` from a `replay` disposition when present; a fresh
 * key is minted otherwise (the constructor in Laravel).
 *
 * Operator entrypoint: the staging-gated
 * `POST /admin/queue/failed/:id/redispatch` route calls this helper for a
 * single reconciled row. No CLI or worker wiring imports it. The caller
 * passes the raw queue binding plus its ledger; the helper wraps them with
 * `trackingQueue` itself so the live message always records a `queue_jobs`
 * row for the runbook's dead-row-stays-until-recovery-confirmed check.
 */
export async function replayFailedSyncEvent(
  queue: Sendable,
  ledger: QueueLedger,
  lock: UniqueLock,
  eventKey: string,
  idempotencyKey: string = crypto.randomUUID(),
  signal?: AbortSignal,
  // Originating HTTP request for queue.failing correlation; optional, same as dispatchSyncEvent.
  requestId?: string,
): Promise<boolean> {
  return dispatchSyncEvent(
    trackingQueue(queue, ledger),
    lock,
    eventKey,
    idempotencyKey,
    signal,
    requestId,
  );
}
