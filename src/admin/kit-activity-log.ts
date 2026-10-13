// Kit activity-log viewer core (card 38/43). Framework-free so the root
// Vitest suite pins every branch without a SvelteKit transform: the
// +page.server.ts binding owns only the 503 mapping, like
// src/kit-past-events.ts. Same reads and failure posture as the Hono viewer
// (src/admin/routes.tsx GET /admin/activity-log): the bounded subject/causer
// filters, newest-first paging with a one-row lookahead, and the explicit
// projection that never selects `properties`. The hook's member-read boundary
// owns classification and the audit; this only decides which HTTP posture the
// Hono route keeps.
//
// Imported rows keep legacy internal causer IDs (docs/data-import.md): they
// render with an explicit legacy label and never become access-log subjects,
// because the guard only accepts snowflakes and inventing a member subject
// would be worse than logging none. Null causers (cron/system) render as an
// em dash and likewise contribute no subject.
import { ACTIVITY_LOG_PAGE_SIZE, parseActivityLogQuery } from "./table-list";
import type { Db } from "../db/index";
import type { Env } from "../env";
import { listActivityLog, type ActivityLogViewerRow } from "./reads";
import { dbFor } from "./db";

export { formatActivityCauser } from "./table-list";

/** Kit-serializable viewer row: the stable UTC instant travels as ISO text. */
export type KitActivityLogRow = Omit<ActivityLogViewerRow, "createdAt"> & {
  createdAt: string;
};

export type ActivityLogListFn = (
  db: Db,
  opts: { subject?: string; causer?: string; page?: number },
) => Promise<ActivityLogViewerRow[]>;

export interface ActivityLogLoadArgs {
  env: Env;
  subjectParam: string | null;
  causerParam: string | null;
  pageParam: string | null;
  setHeaders: (headers: Record<string, string>) => void;
  dbForFn?: (c: { env: Env }) => Promise<Db | null>;
  listFn?: ActivityLogListFn;
}

/** Branded-outage marker: the Kit binding maps every throw to error(503). */
export function activityLogUnavailable(): Error & { status: number } {
  return Object.assign(new Error("Admin temporarily unavailable"), { status: 503 });
}

const PRIVATE_NO_STORE = { "cache-control": "private, no-store" };

/**
 * Load the viewer page. Exactly one setHeaders call per path: SvelteKit
 * throws `header_already_set` on a double-set, so the caller must not set
 * headers again on a throw. Rows arrive pre-rendered with ISO instants,
 * exactly as the Hono page emits them inside <time datetime>.
 */
export async function loadActivityLogPage({
  env,
  subjectParam,
  causerParam,
  pageParam,
  setHeaders,
  dbForFn = dbFor,
  listFn = listActivityLog,
}: ActivityLogLoadArgs): Promise<{
  rows: KitActivityLogRow[];
  query: { subject: string; causer: string; page: number };
  hasNext: boolean;
}> {
  let db: Db | null;
  try {
    db = await dbForFn({ env });
  } catch {
    setHeaders(PRIVATE_NO_STORE);
    throw activityLogUnavailable();
  }
  if (!db) {
    setHeaders(PRIVATE_NO_STORE);
    throw activityLogUnavailable();
  }
  const query = parseActivityLogQuery({
    subject: subjectParam ?? undefined,
    causer: causerParam ?? undefined,
    page: pageParam ?? undefined,
  });
  try {
    const fetched = await listFn(db, query);
    const rows = fetched.slice(0, ACTIVITY_LOG_PAGE_SIZE).map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    }));
    setHeaders(PRIVATE_NO_STORE);
    return { rows, query, hasNext: fetched.length > ACTIVITY_LOG_PAGE_SIZE };
  } catch {
    setHeaders(PRIVATE_NO_STORE);
    throw activityLogUnavailable();
  }
}
