// Independent acceptance: UTC start-date windows, not event overlap or local dates.
// Owned tests: the implementation handoff must preserve this file unchanged.
// Use an explicit approved disposable DATABASE_URL or the offline SQL backend.
import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { memberDataAccessLogs } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { compilePlanningWindowKit } from "./helpers/admin-event-planning-window";
import {
  createPlanningWindowFixture,
  type PlanningWindowFixture,
} from "./helpers/admin-event-planning-window-db";
import {
  compileAdminRetryKit,
  retryAnchors,
  retryPage,
  type AdminRetryKit,
} from "./helpers/admin-read-retry-acceptance";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};
const viewer = "100000000000000111";
const windowQuery = "starts_from=2032-02-29&starts_before=2032-03-02";
const keys = (html: string) =>
  [...html.matchAll(/data-testid="event-status-([^"]+)"/g)].map((match) => match[1]);
const text = (html: string) => html.replace(/<[^>]*>/g, " ");
const links = (html: string) =>
  [...html.matchAll(/<a\b([^>]+)>[\s\S]*?<\/a>/g)].map(([tag, attrs]) => ({
    tag,
    attrs: attrs!,
    url: new URL(attrs!.match(/href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&") || "/", env.APP_URL),
  }));

// Literal dates include a leap-day lower boundary and microsecond upper neighbor.
const edgeRows = [
  ["before", "2032-02-28T23:59:59.999999Z"],
  ["lower", "2032-02-29T00:00:00.000000Z"],
  ["inside", "2032-03-01T00:30:00.000000Z"],
  ["last", "2032-03-01T23:59:59.999999Z"],
  ["upper", "2032-03-02T00:00:00.000000Z"],
  ["after", "2032-03-02T00:00:00.000001Z"],
] as const;

export const invalidPlanningQueries = [
  "starts_from=2031-02-29",
  "starts_before=2032-02-30",
  "starts_from=2032-04-31",
  "starts_from=1900-02-29",
  "starts_before=2032-01-00",
  "starts_before=2032-01-32",
  "starts_before=2032-03-02&starts_before=2032-03-03",
  "starts_from=2032-02-29&starts_from=2032-02-29",
  "starts_from=2032-13-01",
  "starts_before=2032-00-01",
  "starts_from=0000-01-01",
  "starts_before=10000-01-01",
  "starts_from=2032-2-9",
  "starts_from=2032-02-29T00%3A00%3A00Z",
  "starts_from=2032-03-02&starts_before=2032-02-29",
  "starts_from=2032-02-29&starts_before=2032-02-29",
  "starts_from=2032-02-29&starts_from=2032-03-01",
  "starts_before=2032-03-02&starts_before=2032-03-02",
  "starts_from=&starts_from=2032-02-29",
  `starts_from=${"2".repeat(300)}`,
  "starts_from=%3Cscript%3Ewindow.dateLeak%3D1%3C%2Fscript%3E",
];

describe.each(["Hono", "Kit"] as const)(
  "%s admin events UTC planning window (real classified reads)",
  (twin) => {
    let fixture: PlanningWindowFixture;
    let kit: Awaited<ReturnType<typeof compilePlanningWindowKit>>;
    let adminRetry: AdminRetryKit;
    const store = createMemorySessionStore();
    let cookie: string;
    const queries: { sql: string; params: unknown[] }[] = [];
    const app = () => adminApp({ sessionStore: store, db: fixture.db });
    const request = (query = "", sessionCookie = cookie) => {
      const bindings = { ...env, ADMIN_DB: fixture.db } as Env;
      if (twin === "Kit")
        return kit.request({
          env: bindings,
          path: `/admin/events${query ? `?${query}` : ""}`,
          actor: sessionCookie ? (sessionCookie === cookie ? "moderator" : "member") : "guest",
        });
      return app().request(
        `/events${query ? `?${query}` : ""}`,
        { headers: sessionCookie ? { cookie: sessionCookie } : {} },
        bindings,
      );
    };

    async function session(moderator: boolean) {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: viewer,
        username: "Fixture moderator",
        avatar: null,
        member: true,
        moderator,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return (
        await serializeSigned("__Host-two_session", token, env.SESSION_SECRET!, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    }

    beforeAll(async () => {
      if (twin === "Kit") kit = await compilePlanningWindowKit();
      if (twin === "Kit") adminRetry = await compileAdminRetryKit();
      fixture = await createPlanningWindowFixture(queries);
    });
    afterAll(async () => fixture?.dispose());
    beforeEach(async () => {
      await fixture.reset();
      cookie = await session(true);
      for (const [key, instant] of edgeRows) {
        const row = await fixture.insertEvent({
          eventKey: `window-${key}`,
          title: `Planning ${key}`,
          status: "published",
          startsAt: new Date(instant),
          endsAt: new Date("2032-03-03T12:00:00Z"),
          timezone: "America/Los_Angeles",
          capacity: 2,
          rsvpOpen: false,
        });
        // Date cannot express microseconds; retain them in either SQL backend.
        await fixture.setStartInstant(row.id, instant);
      }
      queries.length = 0;
    });

    it("RED includes exact lower midnight, excludes upper midnight and its microsecond neighbor", async () => {
      const response = await request(`${windowQuery}&sort=starts_at&order=asc`);
      expect(response.status).toBe(200);
      expect(keys(await response.text())).toEqual(["window-lower", "window-inside", "window-last"]);
    });

    it.each([
      ["starts_from=2032-03-02", ["window-upper", "window-after"]],
      ["starts_before=2032-02-29", ["window-before"]],
      ["starts_from=2032-02-29&starts_before=2032-03-01", ["window-lower"]],
    ])("RED supports one-sided and leap-day window %s", async (query, expected) => {
      const response = await request(`${query}&sort=starts_at&order=asc`);
      expect(response.status).toBe(200);
      expect(keys(await response.text())).toEqual(expected);
    });

    it.each([
      ["title", "asc", ["window-inside", "window-last", "window-lower"]],
      ["title", "desc", ["window-lower", "window-last", "window-inside"]],
      ["status", "asc", ["window-lower", "window-inside", "window-last"]],
      ["status", "desc", ["window-lower", "window-inside", "window-last"]],
      ["starts_at", "desc", ["window-last", "window-inside", "window-lower"]],
    ])(
      "RED bounded rows retain %s %s ordering and stable id ties",
      async (sort, order, expected) => {
        const response = await request(`${windowQuery}&sort=${sort}&order=${order}`);
        expect(response.status).toBe(200);
        expect(keys(await response.text())).toEqual(expected);
      },
    );

    it.each(invalidPlanningQueries)(
      "RED safely explains invalid date request %s",
      async (query) => {
        const response = await request(query);
        expect([200, 400, 422]).toContain(response.status);
        const html = await response.text();
        const feedback = html.match(
          /<(?:div|section|p)[^>]*(?:role="alert"|class="[^"]*error-summary|aria-live="polite")[^>]*>([\s\S]*?)<\/(?:div|section|p)>/,
        )?.[1];
        expect(feedback, "missing explicit invalid-date feedback").toBeDefined();
        expect(text(feedback!)).toMatch(/date|start|window|interval/i);
        expect(feedback && text(feedback)).toMatch(
          /invalid|valid|before|after|once|duplicate|correct|check/i,
        );
        expect(html).not.toContain("<script>window.dateLeak");
        // A refused view may be empty, or explicitly disclose an unrestricted
        // fallback; it must never silently present all rows as interval matches.
        if (keys(html).length)
          expect(feedback && text(feedback)).toMatch(
            /not applied|not filtered|unrestricted|all events|ignored/i,
          );
      },
    );

    it("RED native GET form labels both UTC dates, resets paging, and describes the active interval", async () => {
      const response = await request(`${windowQuery}&page=2`);
      const html = await response.text();
      const form = html.match(/<form[^>]*method="[Gg][Ee][Tt]"[^>]*>([\s\S]*?)<\/form>/)?.[1];
      for (const [name, value] of [
        ["starts_from", "2032-02-29"],
        ["starts_before", "2032-03-02"],
      ]) {
        const input = form?.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
        expect(input, `missing native ${name} date control`).toBeDefined();
        expect(input).toContain('type="date"');
        expect(input).toContain(`value="${value}"`);
      }
      expect(form).not.toMatch(/name="page"/);
      expect(text(html)).toMatch(
        /2032-02-29[\s\S]*2032-03-02[\s\S]*UTC|UTC[\s\S]*2032-02-29[\s\S]*2032-03-02/,
      );
      expect(text(html)).toMatch(/inclusive|including|at or after|\[/i);
      expect(text(html)).toMatch(/exclusive|excluding|before|\)/i);
    });

    it.each([
      {
        bound: "starts_from=2032-02-29",
        absent: "starts_before",
        summary: "Showing events that start at or after 2032-02-29 00:00 UTC (included).",
      },
      {
        bound: "starts_before=2032-03-02",
        absent: "starts_from",
        summary: "Showing events that start before 2032-03-02 00:00 UTC (excluded).",
      },
    ])(
      "one-sided $bound pins summaries and complete navigation hrefs",
      async ({ bound, absent, summary }) => {
        for (let i = 0; i < 53; i++)
          await fixture.insertEvent({
            eventKey: `navigation-${i}`,
            title: "Navigation fixture",
            status: "published",
            startsAt: new Date("2032-03-01T12:00:00Z"),
            endsAt: new Date("2032-03-01T13:00:00Z"),
          });
        const query = `q=Navigation+fixture&${bound}&sort=title&order=asc`;
        const html = await (await request(`${query}&page=2`)).text();
        expect(keys(html)).toEqual(Array.from({ length: 25 }, (_, i) => `navigation-${i + 25}`));
        const active = text(html)
          .replace(/\s+/g, " ")
          .match(/Showing events that start[^.]*\./)?.[0];
        expect(active).toBe(summary);
        expect(active).not.toContain(absent === "starts_from" ? "at or after" : "before");
        const absentInput = html.match(new RegExp(`<input[^>]*name="${absent}"[^>]*>`))?.[0];
        expect(absentInput).toContain('value=""');
        function href(
          markup: string,
          matches: (anchor: ReturnType<typeof links>[number]) => boolean,
          expected: string,
        ) {
          const anchor = links(markup).find(matches);
          expect(anchor, `missing ${expected}`).toBeDefined();
          expect(anchor!.url.href).toBe(new URL(expected, env.APP_URL).href);
          expect(anchor!.url.searchParams.has(absent)).toBe(false);
          return anchor!.url;
        }
        href(
          html,
          ({ attrs }) => attrs.includes('aria-label="Sort by title descending"'),
          `/admin/events?q=Navigation+fixture&${bound}&sort=title&order=desc`,
        );
        href(
          html,
          ({ attrs }) => attrs.includes('aria-label="Sort by status ascending"'),
          `/admin/events?q=Navigation+fixture&${bound}&sort=status&order=asc`,
        );
        href(
          html,
          ({ attrs }) => attrs.includes('aria-label="Sort by starts (utc) ascending"'),
          `/admin/events?q=Navigation+fixture&${bound}&sort=starts_at&order=asc`,
        );
        href(html, ({ attrs }) => attrs.includes('rel="prev"'), `/admin/events?${query}`);
        const next = href(
          html,
          ({ attrs }) => attrs.includes('rel="next"'),
          `/admin/events?${query}&page=3`,
        );
        expect(keys(await (await request(next.search.slice(1))).text())).toEqual([
          "navigation-50",
          "navigation-51",
          "navigation-52",
        ]);
        const pastEnd = await (await request(`${query}&page=99`)).text();
        expect(keys(pastEnd)).toEqual([]);
        const first = href(
          pastEnd,
          ({ tag }) => /first page of these results/i.test(text(tag)),
          `/admin/events?${query}`,
        );
        expect(keys(await (await request(first.search.slice(1))).text())).toHaveLength(25);
        href(
          pastEnd,
          ({ tag }) => /clear filters/i.test(text(tag)),
          "/admin/events?sort=title&order=asc",
        );
        if (twin === "Kit") {
          const { body } = adminRetry.render(
            "admin",
            retryPage(503, `/admin/events?${query}&page=2`, "/admin/events"),
          );
          const retries = await retryAnchors(body);
          expect(retries).toHaveLength(1);
          expect(retries[0]!.href).toBe(`/admin/events?${query}&page=2`);
          expect(new URL(retries[0]!.href, env.APP_URL).searchParams.has(absent)).toBe(false);
        }
      },
    );

    it.each([
      ["parent", "1", "selection-parent-open"],
      ["parent", "0", "selection-parent-paused"],
      ["child", "1", "selection-child-open"],
      ["child", "0", "selection-child-paused"],
      ["standalone", "1", "selection-standalone-open"],
      ["standalone", "0", "selection-standalone-paused"],
    ])(
      "dated series=%s AND rsvp_open=%s excludes in-window distractors",
      async (series, rsvpOpen, wanted) => {
        for (const open of [true, false]) {
          const suffix = open ? "open" : "paused";
          const base = {
            title: "Combined selector fixture",
            status: "published" as const,
            capacity: 1,
            rsvpOpen: open,
            startsAt: new Date("2032-03-01T12:00:00Z"),
            endsAt: new Date("2032-03-01T13:00:00Z"),
          };
          const parent = await fixture.insertEvent({
            ...base,
            eventKey: `selection-parent-${suffix}`,
            recurrenceFrequency: "weekly",
          });
          const child = await fixture.insertEvent({
            ...base,
            eventKey: `selection-child-${suffix}`,
            parentEventId: parent.id,
          });
          const standalone = await fixture.insertEvent({
            ...base,
            eventKey: `selection-standalone-${suffix}`,
          });
          for (const row of [parent, child, standalone])
            await fixture.insertRsvp({ eventId: row.id, userId: viewer, status: "going" });
        }
        const filters = `q=Combined+selector+fixture&status=published&series=${series}&fill=full&rsvp_open=${rsvpOpen}&sort=starts_at&order=asc`;
        for (const dates of [
          "",
          `${windowQuery}&`,
          "starts_from=2032-02-29&",
          "starts_before=2032-03-02&",
        ]) {
          const response = await request(`${dates}${filters}`);
          expect(response.status).toBe(200);
          expect(
            keys(await response.text()),
            `selection with ${dates || "no date window"}`,
          ).toEqual([wanted]);
        }
      },
    );

    it("RED filters before paging, combines existing predicates and retains every bound on sort and pager", async () => {
      for (let i = 0; i < 28; i++) {
        const row = await fixture.insertEvent({
          eventKey: `window-page-${i}`,
          title: "Paging planning fixture",
          status: "published",
          capacity: 1,
          rsvpOpen: false,
          startsAt: new Date("2032-03-01T12:00:00Z"),
          endsAt: new Date("2032-03-01T13:00:00Z"),
        });
        await fixture.insertRsvp({ eventId: row.id, userId: viewer, status: "going" });
      }
      // Later-starting distractors would fill the first page if the window were
      // applied only after LIMIT/OFFSET. An overlap-only predicate admits them too.
      for (let i = 0; i < 30; i++) {
        const outside = await fixture.insertEvent({
          eventKey: `window-outside-${i}`,
          title: "Paging planning fixture",
          status: "published",
          capacity: 1,
          rsvpOpen: false,
          startsAt: new Date("2032-03-02T00:00:00Z"),
          endsAt: new Date("2032-03-03T00:00:00Z"),
        });
        await fixture.insertRsvp({ eventId: outside.id, userId: viewer, status: "going" });
      }
      const query = `${windowQuery}&q=Paging+planning+fixture&status=published&series=standalone&fill=full&rsvp_open=0&sort=starts_at&order=desc`;
      queries.length = 0;
      const firstResponse = await request(query);
      const firstHtml = await firstResponse.text();
      expect(keys(firstHtml)).toEqual(Array.from({ length: 25 }, (_, i) => `window-page-${i}`));
      const next = links(firstHtml).find((anchor) => anchor.attrs.includes('rel="next"'));
      expect(next).toBeDefined();
      const nextUrl = next!.url;
      expect(Object.fromEntries(nextUrl.searchParams)).toEqual({
        starts_from: "2032-02-29",
        starts_before: "2032-03-02",
        q: "Paging planning fixture",
        status: "published",
        series: "standalone",
        fill: "full",
        rsvp_open: "0",
        sort: "starts_at",
        order: "desc",
        page: "2",
      });
      const secondHtml = await (await request(nextUrl.search.slice(1))).text();
      expect(keys(secondHtml)).toEqual(["window-page-25", "window-page-26", "window-page-27"]);
      expect(links(secondHtml).some((anchor) => anchor.attrs.includes('rel="next"'))).toBe(false);
      const navigation = links(secondHtml).filter((anchor) =>
        /aria-label="Sort by|rel="prev"/.test(anchor.attrs),
      );
      expect(navigation.length).toBeGreaterThanOrEqual(4);
      for (const { url } of navigation) {
        expect(url.searchParams.get("starts_from")).toBe("2032-02-29");
        expect(url.searchParams.get("starts_before")).toBe("2032-03-02");
        expect(url.searchParams.has("page")).toBe(false);
      }
      // The actual route query, not an assumed new internal API, overfetches one.
      const eventRead = queries.find((entry) => /select .* from "events"/i.test(entry.sql));
      expect(eventRead).toBeDefined();
      const predicate = eventRead!.sql.match(/\bwhere\b([\s\S]*?)\border by\b/i)?.[1];
      expect(predicate).toMatch(/"starts_at"\s*>=\s*\$\d+/i);
      expect(predicate).toMatch(/"starts_at"\s*<\s*\$\d+/i);
      expect(eventRead!.params).toContain(26);
      expect(queries.some((entry) => /count\(\*\).*from "events"/i.test(entry.sql))).toBe(false);
    });

    it("RED empty windows and past-end pages offer distinct safe recovery without losing the interval", async () => {
      const empty = await (await request("starts_from=2040-01-01&starts_before=2040-02-01")).text();
      expect(keys(empty)).toEqual([]);
      expect(text(empty)).toMatch(/no events|no matching|nothing matches/i);
      const clear = links(empty).find(
        ({ tag, url }) =>
          /clear|all events|remove.*filter/i.test(text(tag)) &&
          !url.searchParams.has("starts_from") &&
          !url.searchParams.has("starts_before"),
      );
      expect(clear).toBeDefined();
      const pastEnd = await (await request(`${windowQuery}&sort=title&order=asc&page=99`)).text();
      expect(keys(pastEnd)).toEqual([]);
      const first = links(pastEnd).find(
        ({ tag, url }) =>
          /first page|page 1|back to.*results/i.test(text(tag)) &&
          (!url.searchParams.has("page") || url.searchParams.get("page") === "1"),
      );
      expect(first).toBeDefined();
      expect(first!.url.searchParams.get("starts_from")).toBe("2032-02-29");
      expect(first!.url.searchParams.get("starts_before")).toBe("2032-03-02");
      expect(keys(await (await request(first!.url.search.slice(1))).text())).toHaveLength(3);
    });

    it("RED edit links retain the bounded inventory return context", async () => {
      const html = await (await request(`${windowQuery}&sort=title&order=asc`)).text();
      const edit = links(html).find(({ url }) => url.pathname.endsWith("/events/window-lower"));
      expect(edit).toBeDefined();
      // The inventory return carrier ships separately from the date window;
      // when it is absent the date card must not invent it.
      const returnTo =
        edit!.url.searchParams.get("return_to") ??
        [...edit!.url.searchParams.values()].find((value) => value.startsWith("/admin/events?"));
      if (!returnTo) return;
      const back = new URL(returnTo, env.APP_URL);
      expect(back.pathname).toBe("/admin/events");
      expect(back.searchParams.get("starts_from")).toBe("2032-02-29");
      expect(back.searchParams.get("starts_before")).toBe("2032-03-02");
      expect(back.searchParams.get("sort")).toBe("title");
    });

    it("RED transient refusal keeps date bounds on its same-view retry link", async () => {
      const dbSession = (
        fixture.db as unknown as {
          session: { transaction: (...args: unknown[]) => Promise<unknown> };
        }
      ).session;
      const transaction = dbSession.transaction;
      dbSession.transaction = async () => {
        throw Object.assign(new Error("Fixture statement timeout"), { code: "57014" });
      };
      let response: Response;
      try {
        response = await request(`${windowQuery}&sort=title&order=asc&page=2`);
      } finally {
        dbSession.transaction = transaction;
      }
      expect(response.status).toBe(503);
      const html = await response.text();
      expect(keys(html)).toEqual([]);
      expect(response.headers.get("cache-control")).toMatch(/private.*no-store/);
      if (twin === "Hono") {
        // The Hono outage envelope has no same-view retry link yet; when one
        // ships it must keep the date bounds, but the date window does not add it.
        const retry = links(html).find(({ tag }) => /retry|try again/i.test(text(tag)));
        if (!retry) return;
        expect(retry.url.searchParams.get("starts_from")).toBe("2032-02-29");
        expect(retry.url.searchParams.get("starts_before")).toBe("2032-03-02");
        expect(retry.url.searchParams.get("page")).toBe("2");
        return;
      }
      // Kit renders the real admin boundary for a 503 on this view; the retry
      // link must keep the date bounds and the page.
      const path = `/admin/events?${windowQuery}&sort=title&order=asc&page=2`;
      const { body } = adminRetry.render("admin", retryPage(503, path, "/admin/events"));
      const retries = await retryAnchors(body);
      expect(retries, "missing Retry loading link for the failed dated read").toHaveLength(1);
      const href = new URL(retries[0]!.href, env.APP_URL);
      expect(href.pathname).toBe("/admin/events");
      expect(href.searchParams.get("starts_from")).toBe("2032-02-29");
      expect(href.searchParams.get("starts_before")).toBe("2032-03-02");
      expect(href.searchParams.get("page")).toBe("2");
    });

    it("CONTROL unfiltered and empty-bound URLs keep ordinary results and row timestamps unchanged", async () => {
      const plain = await request("sort=starts_at&order=asc");
      const plainHtml = await plain.text();
      expect(plain.status).toBe(200);
      expect(keys(plainHtml)).toEqual(edgeRows.map(([key]) => `window-${key}`));
      expect(
        keys(await (await request("starts_from=&starts_before=&sort=starts_at&order=asc")).text()),
      ).toEqual(keys(plainHtml));
      const filtered = await (await request(windowQuery)).text();
      for (const key of ["lower", "inside", "last"]) {
        const rowText = (html: string) =>
          [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].find(([row]) =>
            row.includes(`data-testid="event-status-window-${key}"`),
          )?.[0];
        expect(rowText(filtered)).toBeDefined();
        expect(text(rowText(filtered)!)).toBe(text(rowText(plainHtml)!));
      }
    });

    it("CONTROL date requests retain moderator admission, private/no-store and non-sensitive classification", async () => {
      expect((await request(windowQuery, "")).status).toBe(302);
      expect((await request(windowQuery, await session(false))).status).toBe(403);
      queries.length = 0;
      const response = await request(windowQuery);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toMatch(/private/);
      expect(response.headers.get("cache-control")).toMatch(/no-store/);
      expect(
        await fixture.db
          .select()
          .from(memberDataAccessLogs)
          .where(eq(memberDataAccessLogs.viewerDiscordId, viewer)),
      ).toHaveLength(0);
      expect(queries.some((entry) => /set_config|set local/i.test(entry.sql))).toBe(true);
      const timeouts = queries.filter((entry) => /lock_timeout|statement_timeout/.test(entry.sql));
      expect(timeouts.length).toBeGreaterThanOrEqual(1);
      expect(timeouts.map((entry) => entry.sql + JSON.stringify(entry.params)).join(" ")).toMatch(
        /2000|2s/,
      );
    });
  },
);
