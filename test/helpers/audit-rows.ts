// Audit tables are append-only (drizzle/1018_audit-immutability.sql): DELETE of
// a fresh row and TRUNCATE raise. Test teardown connects as the table owner, so
// it may lift the TRUNCATE guard inside one transaction, which is exactly the
// DDL right the deployed non-owner web role never holds.
import { sql as raw } from "drizzle-orm";
import type postgres from "postgres";
import type { Db } from "../../src/db/index";

export const AUDIT_TABLES = ["agent_event_audits", "member_data_access_logs", "activity_log"] as const;
export type AuditTable = (typeof AUDIT_TABLES)[number];

/** Owner-only reset of audit rows, resolved through the client's search_path. */
export async function clearAuditRows(client: postgres.Sql | Db, tables: readonly AuditTable[] = AUDIT_TABLES) {
  const statements = tables.flatMap((t) => [
    `ALTER TABLE "${t}" DISABLE TRIGGER "${t}_no_truncate"`,
    `TRUNCATE "${t}"`,
    `ALTER TABLE "${t}" ENABLE TRIGGER "${t}_no_truncate"`,
  ]);
  if ("transaction" in client) {
    await client.transaction(async (tx) => { for (const s of statements) await tx.execute(raw.raw(s)); });
  } else {
    await client.begin(async (tx) => { for (const s of statements) await tx.unsafe(s); });
  }
}
