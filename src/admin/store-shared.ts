// Shared admin-store helpers (W11). Imported by both `./store` (event
// writes, access log) and `./store-featured` (featured CRUD) so the two
// leaves share one audit shape with no import cycle. `Actor` and
// `NotFoundError` are re-exported through `./store`, so existing importers
// keep working untouched; `dirty`/`audit` stay module-private as before.

import type { Db } from "../db/index";
import { activityLog } from "../db/admin-schema";

export type Actor = { id: string; username: string };

export class NotFoundError extends Error {
  constructor(readonly what: string) {
    super(`${what} not found`);
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
    const norm = (x: unknown) => (x instanceof Date ? x.toISOString() : (x ?? null));
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
