// Shared admin-store helpers (W11). Imported by both `./store` (event
// writes, access log) and `./store-featured` (featured CRUD) so the two
// leaves share one audit shape with no import cycle. `Actor` and
// `NotFoundError` are re-exported through `./store`, so existing importers
// keep working untouched; `dirty`/`audit` stay module-private as before.

import { sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { activityLog } from "../db/admin-schema";

export type Actor = { id: string; username: string };

const MODERATOR_WRITE_DB_TIMEOUT_MS = 2000;

// Same transaction-local convention as recordAccess. Install before any lock or
// write, keeping dependent child, waitlist and audit statements bounded too.
// This is a per-statement bound, not a whole-series/request deadline. Await the
// surrounding transaction (including rollback) before returning an HTTP refusal.
export async function boundModeratorWrite(tx: Pick<Db, "execute">): Promise<void> {
  await tx.execute(
    sql`select set_config('lock_timeout', ${`${MODERATOR_WRITE_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${MODERATOR_WRITE_DB_TIMEOUT_MS}ms`}, true)`,
  );
}

export const INVENTORY_READ_DB_TIMEOUT_MS = 2000;

// Same transaction-local convention as boundModeratorWrite, for the admin
// inventory reads (event list plus its Going counts, featured list,
// activity-log list). Install before any inventory statement so Postgres
// cancels a lock-blocked or slow SELECT server-side instead of the page
// waiting unbounded. Per-statement bound, not a whole-request deadline.
// Await the surrounding transaction (including rollback) before returning
// an HTTP refusal.
export async function boundInventoryRead(tx: Pick<Db, "execute">): Promise<void> {
  await tx.execute(
    sql`select set_config('lock_timeout', ${`${INVENTORY_READ_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${INVENTORY_READ_DB_TIMEOUT_MS}ms`}, true)`,
  );
}

export class NotFoundError extends Error {
  constructor(readonly what: string) {
    super(`${what} not found`);
  }
}

/**
 * The form's saved-content baseline no longer matches the locked row: another
 * writer committed first. Thrown before any mutation, so the refuse path
 * writes no content, no audit row and no child shift. The route answers 409
 * and re-renders the typed draft.
 */
export class StaleBaselineError extends Error {
  constructor() {
    super("event changed since the form was rendered");
  }
}

const AUDIT_EXCLUDE = new Set(["discordEventId", "icsSequence"]);

export function dirty<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const [k, v] of Object.entries(after)) {
    if (AUDIT_EXCLUDE.has(k)) continue;
    const b = before[k];
    // JSON represents an unrenderable stored date as null, including on repair.
    const norm = (x: unknown) => (x instanceof Date ? x.toJSON() : (x ?? null));
    if (JSON.stringify(norm(b)) !== JSON.stringify(norm(v)))
      out[k] = { before: norm(b), after: norm(v) };
  }
  return out;
}

export async function audit(
  db: Pick<Db, "insert">,
  opts: {
    subjectType: string;
    subjectId: string;
    causerId: string | null;
    description: string;
    properties: Record<string, { before: unknown; after: unknown }>;
  },
): Promise<void> {
  await db.insert(activityLog).values({
    logName: "default",
    description: opts.description,
    subjectType: opts.subjectType,
    subjectId: opts.subjectId,
    causerId: opts.causerId,
    properties: opts.properties,
  });
}
