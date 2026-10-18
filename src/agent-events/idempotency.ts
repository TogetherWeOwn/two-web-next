import type { Answer, Grant, Row, Tx } from "./types";
import { isPlainObject, timingSafeEqualHex } from "./payload";
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
  // A stored body that cannot be decoded back into the original response
  // object must not wedge its key: answer the existing idempotency_conflict
  // vocabulary as an audited, committed 409, leaving the stored row untouched
  // and never re-executing (the original may already have committed).
  // "Undecodable" covers a string that is not JSON, truncated JSON, an empty
  // string, and JSON decoding to a non-object (scalar/array/null). Decoding
  // runs after the digest check above, so a mismatched payload keeps its plain
  // conflict without ever touching the stored bytes.
  let decoded: unknown = replay.body;
  if (typeof decoded === "string") {
    // Earlier standalone clients double-encoded the body; one parse restores
    // their object. Loop while a string remains so a doubly wrapped string
    // still resolves, but stop on the first non-JSON string.
    for (let i = 0; i < 3 && typeof decoded === "string"; i++) {
      try {
        decoded = JSON.parse(decoded);
      } catch {
        decoded = undefined;
        break;
      }
    }
  }
  if (!isPlainObject(decoded)) {
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
  // The replayed audit runs only after a successful decode, so it commits with
  // the answer instead of rolling back with a throw.
  await audit(sql, grant, op, replay.event_key, key, dig, requestId, "replayed", null);
  return {
    status: replay.status,
    body: { ...decoded, replayed: true, request_id: requestId },
  };
}
