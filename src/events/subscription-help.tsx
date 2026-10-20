import { feedUrl } from "./feeds";
import { SUBSCRIPTION_GUIDANCE } from "./subscription-copy";

// SSR fragment for the Hono surfaces. Kit's archive mirrors this markup
// statically in web/src/routes/events/past/+page.svelte: Svelte cannot emit
// a literal <script> in a template, and {@html} inside the compared section
// leaves hydration anchors with no Hono counterpart, so the fragment carries
// no island script — each page loads /islands/copy-link.js once beside its
// other island scripts. The cross-target section contract pins Hono and Kit
// equal. Keep outside each island's swapped zones.
export function subscriptionHelp(appUrl: string) {
  const url = feedUrl(appUrl);
  return (
    <details class="subscription-help">
      <summary>How to subscribe to the calendar</summary>
      {SUBSCRIPTION_GUIDANCE.slice(0, 2).map((paragraph) => (
        <p>{paragraph}</p>
      ))}
      <label for="calendar-feed-url">Calendar feed URL</label>
      <div class="subscription-copy">
        <input id="calendar-feed-url" type="text" value={url} readonly />
        <button class="btn" type="button" data-copy-link={url} data-copy-feed hidden>
          Copy feed URL
        </button>
      </div>
      <p>Select the feed URL to copy it manually if Subscribe does not open your calendar app.</p>
      <p role="status" aria-atomic="true" data-copy-toast></p>
      <p>{SUBSCRIPTION_GUIDANCE[2]}</p>
    </details>
  );
}
