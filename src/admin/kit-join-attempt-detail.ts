// Kit read model for GET /admin/join-attempts/:id.
// Framework-free by construction, like src/admin/kit-featured-edit.ts: the
// +page.server.ts load is a thin SvelteKit binding around this, so the root
// suite pins the read shape without a SvelteKit transform. Authorization
// stays in the admin layout guard; the hook's member-read boundary owns
// classification and the audit.
//
// The read mirrors the Hono handler (src/admin/routes.tsx,
// admin.join-attempts.show): the same canonical-ID admission (a non-canonical
// spelling 404s before any record lookup), the same shared getJoinAttempt
// retention-window lookup, and the same outcome/source/time/trace fields the
// Hono detail page renders. join_attempts.id is a bigserial, so the admission
// is the Hono handler's own positive-safe-integer spelling — NOT
// parseRecordId, whose signed-32-bit cap would 404 large retained IDs. Dates
// cross into the view pre-rendered as UTC ISO strings. No raw provider/token
// payload is selected: the shared projection carries only the six safe
// columns, and the token-hygiene test (test/join.test.ts) pins that no token
// ever reaches any table.
import type { Db } from "../db/index";
import { isDatabaseUnavailable } from "../db/errors";
import { alertRequestError } from "../alerts";
import { getJoinAttempt, type JoinAttemptRow } from "./reads";

/** Kit-serializable detail view: the stable UTC instant travels as ISO text. */
export type KitJoinAttemptDetailView = {
  id: number;
  outcome: string;
  source: string | null;
  requestId: string | null;
  discordId: string | null;
  createdAt: string;
};

export type KitJoinAttemptDetailOutcome =
  | { kind: "notFound" }
  | { kind: "unavailable" }
  | { kind: "ok"; view: KitJoinAttemptDetailView };

export type KitJoinAttemptDetailDeps = {
  /** Null database answers the Hono dbOr503 503; the guard owns the rest. */
  db: Db | null;
  get?: (db: Db, id: number) => Promise<{ attempt: JoinAttemptRow } | null>;
};

/**
 * Admit only the Hono handler's canonical positive-decimal ID spelling:
 * no leading zeros, no sign, no decimals, within safe-integer range.
 */
export function parseJoinAttemptId(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export async function resolveKitJoinAttemptDetail(
  rawId: string,
  deps: KitJoinAttemptDetailDeps,
): Promise<KitJoinAttemptDetailOutcome> {
  // Canonical serial admission first: a non-canonical spelling 404s before
  // any record lookup or activity write, exactly like the Hono controller.
  const id = parseJoinAttemptId(rawId);
  if (id === null) return { kind: "notFound" };
  if (!deps.db) return { kind: "unavailable" };
  const get = deps.get ?? getJoinAttempt;
  let found: { attempt: JoinAttemptRow } | null;
  try {
    found = await get(deps.db, id);
  } catch (err) {
    // A classified outage answers the shared 503 (the Hono guard's
    // memberReadBoundary turns the read's rethrown outage into the
    // databaseUnavailable envelope; SvelteKit would otherwise render its 500
    // error page for the uncaught rejection). A code bug emits the leak-free
    // error.alert diagnostic first so it never looks like a downstream
    // outage, mirroring src/admin/kit-activity-log.ts, then still throws;
    // SvelteKit renders its branded 500 shell, which the boundary releases
    // only after its audit decision, so no trace identifiers escape.
    if (isDatabaseUnavailable(err)) return { kind: "unavailable" };
    alertRequestError(err, { method: "GET", route: "/admin/join-attempts/:id" });
    throw err;
  }
  if (!found) return { kind: "notFound" };
  const row = found.attempt;
  return {
    kind: "ok",
    view: {
      id: row.id,
      outcome: row.outcome,
      source: row.source,
      requestId: row.requestId,
      discordId: row.discordId,
      createdAt: row.createdAt.toISOString(),
    },
  };
}
