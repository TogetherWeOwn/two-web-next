// S1 link-in-bio pages (spec section 9, S1): the public no-JS member links
// page and the owner's native-form editor. The public page ships zero
// <script> tags and always renders guest chrome (link-in-bio viewers arrive
// logged out from other platforms), so it reads no session. Both pages reuse
// the profile theme through a standalone shell (Layout's theme="profile"
// head), so the canonical tag serializes with the exact `>` form the
// inventory pins (Hono JSX self-closes void elements as `/>`).
import { html, raw } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";
import { profileAvatarSrcset } from "../islands/contracts";
import { SiteFooter, SiteHeader, SkipLink } from "../page-shell";
import { canonicalUrl } from "../seo";
import type { MemberLink } from "./links-store";
import { MEMBER_LINKS_MAX } from "./links-validation";
import { profileInitials } from "./pages";
import type { MemberView } from "./store";

export const MEMBER_LINKS_FORM_TESTID = "member-links-form";
export const MEMBER_LINKS_TEXT_ID = "member-links-text";

const descriptionFor = (member: MemberView): string =>
  member.bio && member.bio.trim().length >= 20
    ? member.bio.trim()
    : `${member.username}'s links on Together We Own`;

/** Standalone shell: Layout's theme="profile" head with an exact canonical tag. */
const LinksShell: FC<
  PropsWithChildren<{ title: string; description: string; canonical: string }>
> = ({ title, description, canonical, children }) => (
  <>
    {raw("<!doctype html>")}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#151720" />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" sizes="180x180" />
        <title>{title}</title>
        <meta name="description" content={description} />
        {html`<link rel="canonical" href="${canonical}">`}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Together We Own" />
        <meta property="og:url" content={canonical} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <link rel="stylesheet" href="/styles.css" />
        <link
          rel="preload"
          href="/fonts/display-latin-700.woff2"
          as="font"
          type="font/woff2"
          crossorigin="anonymous"
        />
        <link rel="stylesheet" href="/theme-tokens.css" />
        <link rel="stylesheet" href="/theme.css" />
        <link rel="stylesheet" href="/profile-theme.css" />
      </head>
      <body class="base-theme profile-theme">
        <SkipLink />
        {children}
      </body>
    </html>
  </>
);

export const MemberLinksPage: FC<{
  member: MemberView;
  links: MemberLink[];
  appUrl: string;
  reportHref: string;
}> = ({ member, links, appUrl, reportHref }) => {
  const img = profileAvatarSrcset(member.id, member.avatar);
  const canonical = canonicalUrl(appUrl, `/members/${member.id}/links`);
  // S5 wires the subscriber live banner into this slot; S1 always renders offline.
  const liveCopy = "Offline — not live right now";
  return (
    <LinksShell
      title={`${member.username}'s links — Together We Own`}
      description={descriptionFor(member)}
      canonical={canonical}
    >
      <SiteHeader />
      <main id="main" tabindex={-1}>
        <section class="profile-player" aria-labelledby="member-links-heading">
          <div class="profile-identity">
            <span data-testid="member-links-avatar" class="avatar" aria-hidden="true">
              {img ? (
                <img
                  src={img.src}
                  srcset={img.srcset}
                  alt=""
                  width="64"
                  height="64"
                  loading="eager"
                />
              ) : null}
              <span class="avatar-initial" hidden={!!img}>
                {profileInitials(member.username)}
              </span>
            </span>
            <div>
              <p class="profile-caption">Member links</p>
              <h1 id="member-links-heading" tabindex={-1}>
                {member.username}
              </h1>
              <p class="profile-bio" data-testid="member-links-bio">
                {member.bio || `${member.username} hasn't added a bio yet.`}
              </p>
            </div>
          </div>
          <p data-testid="member-links-live-status" class="links-live" role="status">
            <span class="links-live-dot" aria-hidden="true"></span> {liveCopy}
          </p>
          <h2 id="member-links-list-heading">Links</h2>
          <ul
            data-testid="member-links-list"
            class="links-list"
            aria-labelledby="member-links-list-heading"
          >
            {links.map((link) => (
              <li>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener"
                  aria-label={`${link.label} (opens in a new tab)`}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
          {links.length === 0 ? <p class="profile-hint">No links yet.</p> : null}
          <p class="profile-hint">
            See something harmful? <a href={reportHref}>Report abuse</a> in our Discord.
          </p>
        </section>
      </main>
      <SiteFooter />
    </LinksShell>
  );
};

export const LinksEditorPage: FC<{
  member: MemberView;
  appUrl: string;
  isModerator: boolean;
  draft: string;
  errors?: Record<string, string>;
}> = ({ member, appUrl, isModerator, draft, errors }) => {
  const messages = errors ? Object.values(errors) : [];
  const describedBy =
    messages.length > 0 ? "member-links-text-help member-links-errors" : "member-links-text-help";
  return (
    <LinksShell
      title={`Edit your links — Together We Own`}
      description={`Edit the up to ${MEMBER_LINKS_MAX} links on your Together We Own link-in-bio page.`}
      canonical={canonicalUrl(appUrl, "/profile/links")}
    >
      <header class="bar profile-header-bar">
        <a class="brand" href="/">
          TWO
        </a>
        <div class="profile-header-actions">
          <nav aria-label="Primary">
            <a class="btn" href="/profile">
              Your profile
            </a>
            <a class="btn profile-secondary" href="/events">
              Events
            </a>
            {isModerator ? (
              <a class="btn profile-secondary" href="/admin" data-testid="profile-admin-link">
                Moderator admin
              </a>
            ) : null}
          </nav>
          <form method="post" action="/logout" data-testid="member-links-signout">
            <button type="submit" class="link">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main id="main" tabindex={-1}>
        <section class="profile-panel" aria-labelledby="links-edit-heading">
          <h1 id="links-edit-heading" tabindex={-1}>
            Edit your links
          </h1>
          <p class="profile-hint">
            <a href={`/members/${member.id}/links`}>View your links page</a>
          </p>
          {messages.length > 0 ? (
            <div role="alert" tabindex={-1} id="member-links-errors">
              <ul>
                {messages.map((message) => (
                  <li>
                    <a href={`#${MEMBER_LINKS_TEXT_ID}`}>{message}</a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <form method="post" action="/profile/links" data-testid={MEMBER_LINKS_FORM_TESTID}>
            <label class="profile-field">
              Links (one per line, as `Label | https://…`){" "}
              <textarea
                id={MEMBER_LINKS_TEXT_ID}
                name="links_text"
                rows={6}
                aria-invalid={messages.length > 0 ? "true" : undefined}
                aria-describedby={describedBy}
              >
                {draft}
              </textarea>
            </label>
            <p id="member-links-text-help" class="profile-hint">
              Up to {MEMBER_LINKS_MAX} links, one per line. Clear the box to remove every link.
            </p>
            <p>
              <button class="btn" type="submit" data-testid="member-links-save">
                Save links
              </button>
            </p>
          </form>
        </section>
      </main>
      <SiteFooter />
    </LinksShell>
  );
};
