// route-inventory: GET /events
// Real SQL + real mounted Hono / Kit load/render: no replacement model/read.
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { registerEventRoutes } from "../src/events/routes";
import { loadEventsPage } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";
import {
  calendarLinks,
  gatheringKey,
  type CalendarTwin,
} from "./helpers/calendar-multiday-acceptance";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const raw = process.env.DATABASE_URL;
const url = raw ? testDatabaseUrl(raw).href : undefined;
const origin = "https://calendar.example.test";
const discord = { upcoming: async () => [], lastReadFailed: () => false };

describe.skipIf(!url)("multi-day route-to-card acceptance (disposable DB)", () => {
  let fixture: MemberDataFixture;
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(
    app,
    async () => null,
    async () => null,
  );

  beforeAll(async () => {
    fixture = await createMemberDataFixture(url!);
  });
  beforeEach(async () => {
    await fixture.reset();
    __resetAnonEventCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await fixture?.dispose();
  });

  async function request(twin: CalendarTwin, path: string, island = false) {
    const env = {
      APP_URL: origin,
      DISCORD_INVITE_URL: "https://discord.gg/fixture",
      ADMIN_DB: fixture.db,
      DISCORD_EVENTS: discord,
    } as unknown as Env;
    const requestUrl = new URL(path, origin);
    const headers: Record<string, string> = island ? { "X-Two-Island": "events-calendar" } : {};
    if (twin === "Hono") {
      const res = await app.request(requestUrl.href, { headers }, env);
      expect(res.status).toBe(200);
      return res.text();
    }
    const collected: Record<string, string> = {};
    const data = await loadEventsPage({
      env,
      url: requestUrl,
      method: "GET",
      island,
      request: new Request(requestUrl, { headers }),
      setHeaders: (values) => Object.assign(collected, values),
      deleteJoinCookie: () => {},
      dbForFn: async () => fixture.db,
      sessionForFn: async () => null,
      journeyForFn: async () => null,
      discordForFn: () => discord as never,
    });
    const res = await renderEventsHtml(data as never, collected);
    expect(res.status).toBe(200);
    return res.body;
  }

  for (const twin of ["Hono", "Kit"] as const) {
    for (const island of [false, true]) {
      it(`${twin} island=${island}: a before-grid start is discoverable and jumps to its one list card`, async () => {
        await fixture.client`insert into events (event_key, title, starts_at, ends_at, timezone, status)
          values (${gatheringKey}, 'Ongoing gathering', '2027-01-20T12:00Z', '2027-02-03T00:00Z', 'UTC', 'published')`;
        const html = await request(twin, "/events?view=calendar&month=2027-02", island);
        const links = calendarLinks(html);
        expect(links.map((link) => link.day)).toEqual(["2027-02-01", "2027-02-02"]);
        for (const link of links) {
          expect(link.text).toContain("Continues");
          const list = await request(twin, link.href, island);
          expect([...list.matchAll(/data-testid="event-card"/g)]).toHaveLength(1);
          expect([...list.matchAll(new RegExp(`id="event-${gatheringKey}"`, "g"))]).toHaveLength(1);
          expect(list).toContain(`href="/e/${gatheringKey}"`);
        }
      });

      it(`${twin} island=${island}: every continuation resolves a card beyond the first list page`, async () => {
        await fixture.client`insert into events (event_key, title, starts_at, ends_at, timezone, status)
          select 'filler-' || n, 'Earlier event', '2027-02-01T12:00Z'::timestamptz,
            '2027-02-01T14:00Z'::timestamptz, 'UTC', 'published' from generate_series(1, 20) as n`;
        await fixture.client`insert into events (event_key, title, starts_at, ends_at, timezone, status)
          values (${gatheringKey}, 'Overnight gathering', '2027-02-14T23:30Z', '2027-02-15T01:00Z', 'UTC', 'published')`;
        const grid = await request(twin, "/events?view=calendar&month=2027-02", island);
        const links = calendarLinks(grid).filter((link) => link.href.includes(gatheringKey));
        expect(links.map((link) => link.day)).toEqual(["2027-02-14", "2027-02-15"]);
        expect(new Set(links.map((link) => link.href)).size).toBe(1);
        const list = await request(twin, links[1]!.href, island);
        expect(list).toContain("Page 2 of 2.");
        expect([...list.matchAll(/data-testid="event-card"/g)]).toHaveLength(1);
        expect([...list.matchAll(new RegExp(`id="event-${gatheringKey}"`, "g"))]).toHaveLength(1);
      });
    }
  }
});
