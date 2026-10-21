// C1 acceptance: event-authored text stays inert in machine Markdown documents.
//
// Test Author-owned, failing-first handoff. Builder builds on this branch and
// never edits this file; follow-up test corrections return to the Test Author.
//
// Agent-runnable local check (pure builders: no DATABASE_URL, no network):
//   npx vitest run test/ai-friendly-md-inert-acceptance.test.ts
//
// Contract under test: event-authored title/game/location/description must not
// produce author-controlled HTML, link (including autolink) or image nodes
// when a CommonMark reader parses the generated list/detail/cancelled
// Markdown, while server-owned canonical/event/calendar/next-action links,
// headings, status lines and event-key identities survive. The escaping
// mechanism is the builder's choice (backslash, entity, or equivalent): these
// tests assert parsed nodes, never exact escape spellings — except the
// pre-existing bracket escapes, which are pinned as guards, not re-specified.
//
// Explicit non-claim: neutralizing markup says nothing about natural-language
// prompt injection. A hostile sentence that reads as an instruction stays a
// sentence; these tests only pin that it cannot become HTML, a link, or an
// image.
//
// Threat model (verified against src/ai-friendly/md.ts at handoff): mdText
// escapes backslashes, brackets and line-leading block openers only, so inline
// `<tag>` and `<https://...>` autolinks survive mid-line. The same helper
// feeds the list, detail and cancelled builders, so one leak reaches all three
// surfaces; each surface is pinned separately below.
import { describe, expect, it } from "vitest";
import { mdEvent, mdEventGone, mdEvents, mdText, type MdEvent } from "../src/ai-friendly/md";

const APP_URL = "https://togetherweown.com";
const EVIL_HOST = "evil.example.test";
const evilUrl = (path: string): string => `https://${EVIL_HOST}${path}`;

// Readable sentinel words: plain prose adjacent to (never inside) hostile
// constructs, so both escaping and stripping fixes keep them legible.
const TITLE_SENTINEL = "Titlekite";
const GAME_SENTINEL = "Gamekite";
const LOCATION_SENTINEL = "Lockite";
const DESCRIPTION_SENTINEL = "Desckite";

const TITLE_HOSTILE = `${TITLE_SENTINEL} <img src="${evilUrl("/title.png")}" onerror="alert(1)"> encore`;
const GAME_HOSTILE = `${GAME_SENTINEL} <${evilUrl("/game-autolink")}> night`;
const LOCATION_HOSTILE = `${LOCATION_SENTINEL} hall <b class="x">404</b> mezzanine`;
const DESCRIPTION_HOSTILE = [
  `${DESCRIPTION_SENTINEL} join us <script>alert("desc")</script> tonight`,
  `poster ![${DESCRIPTION_SENTINEL.toLowerCase()}](${evilUrl("/desc.png")}) here`,
  `rsvp <${evilUrl("/desc-autolink")}> or [${DESCRIPTION_SENTINEL.toLowerCase()}](${evilUrl("/desc-link")}) please`,
].join("\n");

// ---------------------------------------------------------------------------
// CommonMark-subset inline scanner (test-local; documents the assertions).
//
// Detects the node kinds the contract forbids from author input: raw HTML
// (html_inline), angle autolinks, inline links and inline images. Code spans
// are blanked first (nodes never form inside backticks); an opener counts
// only when not backslash-escaped. Deliberately narrow: fixtures use tight
// destinations without nested brackets/parens, and fence handling stays owned
// by the existing fence pins (an escaped fence cannot open a code block, so
// the scanner never needs to skip fenced regions on these fixtures).
// ---------------------------------------------------------------------------

type InertKind = "html" | "autolink" | "link" | "image";

interface InertNode {
  kind: InertKind;
  /** Raw source slice, for failure attribution. */
  text: string;
}

const isEscaped = (src: string, index: number): boolean => {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && src[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
};

/** Blank inline code spans: links and tags inside backticks never form nodes. */
const stripCodeSpans = (src: string): string =>
  src.replace(/(`+)[^`\n]*?\1/g, (m) => " ".repeat(m.length));

const AUTOLINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*$/;
const AUTOLINK_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;

function scanAngleNodes(src: string): InertNode[] {
  const out: InertNode[] = [];
  const re = /<(\/?[A-Za-z][^<>\n]*|\?[^<>\n]*|![^<>\n]*?)>/g;
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0;
    if (isEscaped(src, at)) continue;
    const inner = m[1] ?? "";
    const autolink = AUTOLINK_SCHEME.test(inner) || AUTOLINK_EMAIL.test(inner);
    out.push({ kind: autolink ? "autolink" : "html", text: m[0] });
  }
  return out;
}

function scanLinkNodes(src: string): InertNode[] {
  const out: InertNode[] = [];
  let i = 0;
  while (i < src.length) {
    const close = src.indexOf("](", i);
    if (close === -1) return out;
    if (isEscaped(src, close) || isEscaped(src, close + 1)) {
      i = close + 2;
      continue;
    }
    // Nearest unescaped "[" with no unescaped bracket between: the label open.
    let open = -1;
    for (let j = close - 1; j >= 0; j -= 1) {
      const c = src[j];
      if (c !== "[" && c !== "]") continue;
      if (isEscaped(src, j)) continue;
      if (c === "]") break;
      open = j;
      break;
    }
    if (open === -1) {
      i = close + 2;
      continue;
    }
    let end = -1;
    for (let j = close + 2; j < src.length; j += 1) {
      const c = src[j];
      if (c === "\n" || c === " " || c === "(") break;
      if (c !== ")") continue;
      if (isEscaped(src, j)) continue;
      end = j;
      break;
    }
    if (end === -1) {
      i = close + 2;
      continue;
    }
    const bang = open > 0 && src[open - 1] === "!" && !isEscaped(src, open - 1);
    out.push({
      kind: bang ? "image" : "link",
      text: src.slice(bang ? open - 1 : open, end + 1),
    });
    i = end + 1;
  }
  return out;
}

const destOf = (nodeText: string): string => {
  const at = nodeText.lastIndexOf("](");
  return at === -1 ? "" : nodeText.slice(at + 2, -1);
};

const isServerOwned = (dest: string): boolean => dest === APP_URL || dest.startsWith(`${APP_URL}/`);

/**
 * Nodes attributable to event-authored input. Server event templates emit no
 * raw tags, no autolinks and no images (pinned by the healthy-input premise
 * tests), and every server link destination starts with APP_URL — so any
 * angle node, any image node, and any link leaving APP_URL is author-made.
 */
function authorControlledNodes(doc: string): InertNode[] {
  const body = stripCodeSpans(doc);
  const bad: InertNode[] = [...scanAngleNodes(body)];
  for (const n of scanLinkNodes(body)) {
    if (n.kind === "image") {
      bad.push(n);
      continue;
    }
    if (!isServerOwned(destOf(n.text))) bad.push(n);
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Fixtures: one fully hostile event plus per-field variants over healthy rows.
// ---------------------------------------------------------------------------

const mdRow = (o: Partial<MdEvent> = {}): MdEvent => ({
  eventKey: "01J0000000000000000000ABCD",
  title: "Friday night Helldivers",
  game: "Helldivers",
  description: "Bring stims.",
  startsAt: new Date("2030-07-15T18:00:00Z"),
  endsAt: new Date("2030-07-15T20:00:00Z"),
  timezone: "Europe/London",
  location: "Voice: General",
  capacity: null,
  goingCount: 7,
  goingOccupancy: 7,
  status: "published",
  ...o,
});

const hostileRow = (): MdEvent =>
  mdRow({
    title: TITLE_HOSTILE,
    game: GAME_HOSTILE,
    location: LOCATION_HOSTILE,
    description: DESCRIPTION_HOSTILE,
  });

describe("mdText inline-node contract (failing-first unit pins)", () => {
  it("neutralizes inline raw HTML mid-line", () => {
    const out = mdText(`Hello <img src="${evilUrl("/u.png")}" onerror="alert(1)"> world`);
    expect(authorControlledNodes(out)).toEqual([]);
  });

  it("neutralizes angle-bracket autolinks", () => {
    const out = mdText(`see <${evilUrl("/a")}> ok`);
    expect(authorControlledNodes(out)).toEqual([]);
  });

  it("neutralizes email-shaped autolinks", () => {
    const out = mdText(`ping <rogue@${EVIL_HOST}> me`);
    expect(authorControlledNodes(out)).toEqual([]);
  });

  it("an author backslash cannot un-escape a tag", () => {
    // Input `\\<img>`: escaping only the backslash leaves a live tag.
    const out = mdText("a \\<img src=x> b");
    expect(authorControlledNodes(out)).toEqual([]);
  });

  it("keeps bracket links inert (existing escape, guard)", () => {
    const out = mdText(`[kite](${evilUrl("/l")})`);
    expect(authorControlledNodes(out)).toEqual([]);
  });

  it("keeps markdown images inert (existing escape, guard)", () => {
    const out = mdText(`![kite](${evilUrl("/i.png")})`);
    expect(authorControlledNodes(out)).toEqual([]);
  });

  it("neutralizes a line-leading tag pair including its closer", () => {
    // The current line-leading backslash escapes the opener only: the live
    // `</div>` closer survives as an html_inline node. A correct fix escapes
    // every author angle bracket, so this pin is spelling-agnostic on purpose.
    const out = mdText("first\n<div>block</div>");
    expect(authorControlledNodes(out)).toEqual([]);
  });

  it("neutralizes mid-line HTML comments", () => {
    const out = mdText("a <!-- hi --> b");
    expect(authorControlledNodes(out)).toEqual([]);
  });

  it("keeps line-leading comments inert (guard)", () => {
    const out = mdText("<!-- hi -->");
    expect(authorControlledNodes(out)).toEqual([]);
  });

  it("delimiter combinations cannot form author links (guard)", () => {
    expect(authorControlledNodes(mdText(`**[kite](${evilUrl("/n")})**`))).toEqual([]);
    expect(authorControlledNodes(mdText(`\`[kite](${evilUrl("/c")})\``))).toEqual([]);
    expect(mdText(`**[kite](${evilUrl("/n")})**`)).toContain("kite");
  });

  it("entity-like text cannot smuggle tags (guard)", () => {
    const out = mdText("Fish &lt;img src=x&gt; and AT&T");
    expect(authorControlledNodes(out)).toEqual([]);
    expect(out).toContain("Fish");
    expect(out).toContain("AT&T");
  });

  it("leaves plain and Unicode prose byte-identical (guard)", () => {
    expect(mdText("Bring stims. Voice: General 123")).toBe("Bring stims. Voice: General 123");
    expect(mdText("Café 🎲 naïve — 日本語")).toBe("Café 🎲 naïve — 日本語");
  });

  it("keeps multiline prose line breaks (guard)", () => {
    expect(mdText("one\ntwo\n\nthree")).toBe("one\ntwo\n\nthree");
  });

  it("bare author URLs stay plain text, never link nodes (guard)", () => {
    const out = mdText(`see ${evilUrl("/bare")} ok`);
    expect(authorControlledNodes(out)).toEqual([]);
    expect(out).toContain(evilUrl("/bare"));
  });
});

describe("list document with hostile event fields", () => {
  it("carries no author-controlled HTML or autolink nodes", () => {
    const body = mdEvents(APP_URL, [hostileRow()]);
    expect(authorControlledNodes(body)).toEqual([]);
  });

  it("carries no author-controlled link or image nodes", () => {
    const body = mdEvents(APP_URL, [hostileRow()]);
    const links = authorControlledNodes(body).filter(
      (n) => n.kind === "link" || n.kind === "image",
    );
    expect(links).toEqual([]);
  });

  it("keeps server canonical, event and markdown links (guard)", () => {
    const body = mdEvents(APP_URL, [hostileRow()]);
    const key = "01J0000000000000000000ABCD";
    expect(body).toContain(`](${APP_URL}/e/${key})`);
    expect(body).toContain(`- Markdown: ${APP_URL}/e/${key}.md`);
    expect(body).toContain(`> Canonical page: ${APP_URL}/events`);
    expect(body).toContain(`${APP_URL}/events.md`);
  });

  it("keeps headings, event keys and row structure stable (guard)", () => {
    const body = mdEvents(APP_URL, [hostileRow()]);
    expect(body).toContain("# Upcoming events at Together We Own");
    expect(body.match(/^## \[/gm)).toHaveLength(1);
    expect(body).toContain("- When:");
    expect(body).toContain("- Game:");
    expect(body).toContain("- Where:");
    expect(body).toContain("- Markdown:");
    expect(body).toContain(TITLE_SENTINEL);
    expect(body).toContain(GAME_SENTINEL);
    expect(body).toContain(LOCATION_SENTINEL);
    expect(body).toContain(DESCRIPTION_SENTINEL);
  });

  it("one hostile row cannot swallow the next event (guard)", () => {
    const body = mdEvents(APP_URL, [
      hostileRow(),
      mdRow({ eventKey: "01J0000000000000000000WXYZ", title: "Second night" }),
    ]);
    expect(body.match(/^## \[/gm)).toHaveLength(2);
    expect(body).toContain("Second night");
    expect(body).toContain(`${APP_URL}/e/01J0000000000000000000WXYZ.md`);
  });
});

describe("detail document: each hostile field alone stays inert", () => {
  it("hostile title alone yields no author nodes", () => {
    const body = mdEvent(APP_URL, mdRow({ title: TITLE_HOSTILE }));
    expect(authorControlledNodes(body)).toEqual([]);
  });

  it("hostile game alone yields no author nodes", () => {
    const body = mdEvent(APP_URL, mdRow({ game: GAME_HOSTILE }));
    expect(authorControlledNodes(body)).toEqual([]);
  });

  it("hostile location alone yields no author nodes", () => {
    const body = mdEvent(APP_URL, mdRow({ location: LOCATION_HOSTILE }));
    expect(authorControlledNodes(body)).toEqual([]);
  });

  it("hostile description alone yields no author nodes", () => {
    const body = mdEvent(APP_URL, mdRow({ description: DESCRIPTION_HOSTILE }));
    expect(authorControlledNodes(body)).toEqual([]);
  });

  it("hostile Unicode title stays readable and node-free", () => {
    const body = mdEvent(APP_URL, mdRow({ title: "Café 🎲 naïve 日本語 <img src=x alt=uni>" }));
    expect(authorControlledNodes(body)).toEqual([]);
    expect(body).toContain("Café 🎲 naïve 日本語");
  });

  it("hostile multiline title collapses to one inert heading line", () => {
    const body = mdEvent(
      APP_URL,
      mdRow({ title: `First line\nSecond <img src="${evilUrl("/t.png")}"> line` }),
    );
    expect(authorControlledNodes(body)).toEqual([]);
    expect(body.match(/^# /gm)).toHaveLength(1);
  });
});

describe("detail document with fully hostile fields", () => {
  it("carries no author-controlled nodes", () => {
    const body = mdEvent(APP_URL, hostileRow());
    expect(authorControlledNodes(body)).toEqual([]);
  });

  it("keeps status, range, calendar and next-action links (guard)", () => {
    const body = mdEvent(APP_URL, hostileRow());
    const key = "01J0000000000000000000ABCD";
    expect(body).toContain("- Status: scheduled");
    expect(body).toContain("- Starts:");
    expect(body).toContain("- Ends:");
    expect(body).toContain("## About this event");
    expect(body).toContain(`[Add to calendar (.ics)](${APP_URL}/events/${key}.ics)`);
    expect(body).toContain(`[See upcoming events](${APP_URL}/events)`);
    expect(body).toContain(`${APP_URL}/e/${key}`);
  });

  it("ordinary multiline description keeps its paragraphs (guard)", () => {
    const body = mdEvent(APP_URL, mdRow({ description: "First paragraph.\n\nSecond paragraph." }));
    expect(body).toContain("First paragraph.\n\nSecond paragraph.");
    expect(authorControlledNodes(body)).toEqual([]);
  });

  it("privacy boundary holds under hostile input (guard)", () => {
    const body = mdEvent(APP_URL, hostileRow());
    for (const leak of ["attendee", "rsvp_user", "waitlist_position", "discord_event_id"])
      expect(body.toLowerCase()).not.toContain(leak);
  });
});

describe("cancelled document with hostile title", () => {
  it("carries no author-controlled nodes from the title", () => {
    const body = mdEventGone(APP_URL, hostileRow());
    expect(authorControlledNodes(body)).toEqual([]);
  });

  it("keeps the cancellation notice and the way back (guard)", () => {
    const body = mdEventGone(APP_URL, hostileRow());
    expect(body).toContain("Cancelled");
    expect(body).toContain(TITLE_SENTINEL);
    expect(body).toContain(`[See upcoming events](${APP_URL}/events)`);
    expect(body).toContain(`${APP_URL}/e/01J0000000000000000000ABCD`);
  });
});

describe("server template premise on healthy input (guards)", () => {
  const healthyList = (): string => mdEvents(APP_URL, [mdRow()]);
  const healthyDetail = (): string => mdEvent(APP_URL, mdRow());
  const healthyGone = (): string => mdEventGone(APP_URL, mdRow());

  it("healthy event docs contain no angle-bracket or image syntax", () => {
    for (const body of [healthyList(), healthyDetail(), healthyGone()]) {
      expect(body).not.toContain("<");
      expect(body).not.toContain("![");
    }
  });

  it("every link destination in healthy docs is server-owned", () => {
    for (const body of [healthyList(), healthyDetail(), healthyGone()]) {
      for (const n of scanLinkNodes(stripCodeSpans(body))) {
        expect(n.kind).toBe("link");
        expect(isServerOwned(destOf(n.text))).toBe(true);
      }
    }
  });

  it("healthy docs carry no author-attributable nodes", () => {
    expect(authorControlledNodes(healthyList())).toEqual([]);
    expect(authorControlledNodes(healthyDetail())).toEqual([]);
    expect(authorControlledNodes(healthyGone())).toEqual([]);
  });

  it("no reference-style link definitions can form from author text", () => {
    for (const body of [
      mdEvents(APP_URL, [hostileRow()]),
      mdEvent(APP_URL, hostileRow()),
      mdEventGone(APP_URL, hostileRow()),
    ])
      expect(body).not.toMatch(/^\s{0,3}\[[^\]\n]+\]:/m);
  });

  it("escaping does not duplicate author prose", () => {
    const body = mdEvent(APP_URL, hostileRow());
    for (const sentinel of [TITLE_SENTINEL, GAME_SENTINEL, LOCATION_SENTINEL, DESCRIPTION_SENTINEL])
      expect(body.split(sentinel)).toHaveLength(2);
  });
});
