import type { Answer, Grant, Row, Tx } from "./types";
import { timingSafeEqualHex } from "./payload";
import { audit } from "./audit";

export async function lookupReplay(sql: Tx, grantId: string, key: string): Promise<Row | null> {
  const [row] =
    await sql`SELECT payload_digest, status, body, event_key FROM agent_event_idempotency_keys WHERE grant_id = ${grantId} AND key = ${key}`;
  return row ?? null;
}

export async function replayAnswer(
  sql: Tx,
  grant: Grant,
  op: string,
  replay: Row,
  dig: string,
  requestId: string,
  key: string,
): Promise<Answer> {
  if (!timingSafeEqualHex(replay.payload_digest, dig)) {
    await audit(
      sql,
      grant,
      op,
      replay.event_key,
      key,
      dig,
      requestId,
      "conflict",
      "idempotency_conflict",
    );
    return {
      status: 409,
      body: {
        reason: "idempotency_conflict",
        message:
          "This idempotency key was already used with a different payload. A key identifies one operation.",
        request_id: requestId,
      },
    };
  }
  // A delivery receipt, not another successful operation: keep stored evidence
  // untouched and distinguish replays from the original mutation/read.
  // Earlier standalone clients double-encoded the body; retain their replay
  // evidence without rewriting it or losing the original response fields.
  await audit(sql, grant, op, replay.event_key, key, dig, requestId, "replayed", null);
  const body = typeof replay.body === "string" ? JSON.parse(replay.body) : replay.body;
  return {
    status: replay.status,
    body: { ...(body as Record<string, unknown>), replayed: true, request_id: requestId },
  };
}
