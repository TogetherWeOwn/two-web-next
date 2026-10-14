// Kit read model for GET /admin/featured/:id.
// Framework-free by construction, like src/admin/kit-featured.ts: the
// +page.server.ts load is a thin SvelteKit binding around this, so the root
// suite pins the read shape without a SvelteKit transform. Authorization
// stays in the admin layout guard; the hook's member-read boundary owns
// classification and the audit.
//
// The read mirrors the Hono handler (src/admin/routes.tsx,
// admin.featured.edit): the same canonical parseRecordId admission (a
// non-canonical spelling 404s before any record lookup), the same shared
// getFeatured read, the same featuredValues shape for the form, and the same
// shared featuredStatus()/currentlyVisible() preview the Hono edit page
// renders. Dates cross into the view pre-rendered as UTC ISO strings. The
// POST /admin/featured/:id and POST /admin/featured/:id/delete siblings and
// the guarded /admin/featured-contents/:id/edit legacy redirect stay
// Hono-owned, so this model carries no write.
import type { Db } from "../db/index";
import { isDatabaseUnavailable } from "../db/errors";
import { currentlyVisible, featuredStatus, type FeaturedStatus } from "../featured-status";
import { parseRecordId } from "./record-id";
import type { FeaturedEditRow } from "./store-featured";

/** The edit-form values the Hono featuredValues() helper renders. */
export type KitFeaturedEditValues = {
  title: string;
  body: string;
  url: string;
  image_url: string;
  image_alt: string;
  is_published: string;
  position: string;
  starts_at: string;
  ends_at: string;
};

export type KitFeaturedEditView = {
  id: number;
  title: string;
  values: KitFeaturedEditValues;
  status: FeaturedStatus;
  visible: boolean;
  startsAt: string | null;
  endsAt: string | null;
  updatedAt: string;
};

export type KitFeaturedEditOutcome =
  | { kind: "notFound" }
  | { kind: "unavailable" }
  | { kind: "ok"; view: KitFeaturedEditView };

export type KitFeaturedEditDeps = {
  /** Null database answers the Hono dbOr503 503; the guard owns the rest. */
  db: Db | null;
  get: (db: Db, id: number) => Promise<FeaturedEditRow | null>;
  now?: Date;
};

export async function resolveKitFeaturedEdit(
  rawId: string,
  deps: KitFeaturedEditDeps,
): Promise<KitFeaturedEditOutcome> {
  // Canonical serial admission first: a non-canonical spelling 404s before
  // any record lookup or activity write, exactly like the Hono controller.
  const id = parseRecordId(rawId);
  if (id === null) return { kind: "notFound" };
  if (!deps.db) return { kind: "unavailable" };
  let row: FeaturedEditRow | null;
  try {
    row = await deps.get(deps.db, id);
  } catch (err) {
    // A classified outage answers the shared 503 (the Hono guard's
    // memberReadBoundary turns the read's rethrown outage into the
    // databaseUnavailable envelope; SvelteKit would otherwise render its 500
    // error page for the uncaught rejection). Anything else still throws.
    if (isDatabaseUnavailable(err)) return { kind: "unavailable" };
    throw err;
  }
  if (!row) return { kind: "notFound" };
  const now = deps.now ?? new Date();
  return {
    kind: "ok",
    view: {
      id: row.id,
      title: row.title,
      values: {
        title: row.title,
        body: row.body ?? "",
        url: row.url ?? "",
        image_url: row.imageUrl ?? "",
        image_alt: row.imageAlt ?? "",
        is_published: row.isPublished ? "on" : "",
        position: String(row.position),
        starts_at: row.startsAtText ?? "",
        ends_at: row.endsAtText ?? "",
      },
      status: featuredStatus(row, now),
      visible: currentlyVisible(row, now),
      startsAt: row.startsAt ? row.startsAt.toISOString() : null,
      endsAt: row.endsAt ? row.endsAt.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}
