import type { FC } from "hono/jsx";
import type { JoinResult } from "../return-journey";
import { canonicalUrl } from "../seo";
import { JoinResultBanner, Layout, SiteFooter, SiteHeader } from "../page-shell";

// Join carries the same share tags as home (TOG-5624): the funnel lives on
// shared links. The intro doubles as the share description, same as legacy.
export const JOIN_INTRO = "Approve once with Discord and we will add you to the server.";

export const Join: FC<{
  inviteUrl: string;
  widgetUrl: string | null;
  next?: string | null;
  appUrl: string;
  joinResult?: JoinResult | null;
}> = ({ inviteUrl, widgetUrl, next, appUrl, joinResult }) => (
  <Layout
    title="Join Together We Own"
    canonical={canonicalUrl(appUrl, "/join")}
    shareDescription={JOIN_INTRO}
    theme="join"
  >
    <SiteHeader />
    <main id="main" tabindex={-1}>
      {joinResult ? <JoinResultBanner result={joinResult} /> : null}
      <section class="join-layout" aria-labelledby="join-heading">
        <div class="join-panel">
          <h1 id="join-heading">Join Together We Own</h1>
          <p class="lead">{JOIN_INTRO}</p>
          <p>
            One click with Discord and we&apos;ll add you to the server — no invite link, no
            waiting.
          </p>
          <p class="join-actions">
            <a
              class="btn"
              href={next ? `/join/discord?next=${encodeURIComponent(next)}` : "/join/discord"}
              data-testid="join-oneclick"
            >
              Join with Discord
            </a>{" "}
            <a href={inviteUrl} data-testid="join-invite">
              Join with an invite link instead
            </a>
          </p>
        </div>
        <div class="join-preview">
          {widgetUrl ? (
            <iframe
              title="TWO Discord server preview"
              src={widgetUrl}
              width="350"
              height="500"
              sandbox="allow-scripts allow-same-origin"
              loading="lazy"
              referrerpolicy="no-referrer"
              data-testid="join-widget"
            />
          ) : (
            <p class="strap" data-testid="join-widget-fallback">
              Live server preview is unavailable — the join button above still works.
            </p>
          )}
        </div>
      </section>
    </main>
    <SiteFooter />
  </Layout>
);
