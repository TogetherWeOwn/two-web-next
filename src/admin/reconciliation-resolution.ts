import { pgReconciliationStore } from "../jobs/reconciliation";
import type { TxClient } from "../jobs/types";

/** Record only the bounded resolution category, not a bot response or payload. */
export async function recordReconciliationResolution(
  tx: TxClient,
  actorId: string,
  key: string,
  resolution: string,
): Promise<void> {
  await tx`insert into activity_log
    (log_name, description, subject_type, subject_id, causer_type, causer_id, event, properties)
    values ('operations', 'bot-reconciliation.resolve', 'bot_reconciliation_intents', ${key},
      'User', ${actorId}, 'resolve', ${JSON.stringify({
        resolution: { before: null, after: resolution },
      })}::text::jsonb)`;
}

/** The store commits the receipt and conditional resolution in the same transaction. */
export function resolveReconciliation(
  store: Pick<ReturnType<typeof pgReconciliationStore>, "resolve">,
  key: string,
  actorId: string,
  resolution: string,
): Promise<boolean> {
  return store.resolve(key, actorId, resolution, (tx) =>
    recordReconciliationResolution(tx, actorId, key, resolution),
  );
}
