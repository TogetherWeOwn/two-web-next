// route-inventory: GET /e/:key
// route-inventory: GET /events.json
// route-inventory: GET /events/:file{.+\.ics}
// route-inventory: GET /events.ics
// route-inventory: GET /events
// Fold-display remaining matrix (TOG-12679): the leftover rows of legacy
// Feature/Events/EventTimezoneDisplayTest.php that TOG-12103 and
// test/event-fold-display-agreement.test.ts do not port. A 20:00 host wall
// clock reads 20:00 on both sides of each 2026 DST boundary; the two fold
// occurrences share one visible wall text ("Sunday, 25 October 2026 at
// 01:30") while the related-event offset text, member JSON and ICS keep two
// distinct instants; a New York evening rolls to the next UTC day on every
// surface while printing the host's 15th; and an Auckland viewer still gets
// the host bucket and host chip. Display pins only — no src edits here.
// Clock-only fake (Date): full fake timers hang the postgres-js socket
// timers. Isolated test DB only.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import { users, profiles } from "../src/db/schema";
import type { Env } from "../src/env";
import type { SyncMessage } from "../src/events/sync";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "fold-display-matrix-secret-at-least-32-bytes";
// Before every seeded event, so feeds (ends_at >= now) list them all.
const NOW = new Date("2026-03-01T12:00:00.000Z");

// [label, host-visible show text, calendar chip, stored instant]. 20:00 in
// Europe/London is a different instant on each side of each boundary, but the
// page must always read 20:00.
const EVENING_MATRIX = [
  [
    "spring, GMT side",
    "Saturday, 28 March 2026 at 20:00",
    "Sat 28 Mar, 20:00",
    "2026-03-28T20:00:00.000Z",
  ],
  [
    "spring, BST side",
    "Monday, 30 March 2026 at 20:00",
    "Mon 30 Mar, 20:00",
    "2026-03-30T19:00:00.000Z",
  ],
  [
    "autumn, BST side",
    "Saturday, 24 October 2026 at 20:00",
    "Sat 24 Oct, 20:00",
    "2026-10-24T19:00:00.000Z",
  ],
  [
    "autumn, GMT side",
    "Monday, 26 October 2026 at 20:00",
    "Mon 26 Oct, 20:00",
    "2026-10-26T20:00:00.000Z",
  ],
] as const;

const FOLD_FIRST = "2026-10-25T00:30:00.000Z";
const FOLD_SECOND = "2026-10-25T01:30:00.000Z";
const FOLD_VISIBLE = "Sunday, 25 October 2026 at 01:30";

// 20:00 in New York is the next UTC day.
const NY_WALL = "Wednesday, 15 July 2026 at 20:00";
const NY_CARD = "Wed 15 Jul, 20:00";
const NY_INSTANT = "2026-07-16T00:00:00.000Z";
const NY_BUCKET = "2026-07-15";

// 26-char Crockford keys: /e/:key and /events/:key.ics 404 anything else.
const key = (n: number) => String(n).padStart(26, "0");
const plusHours = (iso: string, h: number) =>
  new Date(Date.parse(iso) + h * 3600_000).toISOString();
const icsInstant = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

describe.skipIf(!process.env.DATABASE_URL)(
  "fold-display remaining matrix (isolated test DB)",
  () => {
    let fixture: MemberDataFixture;
    let env: Env;
    // Late-bound clock: the default captures the real Date.now before the fake.
    const store = createMemorySessionStore(() => Date.now());
    const sent: SyncMessage[] = [];

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      env = {
        APP_URL,
        SESSION_SECRET,
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
        DISCORD_GUILD_ID: "326474832151838730",
        DISCORD_INVITE_URL: "https://discord.gg/invite",
        DISCORD_BOT_TOKEN: "bot-token",
        ADMIN_DB: fixture.db,
        SESSION_STORE: store,
        EVENT_SYNC_QUEUE: { send: async (message: SyncMessage) => void sent.push(message) },
        // Deterministic calendar reads: no live Discord fetch behind the grid.
        DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
      } as unknown as Env;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      await fixture.reset();
      sent.length = 0;
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function cookieFor(userId: string) {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId,
        username: userId,
        avatar: null,
        member: true,
        moderator: false,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return (
        await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    }

    const seed = (
      n: number,
      startsAt: string,
      overrides: { timezone?: string; game?: string | null } = {},
    ) =>
      fixture.db.insert(events).values({
        eventKey: key(n),
        title: "Evening games",
        game: overrides.game ?? null,
        timezone: overrides.timezone ?? "Europe/London",
        status: "published",
        startsAt: new Date(startsAt),
        endsAt: new Date(plusHours(startsAt, 2)),
      });

    const showTime = (html: string, iso: string) =>
      html.match(new RegExp(`<dd>\\s*<time datetime="${iso}">([^<]*)</time>\\s*</dd>`));

    const cellFor = (html: string, iso: string) =>
      new RegExp(`<td[^>]*data-date="${iso}"[^>]*>([\\s\\S]*?)</td>`).exec(html)?.[1];

    it.each(EVENING_MATRIX.map(([label, visible, , iso], i) => [label, visible, iso, i + 11]))(
      "20:00 %s: page, JSON and ICS agree",
      async (_, visible, iso, n) => {
        await seed(n, iso);
        const ics = icsInstant(iso);
        const icsEnd = icsInstant(plusHours(iso, 2));

        const page = await app.request(`/e/${key(n)}`, {}, env);
        expect(page.status).toBe(200);
        const html = await page.text();
        const time = showTime(html, iso);
        expect(time, "show-page <time> carries the stored instant").not.toBeNull();
        expect(time![1]).toBe(visible);
        expect(html).toContain(`dates=${ics}%2F${icsEnd}`);

        const json = await app.request(
          `/events.json?event_key=${key(n)}`,
          { headers: { cookie: await cookieFor("fold-matrix-member") } },
          env,
        );
        expect(json.status).toBe(200);
        const { data } = (await json.json()) as {
          data: { starts_at: string; ends_at: string; timezone: string }[];
        };
        expect(data).toHaveLength(1);
        expect(data[0]).toMatchObject({
          starts_at: iso,
          ends_at: plusHours(iso, 2),
          timezone: "Europe/London",
        });

        const single = await app.request(`/events/${key(n)}.ics`, {}, env);
        expect(single.status).toBe(200);
        const body = await single.text();
        expect(body).toContain(`DTSTART:${ics}\r\n`);
        expect(body).toContain(`DTEND:${icsEnd}\r\n`);
      },
    );

    it("the fold pair shares one visible wall text with distinct offset, JSON and ICS instants", async () => {
      // Same game so each show page links the other as related; the related
      // link renders fmtWithOffset, which names the GMT offset the main
      // <time> text omits.
      await seed(21, FOLD_FIRST, { game: "Helldivers 2" });
      await seed(22, FOLD_SECOND, { game: "Helldivers 2" });

      const firstHtml = await (await app.request(`/e/${key(21)}`, {}, env)).text();
      const secondHtml = await (await app.request(`/e/${key(22)}`, {}, env)).text();
      expect(showTime(firstHtml, FOLD_FIRST)?.[1]).toBe(FOLD_VISIBLE);
      expect(showTime(secondHtml, FOLD_SECOND)?.[1]).toBe(FOLD_VISIBLE);

      // The visible main texts read identically; the offset texts differ.
      expect(firstHtml).toContain(
        `<time datetime="${FOLD_SECOND}">${FOLD_VISIBLE} GMT+00:00</time>`,
      );
      expect(secondHtml).toContain(
        `<time datetime="${FOLD_FIRST}">${FOLD_VISIBLE} GMT+01:00</time>`,
      );

      const json = await app.request(
        "/events.json",
        { headers: { cookie: await cookieFor("fold-matrix-member") } },
        env,
      );
      const { data } = (await json.json()) as { data: { event_key: string; starts_at: string }[] };
      expect(Object.fromEntries(data.map((e) => [e.event_key, e.starts_at]))).toEqual({
        [key(21)]: FOLD_FIRST,
        [key(22)]: FOLD_SECOND,
      });

      const feed = await (await app.request("/events.ics", {}, env)).text();
      expect(feed).toContain(`DTSTART:${icsInstant(FOLD_FIRST)}\r\n`);
      expect(feed).toContain(`DTSTART:${icsInstant(FOLD_SECOND)}\r\n`);

      for (const [n, iso] of [
        [21, FOLD_FIRST],
        [22, FOLD_SECOND],
      ] as const) {
        const body = await (await app.request(`/events/${key(n)}.ics`, {}, env)).text();
        expect(body).toContain(`DTSTART:${icsInstant(iso)}\r\n`);
      }
    });

    it("a New York evening prints the host date while every machine surface names the UTC day", async () => {
      await seed(31, NY_INSTANT, { timezone: "America/New_York" });

      const page = await app.request(`/e/${key(31)}`, {}, env);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(showTime(html, NY_INSTANT)?.[1]).toBe(NY_WALL);
      expect(html).toContain(
        `dates=${icsInstant(NY_INSTANT)}%2F${icsInstant(plusHours(NY_INSTANT, 2))}`,
      );

      const json = await app.request(
        `/events.json?event_key=${key(31)}`,
        { headers: { cookie: await cookieFor("fold-matrix-member") } },
        env,
      );
      const { data } = (await json.json()) as {
        data: { starts_at: string; timezone: string }[];
      };
      expect(data[0]).toMatchObject({ starts_at: NY_INSTANT, timezone: "America/New_York" });

      const single = await (await app.request(`/events/${key(31)}.ics`, {}, env)).text();
      expect(single).toContain(`DTSTART:${icsInstant(NY_INSTANT)}\r\n`);
      expect(single).toContain(`DTEND:${icsInstant(plusHours(NY_INSTANT, 2))}\r\n`);

      const list = await (await app.request("/events", {}, env)).text();
      expect(list).toContain(`${NY_CARD}</time>`);
      expect(list).toContain("America/New_York");

      const grid = await (await app.request("/events?view=calendar&month=2026-07", {}, env)).text();
      expect(cellFor(grid, NY_BUCKET)).toContain(`20:00 Evening games`);
      expect(cellFor(grid, "2026-07-16")).not.toContain("Evening games");
    });

    it("an Auckland viewer still gets the host bucket and the host chip", async () => {
      await seed(41, NY_INSTANT, { timezone: "America/New_York" });
      await fixture.db.insert(users).values({ id: "auck-viewer", username: "Auck", member: true });
      await fixture.db.insert(profiles).values({
        userId: "auck-viewer",
        bio: null,
        games: [],
        timezone: "Pacific/Auckland",
      });
      // Each authenticated request mints its own token: the full-page
      // reader rotates the session (deleting the presented row), so reusing
      // one cookie across three requests would 401 the last one as a guest.
      const viewerGridCookie = await cookieFor("auck-viewer");
      const viewerListCookie = await cookieFor("auck-viewer");
      const viewerJsonCookie = await cookieFor("auck-viewer");

      // The instant is noon on the 16th in Auckland; the grid must still file
      // it on the host's 15th with the host's 20:00 chip, never a 12:00 chip.
      const grid = await (
        await app.request(
          "/events?view=calendar&month=2026-07",
          { headers: { cookie: viewerGridCookie } },
          env,
        )
      ).text();
      expect(cellFor(grid, NY_BUCKET)).toContain(`20:00 Evening games`);
      expect(cellFor(grid, "2026-07-16")).not.toContain("Evening games");
      expect(grid).not.toContain("12:00");

      const list = await (
        await app.request("/events", { headers: { cookie: viewerListCookie } }, env)
      ).text();
      const card = new RegExp(
        `<article[^>]*data-event-key="${key(41)}"[^>]*>([\\s\\S]*?)</article>`,
      ).exec(list)?.[1];
      expect(card, "calendar list renders the event card").toBeDefined();
      expect(card).toContain(NY_CARD);
      expect(card).toContain("America/New_York");
      expect(card).not.toContain("12:00");

      const json = await app.request(
        `/events.json?event_key=${key(41)}`,
        { headers: { cookie: viewerJsonCookie } },
        env,
      );
      const { data } = (await json.json()) as {
        data: { starts_at: string; timezone: string }[];
      };
      expect(data[0]).toMatchObject({ starts_at: NY_INSTANT, timezone: "America/New_York" });
    });
  },
);
