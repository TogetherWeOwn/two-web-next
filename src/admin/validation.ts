// Admin input validation (W11). Ports the legacy Filament form rules
// (EventForm, FeaturedContentForm, EventInput, RecurrenceSchedule) as pure
// functions so they are unit-testable without a database.
//
// The validators live in ./validation-*.ts, one leaf per concern:
// shared error shape + text helpers, wall-time resolution, event-key minting,
// the event form, the featured form, and the status guard. The export list
// below is exactly the previous export list of this file, so all importers
// keep working untouched.

export { ValidationError, containsControlCharacters, type FieldErrors } from "./validation-shared";
export { isKnownTimezone, utcToWall, wallToUtc } from "./validation-wall-time";
export type { FoldPreference } from "./validation-wall-time";
export { newEventKey } from "./validation-event-keys";
export { parseEventForm, type EventFormInput } from "./validation-event-form";
export { parseFeaturedForm, type FeaturedFormInput } from "./validation-featured-form";
export { isMirrored, nextStatus, type EventStatus } from "./validation-status";
