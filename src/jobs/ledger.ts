import { uniqueKey } from "./sync-event";
import type { QueueLedger, QueueMessage } from "./types";

type Sendable = { send(body: unknown, opts?: { delaySeconds?: number }): Promise<unknown> };

/**
 * N3 (TOG-9895): wraps a Queue producer so every accepted message also lands in
 * the Postgres ledger — the `jobs` row the /up probe counts. The jobId minted
 * here travels on the message body and is what the consumer stamps its
 * reserved/released/dequeued transitions on.
 *
 * Ordering: the ledger row is written before `send` because a row without a
 * message fails visible (phantom backlog), while a message without a row fails
 * silent (depth the probe cannot see). Rejected sends and cancelled inserts are
 * compensated by exact jobId, never by key or age. A failed compensation stays
 * visible as backlog; a later successful reconciliation cannot remove it.
 *
 * If the ledger write itself throws, send is never attempted and the error
 * propagates to the dispatcher — same posture as the legacy database queue,
 * where the job row WAS the dispatch.
 */
export function trackingQueue(
  queue: Sendable,
  ledger: QueueLedger,
  now: () => Date = () => new Date(),
  signal?: AbortSignal,
): Sendable {
  return {
    async send(body, opts) {
      signal?.throwIfAborted();
      const msg = body as QueueMessage;
      const jobId = crypto.randomUUID();
      const availableAt = new Date(now().getTime() + (opts?.delaySeconds ?? 0) * 1000);
      const key = msg.kind === "sync-event" ? uniqueKey(msg.eventKey) : null;
      try {
        // A lost INSERT response can hide a committed row too. No send has
        // started on this failure path, so exact-id compensation remains safe.
        await ledger.enqueued({ jobId, kind: msg.kind, key, availableAt });
        // A bounded successor may time out while its ledger insert is still
        // queued. Compensate a late insert; never begin a send after expiry.
        // An already-started send may complete late and keeps its tracked row.
        signal?.throwIfAborted();
        return await queue.send({ ...msg, jobId }, opts);
      } catch (err) {
        await ledger.dequeued(jobId).catch((e: unknown) => {
          console.warn("queue ledger compensation failed", jobId, e instanceof Error ? e.constructor.name : typeof e);
        });
        throw err;
      }
    },
  };
}
