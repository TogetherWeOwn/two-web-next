import type { FC, PropsWithChildren } from "hono/jsx";
import type { Session } from "./env";
import type { JoinResult } from "./return-journey";

const SITE_NAME = "Together We Own";

export const SkipLink: FC = () => (
  <a class="skip-link" href="#main">
    Skip to content
  </a>
);

export const Layout: FC<
  PropsWithChildren<{
    title: string;
    canonical?: string;
    shareTitle?: string;
    shareDescription?: string | null;
    robots?: string;
    theme?: "home" | "event" | "content" | "join" | "profile" | "schedule";
  }>
> = ({ title, canonical, shareTitle, shareDescription, robots, theme, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="theme-color" content="#151720" />
      <link rel="manifest" href="/site.webmanifest" />
      <link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192" />
      <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" sizes="180x180" />
      {robots ? <meta name="robots" content={robots} /> : null}
      <title>{title}</title>
      <meta
        name="description"
        content={
          shareDescription || "Together We Own: a close-knit adult gaming community, founded 1998."
        }
      />
      {canonical ? (
        <>
          <link rel="canonical" href={canonical} />
          <meta property="og:type" content="website" />
          <meta property="og:site_name" content={SITE_NAME} />
          <meta property="og:url" content={canonical} />
          <meta property="og:title" content={shareTitle ?? title} />
          {shareDescription ? <meta property="og:description" content={shareDescription} /> : null}
          <meta name="twitter:card" content="summary" />
          <meta name="twitter:title" content={shareTitle ?? title} />
          {shareDescription ? <meta name="twitter:description" content={shareDescription} /> : null}
        </>
      ) : null}
      <link
        rel="alternate"
        type="application/rss+xml"
        title={`${SITE_NAME} Events`}
        href="/events.rss"
      />
      <link rel="stylesheet" href="/styles.css" />
      {theme ? (
        <>
          <link
            rel="preload"
            href="/fonts/display-latin-700.woff2"
            as="font"
            type="font/woff2"
            crossorigin="anonymous"
          />
          <link rel="stylesheet" href="/theme.css" />
          {theme === "event" ? <link rel="stylesheet" href="/event-theme.css" /> : null}
          {theme === "profile" ? <link rel="stylesheet" href="/profile-theme.css" /> : null}
          {theme === "schedule" ? <link rel="stylesheet" href="/schedule-theme.css" /> : null}
        </>
      ) : null}
    </head>
    <body
      class={
        theme ? `base-theme ${theme === "home" ? "homepage-theme" : `${theme}-theme`}` : undefined
      }
    >
      <SkipLink />
      {children}
    </body>
  </html>
);

type HeaderCta = { href: string; label: string };

// Header sign-in is the ordinary login round trip (/auth/discord). The RSVP and
// guest-redirect CTAs use loginUrl, which starts the join journey instead.
const signInUrl = (returnTo: string | null) =>
  returnTo ? `/auth/discord?next=${encodeURIComponent(returnTo)}` : "/auth/discord";

// Static pages pass no session: shared chrome never reads account persistence.
// joinAction renders the join-funnel entry on the static leaves; an explicit
// cta overrides the guest action (recovery shells pass their way back in).
// Children replace the account area (the schedule's member Discord link);
// loginReturnTo carries the guest sign-in destination. account={false} drops
// the account area on the session-less cancelled (410) event page; active
// "event" marks Events as the current section (not page) on event detail.
export const SiteHeader: FC<
  PropsWithChildren<{
    session?: Session | null;
    active?: "home" | "events" | "event";
    loginReturnTo?: string | null;
    account?: boolean;
    joinAction?: boolean;
    cta?: HeaderCta;
  }>
> = ({ session, active, loginReturnTo = null, account = true, joinAction, cta, children }) => (
  <header class="bar site-header">
    <nav class="main-nav" aria-label="Primary">
      <a href="/" aria-current={active === "home" ? "page" : undefined}>
        Home
      </a>
      <a
        href="/events"
        aria-current={active === "events" ? "page" : active === "event" ? "location" : undefined}
      >
        Events
      </a>
    </nav>
    <a class="brand" href="/" aria-label="Together We Own homepage">
      <img src="/logo.svg" width="64" height="64" alt="Together We Own" />
    </a>
    {account ? (
      <nav class="header-account" aria-label="Account">
        {children ??
          (session ? (
            <form method="post" action="/logout">
              <span class="account-caption">Signed in</span>
              <span class="who">{session.username}</span>
              <button type="submit" class="link">
                Sign out
              </button>
            </form>
          ) : (
            <div>
              <span class="account-caption">Welcome, guest</span>
              {cta ? (
                <a class="btn" href={cta.href} data-testid="signin">
                  {cta.label}
                </a>
              ) : joinAction ? (
                <a class="btn" href="/join">
                  Join with Discord
                </a>
              ) : (
                <a class="btn" href={signInUrl(loginReturnTo)} data-testid="signin">
                  Sign in with Discord
                </a>
              )}
            </div>
          ))}
      </nav>
    ) : null}
  </header>
);

// The site footer carries the static-leaf links on the funnel + leaf + error
// shells (home, join, recovery, about/faq/rules/privacy, branded errors —
// ports the legacy home footer: About, FAQ, House rules, Privacy), the
// themed schedule (/events, /events/past) and event detail/cancelled pages.
// Admin and profile shells intentionally keep their own chrome. One
// component so a new leaf cannot ship without a way back to it.
export const SiteFooter: FC = () => (
  <footer>
    Together We Own · adult gaming community · founded 1998
    <nav aria-label="Site">
      <a href="/about">About</a> <a href="/faq">FAQ</a> <a href="/rules">House rules</a>{" "}
      <a href="/privacy">Privacy</a>
    </nav>
  </footer>
);

// Presentational only: error and OAuth recovery routes must not read sessions
// or require a database just to render a way back into the community.
export const RecoveryShell: FC<
  PropsWithChildren<{
    title: string;
    headingId: string;
    code?: string;
    robots?: string;
    headerCta?: HeaderCta;
    supportingContent?: PropsWithChildren["children"];
  }>
> = ({ title, headingId, code, robots, headerCta, supportingContent, children }) => (
  <Layout title={`${title} — Together We Own`} robots={robots} theme="home">
    <SiteHeader cta={headerCta} />
    <main id="main" tabindex={-1}>
      <section class="hero recovery-hero" aria-labelledby={headingId}>
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
        {code ? (
          <p class="recovery-code" aria-hidden="true">
            {code}
          </p>
        ) : (
          <p class="strap">Let&apos;s get you back to the lobby</p>
        )}
        <h1 id={headingId}>{title}</h1>
        {children}
      </section>
      {supportingContent}
    </main>
    <SiteFooter />
  </Layout>
);

export type Notice =
  | "joined"
  | "already_member"
  | "join_failed"
  | "signin_failed"
  | "signin_denied"
  | "signin_unavailable"
  | null;

// One actionable sentence per failure meaning (legacy auth-discord.php, matched
// by meaning, not translation key): denied says "you cancelled", unavailable
// says "this is on Discord, not you — try again in a minute", the generic
// sentence covers an expired or otherwise incomplete attempt. Nobody's browser
// ever shows Discord's error_description.
export const NOTICES: Record<Exclude<Notice, null>, string> = {
  joined: "You're in. Welcome to the TWO Discord.",
  already_member: "Signed in. You're already in the TWO Discord.",
  join_failed:
    "Signed in, but we couldn't add you to the Discord automatically. Use the invite link below.",
  signin_failed: "Discord sign-in didn't complete. Please try again.",
  signin_denied:
    "You cancelled the Discord sign-in, so we didn't sign you in. Nothing changed — try again whenever you like.",
  signin_unavailable:
    "Discord did not answer just now, so we could not sign you in. This is on Discord, not you — please try again in a minute.",
};

// One-shot join confirmation (legacy join_result flash → data-testid="join-result",
// JoinResultCopyTest/AlreadyMemberReinviteTest). A member who was already in the
// guild gets the reinvite action — /discord resolves to the live invite — never
// the bare homepage "Open Discord".
export const JoinResultBanner: FC<{ result: JoinResult }> = ({ result }) => (
  <p class="notice" role="status" data-testid="join-result">
    {result === "added" ? (
      <>You are in. Finish Discord's rules screening before you can post.</>
    ) : (
      <>
        You are already in the server.{" "}
        <a href="/discord" data-testid="reinvite-link">
          Rejoin with the Discord invite
        </a>
      </>
    )}
  </p>
);

// Shared funnel-leaf chrome for the static content leaves (about/faq/rules/
// privacy). Not part of the public barrel surface: leaf screens import it
// directly so the re-export list stays exactly the previous export list.
export const JOIN_HREF = "/join";

export const Leaf: FC<
  PropsWithChildren<{ title: string; canonical: string; headingId: string; heading: string }>
> = ({ title, canonical, headingId, heading, children }) => (
  <Layout title={title} canonical={canonical} theme="content">
    <SiteHeader joinAction />
    <main id="main" tabindex={-1}>
      <div class="content-layout">
        <nav class="content-nav" aria-label="Community information">
          <a href="/about" aria-current={headingId === "about-heading" ? "page" : undefined}>
            About
          </a>
          <a href="/faq" aria-current={headingId === "faq-heading" ? "page" : undefined}>
            FAQ
          </a>
          <a href="/rules" aria-current={headingId === "rules-heading" ? "page" : undefined}>
            House rules
          </a>
          <a href="/privacy" aria-current={headingId === "privacy-heading" ? "page" : undefined}>
            Privacy
          </a>
        </nav>
        <section class="content-page" aria-labelledby={headingId}>
          <h1 id={headingId}>{heading}</h1>
          {children}
        </section>
      </div>
    </main>
    <SiteFooter />
  </Layout>
);
