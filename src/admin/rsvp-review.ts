// Shared pause-review presentation copy only; the existing Hono POST
// /admin/events/:key/rsvp-pause endpoint owns admission. Mirrors the
// terminal-action review shape (native disclosure, escaped saved target,
// truthful consequence, clearly labelled final submit) without depending on
// its unmerged files. Pure constants: safe to import into the Kit client.
// The Kit pages receive pre-rendered review HTML via their load data (never
// as literals or Svelte templates here), so the client bundle carries no
// review strings or disclosure markup; the parity test pins that.
export const rsvpPauseReviewCopy = {
  summary: "Review pause",
  target: "Saved event",
  consequence:
    "Pausing closes signups and freezes the waitlist line. Reopening settles waitlist vacancies.",
  keep: "To keep RSVPs open, close this review using Review pause again. Opening or closing this review changes nothing.",
  final: "Pause RSVPs",
} as const;

/** Escape exactly like Svelte 5 escape_html: text escapes & and <; attribute
 * values additionally escape ". Neither escapes > or '. */
function escapeReviewText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function escapeReviewAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Pre-render the Kit pause review as server-only HTML for {@html}: identical
 * markup, classes, testids and copy to the Hono RsvpAction disclosure, with
 * the saved title and key escaped exactly like Svelte would. The Kit client
 * bundle never sees this string; it arrives via load data. */
export function renderRsvpPauseReviewHtml(title: string, eventKey: string): string {
  const copy = rsvpPauseReviewCopy;
  const safeTitle = escapeReviewText(title);
  const safeLabel = escapeReviewAttr(`${copy.summary}: ${title}`);
  const safeKey = escapeReviewAttr(eventKey);
  return (
    `<details class="rsvp-review" data-testid="rsvp-pause-review">` +
    `<summary aria-label="${safeLabel}">${escapeReviewText(copy.summary)}</summary>` +
    `<p>${escapeReviewText(copy.target)}: <strong>${safeTitle}</strong></p>` +
    `<p class="rsvp-review-id">ID: ${escapeReviewText(eventKey)}</p>` +
    `<p>${escapeReviewText(copy.consequence)}</p>` +
    `<p>${escapeReviewText(copy.keep)}</p>` +
    `<form method="post" action="/admin/events/${safeKey}/rsvp-pause">` +
    `<button type="submit" class="btn" data-testid="rsvp-pause">${escapeReviewText(copy.final)}</button>` +
    `</form></details>`
  );
}
