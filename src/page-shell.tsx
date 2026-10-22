import { raw } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";
import { BRAND_ICON_SVG, BRAND_LOCKUP_SVG } from "./brand-lockup";
import type { Session } from "./env";
import { HOME_JOIN_RESULT_COPY, HOME_NOTICES } from "./home-copy";
import { LEAF_CRITICAL_CSS } from "./leaf-critical-css";
import type { JoinResult } from "./return-journey";

const SITE_NAME = "Together We Own";

// Absolute share-image URL from the page canonical's origin: og:image and
// twitter:image must be absolute, and the render is a new file so no cache
// entry needs invalidating. A relative canonical cannot happen (canonicalUrl
// always prefixes APP_URL); the fallback keeps the tag well-formed anyway.
const shareImageUrl = (canonical: string): string => {
  try {
    return new URL("/og-1200x630.png", canonical).href;
  } catch {
    return "/og-1200x630.png";
  }
};

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
    /** Rooted path of the curated Markdown alternate (A2), e.g. `/about.md`. */
    markdownAlternate?: string;
    /**
     * Inline the shared critical-CSS bundle instead of linking it. Only the
     * homepage sets this: it reuses the exact leaf bundle (styles.css +
     * theme-tokens.css + theme.css), so first paint needs zero render-blocking
     * stylesheet requests. Recovery/error shells keep theme="home" without the
     * flag and stay on external stylesheets, so the CSP hash allowlist stays
     * scoped to "/" plus the content leaves.
     */
    inlineCriticalCss?: boolean;
  }>
> = ({
  title,
  canonical,
  shareTitle,
  shareDescription,
  robots,
  theme,
  markdownAlternate,
  inlineCriticalCss,
  children,
}) => (
  <>
    {raw("<!doctype html>")}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {theme && theme !== "content" ? (
          // First network hint: the Chakra Petch 700 LCP text must be discovered
          // with the first document chunk, not after the ~19 KB inlined style
          // block below. Late discovery left the simulated font completion at
          // the paint boundary and flipped `/` mobile LCP between FCP and
          // FCP + ~450 ms across staging runs.
          <link
            rel="preload"
            href="/fonts/chakra-petch-latin-700-normal.woff2"
            as="font"
            type="font/woff2"
            crossorigin="anonymous"
          />
        ) : null}
        <meta name="theme-color" content="#141117" />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/icons/icon-32.png" type="image/png" sizes="32x32" />
        <link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" sizes="180x180" />
        {robots ? <meta name="robots" content={robots} /> : null}
        <title>{title}</title>
        <meta
          name="description"
          content={
            shareDescription ||
            "Together We Own: a close-knit adult gaming community, founded 1998."
          }
        />
        {canonical ? (
          <>
            <link rel="canonical" href={canonical} />
            <meta property="og:type" content="website" />
            <meta property="og:site_name" content={SITE_NAME} />
            <meta property="og:url" content={canonical} />
            <meta property="og:title" content={shareTitle ?? title} />
            {shareDescription ? (
              <meta property="og:description" content={shareDescription} />
            ) : null}
            <meta property="og:image" content={shareImageUrl(canonical)} />
            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:title" content={shareTitle ?? title} />
            {shareDescription ? (
              <meta name="twitter:description" content={shareDescription} />
            ) : null}
            <meta name="twitter:image" content={shareImageUrl(canonical)} />
          </>
        ) : null}
        <link
          rel="alternate"
          type="application/rss+xml"
          title={`${SITE_NAME} Events`}
          href="/events.rss"
        />
        {markdownAlternate ? (
          <link
            rel="alternate"
            type="text/markdown"
            title="Markdown version"
            href={markdownAlternate}
          />
        ) : null}
        {theme === "content" || inlineCriticalCss ? (
          // Content leaves inline the three stylesheets: the mobile audit
          // measured ~150 ms of render-blocking savings on /rules, while
          // preload hints for the same files measured zero. The homepage
          // reuses the exact same bundle: its hero paints at first paint
          // (LCP equals FCP every staging run), so removing the three external
          // stylesheet requests is the primary FCP improvement. The Chakra Petch
          // 700 preload stays at the top of the head (above this block) for an
          // early font fetch; the Arial-metric 'Display Fallback' reduces
          // delayed-font layout shift (the preload alone cannot close the
          // FCP/font gap on cold mobile). The block is allowlisted by hash in
          // style-src (no unsafe-inline).
          <style dangerouslySetInnerHTML={{ __html: LEAF_CRITICAL_CSS }} />
        ) : (
          <link rel="stylesheet" href="/styles.css" />
        )}
        {theme ? (
          <>
            {!inlineCriticalCss && theme !== "content" ? (
              <>
                <link rel="stylesheet" href="/theme-tokens.css" />
                <link rel="stylesheet" href="/theme.css" />
              </>
            ) : null}
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
  </>
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
// "leaderboard" marks the member board link, which renders for members only:
// guests and non-members cannot open the board, so they are not offered it.
export const SiteHeader: FC<
  PropsWithChildren<{
    session?: Session | null;
    active?: "home" | "events" | "event" | "leaderboard";
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
      {session?.member ? (
        <a
          href="/leaderboards/members"
          aria-current={active === "leaderboard" ? "page" : undefined}
        >
          Leaderboard
        </a>
      ) : null}
    </nav>
    <a class="brand" href="/" aria-label="Together We Own homepage">
      {raw(BRAND_LOCKUP_SVG)}
      {raw(BRAND_ICON_SVG)}
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

// Notice sentences live in ./home-copy (shared with the Kit home route);
// this re-export keeps every existing importer untouched.
export const NOTICES: Record<Exclude<Notice, null>, string> = HOME_NOTICES;

// One-shot join confirmation (legacy join_result flash → data-testid="join-result",
// JoinResultCopyTest/AlreadyMemberReinviteTest). A member who was already in the
// guild gets the reinvite action — /discord resolves to the live invite — never
// the bare homepage "Open Discord".
export const JoinResultBanner: FC<{ result: JoinResult }> = ({ result }) => (
  <p class="notice" role="status" data-testid="join-result">
    {result === "added" ? (
      <>{HOME_JOIN_RESULT_COPY.added}</>
    ) : (
      <>
        {HOME_JOIN_RESULT_COPY.alreadyInServer}{" "}
        <a href="/discord" data-testid="reinvite-link">
          {HOME_JOIN_RESULT_COPY.reinvite}
        </a>
      </>
    )}
  </p>
);

// Shared funnel-leaf chrome for the static content leaves (about/faq/rules/
// privacy). Not part of the public barrel surface: leaf screens import it
// directly so the re-export list stays exactly the previous export list.
export const JOIN_HREF = "/join";

// The .md alternate sits next to the leaf path by construction (A2: one media
// type per route, so the alternate is the same path plus `.md`). Derived here
// so the four leaf screens cannot ship a mismatched pair.
const leafMarkdownAlternate = (canonical: string): string | undefined => {
  try {
    return `${new URL(canonical).pathname}.md`;
  } catch {
    return undefined;
  }
};

export const Leaf: FC<
  PropsWithChildren<{ title: string; canonical: string; headingId: string; heading: string }>
> = ({ title, canonical, headingId, heading, children }) => (
  <Layout
    title={title}
    canonical={canonical}
    theme="content"
    markdownAlternate={leafMarkdownAlternate(canonical)}
  >
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
