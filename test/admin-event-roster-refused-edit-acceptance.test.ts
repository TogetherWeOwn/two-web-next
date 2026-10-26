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

const stripTags = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();

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
// 4. reloading discards the unsaved edits currently shown.
const DISCARD_RE =
  /(reload|reloading|reopen|leaving)[^.]{0,160}(discard|lose|lost|throw away)[^.]{0,80}(unsaved|edit|change)|(discard|lose)[^.]{0,80}unsaved/i;

type Anchor = { href: string; index: number };
const anchors = (html: string): Anchor[] =>
  [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>/g)].map((m) => ({
    href: m[1]!.replaceAll("&amp;", "&"),
    index: m.index,
  }));

/**
 * The notice link: an anchor to the canonical GET edit page for this event
 * (same pathname, no roster filter state to resurrect), with hidden-roster
 * wording in the text immediately around it. Returns the anchor plus that
 * surrounding visible text, or null when no such notice exists.
 */
function findRosterHiddenNotice(
  html: string,
): { href: string; window: string; index: number } | null {
  for (const anchor of anchors(html)) {
    const url = new URL(anchor.href, APP_URL);
    if (url.pathname !== EDIT_PATH) continue;
    if ([...url.searchParams.keys()].some((k) => k.startsWith("roster_"))) continue;
    const window = stripTags(html.slice(Math.max(0, anchor.index - 2500), anchor.index + 2500));
    if (HIDDEN_RE.test(window)) return { href: anchor.href, window, index: anchor.index };
  }
  return null;
}

function expectRefusedEditNotice(html: string) {
  const notice = findRosterHiddenNotice(html);
  expect(notice, "no roster-hidden notice link found on the 422 re-render").not.toBeNull();
  // Every job of the notice wording, judged in the text around the link.
  expect(notice!.window).toMatch(UNCHANGED_RE);
  expect(notice!.window).toMatch(RELOAD_SHOWS_RE);
  expect(notice!.window).toMatch(DISCARD_RE);
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
