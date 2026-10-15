import { sha256Hex } from "../bot/signer";
import type { Answer, Grant, Tx } from "./types";
import { audit } from "./audit";

export async function findGrant(sql: Tx, credential: string): Promise<Grant | null> {
  const [row] = await sql<
    Grant[]
  >`SELECT id, agent_id, guild_id, expires_at, disabled_at FROM agent_event_grants WHERE verifier_hash = ${await sha256Hex(credential)}`;
  return row ?? null;
}

// The final admission lock follows the operation/event locks, never precedes an
// event-row wait. It holds off provisioning updates until effects commit. Time is
// sampled after all waits, not with transaction-start now(); epoch milliseconds
// match initial Date admission without depending on the client's timestamp decoder.
export async function checkGrant(
  tx: Tx,
  grant: Grant,
  op: string,
  key: string,
  dig: string,
  requestId: string,
  eventKey: string | null,
  lock = false,
): Promise<Answer | null> {
  if (lock) await tx`SELECT id FROM agent_event_grants WHERE id = ${grant.id} FOR SHARE`;
  const [current] =
    await tx`SELECT floor(extract(epoch FROM expires_at) * 1000)::double precision AS expires_at_ms,
                            disabled_at IS NOT NULL AS disabled FROM agent_event_grants WHERE id = ${grant.id}`;
  const expired = current?.expires_at_ms != null && current.expires_at_ms <= Date.now();
  if (current && !expired && !current.disabled) return null;
  const reason = expired ? "grant_expired" : "grant_disabled";
  await audit(tx, current ? grant : null, op, eventKey, key, dig, requestId, "denied", reason);
  return {
    status: 403,
    body: {
      reason,
      message: expired
        ? "The grant has expired. Expiry rejects ingress and dispatch alike."
        : "The grant has been disabled by its provisioning owner.",
      request_id: requestId,
    },
  };
}
