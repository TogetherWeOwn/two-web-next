// Moderator reconciliation surface (contract v2 §7.4/§11).
//
// Keyed bot mutations that end without confirmation — `needs_reconciliation`
// hard stops and retry-budget-exhausted unknowns — land here instead of a
// terminal failure or a member error. A moderator checks Discord by hand and
// stamps the row resolved with a note. Rows are never deleted and never
// re-dispatched from here: re-sending under a fresh key would fork the bot's
// key log, which is exactly what `needs_reconciliation` reports.
import postgres from "postgres";
import { databaseOptions, databaseUrl } from "../db/connection";
import { queueExceptionClass } from "../jobs/queue-error";
import { pgReconciliationStore, type ReconciliationStore } from "../jobs/reconciliation";
import type { TxClient } from "../jobs/types";
import type { Env } from "../env";

/** Bounded operator reads: the surface stays a page, never a dump. */
export const RECONCILIATION_OPEN_LIMIT = 100;
export const RECONCILIATION_RESOLVED_LIMIT = 50;

/** Resolution note bound (characters); blank refuses, longer refuses. */
export const RECONCILIATION_NOTE_MAX = 500;

/** Test-only seam (production resolves through the same seams as redispatch).
 * Route tests inject a store double (and an audit double) so they stay
 * DB-free; live suites leave both unset and exercise Postgres against the
 * disposable database. */
export type ReconciliationDeps = {
  store?: ReconciliationStore;
  audit?: (
    tx: TxClient,
    actorId: string,
    idempotencyKey: string,
    resolution: string,
  ) => Promise<void>;
};

type EnvWithReconciliationDeps = Env & { RECONCILIATION_DEPS?: ReconciliationDeps };

function depsFor(env: Env): ReconciliationDeps {
  return (env as EnvWithReconciliationDeps).RECONCILIATION_DEPS ?? {};
}

/** Open a request-scoped raw client for the stuck-intent store. Test doubles
 * bypass the pool entirely; production opens and ends one client per request
 * (the same posture as the queue redispatch path). */
export async function reconciliationStoreFor(env: Env): Promise<{
  store: ReconciliationStore;
  close: () => Promise<void>;
}> {
  const injected = depsFor(env).store;
  if (injected) return { store: injected, close: async () => {} };
  const url = databaseUrl(env);
  if (!url) throw new Error("no reconciliation database configured");
  const sql = postgres(url, {
    ...databaseOptions,
    connect_timeout: 2,
    connection: { statement_timeout: 5000 },
  });
  return {
    store: pgReconciliationStore(sql),
    close: async () => {
      await sql.end({ timeout: 1 }).catch(() => {});
    },
  };
}

/** Audit receipt for a manual reconcile: who stamped which key resolved, and
 * why. Append-only like every admin write; the row itself stays the evidence.
 * Runs on the resolve transaction's client, never its own connection. */
export async function recordReconciliationAccess(
  tx: TxClient,
  actorId: string,
  idempotencyKey: string,
  resolution: string,
): Promise<void> {
  await tx`insert into activity_log
    (log_name, description, subject_type, subject_id, causer_type, causer_id, event, properties)
    values ('operations', 'bot-reconciliation.resolve', 'bot_reconciliation_intents', ${idempotencyKey},
      'User', ${actorId}, 'resolve', ${JSON.stringify({
        resolution: { before: null, after: resolution },
      })}::jsonb)`;
}

/** Stamp the row resolved and write its receipt in one transaction. The
 * receipt follows the conditional update, so a lost race or failed update
 * leaves no receipt, and an unwritable trail rolls the stamp back (fail
 * closed): no resolve ever answers without a receipt. */
export async function resolveWithReceipt(
  env: Env,
  store: ReconciliationStore,
  actorId: string,
  idempotencyKey: string,
  note: string,
): Promise<"resolved" | "unchanged" | "refused"> {
  const audit = depsFor(env).audit ?? recordReconciliationAccess;
  try {
    const row = await store.resolveStuck(idempotencyKey, { by: actorId, note }, new Date(), (tx) =>
      audit(tx, actorId, idempotencyKey, note),
    );
    return row ? "resolved" : "unchanged";
  } catch (err) {
    console.warn("Reconciliation resolve failed; refusing the resolve.", {
      exception: queueExceptionClass(err),
      intent_key: typeof idempotencyKey === "string" ? "present" : "missing",
    });
    return "refused";
  }
}

/** Resolution note validation: non-empty, single scalar note, bounded. */
export function validateResolutionNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const note = raw.trim();
  if (note.length === 0 || note.length > RECONCILIATION_NOTE_MAX) return null;
  return note;
}
