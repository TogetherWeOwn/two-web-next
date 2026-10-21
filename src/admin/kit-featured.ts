// Kit read model for GET /admin/featured.
// Framework-free by construction, like src/admin/kit-dashboard.ts: the
// +page.server.ts load is a thin SvelteKit binding around this, so the root
// suite pins the read shape without a SvelteKit transform. Authorization
// stays in the admin layout guard; the hook's member-read boundary owns
// classification and the audit.
//
// The read mirrors the Hono handler (src/admin/routes.tsx,
// admin.featured.index): the same bounded parseFeaturedListQuery, the same
// published-flag mapping onto the shared listFeatured read, the same
// one-lookahead-row pagination slice. Dates cross into the view pre-rendered
// as UTC ISO strings, exactly as the Hono page emits them, and the
// publish/window status is the shared featuredStatus() the homepage read
// uses — never a UI-local copy.
import type { Db } from "../db/index";
import { isDatabaseUnavailable } from "../db/errors";
import { alertRequestError } from "../alerts";
import { featuredStatus, type FeaturedStatus } from "../featured-status";
import {
  FEATURED_PAGE_SIZE,
  featuredEmptyText,
  parseFeaturedListQuery,
  type FeaturedListQuery,
} from "./featured-list-query";
import type { ListParams } from "./table-list";

/** The FeaturedRow fields the list view reads (structural, so this stays light). */
export type KitFeaturedSourceRow = {
  id: number;
  title: string;
  isPublished: boolean;
  position: number;
  startsAt: Date | null;
  endsAt: Date | null;
  updatedAt: Date;
};

export type KitFeaturedRow = {
  id: number;
  title: string;
  status: FeaturedStatus;
  position: number;
  startsAt: string | null;
  endsAt: string | null;
  updatedAt: string;
};

export type KitFeaturedOutcome =
  | { kind: "unavailable" }
  | {
      kind: "ok";
      rows: KitFeaturedRow[];
      query: FeaturedListQuery;
      hasNext: boolean;
      emptyText: string;
    };

export type KitFeaturedDeps = {
  /** Null database answers the Hono dbOr503 503; the guard owns the rest. */
  db: Db | null;
  list: (
    db: Db,
    opts: {
      published?: boolean;
      q?: string;
      sort?: string;
      order?: string;
      page?: string | number;
    },
  ) => Promise<KitFeaturedSourceRow[]>;
  now?: Date;
};

export async function resolveKitFeaturedList(
  params: ListParams,
  deps: KitFeaturedDeps,
): Promise<KitFeaturedOutcome> {
  if (!deps.db) return { kind: "unavailable" };
  const query = parseFeaturedListQuery(params);
  const now = deps.now ?? new Date();
  let fetched: KitFeaturedSourceRow[];
  try {
    fetched = await deps.list(deps.db, {
      ...query,
      published: query.published ? query.published === "1" : undefined,
    });
  } catch (err) {
    // A classified outage answers the shared 503 (the Hono guard's
    // memberReadBoundary turns the list read's rethrown outage into the
    // databaseUnavailable envelope; SvelteKit would otherwise render its 500
    // error page for the uncaught rejection). A code bug emits the leak-free
    // error.alert diagnostic first so it never looks like a downstream
    // outage, mirroring src/admin/kit-activity-log.ts, then still throws.
    if (isDatabaseUnavailable(err)) return { kind: "unavailable" };
    alertRequestError(err, { method: "GET", route: "/admin/featured" });
    throw err;
  }
  const rows = fetched.slice(0, FEATURED_PAGE_SIZE).map((r) => ({
    id: r.id,
    title: r.title,
    status: featuredStatus(r, now),
    position: r.position,
    startsAt: r.startsAt ? r.startsAt.toISOString() : null,
    endsAt: r.endsAt ? r.endsAt.toISOString() : null,
    updatedAt: r.updatedAt.toISOString(),
  }));
  return {
    kind: "ok",
    rows,
    query,
    hasNext: fetched.length > FEATURED_PAGE_SIZE,
    emptyText: featuredEmptyText(query),
  };
}
