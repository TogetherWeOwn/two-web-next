import type { FC, PropsWithChildren } from "hono/jsx";
import type { Counts, Rank } from "./counts";
import type { Session } from "./env";
import { canonicalUrl } from "./seo";

const SITE_NAME = "Together We Own";

export const Layout: FC<
  PropsWithChildren<{
    title: string;
    canonical?: string;
    shareTitle?: string;
    shareDescription?: string | null;
    robots?: string;
  }>
> = ({ title, canonical, shareTitle, shareDescription, robots, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="theme-color" content="#0b0714" />
      <link rel="manifest" href="/site.webmanifest" />
      <link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192" />
      <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" sizes="180x180" />
      {robots ? <meta name="robots" content={robots} /> : null}
      <title>{title}</title>
      <meta name="description" content="Together We Own: a close-knit adult gaming community, founded 1998." />
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
      <link rel="alternate" type="application/rss+xml" title={`${SITE_NAME} Events`} href="/events.rss" />
      <link rel="stylesheet" href="/styles.css" />
    </head>
    <body>{children}</body>
  </html>
);

// The site footer carries the static-leaf links on the funnel + leaf + error
// shells (home, join, recovery, about/faq/rules/privacy, branded errors —
// ports the legacy home footer: About, FAQ, House rules, Privacy). Admin,
// events and profile shells intentionally keep their own chrome. One
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

export type Notice = "joined" | "already_member" | "join_failed" | "signin_failed" | null;

const NOTICES: Record<Exclude<Notice, null>, string> = {
  joined: "You're in. Welcome to the TWO Discord.",
  already_member: "Signed in. You're already in the TWO Discord.",
  join_failed: "Signed in, but we couldn't add you to the Discord automatically. Use the invite link below.",
  signin_failed: "Discord sign-in didn't complete. Please try again.",
};

const JOIN_HREF = "/join";

// Join carries the same share tags as home (TOG-5624): the funnel lives on
// shared links. The intro doubles as the share description, same as legacy.
export const JOIN_INTRO = "Approve once with Discord and we will add you to the server.";

export const Join: FC<{ inviteUrl: string; widgetUrl: string | null; next?: string | null; appUrl: string }> = ({
  inviteUrl,
  widgetUrl,
  next,
  appUrl,
}) => (
  <Layout title="Join Together We Own" canonical={canonicalUrl(appUrl, "/join")} shareDescription={JOIN_INTRO}>
    <header class="bar">
      <a class="brand" href="/">TWO</a>
      <nav>
        <a class="btn" href="/auth/discord" data-testid="signin">Sign in with Discord</a>
      </nav>
    </header>
    <main>
      <section aria-labelledby="join-heading">
        <h1 id="join-heading">Join Together We Own</h1>
        <p class="lead">{JOIN_INTRO}</p>
        <p>One click with Discord and we&apos;ll add you to the server — no invite link, no waiting.</p>
        <p>
          <a
            class="btn"
            href={next ? `/join/discord?next=${encodeURIComponent(next)}` : "/join/discord"}
            data-testid="join-oneclick"
          >
            Join with Discord
          </a>{" "}
          <a href={inviteUrl} data-testid="join-invite">Join with an invite link instead</a>
        </p>
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
      </section>
    </main>
    <SiteFooter />
  </Layout>
);

export const Recovery: FC<{
  title: string;
  message: string;
  retryUrl: string;
  retryLabel: string;
  inviteUrl: string;
}> = ({ title, message, retryUrl, retryLabel, inviteUrl }) => (
  <Layout title={`${title} — Together We Own`}>
    <header class="bar">
      <a class="brand" href="/">TWO</a>
      <nav>
        <a class="btn" href="/join">Join with Discord</a>
      </nav>
    </header>
    <main>
      <section aria-labelledby="recovery-heading">
        <h1 id="recovery-heading">{title}</h1>
        <p class="lead">{message}</p>
        <p>
          <a class="btn" href={retryUrl} data-testid="recovery-retry">{retryLabel}</a>{" "}
          <a href={inviteUrl} data-testid="recovery-invite">Join with an invite link instead</a>
        </p>
      </section>
    </main>
    <SiteFooter />
  </Layout>
);

const FALLBACK_RANKS: Rank[] = ["Prospect", "Member", "Soldier", "Veteran", "Legend"].map((label) => ({
  key: label.toLowerCase(), label, memberCount: null,
}));

export const Home: FC<{
  session: Session | null;
  notice: Notice;
  inviteUrl: string;
  appUrl: string;
  counts: Counts;
}> = ({ session, notice, inviteUrl, appUrl, counts }) => (
  <Layout
    title="Together We Own — the lobby is open"
    canonical={canonicalUrl(appUrl, "/")}
    shareDescription="We spent most of our life private. Now you can just turn up."
  >
    <header class="bar">
      <a class="brand" href="/">TWO</a>
      <nav>
        {session ? (
          <form method="post" action="/logout">
            <span class="who">{session.username}</span>
            <button type="submit" class="link">Sign out</button>
          </form>
        ) : (
          <a class="btn" href="/auth/discord" data-testid="signin">Sign in with Discord</a>
        )}
      </nav>
    </header>
    <main>
      {notice && <p class="notice" role="status" data-testid="notice">{NOTICES[notice]}</p>}
      <section class="hero">
        <p class="strap">A close-knit gaming clan / mostly evenings / 18+</p>
        <h1>The lobby is open.</h1>
        <p class="lead">We spent most of our life private. Now you can just turn up.</p>
        <p>Small enough that people notice when you come back.</p>
        {session?.member ? (
          <a class="btn" href={inviteUrl}>Open Discord</a>
        ) : (
          <a class="btn" href="/auth/discord" data-testid="join">Join with Discord</a>
        )}
        {notice === "join_failed" && <p><a href={inviteUrl}>Join with an invite link instead</a></p>}
        {counts.memberCount != null && (
          <p class="counts" data-testid="member-count">
            <strong>{counts.memberCount}</strong> members
            {counts.onlineCount != null && counts.onlineCount > 0 && (
              <>
                {" · "}<strong>{counts.onlineCount}</strong> online
              </>
            )}
          </p>
        )}
      </section>
      <section>
        <h2>No application. No interview.</h2>
        <p>Show up a few times. Play. Become a Member. The ladder records trust and time, not grind.</p>
      </section>
      <section>
        <h2>Not a crowd. A place that knows your name.</h2>
        <p>The community is voice-first. Game nights get posted in the Discord first.</p>
      </section>
      <section aria-label="Community ladder">
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
    </main>
    <SiteFooter />
  </Layout>
);

const Leaf: FC<PropsWithChildren<{ title: string; headingId: string; heading: string }>> = ({
  title,
  headingId,
  heading,
  children,
}) => (
  <Layout title={title}>
    <header class="bar">
      <a class="brand" href="/">TWO</a>
      <nav>
        <a class="btn" href={JOIN_HREF}>Join with Discord</a>
      </nav>
    </header>
    <main>
      <section aria-labelledby={headingId}>
        <h1 id={headingId}>{heading}</h1>
        {children}
      </section>
    </main>
    <SiteFooter />
  </Layout>
);

export const About: FC = () => (
  <Leaf title="About — Together We Own" headingId="about-heading" heading="About Together We Own">
    <p class="strap">Est. 1998</p>
    <p class="lead">
      An adult gaming community that spent most of its life private. Now the doors are open: turn up, say hello,
      come back.
    </p>
    <dl data-testid="about-facts" class="facts">
      <div class="card">
        <dt>Voice-first</dt>
        <dd>The community lives in voice. Turn up, say hello, and come back — that is the whole membership path.</dd>
      </div>
      <div class="card">
        <dt>No application, no interview</dt>
        <dd>
          You start as a Prospect. Show up a few times, play, become a Member. The ladder records trust and time,
          not grind.
        </dd>
      </div>
      <div class="card">
        <dt>From forum threads to voice rooms</dt>
        <dd>Founded in 1998. Forum years, then voice years — duos, trios, quads, squads. Today: doors open.</dd>
      </div>
    </dl>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="about-join">Join with Discord</a>{" "}
      <a href="/">Back to the homepage</a>
    </p>
  </Leaf>
);

const RULES: Array<[string, string]> = [
  ["18+ only", "Together We Own is an adult gaming community. If you are under 18, this is not your lobby yet."],
  [
    "Respect the room",
    "No harassment, hate, or punching down. Argue about games all you like; never about people.",
  ],
  [
    "Voice-first",
    "The community lives in voice. Turn up, say hello, and come back — that is the whole membership path.",
  ],
  ["Play fair", "No cheating, exploits, or griefing. Do not spoil the game for the people you share it with."],
  [
    "Moderators have the last word",
    "If a moderator asks you to stop, stop. Appeals happen in private, not in the lobby.",
  ],
];

// The stamp carries both the machine date and the human label (ports the
// legacy "1 September 2026" render): crawlers read datetime, members read words.
export const Rules: FC<{ lastUpdated: { iso: string; label: string } | null }> = ({ lastUpdated }) => (
  <Leaf title="House rules — Together We Own" headingId="rules-heading" heading="House rules">
    <p class="lead">
      Five rules that keep the lobby a place people come back to. Short on purpose — if anything is unclear, ask in
      Discord before you assume.
    </p>
    {lastUpdated ? (
      <p data-testid="rules-last-updated" class="strap">
        Last updated <time datetime={lastUpdated.iso}>{lastUpdated.label}</time>
      </p>
    ) : null}
    <ol data-testid="rules-list" class="facts">
      {RULES.map(([name, body]) => (
        <li class="card" key={name}>
          <h2>{name}</h2>
          <p>{body}</p>
        </li>
      ))}
    </ol>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="rules-join">Join with Discord</a>{" "}
      <a href="/">Back to the homepage</a>
    </p>
  </Leaf>
);

const FAQS: Array<{ section: string; sectionId: string; items: Array<[string, string]> }> = [
  {
    section: "Getting in",
    sectionId: "faq-getting-in",
    items: [
      [
        "What is Together We Own?",
        "A close-knit gaming clan, running since 1998, mostly evenings, 18+. We spent most of our life private; now the lobby is open and you can just turn up. Small enough that people notice when you come back.",
      ],
      [
        "How do I join?",
        "Approve once with Discord on the join page and we'll add you to the server — or use the Discord invite link instead. Then accept the rules on Discord's membership screen: that's the gate, and it's how we know you're really in.",
      ],
      [
        "Do I need an invite, referral, or eligibility check?",
        "No. The doors are open — no invite code, no referral, no waitlist. If you can open the join page, you're eligible.",
      ],
      [
        "Is there an application, interview, or skill requirement?",
        "No application, no interview, no tryout. Everyone starts as a Prospect: show up a few times, play, become a Member. The ladder records trust and time, not grind.",
      ],
    ],
  },
  {
    section: "Your first week",
    sectionId: "faq-first-week",
    items: [
      [
        "I joined but I can't post — what now?",
        "You're at a locked door: Discord holds new members as pending until they accept the rules on the membership screen. Accept them and you're in.",
      ],
      [
        "What should I do first?",
        "Three things: pick your games, say hi in general, and come back once that week. Saying hi is genuinely contributing.",
      ],
    ],
  },
  {
    section: "Ranks and rewards",
    sectionId: "faq-ranks",
    items: [
      [
        "How do ranks, XP, and role rewards work?",
        "Hanging out earns XP: messages earn 15 XP (at most once a minute), voice time earns 5 XP per minute. At certain levels the bot grants you a role reward automatically — it never takes an earned reward away.",
      ],
      [
        "What are the rank rungs?",
        "Five, in order: Prospect → Member → Soldier → Veteran → Legend. Ranks stack — a Veteran still holds everything below. Legend is still unclaimed.",
      ],
    ],
  },
  {
    section: "Events",
    sectionId: "faq-events",
    items: [
      [
        "When do you actually play together?",
        "Sunday Squad, every Sunday at 8pm Eastern, about an hour in the Lobby voice room. It runs whether there's two of us or eight.",
      ],
      [
        "Where do I find events, and do I need an account to look?",
        "On the site's Events page: game nights, tournaments, whatever the community puts on. Anyone can read it — including signed-out visitors arriving from a Discord link.",
      ],
      [
        "How do I RSVP, and what do the answers mean?",
        "Log in with Discord first — signed-out visitors get a log-in prompt instead of a button. Then it's one tap: I'm in. One answer per member per event; changing your mind updates the same answer.",
      ],
    ],
  },
  {
    section: "Game picker",
    sectionId: "faq-onboarding",
    items: [
      [
        "How does the game picker work?",
        "After you accept the rules, the welcome post in the landing channel mentions you with a game picker attached. Pick your games and the bot grants the matching roles. It never DMs you. Changed your mind later? Pick again.",
      ],
    ],
  },
  {
    section: "Support tickets",
    sectionId: "faq-tickets",
    items: [
      [
        "How do I open a private support ticket?",
        "Use the ticket or support button in the server: a private channel opens for you and staff, and a staff member claims it. One active ticket at a time — finish or close the open one before starting another.",
      ],
    ],
  },
  {
    section: "Your site profile",
    sectionId: "faq-profile",
    items: [
      [
        "How do I fill in my profile?",
        "Sign in with Discord and open your profile. Three things are yours to write: a short bio, your games, and your timezone. We never ask for or store your email.",
      ],
    ],
  },
  {
    section: "Privacy and conduct",
    sectionId: "faq-privacy",
    items: [
      [
        "What do you store about me, and what are the rules?",
        "We store Discord user IDs, timestamps, and channel IDs — enough to count joins honestly. We never store message content, email, location, or voice audio. Ask anytime to be removed and we delete your rows.",
      ],
    ],
  },
];

export const Faq: FC = () => (
  <Leaf title="FAQ — Together We Own" headingId="faq-heading" heading="Frequently asked questions">
    <p class="strap">New here? Start here</p>
    <p class="lead">
      Short answers to what newcomers actually ask. If yours isn't here, ask in general or DM a moderator.
    </p>
    <div data-testid="faq-list">
      {FAQS.map((group) => (
        <section aria-labelledby={group.sectionId} key={group.sectionId}>
          <h2 id={group.sectionId}>{group.section}</h2>
          {group.items.map(([q, a]) => (
            <div class="card" key={q}>
              <h3>{q}</h3>
              <p>{a}</p>
            </div>
          ))}
        </section>
      ))}
    </div>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="faq-join">Join with Discord</a>{" "}
      <a href="/">Back to the homepage</a>
    </p>
  </Leaf>
);

// Versioned privacy policy (N1: TOG-9893). The body is pre-rendered markdown
// HTML (see src/privacy.ts); the component only stamps the version and wraps
// it in the funnel leaf chrome. No JavaScript ships on this page.
export const Privacy: FC<{ version: number; html: string }> = ({ version, html }) => (
  <Leaf title="Privacy policy — Together We Own" headingId="privacy-heading" heading="Privacy policy">
    <p class="strap" data-testid="privacy-version">Version {version}</p>
    <div data-testid="privacy-policy" dangerouslySetInnerHTML={{ __html: html }} />
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="privacy-join">Join with Discord</a>{" "}
      <a href="/">Back to the homepage</a>
    </p>
  </Leaf>
);
