// FAQ content source, shared by the Hono leaf (src/screens/faq.tsx),
// the Markdown alternate (src/ai-friendly/md.ts) and the Kit page
// (web/src/routes/faq/). Pure data: no session, no cookie, no
// database — importing this module must never connect to anything.

import { SUBSCRIPTION_GUIDANCE } from "./events/subscription-copy";
import { faqLastReviewed } from "./faq-last-reviewed";

export const FAQS: Array<{
  section: string;
  sectionId: string;
  items: Array<[string, string, { label: string; href: string }?]>;
}> = [
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
        { label: "Join page", href: "/join" },
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
        "Game nights are scheduled in Discord — see the Events page for what's on. Times are posted there, so you always see the current plan.",
        { label: "Events page", href: "/events" },
      ],
      [
        "Where do I find events, and do I need an account to look?",
        "On the site's Events page: game nights, tournaments, whatever the community puts on. Anyone can read it — including signed-out visitors arriving from a Discord link.",
        { label: "Events page", href: "/events" },
      ],
      [
        "How do I subscribe to events in my calendar?",
        "On Events or Past events, open “How to subscribe to the calendar”. " +
          SUBSCRIPTION_GUIDANCE.join(" ").replace("feed URL below", "feed URL shown there"),
        { label: "Events page", href: "/events" },
      ],
      [
        "How do I RSVP, and what do the answers mean?",
        "Log in with Discord first — signed-out visitors get a log-in prompt instead of a button. Use I'm in for an open seat, or Join the waitlist when full. Going (You're in) reserves a seat; it is not measured attendance. Waitlisted is a place in line, not a held seat. One answer per member per event: changing your mind updates the same answer. Use Can't make it to withdraw, or Leave the waitlist to leave the line, when those controls are available.",
      ],
      [
        "How do waitlist promotions work?",
        "While the event is published, taking RSVPs and not ended, a released seat promotes the earliest waiting member in first-in, first-out (FIFO) order. Reload the event to check your current answer and position. Do not rely on a notification: the site cannot guarantee Discord delivery. Leaving and rejoining is a new place in line, not your old priority.",
      ],
      [
        "What if my RSVP is syncing, or I couldn't confirm it?",
        "Saved. Syncing to Discord. means your answer is saved and the Discord mirror is pending, not that the reservation failed. Do not save again to force sync. An unknown result — We couldn't confirm your RSVP. Check the event before trying again. — is different: use Refresh the event and check your current answer before another write. For session expiry, throttling, closed events or a persistent mirror delay, follow the recovery guide.",
        {
          label: "RSVP recovery guide",
          href: "https://github.com/TogetherWeOwn/two-web-next/blob/main/docs/rsvp-recovery.md",
        },
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
        { label: "Your profile", href: "/profile" },
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
        { label: "Privacy policy", href: "/privacy" },
      ],
    ],
  },
];

// The Kit page renders this shape server-side: the questions, answer
// semantics and section anchors stay byte-identical across renderers because
// every renderer reads this module, never a pasted copy.
export type FaqPageData = {
  appUrl: string;
  faqs: typeof FAQS;
  lastReviewed: ReturnType<typeof faqLastReviewed>;
};

// The Kit load function only reorders the same reads as the Hono handler
// (src/static-leaves.tsx): APP_URL plus the config stamp, mapped through the
// shared validator so an empty or unparseable value hides the stamp. Kept here
// (not in the Kit route) so the root suite can pin it without importing
// SvelteKit or worker code.
export function faqPageData(appUrl: string, raw?: string | undefined): FaqPageData {
  return { appUrl, faqs: FAQS, lastReviewed: faqLastReviewed(raw) };
}
