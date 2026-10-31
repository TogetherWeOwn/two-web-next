// Stable pause-review API. Hono and Kit share the same escaped native HTML;
// existing Hono POST handlers still own admission and mutation semantics.
export { renderRsvpPauseReviewHtml, rsvpPauseReviewCopy } from "./native-review";
