import type { FC } from "hono/jsx";
import type { Counts, Rank } from "../counts";
import type { Session } from "../env";
import type { HomeEvent } from "../events/reads";
import type { VisibleFeatured } from "../featured";
import { inviteDestination } from "../invite";
import { cardTimeLabel, isValidZone } from "../islands/contracts";
import type { JoinResult } from "../return-journey";
import { canonicalUrl } from "../seo";
import {
  JoinResultBanner,
  Layout,
  NOTICES,
  type Notice,
  SiteFooter,
  SiteHeader,
} from "../page-shell";
import { FeaturedContentItem } from "./featured-item";

const FALLBACK_RANKS: Rank[] = ["Prospect", "Member", "Soldier", "Veteran", "Legend"].map(
  (label) => ({
    key: label.toLowerCase(),
    label,
    memberCount: null,
  }),
);

export const Home: FC<{
  session: Session | null;
  notice: Notice;
  joinResult?: JoinResult | null;
  inviteUrl: string;
  appUrl: string;
  counts: Counts;
  sessionUnavailable?: boolean;
  upcomingEvents: HomeEvent[];
  eventsUnavailable: boolean;
  featured: VisibleFeatured[];
  imageHosts?: string;
}> = ({
  session,
  notice,
  joinResult,
  inviteUrl: configuredInviteUrl,
  appUrl,
  counts,
  sessionUnavailable = false,
  upcomingEvents,
  eventsUnavailable,
  featured,
  imageHosts,
}) => {
  const inviteUrl = inviteDestination(configuredInviteUrl);
  return (
    <Layout
      title="Together We Own — the lobby is open"
      canonical={canonicalUrl(appUrl, "/")}
      shareDescription="We spent most of our life private. Now you can just turn up."
      theme="home"
    >
      <SiteHeader session={session} active="home" />
      <main id="main" tabindex={-1}>
        {/*
        The flashed join confirmation takes the notice slot: both carry the same
        event, and the banner is the richer of the two (reinvite action, exact
        confirmation copy). A bare ?n= still renders its notice when no flash is
        pending.
      */}
        {joinResult ? (
          <JoinResultBanner result={joinResult} />
        ) : (
          notice && (
            <p class="notice" role="status" data-testid="notice">
              {NOTICES[notice]}
            </p>
          )
        )}
        <section class="hero" aria-labelledby="home-heading">
          <div class="hero-detail hero-detail-left" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <div class="hero-detail hero-detail-right" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <p class="strap">A close-knit gaming clan / mostly evenings / 18+</p>
          <h1 id="home-heading">The lobby is open.</h1>
          <p class="lead">We spent most of our life private. Now you can just turn up.</p>
          {sessionUnavailable ? (
            <a class="btn" href="/discord" data-testid="discord-join">
              Join with an invite link
            </a>
          ) : session?.member ? (
            <a class="btn" href={inviteUrl}>
              Open Discord
            </a>
          ) : (
            <a class="btn" href="/auth/discord" data-testid="join">
              Join with Discord
            </a>
          )}
          {!session && !sessionUnavailable && eventsUnavailable && (
            <p>
              <a href="/discord" data-testid="discord-join">
                Join with an invite link instead
              </a>
            </p>
          )}
          {notice === "join_failed" && (
            <p>
              <a href={inviteUrl}>Join with an invite link instead</a>
            </p>
          )}
          {counts.memberCount != null && (
            <p class="counts" data-testid="member-count">
              <strong>{counts.memberCount}</strong> members
              {counts.onlineCount != null && counts.onlineCount > 0 && (
                <>
                  {" · "}
                  <strong>{counts.onlineCount}</strong> online
                </>
              )}
            </p>
          )}
        </section>
        {featured.length > 0 ? (
          <section aria-labelledby="featured-heading" data-testid="featured-content">
            <h2 id="featured-heading">From the community team</h2>
            <div class="facts">
              {featured.map((item) => (
                <FeaturedContentItem
                  key={item.id}
                  row={item}
                  appUrl={appUrl}
                  imageHosts={imageHosts}
                />
              ))}
            </div>
          </section>
        ) : null}
        <div class="community-grid">
          <section class="community-intro" aria-labelledby="community-heading">
            <h2 id="community-heading">No application. No interview.</h2>
            <p>
              Show up a few times. Play. Become a Member. The ladder records trust and time, not
              grind.
            </p>
            <p>Small enough that people notice when you come back.</p>
            <h3>Not a crowd. A place that knows your name.</h3>
            <p>The community is voice-first. Game nights get posted in the Discord first.</p>
          </section>
          <section class="discord-preview" aria-labelledby="discord-heading">
            <h2 id="discord-heading">In the Discord</h2>
            <p>Visit the join page for the server preview and ways to join.</p>
            <p>
              <a href="/join#join-heading" data-testid="home-widget-link">
                View the Discord lobby
              </a>
            </p>
            <p>
              <a href="/discord" data-testid="home-discord-invite">
                Open Discord
              </a>
            </p>
          </section>
        </div>
        <section aria-label="Community ladder" class="community-ladder">
          <h2>Prospect → Member → Soldier → Veteran → Legend</h2>
          <p>Ranks stack — a Veteran still holds everything below.</p>
          <dl class="facts rank-stack" data-testid="rank-stack">
            {(counts.ranks.length ? counts.ranks : FALLBACK_RANKS).map((rank) => (
              <div class="card" key={rank.key} data-rank={rank.key}>
                <dt>{rank.label}</dt>
                <dd>{rank.memberCount === 0 ? "unclaimed" : rank.memberCount}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-labelledby="home-events-heading">
          <p class="strap">Next up</p>
          <h2 id="home-events-heading">Game nights, when they land.</h2>
          {upcomingEvents.length > 0 ? (
            <>
              <ul class="facts home-events" data-testid="home-events-list">
                {upcomingEvents.map((event) => (
                  <li class="card">
                    <a class="home-event-link" href={`/e/${encodeURIComponent(event.eventKey)}`}>
                      <p>
                        <time datetime={event.startsAt.toISOString()}>
                          {cardTimeLabel(event.startsAt, event.timezone)} (
                          {isValidZone(event.timezone) ? event.timezone : "UTC"})
                        </time>
                      </p>
                      <h3>{event.title}</h3>
                      {event.location ? <p>{event.location}</p> : null}
                      <p>{event.goingCount} going</p>
                    </a>
                  </li>
                ))}
              </ul>
              <p>
                <a href="/events">
                  See all events <span aria-hidden="true">→</span>
                </a>
              </p>
            </>
          ) : (
            <div
              class="card"
              data-testid="home-events-empty"
              data-state={eventsUnavailable ? "unavailable" : "empty"}
            >
              <h3>
                {eventsUnavailable
                  ? "Game nights are unavailable right now."
                  : "Nothing scheduled yet."}
              </h3>
              <p>
                {eventsUnavailable
                  ? "We couldn’t load the schedule. The Discord is still open — check there for the next game night."
                  : "Game nights get posted here. Join the Discord and you’ll hear about the next one."}
              </p>
            </div>
          )}
          {!session ? (
            <p>
              <a class="btn" href="/join" data-testid="home-events-join">
                Join the Discord <span aria-hidden="true">→</span>
              </a>
            </p>
          ) : null}
        </section>
      </main>
      <SiteFooter />
    </Layout>
  );
};
