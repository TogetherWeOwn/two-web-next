import { feedUrl } from "./feeds";
import { SUBSCRIPTION_GUIDANCE } from "./subscription-copy";

// One SSR fragment for Hono and Kit. Keep outside each island's swapped zones.
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
      <script src="/islands/copy-link.js" defer />
    </details>
  );
}

export function subscriptionHelpHtml(appUrl: string): string {
  return subscriptionHelp(appUrl).toString();
}
