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
