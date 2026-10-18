// route-inventory: GET /e/:key
// Acceptance: the Hono "Refresh attendees" link re-requests the attendee
// page the member is actually looking at. From ?attendees=3 the rendered
// refresh href carries page 3; page-1 links stay the bare event path;
// invalid or absent values fall back exactly as the existing attendee-page
// normalization dictates (page 1, bare path); and no new query params leak
// into canonical URLs or cache behaviour.
//
// Locked contract (paired builder must satisfy without editing this file):
// - Exactly one anchor data-testid="event-attendees-refresh" with the text
//   "Refresh attendees" renders for a member viewing the roster, as today.
// - Its href is /e/<key>?attendees=<N> when the resolved attendee page is a
//   valid N > 1, and exactly /e/<key> (no query) on page 1.
// - The page value is the route's validated page, never an echo of raw
//   search text: foreign params (e.g. a next= URL) do not ride along, and
//   malformed values (0, negative, fractional, non-numeric, unsafe
//   arithmetic, absolute/protocol-relative URLs) resolve to page 1, exactly
//   as the existing paging fallback already does.
// - Canonical surfaces stay bare at every page: rel="canonical" and the
//   data-copy-link URL remain <APP_URL>/e/<key> with no query string, and
//   the member response keeps Cache-Control: private, no-store and
//   Vary: Cookie.
// - Positive controls: native prev/next pager hrefs are unchanged, and
//   guests/non-members still get no roster, no refresh link, and no audit
//   row at any ?attendees= value.
//
// Assertions read only the rendered HTML and response headers, so the
// builder may carry the validated page through any render channel. The
// past-end empty page is deliberately not pinned here: its return link is
// already covered by test/event-attendees.test.ts. Kit behaviour is out of
// scope (see test/kit-roster-refresh-attendee-page-acceptance.test.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, EVENT_KEY, MEMBER, OUTSIDER, SUBJECT, seed } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const PAGE = 100;
// More than two pages of synthetic attendees: 250 named going rows, so
// page 3 is a real (partial) page and page 2 a real middle page.
const TOTAL_NAMED = 250;
const PATH = `/e/${EVENT_KEY}`;
const pad = (n: number) => String(n).padStart(3, "0");
const synthId = (i: number) => `600000000000000${pad(i)}`; // 18-digit snowflake-shaped
const synthName = (i: number) => `hono-refresh-attendee-${pad(i)}`;
const firstOfPage = (page: number) => synthName((page - 1) * PAGE);

// Every rendered refresh anchor, in document order. Attribute order is
// deliberately not assumed.
function refreshAnchors(html: string): { href: string | null; text: string }[] {
  const anchors: { href: string | null; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*>([^<]*)</g)) {
    if (!m[0].includes('data-testid="event-attendees-refresh"')) continue;
    anchors.push({ href: m[0].match(/\bhref="([^"]*)"/)?.[1] ?? null, text: m[1] ?? "" });
  }
  return anchors;
}

function attendeePageOf(href: string | null): string | null {
  if (!href) return null;
  return new URL(href, env.APP_URL).searchParams.get("attendees");
}

describe.skipIf(!process.env.DATABASE_URL)(
  "Hono roster refresh link keeps the attendee page (isolated agent-testdb schema)",
  () => {
    let fixture: MemberDataFixture;
    let sessions = createMemorySessionStore();
    const request = (path = PATH, init: RequestInit = {}) =>
      app.request(path, init, { ...env, ADMIN_DB: fixture.db, SESSION_STORE: sessions });
    const headers = async (actor = MEMBER) => ({ cookie: await cookieFor(sessions, actor) });
    const logs = () => fixture.db.select().from(memberDataAccessLogs);
    const withPage = (raw: string) => `${PATH}?attendees=${encodeURIComponent(raw)}`;

    // Viewer is MEMBER (not among synthetic attendees). SUBJECT's seeded
    // RSVP is removed so the 250 synthetic rows are the whole named
    // population, mirroring test/event-attendee-paging-acceptance.test.ts.
    async function seedPaging() {
      await fixture.db.delete(rsvps);
      const [event] = await fixture.db.select().from(events);
      const userRows = [];
      const rsvpRows = [];
      for (let i = 0; i < TOTAL_NAMED; i++) {
        userRows.push({ id: synthId(i), username: synthName(i) });
        rsvpRows.push({
          eventId: event!.id,
          userId: synthId(i),
          status: "going",
          createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 25))),
          updatedAt: new Date(Date.UTC(2026, 0, 1)),
        });
      }
      await fixture.db.insert(users).values(userRows);
      await fixture.db.insert(rsvps).values(rsvpRows);
    }

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      await seed(fixture.db);
      sessions = createMemorySessionStore();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await fixture?.reset();
    });
    afterAll(() => fixture?.dispose());

    it.each([2, 3])(
      "keeps page %i on the refresh link so Refresh re-requests the viewed page",
      async (page) => {
        await seedPaging();
        const res = await request(withPage(String(page)), { headers: await headers() });
        expect(res.status).toBe(200);
        const html = await res.text();
        // The roster really is the requested page (not a silent page 1).
        expect(html).toContain(firstOfPage(page));
        expect(html).not.toContain(firstOfPage(1));
        const anchors = refreshAnchors(html);
        expect(anchors).toHaveLength(1);
        expect(anchors[0]?.text).toBe("Refresh attendees");
        expect(anchors[0]?.href).toBe(`${PATH}?attendees=${page}`);
        expect(attendeePageOf(anchors[0]?.href ?? null)).toBe(String(page));
        // Same-origin, same event: never an absolute or protocol-relative URL.
        expect(anchors[0]?.href).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:)?\/\//i);
      },
    );

    it.each(["", "?attendees=1"])(
      "stays the bare event path on page 1 (search %j)",
      async (search) => {
        await seedPaging();
        const res = await request(`${PATH}${search}`, { headers: await headers() });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain(firstOfPage(1));
        const anchors = refreshAnchors(html);
        expect(anchors).toHaveLength(1);
        expect(anchors[0]?.href).toBe(PATH);
        expect(attendeePageOf(anchors[0]?.href ?? null)).toBeNull();
      },
    );

    it.each([
      "0",
      "-1",
      "abc",
      "1.5",
      "2x",
      " 2",
      "",
      "999999999999999999999",
      "https://evil.example/e/other",
      "//evil.example/e/other",
      "2?attendees=3",
    ])(
      "falls back to page 1 and the bare refresh path for invalid/external attendees=%j",
      async (raw) => {
        await seedPaging();
        const res = await request(withPage(raw), { headers: await headers() });
        expect(res.status).toBe(200);
        const html = await res.text();
        // Fallback is the real page 1 roster, not an echo of the raw value.
        expect(html).toContain(firstOfPage(1));
        expect(html).not.toContain(firstOfPage(2));
        const anchors = refreshAnchors(html);
        expect(anchors).toHaveLength(1);
        expect(anchors[0]?.href).toBe(PATH);
        expect(anchors[0]?.href).not.toContain("evil.example");
      },
    );

    it("does not let foreign params ride along on the refresh href", async () => {
      await seedPaging();
      const path = `${PATH}?attendees=3&next=${encodeURIComponent("https://evil.example/steal")}&attendees2=9`;
      const res = await request(path, { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(firstOfPage(3));
      const anchors = refreshAnchors(html);
      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.href).toBe(`${PATH}?attendees=3`);
      expect(anchors[0]?.href).not.toContain("evil.example");
      expect(anchors[0]?.href).not.toContain("attendees2");
    });

    it("keeps canonical URL, copy link and cache headers bare at page 3", async () => {
      await seedPaging();
      const res = await request(withPage("3"), { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`rel="canonical" href="${env.APP_URL}${PATH}"`);
      expect(html).toContain(`data-copy-link="${env.APP_URL}${PATH}"`);
      expect(html).not.toContain(`href="${env.APP_URL}${PATH}?`);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("vary")).toBe("Cookie");
      // The refresh link is the only same-page link allowed to gain the
      // page param beyond the pre-existing pager.
      const anchors = refreshAnchors(html);
      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.href).toBe(`${PATH}?attendees=3`);
    });

    it("leaves the native pager hrefs unchanged at pages 1 and 3 (positive control)", async () => {
      await seedPaging();
      const first = await (await request(undefined, { headers: await headers() })).text();
      expect(first).toContain('data-testid="event-attendees-next"');
      expect(first).toContain(`href="${PATH}?attendees=2"`);
      expect(first).not.toContain('data-testid="event-attendees-prev"');

      const third = await (await request(withPage("3"), { headers: await headers() })).text();
      expect(third).toContain('data-testid="event-attendees-prev"');
      expect(third).toMatch(
        new RegExp(
          `href="${PATH.replace(/\//g, "\\/")}\\?attendees=2"[^>]*data-testid="event-attendees-prev"`,
        ),
      );
      expect(third).not.toContain('data-testid="event-attendees-next"');
    });

    it("keeps a single-page roster on the bare refresh path (positive control)", async () => {
      // Seeded single attendee (SUBJECT) only — no paging seed.
      const res = await request(undefined, { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<a href="/members/${SUBJECT.userId}">${SUBJECT.username}</a>`);
      const anchors = refreshAnchors(html);
      expect(anchors).toHaveLength(1);
      expect(anchors[0]?.href).toBe(PATH);
    });

    it.each(["guest", "non-member"])(
      "%s at ?attendees=3 gets no roster, no refresh link, and no audit row (positive control)",
      async (role) => {
        await seedPaging();
        const res = await request(withPage("3"), {
          headers: role === "guest" ? {} : await headers(OUTSIDER),
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain(`${TOTAL_NAMED} going`);
        for (const value of [firstOfPage(1), firstOfPage(3), "event-attendees", "attendees=3"])
          expect(html).not.toContain(value);
        expect(refreshAnchors(html)).toHaveLength(0);
        expect(await logs()).toHaveLength(0);
      },
    );
  },
);
