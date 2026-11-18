import type postgres from "postgres";
import { databaseOptions, databaseUrl } from "../db/connection";
import { pgReconciliationStore } from "../jobs/reconciliation";
import type { EnvWithAdminDb } from "./db";
import {
  auditedReconciliationReads,
  reconciliationReadReceipt,
} from "./reconciliation-read-access";
import { pgReconciliationReads } from "./reconciliation-reads";
import { submitReconciliationResolution } from "./reconciliation-resolution";

/** Bind the receipts to the admitted moderator. This service does not dispatch jobs. */
export function reconciliationService(sql: ReturnType<typeof postgres>, actorId: string) {
  const reads = auditedReconciliationReads(
    pgReconciliationReads(sql),
    reconciliationReadReceipt(sql),
    actorId,
  );
  const store = pgReconciliationStore(sql);
  return {
    ...reads,
    resolve: (key: unknown, resolution: unknown) =>
      submitReconciliationResolution(store, actorId, key, resolution),
  };
}

/** Follow admin DB precedence; each operation installs its own transaction bounds. */
export async function reconciliationServiceFor(env: EnvWithAdminDb, actorId: string) {
  const injected = env.ADMIN_DB;
  if (injected) return reconciliationService(injected.$client, actorId);
  const url = databaseUrl(env);
  if (!url) return null;
  const { default: connect } = await import("postgres");
  return reconciliationService(connect(url, databaseOptions), actorId);
}
