// route-inventory: GET /llms.txt
// route-inventory: GET /about.md
// route-inventory: GET /faq.md
// route-inventory: GET /rules.md
// route-inventory: GET /privacy.md
// route-inventory: GET /join.md
// route-inventory: GET /events.md
// route-inventory: GET /e/:file{.+\.md}
// A2 AI-friendly machine formats: /llms.txt + curated .md alternates.
// Static suites are DB-free; collection/detail suites need agent-testdb.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { events, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import { FALLBACK_INVITE } from "../src/invite";
import { createMemorySessionStore } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { cookieFor, MODERATOR } from "./helpers/member-data";
import {
  MARKDOWN_MIME,
  llmsTxt,
  mdAbout,
  mdEvent,
  mdEventGone,
  mdEvents,
  mdFaq,
  mdJoin,
  mdPrivacy,
  mdRules,
  mdText,
  type MdEvent,
} from "../src/ai-friendly/md";

// Production apex (the only host that indexes): plain responses carry no
// X-Robots-Tag here, while STAGING_URL proves the staging noindex posture.
const APP_URL = "https://togetherweown.com";
const STAGING_URL = "https://staging.example.test";

const baseEnv = (appUrl: string) =>
  ({
    APP_URL: appUrl,
    DISCORD_INVITE_URL: "https://discord.gg/test-invite",
    DISCORD_GUILD_ID: "123",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    RULES_LAST_UPDATED: "2026-09-01",
  }) as unknown as Env;

const req = (path: string, appUrl = APP_URL, init: RequestInit = {}) =>
  app.request(path, init, baseEnv(appUrl));

const past = {
  game: "Helldivers",
  description: "Bring stims.",
  location: "Voice: General",
  capacity: null as number | null,
};

const mdRow = (o: Partial<MdEvent> = {}): MdEvent => ({
  eventKey: "01J0000000000000000000ABCD",
  title: "Friday night Helldivers",
  game: past.game,
  description: past.description,
  startsAt: new Date("2030-07-15T18:00:00Z"),
  endsAt: new Date("2030-07-15T20:00:00Z"),
  timezone: "Europe/London",
  location: past.location,
  capacity: null,
  goingCount: 7,
  goingOccupancy: 7,
  status: "published",
  ...o,
});

describe("md builders (pure, DB-free)", () => {
  it("about carries the same facts as the HTML leaf", () => {
    const body = mdAbout(APP_URL);
    for (const phrase of [
      "About Together We Own",
      "Est. 1998",
      "Voice-first",
      "No application, no interview",
      "From forum threads to voice rooms",
      `${APP_URL}/about`,
      `${APP_URL}/about.md`,
      `${APP_URL}/join`,
    ])
      expect(body).toContain(phrase);
  });

  it("faq carries every section and answer", () => {
    const body = mdFaq(APP_URL);
    for (const phrase of [
      "Getting in",
      "What is Together We Own?",
      "How do I join?",
      "Your first week",
      "Ranks and rewards",
      "Prospect → Member → Soldier → Veteran → Legend",
      "Events",
      "Game picker",
      "Support tickets",
      "Your site profile",
      "Privacy and conduct",
      "We never ask for or store your email",
      `${APP_URL}/faq`,
    ])
      expect(body).toContain(phrase);
  });

  it("rules carry all five rules plus the stamp", () => {
    const body = mdRules(APP_URL, { iso: "2026-09-01", label: "1 September 2026" });
    for (const phrase of [
      "18+ only",
      "Respect the room",
      "Voice-first",
      "Play fair",
      "Moderators have the last word",
      "1 September 2026",
      `${APP_URL}/rules`,
    ])
      expect(body).toContain(phrase);
    expect(mdRules(APP_URL, null)).not.toContain("Last updated");
  });

  it("privacy serves the policy source with its version, never member data", () => {
    const body = mdPrivacy(APP_URL);
    expect(body).toContain("Version 5");
    expect(body).toContain("We never ask Discord for your email address");
    expect(body).toContain(`${APP_URL}/privacy`);
    for (const leak of ["@example.com", "user_id", "discord_event_id", "web_session"])
      expect(body).not.toContain(leak);
  });

  it("join is a Discord handoff: one-click URL, invite fallback, no OAuth tools", () => {
    const body = mdJoin(APP_URL, "https://discord.gg/test-invite");
    for (const phrase of [
      "Approve once with Discord and we will add you to the server.",
      `${APP_URL}/join/discord`,
      "https://discord.gg/test-invite",
      `${APP_URL}/events`,
    ])
      expect(body).toContain(phrase);
    expect(body).not.toMatch(/client_id|client-secret|token endpoint/i);
  });

  it("states the true status: scheduled for published, past for archived", () => {
    expect(mdEvent(APP_URL, mdRow())).toContain("- Status: scheduled");
    const past = mdEvent(APP_URL, mdRow({ status: "past" }));
    expect(past).toContain("- Status: past");
    expect(past).not.toContain("scheduled");
  });

  it("past detail swaps the calendar footer for the past archive", () => {
    const live = mdEvent(APP_URL, mdRow());
    expect(live).toContain("[Add to calendar (.ics)]");
    expect(live).toContain("[See upcoming events]");
    const past = mdEvent(APP_URL, mdRow({ status: "past" }));
    expect(past).not.toContain("Add to calendar");
    expect(past).not.toContain("See upcoming events");
    expect(past).toContain(`[Browse past events](${APP_URL}/events/past)`);
  });

  it("elapsed published detail reads past, like the HTML share twins", () => {
    // The */10 reconcile hasn't flipped this row yet, but both HTML twins
    // already render the honest past share box for it; the .md alternate
    // must agree instead of offering calendar links for an ended event.
    const now = new Date("2026-10-21T12:00:00Z");
    const elapsed = mdEvent(
      APP_URL,
      mdRow({
        startsAt: new Date("2026-07-15T18:00:00Z"),
        endsAt: new Date("2026-07-15T20:00:00Z"),
      }),
      now,
    );
    expect(elapsed).toContain("- Status: past");
    expect(elapsed).not.toContain("scheduled");
    expect(elapsed).not.toContain("Add to calendar");
    expect(elapsed).not.toContain("See upcoming events");
    expect(elapsed).toContain(`[View this event](${APP_URL}/e/01J0000000000000000000ABCD)`);
    expect(elapsed).toContain(`[Browse past events](${APP_URL}/events/past)`);
    // Boundary matches the HTML verdict: endsAt == now already reads past.
    const boundary = mdEvent(APP_URL, mdRow({ startsAt: now, endsAt: now }), now);
    expect(boundary).toContain("- Status: past");
    expect(boundary).not.toContain("Add to calendar");
  });

  it("event detail carries public fields only", () => {
    const body = mdEvent(APP_URL, mdRow());
    for (const phrase of [
      "Friday night Helldivers",
      "Helldivers",
      "Bring stims.",
      "Voice: General",
      "Europe/London",
      `${APP_URL}/e/01J0000000000000000000ABCD`,
    ])
      expect(body).toContain(phrase);
    for (const leak of ["attendee", "rsvp_user", "waitlist_position", "discord_event_id"])
      expect(body.toLowerCase()).not.toContain(leak);
  });

  it("event detail exposes the complete scheduled range with endpoint offsets", () => {
    // Overnight: the end date differs from the start; both carry their own offset.
    const body = mdEvent(
      APP_URL,
      mdRow({
        startsAt: new Date("2026-06-21T03:30:00.000Z"),
        endsAt: new Date("2026-06-21T05:15:00.000Z"),
        timezone: "America/New_York",
      }),
    );
    expect(body).toContain(
      "- Starts: Saturday, 20 June 2026 at 23:30 GMT-04:00 (America/New_York)",
    );
    expect(body).toContain("- Ends: Sunday, 21 June 2026 at 01:15 GMT-04:00 (America/New_York)");
    expect(body).not.toContain("- When:");
  });

  it("event detail distinguishes the repeated DST hour by offset", () => {
    const body = mdEvent(
      APP_URL,
      mdRow({
        startsAt: new Date("2026-11-01T05:30:00.000Z"),
        endsAt: new Date("2026-11-01T06:30:00.000Z"),
        timezone: "America/New_York",
      }),
    );
    // Same wall clock, different offsets: the range is unambiguous only with both.
    expect(body).toContain("- Starts:");
    expect(body).toContain("- Ends:");
    expect(body).toContain("01:30 GMT-04:00");
    expect(body).toContain("01:30 GMT-05:00");
  });

  it("event detail falls back to UTC for an invalid stored timezone", () => {
    const body = mdEvent(
      APP_URL,
      mdRow({
        startsAt: new Date("2026-06-21T03:30:00.000Z"),
        endsAt: new Date("2026-06-21T05:15:00.000Z"),
        timezone: "Invalid/Timezone",
      }),
    );
    expect(body).toContain("- Starts: 2026-06-21T03:30:00.000Z (UTC)");
    expect(body).toContain("- Ends: 2026-06-21T05:15:00.000Z (UTC)");
    expect(body).not.toContain("Invalid/Timezone");
  });

  it("signals full from seat occupancy, not the attributable count", () => {
    // A nameless seat fills the event while the roster reads one of two:
    // the full signal must follow occupancy, like the write path does.
    const full = mdEvent(APP_URL, mdRow({ goingCount: 1, goingOccupancy: 2, capacity: 2 }));
    expect(full).toContain("- Lineup: 1 going of 2 (full)");
    const room = mdEvent(APP_URL, mdRow({ goingCount: 1, goingOccupancy: 1, capacity: 2 }));
    expect(room).toContain("- Lineup: 1 going of 2");
    expect(room).not.toContain("(full)");
    // Unknown occupancy (feed rows carry no counts) never claims full.
    const unknown = mdEvent(APP_URL, mdRow({ goingCount: 1, goingOccupancy: null, capacity: 1 }));
    expect(unknown).toContain("- Lineup: 1 going of 1");
    expect(unknown).not.toContain("(full)");
  });

  it("event collection lists published rows with canonical links", () => {
    const body = mdEvents(APP_URL, [
      mdRow(),
      mdRow({ eventKey: "01J0000000000000000000WXYZ", title: "Renamed raid" }),
    ]);
    expect(body).toContain("Friday night Helldivers");
    expect(body).toContain("Renamed raid");
    expect(body).toContain(`${APP_URL}/e/01J0000000000000000000ABCD.md`);
    expect(body).toContain(`${APP_URL}/events`);
  });

  it("gone body names the cancellation and the way back", () => {
    const body = mdEventGone(APP_URL, mdRow());
    expect(body).toContain("Cancelled");
    expect(body).toContain("Friday night Helldivers");
    expect(body).toContain(`${APP_URL}/events`);
  });

  it("llms.txt maps every alternate with absolute URLs and stays silent on training", () => {
    const body = llmsTxt(APP_URL);
    for (const path of [
      "/about.md",
      "/faq.md",
      "/rules.md",
      "/privacy.md",
      "/join.md",
      "/events.md",
    ])
      expect(body).toContain(`${APP_URL}${path}`);
    expect(body).toContain("Discord");
    expect(body).not.toMatch(/training/i);
    expect(body).not.toMatch(/member directory/i);
  });

  it("llms.txt uses explicit labels, never blurb fragments", () => {
    const body = llmsTxt(APP_URL);
    for (const label of [
      "- [About](",
      "- [FAQ](",
      "- [House rules](",
      "- [Privacy policy](",
      "- [Join](",
      "- [Upcoming events](",
    ])
      expect(body).toContain(label);
    for (const fragment of [
      "What the community is]",
      "Short answers newcomers actually ask]",
      "Upcoming published events; per-event pages live at /e/",
    ])
      expect(body).not.toContain(fragment);
  });

  it("llms.txt lists the events page once", () => {
    const body = llmsTxt(APP_URL);
    const eventsLinks = body.split("\n").filter((line) => line.includes(`(${APP_URL}/events)`));
    expect(eventsLinks).toHaveLength(1);
  });

  it("mdText treats bare CR as a line break before checking Markdown blocks", () => {
    expect(mdText("a\r```\rb")).toBe("a\n\\```\nb");
  });

  it("keeps multiline event titles, game and location on one line", () => {
    const body = mdEvents(APP_URL, [
      mdRow({
        title: "Night\nsecond line",
        game: "Game\rsecond line",
        location: "Voice\nsecond line",
      }),
    ]);
    expect(body).toContain("## [Night second line](");
    expect(body).toContain("- Game: Game second line");
    expect(body).toContain("- Where: Voice second line");
    expect(body.match(/^## /gm)).toHaveLength(1);
  });

  it("mdText keeps fences, setext underlines and HTML blocks inline", () => {
    expect(mdText("```\nABC123")).toBe("\\```\nABC123");
    expect(mdText("~~~\nABC123")).toBe("\\~~~\nABC123");
    expect(mdText("   ```js")).toBe("\\   ```js");
    expect(mdText("===")).toBe("\\===");
    expect(mdText("---")).toBe("\\---");
    expect(mdText("<!-- hi -->")).toBe("\\<!-- hi -->");
    expect(mdText("<div>hi</div>")).toBe("\\<div>hi\\</div>");
    // Existing contract still holds.
    expect(mdText("# hi")).toBe("\\# hi");
    expect(mdText("> quote")).toBe("\\> quote");
    expect(mdText("- item")).toBe("\\- item");
    expect(mdText("plain [link]")).toBe("plain \\[link\\]");
  });

  it("an unclosed fence in one event cannot swallow the next event", () => {
    const body = mdEvents(APP_URL, [
      mdRow({ description: "Join code below:\n```\nABC123" }),
      mdRow({ eventKey: "01J0000000000000000000WXYZ", title: "Second night" }),
    ]);
    expect(body).toContain("\\```");
    expect(body.match(/^## \[/gm)).toHaveLength(2);
    expect(body).toContain("Second night");
    expect(body).toContain(`${APP_URL}/e/01J0000000000000000000WXYZ.md`);
  });

  it("a bare-CR fence in detail cannot swallow the calendar links", () => {
    const body = mdEvent(APP_URL, mdRow({ description: "code:\r```\rABC" }));
    expect(body).toContain("\\```");
    expect(body).toContain("[Add to calendar (.ics)]");
    expect(body).toContain("[See upcoming events]");
  });

  it("an unclosed fence in detail cannot swallow the calendar links", () => {
    const body = mdEvent(APP_URL, mdRow({ description: "code:\n```\nABC" }));
    expect(body).toContain("\\```");
    expect(body).toContain("[Add to calendar (.ics)]");
    expect(body).toContain("[See upcoming events]");
  });
});

describe("static .md routes (DB-free)", () => {
  it.each([
    ["/about.md", ["Voice-first", "Est. 1998"]],
    ["/faq.md", ["How do I join?", "Prospect"]],
    ["/rules.md", ["18+ only", "1 September 2026"]],
    ["/privacy.md", ["Version 5", "email address"]],
    ["/join.md", ["Approve once with Discord"]],
    ["/llms.txt", ["about.md", "faq.md", "rules.md", "privacy.md", "join.md", "events.md"]],
  ] as Array<[string, string[]]>)("%s serves markdown with parity copy", async (path, phrases) => {
    const res = await req(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(MARKDOWN_MIME);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-robots-tag")).toBeNull();
    const body = await res.text();
    for (const phrase of phrases) expect(body).toContain(phrase);
  });

  it("answers 503 Markdown, never HTML, when the database is down", async () => {
    // baseEnv carries no DB binding, so the event machine formats degrade here.
    for (const path of ["/events.md", "/e/01J0000000000000000000ABCD.md"]) {
      const res = await req(path);
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toBe(MARKDOWN_MIME);
      const body = await res.text();
      expect(body).toContain("Events temporarily unavailable");
      expect(body).not.toContain("Together We Own");
    }
  });

  it("matches HTML copy on every static leaf (content parity)", async () => {
    const pairs: Array<[string, string, string[]]> = [
      ["/about", "/about.md", ["Voice-first", "No application, no interview"]],
      ["/faq", "/faq.md", ["How do I join?", "no invite code"]],
      ["/rules", "/rules.md", ["Play fair", "Moderators have the last word"]],
      ["/privacy", "/privacy.md", ["never ask Discord for your email"]],
      ["/join", "/join.md", ["Approve once with Discord"]],
    ];
    for (const [html, md, phrases] of pairs) {
      const [h, m] = await Promise.all([req(html), req(md)]);
      expect(h.status).toBe(200);
      expect(m.status).toBe(200);
      const [hb, mb] = await Promise.all([h.text(), m.text()]);
      for (const phrase of phrases) {
        expect(hb).toContain(phrase);
        expect(mb).toContain(phrase);
      }
    }
  });

  // Same hostile list as the Hono /join funnel pins: /join.md is the
  // markdownAlternate advertised on /join, so it degrades through the same
  // shared rule instead of echoing the raw env (or a bare gap on empty).
  const hostileJoinInvites = [
    "",
    "not a URL",
    "javascript:alert(1)",
    "https://evil.test/Ab12",
    "//discord.gg/Ab12",
    "/relative/path",
    "http://discord.gg/Ab12",
    "https://discord.gg/Ab12/extra",
    "https://discord.com/login",
  ];

  it.each(hostileJoinInvites)(
    "/join.md degrades a bad invite to the hardcoded fallback: %s",
    async (configured) => {
      const res = await app.request(
        "/join.md",
        {},
        { ...baseEnv(APP_URL), DISCORD_INVITE_URL: configured },
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(FALLBACK_INVITE);
      expect(body).not.toContain("Use  instead");
      if (configured) expect(body).not.toContain(configured);
    },
  );

  it("/join.md keeps a plain valid invite on its own destination", async () => {
    const configured = "https://discord.gg/Ab12";
    const res = await app.request(
      "/join.md",
      {},
      { ...baseEnv(APP_URL), DISCORD_INVITE_URL: configured },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`Use ${configured} instead`);
  });

  it("advises staging crawlers off every machine format", async () => {
    for (const path of [
      "/llms.txt",
      "/about.md",
      "/faq.md",
      "/rules.md",
      "/privacy.md",
      "/join.md",
    ]) {
      const res = await req(path, STAGING_URL);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });

  it("links each HTML leaf to its markdown alternate", async () => {
    const pairs: Array<[string, string]> = [
      ["/about", "/about.md"],
      ["/faq", "/faq.md"],
      ["/rules", "/rules.md"],
      ["/privacy", "/privacy.md"],
      ["/join", "/join.md"],
    ];
    for (const [html, md] of pairs) {
      const res = await req(html);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`rel="alternate" type="text/markdown"`);
      expect(body).toContain(`href="${md}"`);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("event .md routes (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  const tReq = (path: string, appUrl = APP_URL) =>
    app.request(path, {}, {
      ...baseEnv(appUrl),
      get ADMIN_DB() {
        return db;
      },
    } as unknown as Env);
  const ins = (
    key: string,
    status: "draft" | "published" | "cancelled" | "past",
    o: Partial<typeof events.$inferSelect> = {},
  ) =>
    db.insert(events).values({
      eventKey: key,
      title: `t-${key}`,
      description: "Bring stims.",
      startsAt: new Date("2099-01-01T00:00:00Z"),
      endsAt: new Date("2099-01-02T00:00:00Z"),
      timezone: "UTC",
      location: "Voice: General",
      status,
      ...o,
    } as never);

  beforeEach(async () => {
    await db.delete(events);
  });

  it("events.md lists published upcoming only, never drafts or member data", async () => {
    await ins("01J0000000000000000000PXB1", "published");
    await ins("01J0000000000000000000DRF1", "draft");
    await ins("01J0000000000000000000CAN1", "cancelled");
    const res = await tReq("/events.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(MARKDOWN_MIME);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.text();
    expect(body).toContain("PXB1");
    for (const k of ["DRF1", "CAN1"]) expect(body).not.toContain(k);
    expect(body.toLowerCase()).not.toContain("attendee");
  });

  it("event .md mirrors the published page, and the HTML links to it", async () => {
    await ins("01J0000000000000000000PXB1", "published");
    const [md, html] = await Promise.all([
      tReq("/e/01J0000000000000000000PXB1.md"),
      tReq("/e/01J0000000000000000000PXB1"),
    ]);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe(MARKDOWN_MIME);
    const [mb, hb] = await Promise.all([md.text(), html.text()]);
    for (const phrase of ["t-01J0000000000000000000PXB1", "Bring stims.", "Voice: General"])
      expect(mb).toContain(phrase);
    expect(hb).toContain('rel="alternate" type="text/markdown"');
    expect(hb).toContain("/e/01J0000000000000000000PXB1.md");
  });

  it.each([
    ["empty stored name", "100000000000000207", "100000000000000209", true],
    ["missing user row", "100000000000000208", "100000000000000210", false],
  ])(
    "detail .md reads full from seat occupancy when a nameless row holds a seat (%s)",
    async (_shape, namelessId, namedId, insertNamelessUser) => {
      // Route-level pin for the dual-count rule: one named + one nameless
      // going row at capacity 2. Nulling the route's goingOccupancy would
      // drop the (full) signal here while the builder unit pins still pass.
      await ins("01J0000000000000000000MDF1", "published", { capacity: 2 });
      const [row] = await db.select().from(events);
      await db.insert(users).values({ id: namedId, username: "named-friend" });
      if (insertNamelessUser) await db.insert(users).values({ id: namelessId, username: "" });
      await db.insert(rsvps).values([
        { eventId: row!.id, userId: namedId, status: "going" },
        { eventId: row!.id, userId: namelessId, status: "going" },
      ]);
      const res = await tReq("/e/01J0000000000000000000MDF1.md");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(MARKDOWN_MIME);
      expect(await res.text()).toContain("- Lineup: 1 going of 2 (full)");
    },
  );

  it("detail .md stays open when the named count leaves a seat free", async () => {
    await ins("01J0000000000000000000MDP1", "published", { capacity: 2 });
    const [row] = await db.select().from(events);
    await db.insert(users).values({ id: "100000000000000211", username: "named-friend" });
    await db
      .insert(rsvps)
      .values({ eventId: row!.id, userId: "100000000000000211", status: "going" });
    const res = await tReq("/e/01J0000000000000000000MDP1.md");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("- Lineup: 1 going of 2");
    expect(body).not.toContain("(full)");
  });

  it("cancelled .md is a 410 gone notice with noindex, like the HTML page", async () => {
    await ins("01J0000000000000000000CAN1", "cancelled");
    const res = await tReq("/e/01J0000000000000000000CAN1.md");
    expect(res.status).toBe(410);
    expect(res.headers.get("content-type")).toBe(MARKDOWN_MIME);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await res.text();
    expect(body).toContain("Cancelled");
    expect(body).toContain("/events");
  });

  it("draft .md refuses like the HTML page and unknown keys 404", async () => {
    await ins("01J0000000000000000000DRF1", "draft");
    const draft = await tReq("/e/01J0000000000000000000DRF1.md");
    expect(draft.status).toBe(403);
    const missing = await tReq("/e/01J0000000000000000000ZZZ9.md");
    expect(missing.status).toBe(404);
  });

  it("past .md states the archived status instead of scheduled", async () => {
    await ins("01J0000000000000000000PST1", "past");
    const res = await tReq("/e/01J0000000000000000000PST1.md");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("- Status: past");
    expect(body).not.toContain("scheduled");
    expect(body).not.toContain("Add to calendar");
    expect(body).toContain("[Browse past events]");
    expect(body).toContain("/events/past");
  });

  it("moderator draft HTML omits the alternate that would 403", async () => {
    await ins("01J0000000000000000000DRF1", "draft");
    const store = createMemorySessionStore();
    const res = await app.request(
      "/e/01J0000000000000000000DRF1",
      { headers: { cookie: await cookieFor(store, MODERATOR) } },
      {
        ...baseEnv(APP_URL),
        SESSION_STORE: store,
        get ADMIN_DB() {
          return db;
        },
      } as unknown as Env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('type="text/markdown"');
  });

  it("staging noindexes the event machine formats", async () => {
    await ins("01J0000000000000000000PXB1", "published");
    for (const path of ["/events.md", "/e/01J0000000000000000000PXB1.md"]) {
      const res = await tReq(path, STAGING_URL);
      expect([200, 304]).toContain(res.status);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });
});
