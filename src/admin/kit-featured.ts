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
// publish/window status is the shared guarded admin eligibility verdict —
// never a UI-local copy. Undecodable bounds cross as exact saved text.
import type { Db } from "../db/index";
import { isDatabaseUnavailable } from "../db/errors";
import { alertRequestError } from "../alerts";
import {
  featuredBoundDisplay,
  featuredInventoryStatus,
  type FeaturedEligibilityStatus,
} from "../featured-eligibility";
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
  startsAtText?: string | null;
  endsAtText?: string | null;
  updatedAt: Date;
};

export type KitFeaturedRow = {
  id: number;
  title: string;
  status: FeaturedEligibilityStatus;
  position: number;
  startsAt: string | null;
  startsAtText: string | null;
  endsAt: string | null;
  endsAtText: string | null;
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
      state?: string;
      now?: Date;
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
    // One evaluation instant for selection and badges, like the Hono
    // handler: the state predicate and the verdicts below share this now.
    fetched = await deps.list(deps.db, {
      ...query,
      published: query.published ? query.published === "1" : undefined,
      now,
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
  // Guarded admin eligibility/bound-display semantics, shared with the
  // Hono page and the edit panel: a published undecodable window withholds
  // the verdict (unavailable, never live) and keeps its exact saved text.
  const rows = fetched.slice(0, FEATURED_PAGE_SIZE).map((r) => {
    const startsAt = featuredBoundDisplay(r.startsAt, r.startsAtText);
    const endsAt = featuredBoundDisplay(r.endsAt, r.endsAtText);
    return {
      id: r.id,
      title: r.title,
      status: featuredInventoryStatus(r, now),
      position: r.position,
      startsAt: startsAt.kind === "instant" ? startsAt.iso : null,
      startsAtText: startsAt.kind === "text" ? startsAt.text : null,
      endsAt: endsAt.kind === "instant" ? endsAt.iso : null,
      endsAtText: endsAt.kind === "text" ? endsAt.text : null,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
  return {
    kind: "ok",
    rows,
    query,
    hasNext: fetched.length > FEATURED_PAGE_SIZE,
    emptyText: featuredEmptyText(query),
  };
}
