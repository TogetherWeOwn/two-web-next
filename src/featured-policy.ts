// FeaturedContentPolicy parity (docs/parity.md §9).
//
// Legacy: every featured-content write is moderator-only; the public surface
// reads exactly the `currentlyVisible` rows (start inclusive, end exclusive,
// no homepage cap — src/featured.ts:11). TOG-8719 covered JoinAttempt +
// agent-event policies only; this module pins the featured half without
// touching the contested admin screens (routes/pages/guard/reads/store) or
// the event/home renders.
//
// Enforcement lives in the existing layers this file does NOT duplicate:
// - writes: `ALL /admin/*` moderator middleware + adminGuard (guest 302
//   bounce to OAuth, signed-in non-moderator 403) + the mounted app's
//   same-origin 403 on forged POSTs;
// - public reads: listVisibleFeatured (isPublished + [startsAt, endsAt)).
// This module is the reviewable policy statement those layers are tested
// against in test/featured-policy.test.ts.

import { currentlyVisible, type FeaturedWindow } from "./featured-status";

/** Who is asking: null/undefined = guest; the moderator bit comes from the session row. */
export type FeaturedPolicyActor = { moderator: boolean } | null | undefined;

/** All featured writes (create/update/delete/publish-window) are moderator-only. */
export function canManageFeaturedContent(actor: FeaturedPolicyActor): boolean {
  return actor?.moderator === true;
}

export const canCreateFeaturedContent = canManageFeaturedContent;
export const canUpdateFeaturedContent = canManageFeaturedContent;
export const canDeleteFeaturedContent = canManageFeaturedContent;
export const canPublishFeaturedContent = canManageFeaturedContent;

/** Public visibility is exactly `currentlyVisible`: published + [start, end). */
export function isFeaturedPubliclyVisible(row: FeaturedWindow, now: Date = new Date()): boolean {
  return currentlyVisible(row, now);
}

/** The only featured write routes (all behind `ALL /admin/*` → moderator). */
export const FEATURED_WRITE_ROUTES = [
  "POST /admin/featured",
  "POST /admin/featured/:id",
  "POST /admin/featured/:id/delete",
] as const;
