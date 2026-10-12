import type { FC } from "hono/jsx";
import type { DiscordWidgetSnapshot } from "../discord-widget";
import type { JoinResult } from "../return-journey";
import { canonicalUrl } from "../seo";
import { JoinResultBanner, Layout, SiteFooter, SiteHeader } from "../page-shell";

// Join carries the same share tags as home (TOG-5624): the funnel lives on
// shared links. The intro doubles as the share description, same as legacy.
export const JOIN_INTRO = "Approve once with Discord and we will add you to the server.";

export const Join: FC<{
  inviteUrl: string;
  widgetUrl: string | null;
  widgetSnapshot?: DiscordWidgetSnapshot | null;
  next?: string | null;
  appUrl: string;
  joinResult?: JoinResult | null;
}> = ({ inviteUrl, widgetUrl, widgetSnapshot, next, appUrl, joinResult }) => (
  <Layout
    title="Join Together We Own"
    canonical={canonicalUrl(appUrl, "/join")}
    shareDescription={JOIN_INTRO}
    theme="join"
    markdownAlternate="/join.md"
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
          {widgetSnapshot ? (
            <>
              <section
                aria-labelledby="discord-presence-heading"
                data-testid="join-widget-presence"
              >
                <h2 id="discord-presence-heading">In {widgetSnapshot.name} now</h2>
                <p data-testid="join-widget-online">
                  <strong>{widgetSnapshot.presenceCount}</strong>{" "}
                  {widgetSnapshot.presenceCount === 1 ? "member online" : "members online"}
                </p>
                <p>
                  <a href={widgetSnapshot.inviteUrl ?? inviteUrl} data-testid="join-widget-invite">
                    Join with an invite link
                  </a>
                </p>
                {widgetSnapshot.channels.length > 0 ? (
                  <>
                    <h3>Voice and stage channels</h3>
                    <ul data-testid="join-widget-channels">
                      {widgetSnapshot.channels.map((channel) => (
                        <li key={channel.id}>{channel.name}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>No voice channels open right now.</p>
                )}
                {widgetSnapshot.members.length > 0 ? (
                  <>
                    <h3>Online now</h3>
                    <ul data-testid="join-widget-members">
                      {widgetSnapshot.members.map((member, index) => (
                        <li key={`${member.username}-${index}`}>
                          {member.username} ({member.status})
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>Members list unavailable right now.</p>
                )}
              </section>
              {widgetUrl ? (
                <div class="strap">
                  <p>Discord&apos;s live server preview loads only when you ask for it.</p>
                  <a
                    class="btn"
                    href={widgetUrl}
                    referrerpolicy="no-referrer"
                    data-join-widget
                    data-testid="join-widget-load"
                  >
                    Show live server preview
                  </a>
                  <script src="/islands/join-widget.js" defer />
                </div>
              ) : null}
            </>
          ) : widgetUrl ? (
            <div class="strap">
              <p>Discord&apos;s live server preview loads only when you ask for it.</p>
              <a
                class="btn"
                href={widgetUrl}
                referrerpolicy="no-referrer"
                data-join-widget
                data-testid="join-widget-load"
              >
                Show live server preview
              </a>
              <script src="/islands/join-widget.js" defer />
            </div>
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
