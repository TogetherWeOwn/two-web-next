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
// renders. Dates cross into the view pre-rendered as UTC ISO strings, with
// the exact saved SQL text alongside for driver-undecodable bounds (BC,
// infinity). The
// POST /admin/featured/:id and POST /admin/featured/:id/delete siblings and
// the guarded /admin/featured-contents/:id/edit legacy redirect stay
// Hono-owned, so this model carries no write.
import type { Db } from "../db/index";
import { isDatabaseUnavailable } from "../db/errors";
import { alertRequestError } from "../alerts";
import {
  FEATURED_OPEN_END_COPY,
  FEATURED_OPEN_START_COPY,
  FEATURED_WINDOW_RULES_COPY,
  featuredBoundDisplay,
  featuredEligibilityReasonFor,
} from "../featured-eligibility";
import { currentlyVisible, featuredStatus, type FeaturedStatus } from "../featured-status";
import { safeStoredLink } from "../featured";
import { featuredImageSrc } from "../featured-image";
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
  /** Resolve shared copy server-side; even csr=false emits a structural client chunk. */
  eligibilityReason: string;
  startsAtLabel: string;
  endsAtLabel: string;
  windowRules: string;
  visible: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /** Exact saved SQL text of each bound (null when open); the panel shows it when the instant is undecodable (BC, infinity). */
  startsAtText: string | null;
  endsAtText: string | null;
  updatedAt: string;
  /** Evaluation instant featuredStatus() ran at (Hono prints now, not updatedAt). */
  checkedAt: string;
  /** Homepage-policy preview src (null when the homepage suppresses the image). */
  imageSrc: string | null;
  /** Homepage alt fallback (imageAlt?.trim() || title). */
  imageAlt: string;
  /** Stored-link judged preview href (null when the homepage suppresses the link). */
  previewUrl: string | null;
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
  /** Site origin for the shared image policy (load passes env.APP_URL). */
  appUrl?: string;
  /** Extra allowed image hosts (load passes env.FEATURED_IMAGE_HOSTS). */
  imageHosts?: string;
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
    // error page for the uncaught rejection). A code bug emits the leak-free
    // error.alert diagnostic first so it never looks like a downstream
    // outage, mirroring src/admin/kit-activity-log.ts, then still throws.
    if (isDatabaseUnavailable(err)) return { kind: "unavailable" };
    alertRequestError(err, { method: "GET", route: "/admin/featured/:id" });
    throw err;
  }
  if (!row) return { kind: "notFound" };
  const now = deps.now ?? new Date();
  // Homepage preview policy: the Hono panel renders FeaturedContentItem, which
  // runs the URL through featuredImageSrc() (allowlist + userinfo + // guard,
  // same-site absolute URLs rewritten to paths). Mirror it here so the preview
  // cannot show an image the homepage hides or the CSP blocks.
  const imageSrc = row.imageUrl
    ? featuredImageSrc(row.imageUrl, deps.appUrl ?? "", deps.imageHosts)
    : null;
  // Same for the preview link: judge the stored URL with the shared
  // stored-link policy so the preview cannot link what the homepage hides.
  // The form value below stays raw so the moderator can correct the link.
  const previewUrl = safeStoredLink({ url: row.url }).url;
  // BC and infinite bounds decode to Dates toISOString() cannot render; the
  // shared display helper keeps the ISO for finite instants and falls back to
  // the exact saved text so the load never throws on them.
  const startBound = featuredBoundDisplay(row.startsAt, row.startsAtText);
  const endBound = featuredBoundDisplay(row.endsAt, row.endsAtText);
  const status = featuredStatus(row, now);
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
      status,
      eligibilityReason: featuredEligibilityReasonFor(status),
      startsAtLabel:
        startBound.kind === "instant"
          ? startBound.iso
          : startBound.kind === "text"
            ? startBound.text
            : FEATURED_OPEN_START_COPY,
      endsAtLabel:
        endBound.kind === "instant"
          ? endBound.iso
          : endBound.kind === "text"
            ? endBound.text
            : FEATURED_OPEN_END_COPY,
      windowRules: FEATURED_WINDOW_RULES_COPY,
      visible: currentlyVisible(row, now),
      startsAt: startBound.kind === "instant" ? startBound.iso : null,
      endsAt: endBound.kind === "instant" ? endBound.iso : null,
      startsAtText: row.startsAtText ?? null,
      endsAtText: row.endsAtText ?? null,
      updatedAt: row.updatedAt.toISOString(),
      checkedAt: now.toISOString(),
      imageSrc,
      imageAlt: row.imageAlt?.trim() || row.title,
      previewUrl,
    },
  };
}
