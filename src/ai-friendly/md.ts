// AI-friendly machine formats (A2): curated Markdown alternates + /llms.txt.
//
// Pure builders: no I/O, no session, no database. FAQ/rules bodies share the
// exact source arrays the HTML screens render, so copy cannot drift; the
// routes in ./routes.ts only add headers and reads. Public fields only —
// never attendee identities, RSVP records, waitlist state, or raw Discord ids.
import { canonicalUrl } from "../seo";
import { formatEventWhen as mdDetailInstant, isValidZone } from "../events/date-format";
import { fmt } from "../events/pages-shared";
import { POLICY_VERSION } from "../privacy";
import { POLICY_MARKDOWN } from "../privacy-content";
import { FAQS } from "../faq-content";
import { JOIN_INTRO } from "../screens/join";
import { RULES } from "../rules-content";

export const MARKDOWN_MIME = "text/markdown; charset=utf-8";

/** Static leaves mirror the HTML leaf TTL. */
export const STATIC_MD_CACHE = "public, max-age=3600";

/** Event machine formats mirror the feed TTL. */
export const FEED_MD_CACHE = "public, max-age=300";

export interface MdEvent {
  eventKey: string;
  title: string;
  game: string | null;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  location: string | null;
  capacity: number | null;
  /** Null on collection rows (feed scope carries no counts — same as RSS). */
  goingCount: number | null;
  /** Seat occupancy for the full signal; null where the count is unknown
   * (collection rows) or the rollup is unavailable. */
  goingOccupancy: number | null;
  /** Published or past: drafts/cancelled never reach the detail builder. */
  status: "published" | "past";
}

/** Lineup line with an occupancy-based full signal. The attributable count
 * can read a free seat a nameless row already holds, so `full` comes from
 * occupancy — the same aggregate the write path enforces. */
function lineupLine(e: Pick<MdEvent, "goingCount" | "goingOccupancy" | "capacity">): string | null {
  if (e.goingCount === null) return null;
  const seats = e.capacity !== null ? ` of ${e.capacity}` : "";
  const full = e.goingOccupancy !== null && e.capacity !== null && e.goingOccupancy >= e.capacity;
  return `- Lineup: ${e.goingCount} going${seats}${full ? " (full)" : ""}`;
}

/**
 * Keep event-authored text inert in machine Markdown: no author-controlled
 * HTML, link (including autolink) or image nodes can form when a CommonMark
 * reader parses the output. Backslashes first (so later escapes stay literal),
 * then brackets (link/image labels), then `<` (tags, comments, autolinks —
 * every inline HTML/autolink node opens with `<`). Line-leading block openers
 * still take a `\` prefix so blocks can never start. `&` is deliberately left
 * alone: entities expand after tag parsing, so `&lt;` stays text while prose
 * like `AT&T` stays byte-identical. Emphasis, code spans and Unicode pass
 * through — they form no HTML/link/image nodes.
 *
 * Markup only: a hostile sentence that reads as an instruction stays a
 * sentence. Escaping says nothing about natural-language prompt injection.
 */
const MD_BLOCK_START =
  /^\s{0,3}(#{1,6}\s|>\s?|\d+[.)]\s|[-*+]\s|```|~~~|={1,}\s*$|-{1,}\s*$|\*{3,}\s*$|_{3,}\s*$|<)/;
const MD_INDENTED_CODE = /^( {4}|\t)/;

export function mdText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/</g, "\\<")
    .replace(/\r\n|\r/g, "\n")
    .split("\n")
    .map((line) => (MD_BLOCK_START.test(line) || MD_INDENTED_CODE.test(line) ? `\\${line}` : line))
    .join("\n");
}

const mdInlineText = (value: string): string => mdText(value.replace(/\r\n|\r|\n/g, " "));

const sourceLine = (appUrl: string, path: string): string =>
  `> Canonical page: ${canonicalUrl(appUrl, path)} · Markdown alternate: ${canonicalUrl(appUrl, `${path}.md`)}`;

const leafFooter = (appUrl: string): string =>
  `[Join with Discord](${canonicalUrl(appUrl, "/join")}) · [Back to the homepage](${canonicalUrl(appUrl, "/")})`;

export function mdAbout(appUrl: string): string {
  return [
    "# About Together We Own",
    "",
    sourceLine(appUrl, "/about"),
    "",
    "Est. 1998",
    "",
    "An adult gaming community that spent most of its life private. Now the doors are open: turn up, say hello, come back.",
    "",
    "## Voice-first",
    "",
    "The community lives in voice. Turn up, say hello, and come back — that is the whole membership path.",
    "",
    "## No application, no interview",
    "",
    "You start as a Prospect. Show up a few times, play, become a Member. The ladder records trust and time, not grind.",
    "",
    "## From forum threads to voice rooms",
    "",
    "Founded in 1998. Forum years, then voice years — duos, trios, quads, squads. Today: doors open.",
    "",
    leafFooter(appUrl),
    "",
  ].join("\n");
}

export function mdFaq(appUrl: string): string {
  const out = [
    "# Frequently asked questions",
    "",
    sourceLine(appUrl, "/faq"),
    "",
    "New here? Start here.",
    "",
    "Short answers to what newcomers actually ask. If yours isn't here, ask in general or DM a moderator.",
    "",
  ];
  for (const group of FAQS) {
    out.push(`## ${mdText(group.section)}`, "");
    for (const [q, a, link] of group.items) {
      const answer = mdText(a) + (link ? ` [${mdInlineText(link.label)}](${link.href})` : "");
      out.push(`### ${mdText(q)}`, "", answer, "");
    }
  }
  out.push(leafFooter(appUrl), "");
  return out.join("\n");
}

export function mdRules(appUrl: string, stamp: { iso: string; label: string } | null): string {
  const out = [
    "# House rules",
    "",
    sourceLine(appUrl, "/rules"),
    "",
    "Five rules that keep the lobby a place people come back to. Short on purpose — if anything is unclear, ask in Discord before you assume.",
    "",
  ];
  if (stamp) out.push(`Last updated ${stamp.label} (${stamp.iso}).`, "");
  RULES.forEach(([name, body], i) => {
    out.push(`## ${i + 1}. ${mdText(name)}`, "", mdText(body), "");
  });
  out.push(leafFooter(appUrl), "");
  return out.join("\n");
}

export function mdPrivacy(appUrl: string): string {
  return [
    "# Privacy policy",
    "",
    sourceLine(appUrl, "/privacy"),
    "",
    `Version ${POLICY_VERSION}`,
    "",
    POLICY_MARKDOWN.trimEnd(),
    "",
    leafFooter(appUrl),
    "",
  ].join("\n");
}

export function mdJoin(appUrl: string, inviteUrl: string): string {
  return [
    "# Join Together We Own",
    "",
    sourceLine(appUrl, "/join"),
    "",
    JOIN_INTRO,
    "",
    "One click with Discord and we'll add you to the server — no invite link, no waiting.",
    "",
    "## How it works",
    "",
    `1. Open [the one-click join](${canonicalUrl(appUrl, "/join/discord")}) and approve with Discord.`,
    "2. The bot adds you to the server; accept the rules on Discord's membership screen and you're in.",
    `3. Prefer an invite link? Use ${inviteUrl} instead, then accept the rules the same way.`,
    "",
    "Signing in asks Discord for two scopes — `identify`, so the site knows who you are, and `guilds.join`, so the bot can add you in one click. It never asks for your email address or your list of servers.",
    "",
    `No account is needed to look around: [upcoming events](${canonicalUrl(appUrl, "/events")}) are public.`,
    "",
  ].join("\n");
}

function mdEventWhen(e: MdEvent): string {
  return `${fmt(e.startsAt, e.timezone)} (${e.timezone})`;
}

const mdZoneLabel = (tz: string): string => (isValidZone(tz) ? tz : "UTC");

function mdEventBlock(appUrl: string, e: MdEvent): string[] {
  const out = [
    `## [${mdInlineText(e.title)}](${canonicalUrl(appUrl, `/e/${e.eventKey}`)})`,
    "",
    `- When: ${mdEventWhen(e)}`,
  ];
  if (e.game) out.push(`- Game: ${mdInlineText(e.game)}`);
  if (e.location) out.push(`- Where: ${mdInlineText(e.location)}`);
  const lineup = lineupLine(e);
  if (lineup) out.push(lineup);
  out.push(`- Markdown: ${canonicalUrl(appUrl, `/e/${e.eventKey}.md`)}`);
  if (e.description) out.push("", mdText(e.description));
  out.push("");
  return out;
}

export function mdEvents(appUrl: string, rows: MdEvent[]): string {
  const out = [
    "# Upcoming events at Together We Own",
    "",
    sourceLine(appUrl, "/events"),
    "",
    "Game nights, tournaments, whatever the community puts on. Anyone can read this list — including signed-out visitors arriving from a Discord link.",
    "",
  ];
  if (rows.length === 0) {
    out.push("No upcoming events are scheduled right now. Check back soon.", "");
  } else {
    for (const e of rows) out.push(...mdEventBlock(appUrl, e));
  }
  out.push(
    `Per-event Markdown template: ${canonicalUrl(appUrl, "/e/:key")}.md next to each event page (replace :key with the event key).`,
    "",
  );
  return out.join("\n");
}

export function mdEvent(appUrl: string, e: MdEvent): string {
  const lineup = lineupLine(e);
  return [
    `# ${mdInlineText(e.title)}`,
    "",
    sourceLine(appUrl, `/e/${e.eventKey}`),
    "",
    `- Status: ${e.status === "past" ? "past" : "scheduled"}`,
    `- Starts: ${mdDetailInstant(e.startsAt, e.timezone)} (${mdZoneLabel(e.timezone)})`,
    `- Ends: ${mdDetailInstant(e.endsAt, e.timezone)} (${mdZoneLabel(e.timezone)})`,
    ...(e.game ? [`- Game: ${mdInlineText(e.game)}`] : []),
    ...(e.location ? [`- Where: ${mdInlineText(e.location)}`] : []),
    ...(lineup ? [lineup] : []),
    ...(e.description ? ["", `## About this event`, "", mdText(e.description)] : []),
    "",
    `[Add to calendar (.ics)](${canonicalUrl(appUrl, `/events/${e.eventKey}.ics`)}) · [See upcoming events](${canonicalUrl(appUrl, "/events")})`,
    "",
  ].join("\n");
}

export function mdEventGone(appUrl: string, e: Pick<MdEvent, "title" | "eventKey">): string {
  return [
    `# ${mdInlineText(e.title)}`,
    "",
    sourceLine(appUrl, `/e/${e.eventKey}`),
    "",
    "Cancelled — this event was cancelled.",
    "",
    `[See upcoming events](${canonicalUrl(appUrl, "/events")})`,
    "",
  ].join("\n");
}

const MD_PAGES: Array<{ path: string; md: string; label: string; blurb: string }> = [
  {
    path: "/about",
    md: "/about.md",
    label: "About",
    blurb: "What the community is: voice-first, no application, open doors.",
  },
  {
    path: "/faq",
    md: "/faq.md",
    label: "FAQ",
    blurb:
      "Short answers newcomers actually ask: joining, first week, ranks, events, tickets, profiles.",
  },
  {
    path: "/rules",
    md: "/rules.md",
    label: "House rules",
    blurb: "The five house rules plus their last-updated stamp.",
  },
  {
    path: "/privacy",
    md: "/privacy.md",
    label: "Privacy policy",
    blurb: "Versioned privacy policy: what the site stores, who can see it, how to be removed.",
  },
  {
    path: "/join",
    md: "/join.md",
    label: "Join",
    blurb: "Join via the Discord handoff: one-click approve or an invite link.",
  },
];

export function llmsTxt(appUrl: string): string {
  const out = [
    "# Together We Own",
    "",
    "> An adult gaming community, founded 1998. Public pages below are open to search engines and AI assistants answering from public content; link back to the canonical page.",
    "",
    "## Pages",
    "",
  ];
  for (const p of MD_PAGES)
    out.push(
      `- [${p.label}](${canonicalUrl(appUrl, p.path)}): ${p.blurb} Markdown: ${canonicalUrl(appUrl, p.md)}`,
    );
  out.push(
    "",
    "## Events",
    "",
    `- [Upcoming events](${canonicalUrl(appUrl, "/events")}): published events only. Machine list: ${canonicalUrl(appUrl, "/events.md")}`,
    `- Event pages live at ${canonicalUrl(appUrl, "/e/:key")} (template: replace :key with an event key) with a Markdown alternate at ${canonicalUrl(appUrl, "/e/:key")}.md next to each page. Cancelled events answer 410; drafts are never listed.`,
    "",
    "## Machine access",
    "",
    `- Read-only remote tools over MCP at ${canonicalUrl(appUrl, "/mcp")}: \`list_events\`, \`get_event\`, \`get_community\`, \`get_join\`. Typed results, published content only, at most 20 rows and 32 KiB per response.`,
    `- REST discovery: ${canonicalUrl(appUrl, "/openapi.json")} (OpenAPI 3.1 for the same four reads).`,
    "- Agent guide: [docs/machine-interface.md](https://github.com/TogetherWeOwn/two-web-next/blob/main/docs/machine-interface.md) — error codes, limits, next actions and the offline contract check.",
    "",
    "## Notes",
    "",
    "- There is no public listing of members: profiles are members-only and never appear here.",
    "- Joining happens only through the Discord handoff on the join page; sign-in stays in the browser.",
    "- Poll these documents cheaply: send If-None-Match with the ETag you last saw and an unchanged document answers 304 with no body.",
    "- Event pages show Starts and Ends in the event timezone with the UTC offset; invalid stored timezones fall back to ISO UTC.",
    "",
  );
  return out.join("\n");
}
