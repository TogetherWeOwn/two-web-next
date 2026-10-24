// Shared pause-review presentation copy only; the existing Hono POST
// /admin/events/:key/rsvp-pause endpoint owns admission. Mirrors the
// terminal-action review shape (native disclosure, escaped saved target,
// truthful consequence, clearly labelled final submit) without depending on
// its unmerged files. Pure constants: safe to import into the Kit client.
export const rsvpPauseReviewCopy = {
  summary: "Review pause",
  target: "Saved event",
  consequence:
    "Pausing closes signups and freezes the waitlist line. Reopening settles waitlist vacancies.",
  keep: "To keep RSVPs open, close this review using Review pause again. Opening or closing this review changes nothing.",
  final: "Pause RSVPs",
} as const;
