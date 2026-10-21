// route-inventory: GET /events
// route-inventory: GET /e/:key
// Acceptance: Web series page + calendar series chip (spec TOG-35933, slice PR-C).
//
// Written FIRST: RED on arrival (no /events/:key/series route, no chip markup
// anywhere). The paired builder implements on this branch and must NOT edit
// this file. Live suite on the owned disposable-Postgres fixture, skipped
// without DATABASE_URL like test/event-series-window-acceptance.test.ts — the
// series page's SQL shapes do not exist yet, so no pg-proxy fake could answer
// them; the live schema answers whatever the builder writes.
//
// Contract pinned here (card: chip "<Frequency> - N of M" + series link on
// calendar + detail; series page with instances, seats-left, working
// per-instance RSVP + Follow; archived read-only with "This series has
// ended", Follow hidden, history visible). New-hook contract, string literals
// on purpose — the markup does not exist yet:
//   series-chip            anchor; text "Weekly - N of M" ("-" per card, the
//                          middle dot per spec also accepted); href ends with
//                          /events/<parentKey>/series
//   series-page            series page root marker
//   series-instance-row    per-instance row, data-event-key="<key>"
//   series-seats-left      "<N> seats left" within a row (card's own term)
//   series-follow          native POST follow form (member, live series)
//   series-unfollow        native POST unfollow form (member, following)
//   series-ended-banner    archived banner containing "This series has ended"
//   series-edit-link       moderator anchor to /admin/events/<parentKey>
//
// Deliberate scope notes for the builder:
// - Weekly only. Monthly chips ride the same code path once the monthly rule
//   lands; no monthly rows here so this file greens without that slice.
// - The follow round-trip needs the follow slice merged first — the build
//   card records that dependency. Follow/unfollow form actions are discovered
//   from the rendered page, so this file adapts to that slice's route choice;
//   the teeth are DB rows + control flips, not response copy.
// - No end-series link pin: ending a series is slice PR-D.
// - The builder adds `// route-inventory: GET /events/:key/series` plus the
//   fixture + docs/url-freeze.md rows together with the route (a pre-landing
//   comment would trip the stale-reference guard).
// - Kit: calendar chip parity via loadEventsPage/renderEventsHtml is pinned
//   (same cheap harness as the multiday suites). Kit detail/series surfaces
//   stay with the builder + the kit-parity gates.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { occurrences } from "../src/admin/recurrence";
import { events, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import type { DiscordEventsSource } from "../src/events/discord-transients";
import { loadEventsPage } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env as baseEnv, MEMBER, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// Globally allowlisted synthetic ULIDs (.gitleaks.toml); the fixture resets
// between tests, so every seed reuses this pool.
const PARENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const CHILD2_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
const CHILD3_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAC";
const CHILD4_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAD";
const UNKNOWN_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const SERIES_PATH = `/events/${PARENT_KEY}/series`;
const LOGIN_CTA = `/join/discord?next=${encodeURIComponent(SERIES_PATH)}`;

const discord: DiscordEventsSource = {
  upcoming: async () => [],
  lastReadFailed: () => false,
};

const chipText = (n: number, m: number) =>
  new RegExp(`Weekly\\s*(?:·|&middot;|&#0?183;|-)\\s*${n} of ${m}`);

function chipAnchors(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*data-testid="series-chip"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = /href="([^"]+)"/.exec(m[0])?.[1] ?? "";
    out.push({ href: href.replaceAll("&amp;", "&"), text: (m[1] ?? "").trim() });
  }
  return out;
}

function formByTestid(
  html: string,
  testid: string,
): { action: string; method: string; inner: string } | null {
  const m = new RegExp(`<form\\b[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</form>`).exec(html);
  if (!m) return null;
  const tag = m[0];
  return {
    action: (/action="([^"]+)"/.exec(tag)?.[1] ?? "").replaceAll("&amp;", "&"),
    method: (/method="([^"]+)"/.exec(tag)?.[1] ?? "").toLowerCase(),
    inner: m[1] ?? "",
  };
}

function instanceRows(html: string): { key: string; html: string }[] {
  const starts = [
    ...html.matchAll(/<[a-z][a-z0-9]*\b[^>]*data-testid="series-instance-row"[^>]*>/gi),
  ];
  return starts.map((s, i) => {
    const tag = s[0];
    const begin = (s.index ?? 0) + tag.length;
    const end = i + 1 < starts.length ? (starts[i + 1]!.index ?? html.length) : html.length;
    return {
      key: /data-event-key="([^"]+)"/.exec(tag)?.[1] ?? "",
      html: html.slice(begin, end),
    };
  });
}

function hiddenFields(formInner: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of formInner.matchAll(/<input\b[^>]*>/gi)) {
    if (!/type="hidden"/.test(m[0])) continue;
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    if (name) out[name] = (/value="([^"]*)"/.exec(m[0])?.[1] ?? "").replaceAll("&amp;", "&");
  }
  return out;
}

type SeriesSeed = {
  parent: typeof events.$inferSelect;
  child2: typeof events.$inferSelect;
  child3: typeof events.$inferSelect;
  child4: typeof events.$inferSelect;
};

describe.skipIf(!process.env.DATABASE_URL)(
  "web series page + calendar series chip acceptance (live)",
  () => {
    let fixture: MemberDataFixture;
    let sessions = createMemorySessionStore();

    const request = (path: string, init: RequestInit = {}) =>
      app.request(path, init, {
        ...baseEnv,
        ADMIN_DB: fixture.db,
        SESSION_STORE: sessions,
        DISCORD_EVENTS: discord,
        SYNC_EVENT_QUEUE: { send: async () => {} },
      } as unknown as Env);
    const memberHeaders = async () => ({ cookie: await cookieFor(sessions, MEMBER) });
    const moderatorHeaders = async () => ({ cookie: await cookieFor(sessions, MODERATOR) });
    const answersFor = async (userId: string) =>
      (await fixture.db.select().from(rsvps)).filter((r) => r.userId === userId);

    async function kitCalendar(month: string): Promise<string> {
      const requestUrl = new URL(`/events?view=calendar&month=${month}`, baseEnv.APP_URL);
      const collected: Record<string, string> = {};
      const data = await loadEventsPage({
        env: { ...baseEnv, ADMIN_DB: fixture.db, DISCORD_EVENTS: discord } as unknown as Env,
        url: requestUrl,
        method: "GET",
        island: false,
        request: new Request(requestUrl),
        setHeaders: (values) => Object.assign(collected, values),
        deleteJoinCookie: () => {},
        dbForFn: async () => fixture.db,
        sessionForFn: async () => null,
        journeyForFn: async () => null,
        discordForFn: () => discord as never,
      });
      const rendered = await renderEventsHtml(data as never, collected);
      expect(rendered.status).toBe(200);
      return rendered.body;
    }

    async function seedMainSeries(db: Db): Promise<SeriesSeed> {
      const [parent] = await db
        .insert(events)
        .values({
          eventKey: PARENT_KEY,
          title: "Wednesday game night",
          description: "Boards out every Wednesday series-blurb-7f3a",
          status: "published",
          startsAt: new Date("2099-11-04T20:00:00Z"),
          endsAt: new Date("2099-11-04T22:00:00Z"),
          timezone: "Europe/London",
          recurrenceFrequency: "weekly",
          recurrenceCount: 12,
          recurrenceIndex: 1,
        })
        .returning();
      const defs = [
        {
          eventKey: CHILD2_KEY,
          index: 2,
          startsAt: new Date("2099-11-11T20:00:00Z"),
          capacity: 10,
          status: "published",
          title: "Wednesday game night",
        },
        {
          eventKey: CHILD3_KEY,
          index: 3,
          startsAt: new Date("2099-11-18T20:00:00Z"),
          capacity: 1,
          status: "published",
          title: "Wednesday game night",
        },
        {
          eventKey: CHILD4_KEY,
          index: 4,
          startsAt: new Date("2099-11-25T20:00:00Z"),
          capacity: 8,
          status: "draft",
          title: "Draft week game night",
        },
      ];
      const rows = [];
      for (const def of defs) {
        const [row] = await db
          .insert(events)
          .values({
            eventKey: def.eventKey,
            title: def.title,
            status: def.status,
            startsAt: def.startsAt,
            endsAt: new Date(def.startsAt.getTime() + 7200_000),
            timezone: "Europe/London",
            capacity: def.capacity,
            parentEventId: parent!.id,
            recurrenceIndex: def.index,
          })
          .returning();
        rows.push(row!);
      }
      const [child2, child3, child4] = rows as [typeof parent, typeof parent, typeof parent];
      await db.insert(rsvps).values([
        { eventId: child2!.id, userId: "400000000000000901", status: "going" },
        { eventId: child2!.id, userId: "400000000000000902", status: "going" },
        { eventId: child2!.id, userId: "400000000000000903", status: "going" },
        { eventId: child3!.id, userId: "400000000000000911", status: "going" },
      ]);
      return { parent: parent!, child2: child2!, child3: child3!, child4: child4! };
    }

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      sessions = createMemorySessionStore();
      __resetAnonEventCacheForTests();
    });
    afterAll(() => fixture?.dispose());

    describe("series chip (Hono)", () => {
      it("calendar list chips every published member with rule-count M and the series link", async () => {
        await seedMainSeries(fixture.db);
        const res = await request("/events");
        expect(res.status).toBe(200);
        const chips = chipAnchors(await res.text());
        const texts = chips.map((c) => c.text);
        expect(texts.filter((t) => chipText(1, 12).test(t))).toHaveLength(1);
        expect(texts.filter((t) => chipText(2, 12).test(t))).toHaveLength(1);
        expect(texts.filter((t) => chipText(3, 12).test(t))).toHaveLength(1);
        for (const chip of chips) expect(chip.href.endsWith(SERIES_PATH)).toBe(true);
      });

      it("month grid chips in-month members", async () => {
        await seedMainSeries(fixture.db);
        const res = await request("/events?view=calendar&month=2099-11");
        expect(res.status).toBe(200);
        const chips = chipAnchors(await res.text());
        expect(chips.some((c) => chipText(3, 12).test(c.text))).toBe(true);
        for (const chip of chips) expect(chip.href.endsWith(SERIES_PATH)).toBe(true);
      });

      it("detail pages chip the instance and the parent", async () => {
        await seedMainSeries(fixture.db);
        const child = await request(`/e/${CHILD3_KEY}`);
        expect(child.status).toBe(200);
        const childChips = chipAnchors(await child.text());
        expect(childChips.some((c) => chipText(3, 12).test(c.text))).toBe(true);
        for (const chip of childChips) expect(chip.href.endsWith(SERIES_PATH)).toBe(true);
        const parent = await request(`/e/${PARENT_KEY}`);
        expect(parent.status).toBe(200);
        const parentChips = chipAnchors(await parent.text());
        expect(parentChips.some((c) => chipText(1, 12).test(c.text))).toBe(true);
        for (const chip of parentChips) expect(chip.href.endsWith(SERIES_PATH)).toBe(true);
      });

      it("M comes from the ends-on rule, not materialized rows", async () => {
        const endsOn = new Date("2099-11-30T00:00:00Z");
        const [parent] = await fixture.db
          .insert(events)
          .values({
            eventKey: PARENT_KEY,
            title: "Wednesday game night",
            status: "published",
            startsAt: new Date("2099-11-04T20:00:00Z"),
            endsAt: new Date("2099-11-04T22:00:00Z"),
            timezone: "Europe/London",
            recurrenceFrequency: "weekly",
            recurrenceCount: null,
            recurrenceEndsOn: endsOn,
            recurrenceIndex: 1,
          })
          .returning();
        await fixture.db.insert(events).values({
          eventKey: CHILD2_KEY,
          title: "Wednesday game night",
          status: "published",
          startsAt: new Date("2099-11-11T20:00:00Z"),
          endsAt: new Date("2099-11-11T22:00:00Z"),
          timezone: "Europe/London",
          parentEventId: parent!.id,
          recurrenceIndex: 2,
        });
        // Nov 4/11/18/25: two rows materialized, four occurrences named.
        const total = occurrences(
          parent!.startsAt,
          parent!.endsAt,
          "Europe/London",
          "weekly",
          null,
          endsOn,
        ).size;
        expect(total).toBe(4);
        const res = await request(`/e/${CHILD2_KEY}`);
        expect(res.status).toBe(200);
        const chips = chipAnchors(await res.text());
        expect(chips.some((c) => chipText(2, total).test(c.text))).toBe(true);
        for (const chip of chips) expect(chip.href.endsWith(SERIES_PATH)).toBe(true);
      });

      it("CONTROL: an ordinary event renders no chip on detail or calendar", async () => {
        await fixture.db.insert(events).values({
          eventKey: PARENT_KEY,
          title: "One-off game night",
          status: "published",
          startsAt: new Date("2099-11-04T20:00:00Z"),
          endsAt: new Date("2099-11-04T22:00:00Z"),
          timezone: "Europe/London",
        });
        const detail = await request(`/e/${PARENT_KEY}`);
        expect(detail.status).toBe(200);
        const detailHtml = await detail.text();
        expect(detailHtml).not.toContain('data-testid="series-chip"');
        const calendar = await request("/events");
        expect(calendar.status).toBe(200);
        const calendarHtml = await calendar.text();
        expect(calendarHtml).not.toContain('data-testid="series-chip"');
        expect(calendarHtml).not.toMatch(/\/events\/[0-9A-Z]+\/series/);
      });

      it("CONTROL: an unknown series key 404s", async () => {
        const res = await request(`/events/${UNKNOWN_KEY}/series`);
        expect(res.status).toBe(404);
      });
    });

    describe("series chip (Kit calendar parity)", () => {
      it("the Kit month render chips members with the same hook and link", async () => {
        await seedMainSeries(fixture.db);
        const body = await kitCalendar("2099-11");
        const chips = chipAnchors(body);
        expect(chips.some((c) => chipText(3, 12).test(c.text))).toBe(true);
        for (const chip of chips) expect(chip.href.endsWith(SERIES_PATH)).toBe(true);
      });
    });

    describe("series page", () => {
      it("lists instances with seats-left; members see no drafts or edit link", async () => {
        await seedMainSeries(fixture.db);
        const res = await request(SERIES_PATH, { headers: await memberHeaders() });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('data-testid="series-page"');
        expect(html).toContain("Wednesday game night");
        expect(html).toContain("series-blurb-7f3a");
        const rows = instanceRows(html);
        expect(rows.map((r) => r.key)).toEqual(expect.arrayContaining([CHILD2_KEY, CHILD3_KEY]));
        const child2 = rows.find((r) => r.key === CHILD2_KEY)!;
        expect(child2.html).toMatch(/\b7 seats left\b/);
        const child3 = rows.find((r) => r.key === CHILD3_KEY)!;
        expect(child3.html).toContain('value="waitlisted"');
        expect(html).not.toContain(CHILD4_KEY);
        expect(html).not.toContain("Draft week game night");
        expect(html).not.toContain('data-testid="series-edit-link"');
      });

      it("moderators see draft instances and the series edit link", async () => {
        await seedMainSeries(fixture.db);
        const res = await request(SERIES_PATH, { headers: await moderatorHeaders() });
        expect(res.status).toBe(200);
        const html = await res.text();
        const draft = instanceRows(html).find((r) => r.key === CHILD4_KEY);
        expect(draft).toBeDefined();
        expect(draft!.html).toMatch(/draft/i);
        const edit = new RegExp(`<a\\b[^>]*data-testid="series-edit-link"[^>]*>`).exec(html)?.[0];
        expect(edit).toBeDefined();
        expect(/href="([^"]+)"/.exec(edit!)?.[1]).toBe(`/admin/events/${PARENT_KEY}`);
      });

      it("per-instance RSVP posts natively from the row and sticks", async () => {
        const seed = await seedMainSeries(fixture.db);
        const before = await request(SERIES_PATH, { headers: await memberHeaders() });
        expect(before.status).toBe(200);
        const row = instanceRows(await before.text()).find((r) => r.key === CHILD2_KEY)!;
        expect(row.html).toContain('value="going"');
        const tags = [...row.html.matchAll(/<form\b[^>]*>/gi)].map((m) => m[0]);
        const rsvpForm = tags.find((t) => t.includes("/rsvp"));
        expect(rsvpForm).toBeDefined();
        expect(rsvpForm!).toMatch(/method="post"/i);
        const action = /action="([^"]+)"/.exec(rsvpForm!)?.[1]!.replaceAll("&amp;", "&")!;
        expect(action).toContain(`/e/${CHILD2_KEY}/rsvp`);
        const post = await request(action, {
          method: "POST",
          headers: {
            ...(await memberHeaders()),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ status: "going" }),
        });
        expect(post.status).toBe(303);
        const after = await request(SERIES_PATH, { headers: await memberHeaders() });
        expect(after.status).toBe(200);
        const next = instanceRows(await after.text()).find((r) => r.key === CHILD2_KEY)!;
        expect(next.html).toContain('value="withdraw"');
        expect(next.html).toMatch(/\b6 seats left\b/);
        const stored = await answersFor(MEMBER.userId);
        expect(stored.find((r) => r.eventId === seed.child2.id)?.status).toBe("going");
      });

      it("guests get a sign-in CTA, not a follow form", async () => {
        await seedMainSeries(fixture.db);
        const res = await request(SERIES_PATH);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).not.toContain('data-testid="series-follow"');
        expect(html).toContain(`href="${LOGIN_CTA}"`);
      });

      it("follow seats upcoming instances; unfollow keeps the answers", async () => {
        const seed = await seedMainSeries(fixture.db);
        const page = await request(SERIES_PATH, { headers: await memberHeaders() });
        expect(page.status).toBe(200);
        const follow = formByTestid(await page.text(), "series-follow");
        expect(follow).not.toBeNull();
        expect(follow!.method).toBe("post");
        const followed = await request(follow!.action, {
          method: "POST",
          headers: {
            ...(await memberHeaders()),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(hiddenFields(follow!.inner)),
        });
        expect([200, 201, 302, 303]).toContain(followed.status);
        if (followed.status === 200) expect(await followed.text()).toMatch(/follow/i);
        const seated = await answersFor(MEMBER.userId);
        expect(seated.find((r) => r.eventId === seed.child2.id)?.status).toBe("going");
        expect(seated.find((r) => r.eventId === seed.child3.id)?.status).toBe("waitlisted");
        const following = await request(SERIES_PATH, { headers: await memberHeaders() });
        const followingHtml = await following.text();
        expect(followingHtml).not.toContain('data-testid="series-follow"');
        const unfollow = formByTestid(followingHtml, "series-unfollow");
        expect(unfollow).not.toBeNull();
        expect(unfollow!.method).toBe("post");
        const left = await request(unfollow!.action, {
          method: "POST",
          headers: {
            ...(await memberHeaders()),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(hiddenFields(unfollow!.inner)),
        });
        expect([200, 201, 204, 302, 303]).toContain(left.status);
        const kept = await answersFor(MEMBER.userId);
        expect(kept.find((r) => r.eventId === seed.child2.id)?.status).toBe("going");
        expect(kept.find((r) => r.eventId === seed.child3.id)?.status).toBe("waitlisted");
        const again = await request(SERIES_PATH, { headers: await memberHeaders() });
        expect(await again.text()).toContain('data-testid="series-follow"');
      });
    });

    describe("archived series", () => {
      async function seedArchived(db: Db) {
        const [parent] = await db
          .insert(events)
          .values({
            eventKey: PARENT_KEY,
            title: "Wednesday game night",
            status: "past",
            startsAt: new Date("2020-11-04T20:00:00Z"),
            endsAt: new Date("2020-11-04T22:00:00Z"),
            timezone: "Europe/London",
            recurrenceFrequency: "weekly",
            recurrenceCount: 12,
            recurrenceIndex: 1,
          })
          .returning();
        const [child2] = await db
          .insert(events)
          .values({
            eventKey: CHILD2_KEY,
            title: "Past game night",
            status: "past",
            startsAt: new Date("2020-11-11T20:00:00Z"),
            endsAt: new Date("2020-11-11T22:00:00Z"),
            timezone: "Europe/London",
            parentEventId: parent!.id,
            recurrenceIndex: 2,
          })
          .returning();
        const [child3] = await db
          .insert(events)
          .values({
            eventKey: CHILD3_KEY,
            title: "Cancelled game night",
            status: "cancelled",
            startsAt: new Date("2020-11-18T20:00:00Z"),
            endsAt: new Date("2020-11-18T22:00:00Z"),
            timezone: "Europe/London",
            parentEventId: parent!.id,
            recurrenceIndex: 3,
          })
          .returning();
        await db
          .insert(rsvps)
          .values({ eventId: child2!.id, userId: MEMBER.userId, status: "going" });
        return { parent: parent!, child2: child2!, child3: child3! };
      }

      it("ended series is read-only with a banner, Follow hidden, history visible", async () => {
        const seed = await seedArchived(fixture.db);
        const res = await request(SERIES_PATH, { headers: await memberHeaders() });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('data-testid="series-ended-banner"');
        expect(html).toContain("This series has ended");
        expect(html).not.toContain('data-testid="series-follow"');
        expect(html).not.toContain('data-testid="series-unfollow"');
        expect(html).toContain("Past game night");
        expect(html).toContain("Cancelled game night");
        expect(html).not.toContain('name="status"');
        const kept = await answersFor(MEMBER.userId);
        expect(kept.find((r) => r.eventId === seed.child2.id)?.status).toBe("going");
      });

      it("a series with an upcoming instance is not archived", async () => {
        const [parent] = await fixture.db
          .insert(events)
          .values({
            eventKey: PARENT_KEY,
            title: "Wednesday game night",
            status: "past",
            startsAt: new Date("2020-11-04T20:00:00Z"),
            endsAt: new Date("2020-11-04T22:00:00Z"),
            timezone: "Europe/London",
            recurrenceFrequency: "weekly",
            recurrenceCount: 12,
            recurrenceIndex: 1,
          })
          .returning();
        await fixture.db.insert(events).values({
          eventKey: CHILD2_KEY,
          title: "Past game night",
          status: "past",
          startsAt: new Date("2020-11-11T20:00:00Z"),
          endsAt: new Date("2020-11-11T22:00:00Z"),
          timezone: "Europe/London",
          parentEventId: parent!.id,
          recurrenceIndex: 2,
        });
        await fixture.db.insert(events).values({
          eventKey: CHILD3_KEY,
          title: "Wednesday game night",
          status: "published",
          startsAt: new Date("2099-11-18T20:00:00Z"),
          endsAt: new Date("2099-11-18T22:00:00Z"),
          timezone: "Europe/London",
          capacity: 10,
          parentEventId: parent!.id,
          recurrenceIndex: 3,
        });
        const res = await request(SERIES_PATH, { headers: await memberHeaders() });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).not.toContain('data-testid="series-ended-banner"');
        expect(html).not.toContain("This series has ended");
        expect(html).toContain('data-testid="series-follow"');
      });
    });
  },
);
