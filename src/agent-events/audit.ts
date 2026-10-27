import type { Sql } from "postgres";
import type { Grant, Tx } from "./types";
import { storedEventKey } from "./payload";

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
      await audit(tx, grant, operation, eventKey, key, dig, requestId, "error", "operation_busy");
    });
    return "audited";
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "55P03" || code === "57014") return "timeout";
    throw err;
  }
}
