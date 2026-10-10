import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { JOIN_HREF, Leaf } from "../page-shell";

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

export const Faq: FC<{ appUrl: string }> = ({ appUrl }) => (
  <Leaf
    title="FAQ — Together We Own"
    canonical={canonicalUrl(appUrl, "/faq")}
    headingId="faq-heading"
    heading="Frequently asked questions"
  >
    <p class="strap">New here? Start here</p>
    <p class="lead">
      Short answers to what newcomers actually ask. If yours isn't here, ask in general or DM a
      moderator.
    </p>
    <div data-testid="faq-list">
      {FAQS.map((group) => (
        <section aria-labelledby={group.sectionId} key={group.sectionId}>
          <h2 id={group.sectionId}>{group.section}</h2>
          <div>
            {group.items.map(([q, a]) => (
              <div class="card" key={q}>
                <h3>{q}</h3>
                <p>{a}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
    <p>
      <a class="btn" href={JOIN_HREF} data-testid="faq-join">
        Join with Discord
      </a>{" "}
      <a href="/">Back to the homepage</a>
    </p>
  </Leaf>
);
