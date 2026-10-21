import type { FC, PropsWithChildren } from "hono/jsx";
import type { SuggestedEvent } from "./events/suggestions";
import { RecoveryShell } from "./pages";

// Branded error pages (N2 slice, TOG-9906). Ports of the four legacy two-web
// errors/*.blade.php views (TOG-5626/TOG-6788). No session or cookie reads.
// Only 404 attempts a bounded, optional, per-isolate cached DB read — every
// shell works without it.
const NOINDEX = "noindex, nofollow";

const JOIN_HREF = "/auth/discord";

const ErrorShell: FC<
  PropsWithChildren<{
    code: string;
    title: string;
    headerCta?: { href: string; label: string };
    supportingContent?: PropsWithChildren["children"];
  }>
> = ({ code, title, headerCta, supportingContent, children }) => (
  <RecoveryShell
    code={code}
    title={title}
    headingId="error-heading"
    robots={NOINDEX}
    headerCta={headerCta}
    supportingContent={supportingContent}
  >
    {children}
  </RecoveryShell>
);

export const BadRequestPage: FC<{ code?: "400" | "415" }> = ({ code = "400" }) => (
  <ErrorShell code={code} title="Check your request">
    <p class="lead">Check the address or filters and try again.</p>
    <p class="recovery-actions">
      <a class="btn" href="/events" data-testid="error-events">
        Browse all events
      </a>{" "}
      <a href="/" data-testid="error-home">
        Back to the homepage
      </a>
    </p>
  </ErrorShell>
);

// 404 recovery stays available even when the optional event lookup fails.
export const NotFoundPage: FC<{ suggestions?: SuggestedEvent[] }> = ({ suggestions = [] }) => (
  <ErrorShell
    code="404"
    title="We cannot find that page"
    supportingContent={
      <section
        class="recovery-events"
        aria-labelledby="error-events-heading"
        data-testid="error-event-suggestions"
      >
        <h2 id="error-events-heading">Happening soon</h2>
        {suggestions.length ? (
          <ul class="facts">
            {suggestions.map((event) => (
              <li class="card">
                <a
                  href={`/e/${encodeURIComponent(event.key)}`}
                  data-testid="error-event-suggestion"
                >
                  {event.title}
                </a>
                <p>
                  <time datetime={event.startsAt.toISOString()}>
                    {event.startsAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                  </time>
                  {event.location ? <> · {event.location}</> : null}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="error-events-empty">
            Nothing is on the calendar right now — check back soon.
          </p>
        )}
        <p>
          <a href="/events" data-testid="error-all-events">
            Browse all events
          </a>
        </p>
        <form action="/events" method="get" role="search" class="error-events-search">
          <label for="error-events-search">Search events</label>
          <div>
            <input
              id="error-events-search"
              name="q"
              type="search"
              placeholder="Search events…"
              autocomplete="off"
              data-testid="error-events-search"
            />
            <button type="submit" class="btn" data-testid="error-events-search-submit">
              Search events
            </button>
          </div>
        </form>
      </section>
    }
  >
    <p class="lead">
      The link may be old or mistyped, or the page may have moved. The lobby is still open — come in
      and say hello.
    </p>
    <p class="recovery-actions">
      <a class="btn" href={JOIN_HREF} data-testid="error-join">
        Join with Discord
      </a>{" "}
      <a href="/" data-testid="error-home">
        Back to the homepage
      </a>
    </p>
  </ErrorShell>
);

const SupportReference: FC<{ reference?: string }> = ({ reference }) =>
  reference ? (
    <p class="support-reference">
      Support reference: <code data-testid="error-support-reference">{reference}</code>
    </p>
  ) : null;

// 500 (ports errors/500). Never echoes the failure: message and trace stay in
// the logs, never in a member's browser. The CTA — and the header nav — point
// at the Discord invite URL directly, never /auth/discord: during a store
// outage the OAuth start is dead, same as 503.
export const InternalErrorPage: FC<{ inviteUrl: string; supportReference?: string }> = ({
  inviteUrl,
  supportReference,
}) => (
  <ErrorShell
    code="500"
    title="Something broke on our side"
    headerCta={{ href: inviteUrl, label: "Open Discord" }}
  >
    <p class="lead">
      It is not you. We have logged the failure and the team will take a look. Try again in a minute
      — the lobby is not going anywhere.
    </p>
    <p class="recovery-actions">
      <a class="btn" href={inviteUrl} data-testid="error-invite" rel="noopener">
        Use the Discord invite instead
      </a>{" "}
      <a href="/" data-testid="error-home">
        Back to the homepage
      </a>
    </p>
    <SupportReference reference={supportReference} />
  </ErrorShell>
);

// 429 (ports errors/429 + App\Support\ThrottleEnvelope::render). Same outage-safe
// CTA as 500/503: the invite URL works when the session store is throttled or down.
export const RateLimitedPage: FC<{ inviteUrl: string; supportReference?: string }> = ({
  inviteUrl,
  supportReference,
}) => (
  <ErrorShell
    code="429"
    title="Slow down a little"
    headerCta={{ href: inviteUrl, label: "Open Discord" }}
  >
    <p class="lead">
      You have made a lot of requests in a short time. Wait a moment and try again — the lobby is
      not going anywhere.
    </p>
    <p class="recovery-actions">
      <a class="btn" href={inviteUrl} data-testid="error-invite" rel="noopener">
        Use the Discord invite instead
      </a>{" "}
      <a href="/" data-testid="error-home">
        Back to the homepage
      </a>
    </p>
    <SupportReference reference={supportReference} />
  </ErrorShell>
);

// 403. Branded form of the bare "Forbidden" refusals: the viewer
// is signed in but lacks membership or the moderator bit, so there is no login
// loop and no OAuth start — only the way back home and the invite URL that
// works during an outage. No session or DB reads.
export const ForbiddenPage: FC<{ inviteUrl: string }> = ({ inviteUrl }) => (
  <ErrorShell
    code="403"
    title="You do not have access to this"
    headerCta={{ href: inviteUrl, label: "Open Discord" }}
  >
    <p class="lead">
      This page is for members or moderators. If you should see it, sign in again — otherwise the
      lobby is still open.
    </p>
    <p class="recovery-actions">
      <a class="btn" href={inviteUrl} data-testid="error-invite" rel="noopener">
        Use the Discord invite instead
      </a>{" "}
      <a href="/" data-testid="error-home">
        Back to the homepage
      </a>
    </p>
  </ErrorShell>
);

// 410. Generic retired-page shell, distinct from the event-specific
// EventGonePage: unknown and URL-freeze-retired paths stay 404, while an
// explicitly retired document answers here. No session or DB reads.
export const GonePage: FC = () => (
  <ErrorShell code="410" title="This page is gone">
    <p class="lead">The page was removed. The lobby is still open — come in and say hello.</p>
    <p class="recovery-actions">
      <a class="btn" href="/events" data-testid="error-events">
        Browse all events
      </a>{" "}
      <a href="/" data-testid="error-home">
        Back to the homepage
      </a>
    </p>
  </ErrorShell>
);

// 413. The refused body is gone, so the copy says nothing was saved and the
// primary action only recovers the place, never the draft: member-write
// surfaces return to their form (via returnHref/returnLabel), unknown and
// admin paths keep the homepage return.
export const PayloadTooLargePage: FC<{ returnHref?: string; returnLabel?: string }> = ({
  returnHref = "/",
  returnLabel = "Continue to the homepage",
}) => (
  <ErrorShell code="413" title="That request is too large">
    <p class="lead">Reduce the size of your request and try again.</p>
    <p>The refused request was not saved, so you will need to enter it again.</p>
    <p class="recovery-actions">
      <a class="btn" href={returnHref} data-testid="error-return">
        {returnLabel}
      </a>{" "}
      <a href="/" data-testid="error-home">
        Back to the homepage
      </a>
    </p>
  </ErrorShell>
);

// 503 (ports errors/503). The CTA — and the header nav — point at the Discord
// invite URL directly, never /auth/discord: during maintenance /auth may itself
// be down, so nothing on this page sends the member there.
export const MaintenancePage: FC<{ inviteUrl: string; supportReference?: string }> = ({
  inviteUrl,
  supportReference,
}) => (
  <ErrorShell
    code="503"
    title="We will be right back"
    headerCta={{ href: inviteUrl, label: "Open Discord" }}
  >
    <p class="lead">
      The site is down for a minute of maintenance. The Discord server never closes — come in
      through the invite and we will see you there.
    </p>
    <p class="recovery-actions">
      <a class="btn" href={inviteUrl} data-testid="error-invite" rel="noopener">
        Use the Discord invite instead
      </a>{" "}
      <a href="/" data-testid="error-retry">
        Try again
      </a>
    </p>
    <SupportReference reference={supportReference} />
  </ErrorShell>
);
