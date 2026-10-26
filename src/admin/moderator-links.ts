// Shared moderator-navigation targets (U1). Strict, read-free resolvers only
// for the exact subject shapes Next writes: ("Event", uppercase ULID
// eventKey) from store-event-writes.ts and ("FeaturedContent", decimal row
// id) from store-featured.ts, plus the status-correct public/preview target
// for a saved event. Both activity-log twins and both saved-event editor
// twins import these, so one definition pins the shared semantics. No
// legacy-morph guessing, no lookup reads: a shape-valid but nonexistent id
// still resolves, and anything else stays inert. Dependency-free on
// purpose: the Kit twins bundle this into their client output, so it must
// not pull the store, the database, or QA constants.

// The exact minted form: newEventKey (validation-event-keys.ts) emits
// 26-char uppercase Crockford ULIDs, the same alphabet as the public-route
// key parser (src/events/keys.ts) minus its case-insensitive flag —
// lowercase is never the stored form, so it never links.
const MINTED_EVENT_KEY = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// Decimal row ids as the featured writer stores them (String(id)); leading
// zeros, signs and fractions are never written, matching the legacy-edit
// guard's shape (admin/routes.tsx).
const FEATURED_ROW_ID = /^[1-9]\d*$/;

/**
 * Canonical saved-editor href for a Next-written activity subject, or null
 * when the subject must stay inert escaped text (unknown/legacy/malformed
 * type or id). Event editors live at GET /admin/events/:key and featured
 * editors at GET /admin/featured/:id (admin/routes.tsx); the /:key/edit
 * form is a legacy redirect, never the canonical target.
 */
export function resolveActivitySubjectHref(
  subjectType: string | null,
  subjectId: string | null,
): string | null {
  if (subjectType === "Event" && subjectId !== null && MINTED_EVENT_KEY.test(subjectId)) {
    return `/admin/events/${subjectId}`;
  }
  if (subjectType === "FeaturedContent" && subjectId !== null && FEATURED_ROW_ID.test(subjectId)) {
    return `/admin/featured/${subjectId}`;
  }
  return null;
}

export type EventPublicLink = { href: string; label: string };

/**
 * Status-correct public target for a saved event editor, or null when no
 * link may render. GET /e/:key serves drafts to moderators (403 for
 * everyone else), published and past rows publicly, and cancelled rows as
 * 410 Gone (src/events/routes-detail.tsx): drafts link their preview
 * (worded preview, never public), published and past rows link the public
 * page, and cancelled or unknown statuses link nowhere — a 410 is a
 * knowingly dead link. Unsaved/new forms never call this: they have no
 * Status section.
 */
export function eventPublicLink(status: string, eventKey: string): EventPublicLink | null {
  if (status === "draft") return { href: `/e/${eventKey}`, label: "Preview event page" };
  if (status === "published" || status === "past") {
    return { href: `/e/${eventKey}`, label: "View public event page" };
  }
  return null;
}
