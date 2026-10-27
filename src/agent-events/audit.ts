import type { Sql } from "postgres";
import type { Grant, Tx } from "./types";
import { storedEventKey } from "./payload";
import { isIngressBusy } from "./deadline";

export async function audit(
  sql: Tx,
  grant: Grant | null,
  operation: string,
  eventKey: string | null,
  key: string | null,
  dig: string | null,
  requestId: string,
  result: string,
  reason: string | null,
): Promise<void> {
  await sql`INSERT INTO agent_event_audits (grant_id, operation, event_key, idempotency_key, payload_digest, request_id, result, reason_code)
            VALUES (${grant?.id ?? null}, ${operation.slice(0, 32)}, ${storedEventKey(eventKey)}, ${key}, ${dig}, ${requestId}, ${result}, ${reason})`;
}

/** Outcome of a bounded busy audit: committed, or an expected timeout that keeps the 503. */
export type BusyAuditOutcome = "audited" | "timeout";

/**
 * Contention reporting shared by the outer shield and the inner limiter: the
 * error/operation_busy audit runs in its own short transaction with lock and
 * statement deadlines derived from the admission's lock wait — the
 * sampled-refusal precedent in shield.ts — after the admission transaction
 * has settled, holding no admission bucket lock. An expected audit timeout
 * (55P03/57014) returns "timeout" so the caller keeps its honest retryable
 * 503 with the same request_id; any other error propagates unwrapped for
 * existing diagnostics. Never fire-and-forget: the transaction commits or
 * rolls back before this returns.
 */
export async function auditOperationBusy(
  sql: Sql,
  lockWaitMs: number,
  grant: Grant | null,
  operation: string,
  eventKey: string | null,
  key: string | null,
  dig: string | null,
  requestId: string,
): Promise<BusyAuditOutcome> {
  const timeoutMs = Math.max(1, Math.floor(lockWaitMs));
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
      await tx.unsafe(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
      // A fresh grant can be deleted between lookup and this receipt (its zero
      // audit rows do not block deletion via the append-only trigger). The
      // audit FK would then turn the retryable 503 into a 23503 500. Revalidate
      // liveness inside this bounded transaction — FOR SHARE blocks a concurrent
      // delete until the receipt commits, mirroring checkGrant — and attribute a
      // vanished grant as null, like the removed-grant denial path.
      let effectiveGrant = grant;
      if (grant) {
        const [live] = await tx`SELECT id FROM agent_event_grants WHERE id = ${grant.id} FOR SHARE`;
        if (!live) effectiveGrant = null;
      }
      await audit(
        tx,
        effectiveGrant,
        operation,
        eventKey,
        key,
        dig,
        requestId,
        "error",
        "operation_busy",
      );
    });
    return "audited";
  } catch (err) {
    if (isIngressBusy(err)) return "timeout";
    throw err;
  }
}
