// Independent acceptance ownership: this file only. The builder implements
// against it and never edits it.
// Run: DATABASE_URL=postgres://agent_test@agent-testdb:5432/postgres npx vitest run test/admin-event-roster-refused-edit-acceptance.test.ts
// Intended RED on the unbuilt base: both 422 re-renders of an existing
// event's edit form silently omit the roster with no explanatory notice.
// The notice cases fail with "no roster-hidden notice link found"; the
// CONTROL cases (create-mode refusal, plain GET) pass before and after.
// Mutation targets: notice added to only one refusal path; notice without
// the canonical reload link; link losing the event key or gaining roster
// filter state; notice claiming RSVPs changed; missing unsaved-edits
// warning; roster rows leaked into the 422 body; notice shown on create.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { events, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import type { Env } from "../src/env";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "roster-refused-test-secret-at-least-32-bytes";
const KEY = "01K00000000000000000000077";
const EDIT_PATH = `/admin/events/${KEY}`;
const FORM = {
  title: "Game night",
  game: "Chess",
  description: "Boards out",
  location: "Voice",
  capacity: "8",
  starts_at: "2026-11-04 20:00",
  ends_at: "2026-11-04 22:00",
  timezone: "Europe/London",
};
// Fixture-only roster strings: present on the GET, forbidden on any 422.
const ROSTER_NAMES = ["RosterAdaFixture", "RosterBenFixture"] as const;
const ROSTER_ANSWERED = ["2026-10-01T01:00:00.000Z", "2026-10-02T01:00:00.000Z"] as const;

function stripTags(html: string): string {
  const text = (node: DefaultTreeAdapterMap["node"]): string => {
    if ("tagName" in node && (node.tagName === "script" || node.tagName === "style")) return " ";
    if ("value" in node) return node.value;
    return "childNodes" in node ? node.childNodes.map(text).join(" ") : " ";
  };
  return text(parseFragment(html)).replace(/\s+/g, " ").trim();
}

// The notice's four jobs, as loose semantic pins (exact copy is the
// builder's, the meaning is not):
// 1. the roster is hidden/not shown on this refused-save re-render;
const HIDDEN_RE =
  /roster[^.]{0,80}(hidden|not shown|isn'?t shown|not displayed|not visible)|(hidden|not shown|not displayed)[^.]{0,40}roster/i;
// 2. no RSVP data changed;
const UNCHANGED_RE =
  /(no|none of the|nothing)[^.]{0,60}rsvp[^.]{0,60}(chang|delet|remov|lost)|rsvp[^.]{0,80}(unchanged|not changed|haven'?t changed|has not changed|still there|intact|safe)/i;
// 3. reloading the edit page shows the roster again;
const RELOAD_SHOWS_RE =
  /(reload|reopen|re-open)[^.]{0,160}(show|see|display|bring)[^.]{0,80}(roster|again)|roster[^.]{0,80}(again|back)[^.]{0,80}(reload|reopen)/i;
// 4. require an affirmative consequence, not just nearby reload/discard words.
// No arbitrary gap may swallow "does not", "never" or a different object.
const DISCARD_RE =
  /(?:^|[.!?]\s+)(?:reload(?:ing)?|re-?open(?:ing)?|leaving)(?:\s+(?:the\s+)?edit\s+page)?\s+(?:will\s+)?(?:discards?|loses?|throws?\s+away)\s+(?:(?:the|any|your)\s+)?unsaved\s+(?:edits|changes)\b/i;

type Anchor = { href: string; index: number };
const anchors = (html: string): Anchor[] =>
  [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>/g)].map((m) => ({
    href: m[1]!.replaceAll("&amp;", "&"),
    index: m.index,
  }));

/**
 * Find the canonical reload link inside the parsed RSVP notice section.
 * Words in neighboring sections cannot satisfy any of the notice's jobs.
 */
function findRosterHiddenNotice(
  html: string,
): { href: string; window: string; index: number } | null {
  function* sections(
    node: DefaultTreeAdapterMap["node"],
  ): Generator<DefaultTreeAdapterMap["element"]> {
    if (
      "tagName" in node &&
      node.tagName === "section" &&
      node.attrs.some((attr) => attr.name === "aria-label" && attr.value === "RSVP roster")
    )
      yield node;
    if ("childNodes" in node) for (const child of node.childNodes) yield* sections(child);
  }
  for (const section of sections(parseFragment(html, { sourceCodeLocationInfo: true }))) {
    const location = section.sourceCodeLocation!;
    const sectionHtml = html.slice(location.startOffset, location.endOffset);
    const window = stripTags(sectionHtml);
    if (!HIDDEN_RE.test(window)) continue;
    for (const anchor of anchors(sectionHtml)) {
      const url = new URL(anchor.href, APP_URL);
      if (url.pathname !== EDIT_PATH) continue;
      if ([...url.searchParams.keys()].some((k) => k.startsWith("roster_"))) continue;
      return { href: anchor.href, window, index: location.startOffset + anchor.index };
    }
  }
  return null;
}

function expectRefusedEditNotice(html: string) {
  const notice = findRosterHiddenNotice(html);
  expect(notice, "no roster-hidden notice link found on the 422 re-render").not.toBeNull();
  // Every job is judged only in the notice section's visible text.
  expect(notice!.window).toMatch(UNCHANGED_RE);
  expect(notice!.window).toMatch(RELOAD_SHOWS_RE);
  expect(notice!.window, "notice must affirm that reloading discards unsaved edits").toMatch(
    DISCARD_RE,
  );
  // Where the roster would be: after the edit form, not buried in the
  // error summary at the top of the form.
  expect(notice!.index).toBeGreaterThan(html.indexOf("</form>"));
  // The roster itself stays out of the refused-save body, including any
  // roster-derived count (the GET renders it as "RSVPs (2)").
  for (const leaked of [...ROSTER_NAMES, ...ROSTER_ANSWERED]) expect(html).not.toContain(leaked);
  expect(html).not.toMatch(/RSVPs \(\d+\)/);
  // The refusal is still a refusal: field errors remain on the page.
  expect(html).toContain('data-testid="form-errors"');
  return notice!;
}

describe("roster notice text extraction", () => {
  it.each([
    ["uppercase script", "Before<SCRIPT>hidden</SCRIPT>After", "Before After"],
    ["mixed-case style", "Before<StYlE>hidden</sTyLe>After", "Before After"],
    ["script closing slash", "Before<script>hidden</script/>After", "Before After"],
    ["style closing attribute", "Before<style>hidden</style extra>After", "Before After"],
    ["unclosed script", "Before<script>hidden", "Before"],
    ["unclosed style", "Before<style>hidden", "Before"],
  ])("excludes %s text", (_name, html, expected) => {
    expect(stripTags(html)).toBe(expected);
  });

  it("preserves notice text and decoded entities without markup, comments or attributes", () => {
    expect(
      stripTags(
        '<p title="not > visible">Roster <strong>hidden</strong>.\nRSVPs unchanged &amp; safe.</p><!-- hidden -->' +
          "<p>Reload&#32;shows the roster. Reload discards unsaved&nbsp;edits.</p>" +
          "<p>&lt;script&gt;literal&lt;/script&gt;</p>",
      ),
    ).toBe(
      "Roster hidden . RSVPs unchanged & safe. Reload shows the roster. Reload discards unsaved edits. <script>literal</script>",
    );
  });

  it.each(["SCRIPT", "StYlE"])("does not accept a notice supplied only by %s text", (tag) => {
    expect(
      findRosterHiddenNotice(
        `<${tag}>Roster hidden. RSVPs unchanged. Reload shows the roster. Reload discards unsaved edits.</${tag}>` +
          `<a href="${EDIT_PATH}">Reload</a>`,
      ),
    ).toBeNull();
  });
});

describe("refused-edit discard warning oracle", () => {
  const refusedPage = (warning: string) =>
    '<form><div data-testid="form-errors">Fix the start time.</div></form>' +
    '<section aria-label="RSVP roster"><h2>RSVPs</h2><p>Roster hidden. RSVPs unchanged. ' +
    `<a href="${EDIT_PATH}">Reload the edit page</a> to show the roster again. ${warning}</p></section>`;

  it.each([
    "Reloading discards the unsaved edits currently shown.",
    "Reload will discard your unsaved changes.",
    "Reopening the edit page will discard the unsaved <strong>edits</strong> currently shown.",
  ])("accepts an affirmative consequence: %s", (warning) => {
    expect(() => expectRefusedEditNotice(refusedPage(warning))).not.toThrow();
  });

  it.each([
    "Reloading does not discard the unsaved edits currently shown.",
    "Reloading doesn't discard the unsaved edits currently shown.",
    "Reloading will not discard the unsaved edits currently shown.",
    "Reloading never discards the unsaved edits currently shown.",
    "Reloading discards no unsaved edits currently shown.",
    "Reloading discards edits but preserves your unsaved changes.",
  ])("rejects the opposite consequence: %s", (warning) => {
    expect(() => expectRefusedEditNotice(refusedPage(warning))).toThrow(
      "notice must affirm that reloading discards unsaved edits",
    );
  });

  it.each(["before", "after"])(
    "does not borrow a discard warning from a sibling section %s the notice",
    (position) => {
      const page = refusedPage("Fix the highlighted fields first.");
      const unrelated = "<section>Reloading discards the unsaved edits currently shown.</section>";
      const html = position === "before" ? unrelated + page : page + unrelated;
      expect(() => expectRefusedEditNotice(html)).toThrow(
        "notice must affirm that reloading discards unsaved edits",
      );
    },
  );

  it.each(["SCRIPT", "StYlE"])("does not count a warning inside %s", (tag) => {
    const html = refusedPage(
      `<${tag}>Reloading discards the unsaved edits currently shown.</${tag}>`,
    );
    expect(() => expectRefusedEditNotice(html)).toThrow(
      "notice must affirm that reloading discards unsaved edits",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "refused event edit explains the missing roster (isolated test DB)",
  () => {
    let fixture: MemberDataFixture;
    let cookie: string;
    let env: Env;
    let app: Hono<{ Bindings: Env }>;
    const store = createMemorySessionStore();

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: "100000000000007700",
        username: "mod",
        avatar: null,
        member: true,
        moderator: true,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      cookie = (
        await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      env = {
        APP_URL,
        SESSION_SECRET,
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
        DISCORD_GUILD_ID: "guild",
        DISCORD_INVITE_URL: "https://discord.gg/invite",
        DISCORD_BOT_TOKEN: "bot-token",
        ADMIN_DB: fixture.db,
      } as Env;
      app = new Hono<{ Bindings: Env }>()
        .use("*", sameOrigin)
        .route("/admin", adminApp({ sessionStore: store, db: fixture.db }));
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await fixture.reset();
      const [event] = await fixture.db
        .insert(events)
        .values({
          eventKey: KEY,
          title: "Stored title",
          timezone: FORM.timezone,
          status: "draft",
          startsAt: new Date("2026-11-04T20:00:00Z"),
          endsAt: new Date("2026-11-04T22:00:00Z"),
        })
        .returning();
      await fixture.db.insert(users).values([
        { id: "100000000000007701", username: ROSTER_NAMES[0] },
        { id: "100000000000007702", username: ROSTER_NAMES[1] },
      ]);
      await fixture.db.insert(rsvps).values([
        {
          eventId: event!.id,
          userId: "100000000000007701",
          status: "going",
          updatedAt: new Date(ROSTER_ANSWERED[0]!),
        },
        {
          eventId: event!.id,
          userId: "100000000000007702",
          status: "going",
          updatedAt: new Date(ROSTER_ANSWERED[1]!),
        },
      ]);
    });

    const get = (path: string) => app.request(APP_URL + path, { headers: { cookie } }, env);
    const post = (path: string, values: Record<string, string>) =>
      app.request(
        APP_URL + path,
        {
          method: "POST",
          headers: { cookie, origin: APP_URL },
          body: new URLSearchParams(values),
        },
        env,
      );

    it("CONTROL: the plain GET edit page shows the roster and no hidden-roster notice", async () => {
      const res = await get(EDIT_PATH);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-testid="rsvp-roster"');
      for (const name of ROSTER_NAMES) expect(html).toContain(name);
      expect(findRosterHiddenNotice(html)).toBeNull();
      expect(stripTags(html)).not.toMatch(HIDDEN_RE);
    });

    it("a form-parse refusal (invalid start) shows the notice, leaks no roster, writes nothing", async () => {
      const eventsBefore = await fixture.db.select().from(events);
      const rsvpsBefore = await fixture.db.select().from(rsvps);
      const res = await post(EDIT_PATH, { ...FORM, starts_at: "not-a-time" });
      expect(res.status).toBe(422);
      const notice = expectRefusedEditNotice(await res.text());
      expect(notice.href.startsWith(EDIT_PATH)).toBe(true);
      expect(await fixture.db.select().from(events)).toEqual(eventsBefore);
      expect(await fixture.db.select().from(rsvps)).toEqual(rsvpsBefore);
    });

    it("a locked-update refusal (capacity below going) shows the notice, leaks no roster, writes nothing", async () => {
      const eventsBefore = await fixture.db.select().from(events);
      const rsvpsBefore = await fixture.db.select().from(rsvps);
      // Two members are going; capacity 1 parses fine but the locked
      // update refuses it, exercising the second 422 re-render.
      const res = await post(EDIT_PATH, { ...FORM, capacity: "1" });
      expect(res.status).toBe(422);
      expectRefusedEditNotice(await res.text());
      expect(await fixture.db.select().from(events)).toEqual(eventsBefore);
      expect(await fixture.db.select().from(rsvps)).toEqual(rsvpsBefore);
    });

    it("following the notice link reloads the canonical edit page with the roster back", async () => {
      const res = await post(EDIT_PATH, { ...FORM, starts_at: "not-a-time" });
      expect(res.status).toBe(422);
      const notice = expectRefusedEditNotice(await res.text());
      const linked = new URL(notice.href, APP_URL);
      expect(linked.pathname).toBe(EDIT_PATH);
      const reload = await get(linked.pathname + linked.search);
      expect(reload.status).toBe(200);
      const html = await reload.text();
      expect(html).toContain('data-testid="rsvp-roster"');
      for (const name of ROSTER_NAMES) expect(html).toContain(name);
      for (const answered of ROSTER_ANSWERED) expect(html).toContain(answered);
      expect(findRosterHiddenNotice(html)).toBeNull();
    });

    it("CONTROL: a create-mode refusal shows no roster-hidden notice", async () => {
      const res = await post("/admin/events", { ...FORM, starts_at: "not-a-time" });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain('data-testid="form-errors"');
      expect(findRosterHiddenNotice(html)).toBeNull();
      const text = stripTags(html);
      expect(text).not.toMatch(HIDDEN_RE);
      expect(text).not.toMatch(DISCARD_RE);
      for (const name of ROSTER_NAMES) expect(html).not.toContain(name);
    });
  },
);
