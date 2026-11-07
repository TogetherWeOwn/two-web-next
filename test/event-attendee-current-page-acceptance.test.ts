// route-inventory: GET /e/:key
// Acceptance: when native attendee paging is present, both renderers show
// the viewer which attendee page they are on. Today the models already carry
// attendeesPaging.page but neither renderer prints it, so a middle or
// past-end page offers only Previous/Next links with no position.
//
// Locked contract (paired builder must satisfy without editing this file):
// - Inside the existing <nav aria-label="Attendee pages">, exactly one
//   element carries data-testid="event-attendees-current-page",
//   aria-current="page", no hidden/aria-hidden treatment, and its own
//   visible text is exactly "Page <n>" where <n> is the model's existing
//   attendeesPaging.page (the normalized page, never the raw query value).
// - The label sits between the Previous and Next links when both exist,
//   after Previous on a last/past-end page, and before Next on page 1.
// - No total is ever shown: never "Page <n> of <m>", and no page count is
//   derived from the aggregate Going count (named-only: it excludes unnamed
//   and nonmatching going users, so it equals the roster length).
// - No extra identity or count read is added: the audit subjects per request
//   stay exactly the rendered page plus its one lookahead, and the aggregate
//   Going count keeps that named-only rule.
// - Preserved behavior: single-page lists render no pager and no label,
//   guests/nonmembers get no attendee section at all, previous/next hrefs
//   are unchanged, and a past-end page keeps its bare-URL return link with
//   its own (past-end) page number shown and no audit row.
//
// Saved-event review handback (nested in the Hono suite so it shares that
// suite's existing DB boundary and fixture): the real Hono route and the real
// Kit production store (not injected models) select the unfiltered moderator
// review read only after admission, so an unreadable saved window renders its
// corrections while every ordinary read keeps refusing it; review paging keeps
// its validated marker beside archive state on both renderers. Hermetic twins
// live in test/event-saved-review-handback.test.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { sql } from "drizzle-orm";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import { archiveEventHref } from "../src/events/attendee-paths";
import {
  kitEventDetailStore,
  resolveKitEventDetail,
  type KitEventDetailStore,
} from "../src/events/kit-detail";
import { getEventForModeratorReview, getPublicEvent } from "../src/events/reads";
import type { KitRequestSession } from "../src/kit-session";
import { createMemorySessionStore } from "../src/sessions";
import {
  cookieFor,
  env,
  EVENT_KEY,
  MEMBER,
  MODERATOR,
  OUTSIDER,
  SUBJECT,
  seed,
} from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const PAGE = 100;
// 250 named going rows = two full pages plus a 50-row last page; page 4 is
// past the end. Two further going rows (one unnamed, one with no user row)
// are excluded from the aggregate Going total and never named, so the
// aggregate (250) equals the roster length and must never be turned into a
// page total.
const TOTAL_NAMED = 250;
const GOING_TOTAL = TOTAL_NAMED;
const pad = (n: number) => String(n).padStart(3, "0");
const synthId = (i: number) => `400000000000000${pad(i)}`;
const synthName = (i: number) => `paging-attendee-${pad(i)}`;
const sorted = (ids: string[]) => [...ids].sort();
const pageIds = (page: number) => {
  const ids: string[] = [];
  for (let i = (page - 1) * PAGE; i < Math.min(page * PAGE, TOTAL_NAMED); i++) ids.push(synthId(i));
  return ids;
};
// Audit expectation: rendered page + lookahead (first row of next page).
const auditedIds = (page: number) => {
  const ids = pageIds(page);
  const lookahead = page * PAGE;
  if (lookahead < TOTAL_NAMED) ids.push(synthId(lookahead));
  return sorted(ids.filter((id) => id !== MEMBER.userId));
};
const link = (i: number) => `<a href="/members/${synthId(i)}">${synthName(i)}</a>`;
const pageHref = (page: number) =>
  page <= 1 ? `/e/${EVENT_KEY}` : `/e/${EVENT_KEY}?attendees=${page}`;

// SUBJECT's seeded RSVP is removed so the 250 synthetic rows are the whole
// named population; createdAt ties in groups of 25 like the paging suite.
async function seedPaging(db: MemberDataFixture["db"]) {
  await db.delete(rsvps);
  const [event] = await db.select().from(events);
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
  await db.insert(users).values(userRows);
  await db.insert(rsvps).values(rsvpRows);
  await db.insert(users).values({ id: "400000000000000900", username: "" });
  await db.insert(rsvps).values([
    { eventId: event!.id, userId: "400000000000000900", status: "going" },
    { eventId: event!.id, userId: "400000000000000901", status: "going" },
    { eventId: event!.id, userId: "400000000000000902", status: "waitlisted" },
  ]);
  return event!;
}

const CURRENT_ID = 'data-testid="event-attendees-current-page"';

// Test-only text extraction for assertions (no HTML sink): walk angle
// brackets instead of a `<...>` regex replace so the helper does not read
// as an HTML sanitizer (CodeQL incomplete sanitization). tagReplacement is
// emitted once per tag, mirroring the empty- vs space-join at the call sites.
function textOutsideTags(fragment: string, tagReplacement = "") {
  let out = "";
  let inTag = false;
  for (const ch of fragment) {
    if (ch === "<" && !inTag) {
      out += tagReplacement;
      inTag = true;
    } else if (ch === ">" && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

function currentPageElement(html: string) {
  const m = html.match(
    new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b([^>]*${CURRENT_ID}[^>]*)>([\\s\\S]*?)</\\1>`),
  );
  if (!m) return null;
  return {
    attrs: m[2]!,
    text: textOutsideTags(m[3]!).replace(/\s+/g, " ").trim(),
    index: m.index!,
  };
}

function attendeesNav(html: string) {
  const m = html.match(/<nav\b[^>]*aria-label="Attendee pages"[^>]*>([\s\S]*?)<\/nav>/);
  if (!m) return null;
  return {
    inner: m[1]!,
    text: textOutsideTags(m[1]!, " ").replace(/\s+/g, " "),
    index: m.index!,
    end: m.index! + m[0].length,
  };
}

function pagingLink(html: string, testid: "event-attendees-prev" | "event-attendees-next") {
  const m = html.match(new RegExp(`<a\\b([^>]*data-testid="${testid}"[^>]*)>`));
  if (!m) return null;
  return { href: m[1]!.match(/href="([^"]*)"/)?.[1] ?? null, index: m.index! };
}

// The one assertion every paged state in both renderers must satisfy.
function expectCurrentPage(
  html: string,
  page: number,
  expected: { prevHref: string | null; nextHref: string | null },
) {
  const nav = attendeesNav(html);
  expect(nav, "attendee pagination nav").not.toBeNull();
  expect(html.split(CURRENT_ID).length - 1, "exactly one current-page element").toBe(1);
  const el = currentPageElement(html);
  expect(el, "current-page element").not.toBeNull();
  // Visible, accessible, and the model's actual page — with no invented total.
  expect(el!.text).toBe(`Page ${page}`);
  expect(el!.attrs).toContain('aria-current="page"');
  expect(el!.attrs).not.toMatch(/aria-hidden/);
  expect(el!.attrs).not.toMatch(/(^|\s)hidden(\s|=|$)/);
  expect(el!.index).toBeGreaterThan(nav!.index);
  expect(el!.index).toBeLessThan(nav!.end);
  expect(nav!.text).not.toMatch(/\bof\s+\d+\b/);
  expect(html).not.toContain(`Page ${page} of`);
  const prev = pagingLink(html, "event-attendees-prev");
  const next = pagingLink(html, "event-attendees-next");
  if (expected.prevHref === null) {
    expect(prev, "no previous link").toBeNull();
  } else {
    expect(prev?.href, "previous href unchanged").toBe(expected.prevHref);
    expect(prev!.index, "label after previous link").toBeLessThan(el!.index);
  }
  if (expected.nextHref === null) {
    expect(next, "no next link").toBeNull();
  } else {
    expect(next?.href, "next href unchanged").toBe(expected.nextHref);
    expect(next!.index, "label before next link").toBeGreaterThan(el!.index);
  }
}

function expectNoPager(html: string) {
  expect(html).not.toContain(CURRENT_ID);
  expect(attendeesNav(html)).toBeNull();
  expect(html).not.toContain('data-testid="event-attendees-prev"');
  expect(html).not.toContain('data-testid="event-attendees-next"');
}

// Saved-event review handback fixtures.
const UNREADABLE_KEY = "01J00000000000000000000098";
const ABSENT_KEY = "01J00000000000000000000097";
const ARCHIVE = { page: 3, q: "raid night" };
const ARCHIVE_SEARCH = "archivePage=3&archiveQuery=raid+night";
const NOISE = "junk=evil&next=%2F%2Fevil.example&returnTo=%2F%2Fevil.example";
const archiveQuery = { archivePage: "3", archiveQuery: "raid night" };
// 101 synthetic going rows beside the seeded one: page 1 is full with a
// lookahead, page 2 is partial, page 3 is an empty past-end page.
const SYNTHETIC = 101;
const reviewSynthId = (i: number) => `500000000000000${String(i).padStart(3, "0")}`;

function parts(href: string | null | undefined) {
  if (href == null) return null;
  const url = new URL(href, "https://parts.invalid");
  const entries = [...url.searchParams];
  return { path: url.pathname, query: Object.fromEntries(entries), count: entries.length };
}

const reviewHref = (query: Record<string, string>, path = `/e/${EVENT_KEY}`) => ({
  path,
  query,
  count: Object.keys(query).length,
});

function rosterLinks(html: string) {
  const links: Record<string, string> = {};
  for (const match of html.matchAll(
    /<a href="([^"]*)"[^>]*\bdata-testid="event-attendees-(prev|next|refresh)"/g,
  )) {
    links[match[2]!] = match[1]!.replace(/&amp;/g, "&");
  }
  return links;
}

const REVIEW_LINKS = {
  1: {
    refresh: reviewHref({ ...archiveQuery, review: "1" }),
    prev: null,
    next: reviewHref({ attendees: "2", ...archiveQuery, review: "1" }),
  },
  2: {
    refresh: reviewHref({ attendees: "2", ...archiveQuery, review: "1" }),
    prev: reviewHref({ ...archiveQuery, review: "1" }),
    next: null,
  },
  3: {
    refresh: reviewHref({ attendees: "3", ...archiveQuery, review: "1" }),
    prev: reviewHref({ ...archiveQuery, review: "1" }),
    next: null,
  },
} as const;

const ORDINARY_LINKS = (page: number) => ({
  refresh: archiveEventHref(EVENT_KEY, ARCHIVE, page),
  ...(page > 1 ? { prev: archiveEventHref(EVENT_KEY, ARCHIVE, 1) } : {}),
  ...(page === 1 ? { next: archiveEventHref(EVENT_KEY, ARCHIVE, 2) } : {}),
});

const kitSession = (actor: typeof MEMBER): KitRequestSession => ({
  status: "authenticated",
  session: {
    userId: actor.userId,
    username: actor.username,
    avatar: null,
    member: actor.member,
    moderator: actor.moderator,
  },
});

describe.skipIf(!process.env.DATABASE_URL)(
  "Hono attendee current-page label acceptance (isolated agent-testdb schema)",
  () => {
    let fixture: MemberDataFixture;
    let sessions = createMemorySessionStore();
    const request = (path = `/e/${EVENT_KEY}`, init: RequestInit = {}) =>
      app.request(path, init, {
        ...env,
        ADMIN_DB: fixture.db,
        SESSION_STORE: sessions,
      });
    const headers = async (actor = MEMBER) => ({ cookie: await cookieFor(sessions, actor) });
    const logs = () => fixture.db.select().from(memberDataAccessLogs);
    const withPage = (raw: string) => `/e/${EVENT_KEY}?attendees=${encodeURIComponent(raw)}`;

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

    it.each([
      { page: 1, path: undefined, prevHref: null, nextHref: pageHref(2), first: 0 },
      { page: 2, path: withPage("2"), prevHref: pageHref(1), nextHref: pageHref(3), first: PAGE },
      { page: 3, path: withPage("3"), prevHref: pageHref(2), nextHref: null, first: 2 * PAGE },
    ])("shows Page $page beside the unchanged prev/next links", async (c) => {
      await seedPaging(fixture.db);
      const res = await request(c.path, { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(link(c.first));
      expect(html).toContain(`${GOING_TOTAL} going`);
      expectCurrentPage(html, c.page, { prevHref: c.prevHref, nextHref: c.nextHref });
      // No extra identity read: exactly this page plus its lookahead audited.
      expect(await logs()).toMatchObject([
        { subjectUserIds: auditedIds(c.page), route: "events.page" },
      ]);
    });

    it("shows the past-end page number with the bare-URL return link and no audit row", async () => {
      await seedPaging(fixture.db);
      const res = await request(withPage("4"), { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("There are no more attendees on this page.");
      expect(html).not.toContain(synthName(0));
      expect(html).not.toContain(synthName(TOTAL_NAMED - 1));
      expectCurrentPage(html, 4, { prevHref: pageHref(1), nextHref: null });
      expect(await logs()).toHaveLength(0);
    });

    it("labels a malformed attendees value with the normalized page 1, not the raw value", async () => {
      await seedPaging(fixture.db);
      const res = await request(withPage("2x"), { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(link(0));
      expectCurrentPage(html, 1, { prevHref: null, nextHref: pageHref(2) });
      expect(await logs()).toMatchObject([{ subjectUserIds: auditedIds(1) }]);
    });

    it("keeps a single-page list free of pager and label (control)", async () => {
      const res = await request(undefined, { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<a href="/members/${SUBJECT.userId}">${SUBJECT.username}</a>`);
      expect(html).toContain("Who&#39;s going (1)");
      expectNoPager(html);
      expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId] }]);
    });

    it.each(["guest", "non-member"])(
      "%s sees no attendee section, pager, or label on a paged URL (control)",
      async (role) => {
        await seedPaging(fixture.db);
        const res = await request(withPage("2"), {
          headers: role === "guest" ? {} : await headers(OUTSIDER),
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain(`${GOING_TOTAL} going`);
        expect(html).not.toContain(synthName(PAGE));
        expect(html).not.toContain("event-attendees");
        expectNoPager(html);
        expect(await logs()).toHaveLength(0);
      },
    );

    describe("saved-event review handback", () => {
      const reviewRequest = async (path: string, actor?: typeof MEMBER) =>
        app.request(path, actor ? { headers: { cookie: await cookieFor(sessions, actor) } } : {}, {
          ...env,
          ADMIN_DB: fixture.db,
          SESSION_STORE: sessions,
        });
      const productionStore = (): KitEventDetailStore => ({
        ...kitEventDetailStore(env),
        dbForFn: async () => fixture.db,
        suggestionsFn: async () => [],
      });
      const resolveKit = (
        key: string,
        search: string,
        session: KitRequestSession,
        store: KitEventDetailStore = productionStore(),
      ) =>
        resolveKitEventDetail({
          key,
          search,
          path: `/e/${key}`,
          env,
          session,
          joinResult: null,
          setHeaders: () => {},
          store,
        });

      // The enclosing suite's hooks reset, seed and renew sessions before this
      // runs, and restore mocks and reset after each case.
      beforeEach(async () => {
        const [event] = await fixture.db.select().from(events);
        await fixture.db.insert(users).values(
          Array.from({ length: SYNTHETIC }, (_, i) => ({
            id: reviewSynthId(i),
            username: `pager-${i}`,
          })),
        );
        await fixture.db.insert(rsvps).values(
          Array.from({ length: SYNTHETIC }, (_, i) => ({
            eventId: event!.id,
            userId: reviewSynthId(i),
            status: "going",
            createdAt: new Date(Date.UTC(2026, 0, 2, 0, i)),
          })),
        );
        await fixture.db.insert(events).values({
          eventKey: UNREADABLE_KEY,
          title: 'Imported <script>alert("t")</script>',
          status: "draft",
          startsAt: new Date("2099-11-06T20:00:00Z"),
          endsAt: new Date("2099-11-06T22:00:00Z"),
        });
        // The import defect under review: a stored bound no JS Date represents.
        await fixture.db.execute(
          sql`update events set starts_at = 'infinity' where event_key = ${UNREADABLE_KEY}`,
        );
      });

      it("reads the unreadable window only through the moderator review read", async () => {
        expect(await getPublicEvent(fixture.db, UNREADABLE_KEY)).toBeNull();
        const review = await getEventForModeratorReview(fixture.db, UNREADABLE_KEY);
        expect(review).toMatchObject({
          eventKey: UNREADABLE_KEY,
          status: "draft",
          goingCount: 0,
          goingOccupancy: 0,
        });
        expect(Number.isNaN(review!.startsAt.getTime())).toBe(true);
        // A readable row is the same projection, going counts included.
        const readable = await getPublicEvent(fixture.db, EVENT_KEY);
        expect(readable!.goingCount).toBe(SYNTHETIC + 1);
        expect(await getEventForModeratorReview(fixture.db, EVENT_KEY)).toEqual(readable);
        expect(await getEventForModeratorReview(fixture.db, ABSENT_KEY)).toBeNull();
      });

      it("serves the unreadable saved draft to Hono moderator review only", async () => {
        const path = `/e/${UNREADABLE_KEY}`;
        const response = await reviewRequest(`${path}?review=1`, MODERATOR);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        const html = await response.text();
        expect(html).toContain('name="robots" content="noindex, nofollow"');
        expect(html).toContain("Fix these before publishing");
        expect(html).toContain("Time unavailable");
        expect(html).toContain(`href="/admin/events/${UNREADABLE_KEY}#f-location"`);
        expect(html).toContain(`href="/admin/events/${UNREADABLE_KEY}#f-starts-at"`);
        expect(html).toContain("Imported &lt;script&gt;");
        expect(html).not.toContain('<script>alert("t")');
        expect(html).toContain('aria-describedby="preview-rsvp-hint"');
        expect(html).not.toContain("data-rsvp-form");
        expect(html).not.toContain('src="/islands/rsvp-button.js"');

        for (const actor of [undefined, MEMBER]) {
          const refused = await reviewRequest(`${path}?review=1`, actor);
          expect(refused.status).toBe(403);
          expect(await refused.text()).not.toContain("Imported");
        }
        for (const actor of [undefined, MEMBER, MODERATOR]) {
          expect((await reviewRequest(path, actor)).status).toBe(404);
        }
        expect((await reviewRequest(`${path}.md`)).status).toBe(404);
        expect((await reviewRequest(`/e/${ABSENT_KEY}?review=1`, MODERATOR)).status).toBe(404);
      });

      it.each([1, 2, 3] as const)(
        "keeps Hono review paging in review with archive state on page %i",
        async (page) => {
          const attendees = page > 1 ? `attendees=${page}&` : "";
          const response = await reviewRequest(
            `/e/${EVENT_KEY}?review=1&${attendees}${ARCHIVE_SEARCH}&${NOISE}`,
            MODERATOR,
          );
          expect(response.status).toBe(200);
          const html = await response.text();
          expect(html).toContain('data-testid="event-review"');
          const links = rosterLinks(html);
          const want = REVIEW_LINKS[page];
          expect(parts(links.refresh)).toEqual(want.refresh);
          expect(parts(links.prev)).toEqual(want.prev);
          expect(parts(links.next)).toEqual(want.next);
          expect(Object.values(links).join(" ")).not.toMatch(/junk|evil|returnTo/);
          expect(html).not.toContain("data-rsvp-form");
          expect(html).not.toMatch(/action="[^"]*\/rsvp/);

          // Ordinary paging is byte-identical and never gains the marker.
          for (const prefix of ["", "review=true&"]) {
            const ordinary = await reviewRequest(
              `/e/${EVENT_KEY}?${prefix}${attendees}${ARCHIVE_SEARCH}&${NOISE}`,
              MODERATOR,
            );
            expect(ordinary.status).toBe(200);
            const ordinaryHtml = await ordinary.text();
            expect(ordinaryHtml).not.toContain('data-testid="event-review"');
            expect(rosterLinks(ordinaryHtml)).toEqual(ORDINARY_LINKS(page));
          }
        },
      );

      it("refuses guest and member review paging without leaking attendees", async () => {
        for (const actor of [undefined, MEMBER]) {
          const response = await reviewRequest(
            `/e/${EVENT_KEY}?review=1&attendees=2&${ARCHIVE_SEARCH}`,
            actor,
          );
          expect(response.status).toBe(403);
          const html = await response.text();
          expect(html).not.toContain("pager-");
          expect(html).not.toContain('data-testid="event-attendees"');
          expect(html).not.toContain('data-testid="event-review"');
        }
      });

      it("selects the real Kit review read only for an admitted moderator", async () => {
        const ok = await resolveKit(UNREADABLE_KEY, "?review=1", kitSession(MODERATOR));
        expect(ok.kind).toBe("ok");
        if (ok.kind !== "ok") throw new Error(ok.kind);
        expect(ok.headers["cache-control"]).toBe("private, no-store");
        expect(ok.headers["x-robots-tag"]).toBe("noindex, nofollow");
        expect(ok.model.whenText).toBe("Time unavailable");
        expect(ok.model.review?.banner).toContain("Fix these before publishing");
        expect(ok.model.review?.banner).toContain(
          `href="/admin/events/${UNREADABLE_KEY}#f-starts-at"`,
        );
        expect(ok.model.detailHtml.rsvp).toContain("RSVP is disabled in preview.");
        expect(ok.model.detailHtml.rsvp).not.toContain("<form");

        // The production ordinary read still refuses the same row.
        for (const [search, session] of [
          ["", kitSession(MODERATOR)],
          ["?review=0", kitSession(MODERATOR)],
        ] as const) {
          expect(await resolveKit(UNREADABLE_KEY, search, session)).toMatchObject({
            kind: "missing",
            status: 404,
          });
        }
        for (const [session, kind] of [
          [{ status: "guest", session: null }, "forbidden"],
          [kitSession(MEMBER), "forbidden"],
          [{ status: "unknown", session: null }, "unavailable"],
        ] as const) {
          expect((await resolveKit(UNREADABLE_KEY, "?review=1", session)).kind).toBe(kind);
        }
        expect(await resolveKit(ABSENT_KEY, "?review=1", kitSession(MODERATOR))).toMatchObject({
          kind: "missing",
          status: 404,
        });
      });

      it.each([1, 2, 3] as const)(
        "keeps Kit review paging in review with archive state on page %i",
        async (page) => {
          const attendees = page > 1 ? `attendees=${page}&` : "";
          const outcome = await resolveKit(
            EVENT_KEY,
            `?review=1&${attendees}${ARCHIVE_SEARCH}&${NOISE}`,
            kitSession(MODERATOR),
          );
          if (outcome.kind !== "ok") throw new Error(outcome.kind);
          const { model } = outcome;
          const want = REVIEW_LINKS[page];
          expect(parts(model.attendeesRefreshHref)).toEqual(want.refresh);
          expect(parts(model.attendeesPaging.prevHref)).toEqual(want.prev);
          expect(parts(model.attendeesPaging.nextHref)).toEqual(want.next);
          const rendered = rosterLinks(model.detailHtml.roster);
          expect(rendered.refresh).toBe(model.attendeesRefreshHref);
          expect(rendered.prev ?? null).toBe(model.attendeesPaging.prevHref);
          expect(rendered.next ?? null).toBe(model.attendeesPaging.nextHref);

          const ordinary = await resolveKit(
            EVENT_KEY,
            `?${attendees}${ARCHIVE_SEARCH}&${NOISE}`,
            kitSession(MODERATOR),
          );
          if (ordinary.kind !== "ok") throw new Error(ordinary.kind);
          expect(rosterLinks(ordinary.model.detailHtml.roster)).toEqual(ORDINARY_LINKS(page));
        },
      );
    });
  },
);

// Kit parity: same recipe as test/event-attendee-paging-acceptance.test.ts —
// the framework-free resolver over the real store, rendered through the
// Svelte SSR bundle. Hono a11y/visual gates do not exercise this renderer.
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitBundle() {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-attendee-current-page-"));
  try {
    const entry = join(scratch, "entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(worktree, "web/src/lib/EventDetail.svelte"))};
export function renderDetail(model) {
  const { head, body } = render(Detail, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "bundle.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
      plugins: [
        {
          name: "kit-attendee-current-page-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              const { js } = compile(source, {
                generate: "server",
                dev: false,
                filename: args.path,
              });
              return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    return (await import(pathToFileURL(outfile).href)) as {
      renderDetail: (model: Record<string, unknown>) => string;
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe.skipIf(!process.env.DATABASE_URL)(
  "Kit attendee current-page label parity (real store)",
  () => {
    let fixture: MemberDataFixture;
    let renderDetail: (model: Record<string, unknown>) => string;
    const memberSession: KitRequestSession = {
      status: "authenticated",
      session: {
        userId: MEMBER.userId,
        username: MEMBER.username,
        avatar: null,
        member: true,
        moderator: false,
      },
    };
    const outsiderSession: KitRequestSession = {
      status: "authenticated",
      session: {
        userId: OUTSIDER.userId,
        username: OUTSIDER.username,
        avatar: null,
        member: false,
        moderator: false,
      },
    };
    const guestSession: KitRequestSession = { status: "guest", session: null };
    async function renderKit(search: string, session: KitRequestSession = memberSession) {
      const store: KitEventDetailStore = {
        ...kitEventDetailStore(env),
        dbForFn: async () => fixture.db,
      };
      const outcome = await resolveKitEventDetail({
        key: EVENT_KEY,
        search,
        path: `/e/${EVENT_KEY}`,
        env,
        session,
        joinResult: null,
        setHeaders: () => {},
        store,
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") throw new Error("unreachable");
      const model = outcome.model as unknown as Record<string, unknown>;
      return { model, html: renderDetail(model) };
    }

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      ({ renderDetail } = await buildKitBundle());
    });
    beforeEach(async () => {
      await fixture.reset();
      await seed(fixture.db);
      await seedPaging(fixture.db);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await fixture?.reset();
    });
    afterAll(() => fixture?.dispose());

    it.each([
      { page: 1, search: "", prevHref: null, nextHref: pageHref(2) },
      { page: 2, search: "?attendees=2", prevHref: pageHref(1), nextHref: pageHref(3) },
      { page: 3, search: "?attendees=3", prevHref: pageHref(2), nextHref: null },
    ])("renders Page $page from the model beside the unchanged prev/next links", async (c) => {
      const { model, html } = await renderKit(c.search);
      expect(model.attendeesPaging).toMatchObject({
        page: c.page,
        prevHref: c.prevHref,
        nextHref: c.nextHref,
      });
      expect(model.goingCount).toBe(GOING_TOTAL);
      expect((model.attendees as { id: string }[]).map((a) => a.id)).toEqual(pageIds(c.page));
      expectCurrentPage(html, c.page, { prevHref: c.prevHref, nextHref: c.nextHref });
    });

    it("renders the past-end page number with the bare-URL return link", async () => {
      const { model, html } = await renderKit("?attendees=4");
      expect(model.attendeesPaging).toMatchObject({
        page: 4,
        prevHref: pageHref(1),
        nextHref: null,
      });
      expect(html).toContain("There are no more attendees on this page.");
      expect(html).not.toContain(synthName(0));
      expectCurrentPage(html, 4, { prevHref: pageHref(1), nextHref: null });
    });

    it("labels a malformed attendees value with the normalized page 1", async () => {
      const { model, html } = await renderKit("?attendees=2x");
      expect(model.attendeesPaging).toMatchObject({ page: 1 });
      expectCurrentPage(html, 1, { prevHref: null, nextHref: pageHref(2) });
    });

    it("keeps a single-page list free of pager and label (control)", async () => {
      await fixture.db.delete(rsvps);
      const [event] = await fixture.db.select().from(events);
      await fixture.db.insert(rsvps).values({
        eventId: event!.id,
        userId: synthId(0),
        status: "going",
      });
      const { model, html } = await renderKit("");
      expect(model.attendeesPaging).toMatchObject({ page: 1, prevHref: null, nextHref: null });
      expect(html).toContain("Who&#39;s going (1)");
      expectNoPager(html);
    });

    it.each([
      { role: "guest", session: guestSession },
      { role: "non-member", session: outsiderSession },
    ])(
      "$role model renders no attendee section, pager, or label (control)",
      async ({ session }) => {
        const { html } = await renderKit("?attendees=2", session);
        expect(html).not.toContain(synthName(PAGE));
        expect(html).not.toContain('data-testid="event-attendees"');
        expectNoPager(html);
      },
    );
  },
);
