// Admin store barrel (structural split; zero behavior change). One module per
// concern lives beside this file: event writes behind the event-row FOR UPDATE
// lock in ./store-event-writes, event counts/reads in ./store-event-reads,
// the member-data access log in ./store-access, featured leaves in
// ./store-featured, shared audit helpers in ./store-shared. This file
// re-exports the historic public names so existing importers keep working
// untouched.

export {
  createFeatured,
  deleteFeatured,
  getFeatured,
  getFeaturedIdByLegacyId,
  listFeatured,
  updateFeatured,
} from "./store-featured";
export type { FeaturedEditRow, FeaturedRow } from "./store-featured";
export { type Actor, NotFoundError, StaleBaselineError } from "./store-shared";
export {
  createEvent,
  duplicateEvent,
  duplicateTitle,
  materializeMissingInstances,
  materializeRecurringSeries,
  mergePatchInput,
  patchEvent,
  setRsvpOpen,
  transitionEvent,
  updateEvent,
  updateEventIfBaselineMatches,
} from "./store-event-writes";
export type { EventRow, PatchBase, WriteBack } from "./store-event-writes";
export { getEvent, listEvents } from "./store-event-reads";
export type { EventListRow } from "./store-event-reads";
export { ensureAccessLogGin, recordAccess } from "./store-access";
