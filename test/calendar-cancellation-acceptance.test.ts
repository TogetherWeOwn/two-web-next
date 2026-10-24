// Independent fail-first acceptance: cancellation is presentation-terminal even
// when old responses and an open-RSVP flag remain on the retained schedule row.
import { Hono } from "hono";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, Session } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { CalCard } from "../src/events/pages-calendar-card";
import { MonthGrid } from "../src/events/pages-calendar-grid";
import { registerEventRoutes } from "../src/events/routes";
import { listCalendarPast, listUpcoming, listUpcomingForMonth } from "../src/events/reads";
import type { CalRow } from "../src/events/pages-calendar-row";
import { loadEventsPage } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";
import {
  cancellationData,
  cancellationEvent,
  cancellationPath,
  cancellationState,
  discordScheduleEvent,
  publishedScheduleEvent,
  renderedCard,
  renderedText,
} from "./helpers/calendar-cancellation";

vi.mock("../src/events/reads", async (original) => ({
  ...(await original<typeof import("../src/events/reads")>()),
  listUpcoming: vi.fn(),
  listUpcomingForMonth: vi.fn(),
  listCalendarPast: vi.fn(),
  listPublishedGames: vi.fn(async () => []),
  persistedDiscordIds: vi.fn(async () => new Set<string>()),
}));

const existingResponses =
  /(?:existing|previous|recorded|prior|before cancellation).{0,40}(?:rsvps?|responses?)|(?:rsvps?|responses?).{0,40}(?:existing|previous|recorded|prior|before cancellation)/i;

function expectNoCancelledInvitation(card: string): void {
  expect(card).not.toBe("");
  expect(card).not.toMatch(/href="[^"]*(?:\/auth\/|\/join\/|\/rsvp(?:[/?#"]))/i);
  expect(renderedText(card)).not.toMatch(
    /sign in|rsvp (?:now|in discord|to |for )|join (?:this|the) event/i,
  );
  // Informational existing-response controls are allowed, participation is not.
  expect(card).not.toMatch(/data-island="rsvp-button"|<form\b[^>]*action="[^"]*\/rsvp/i);
}

function expectCancelledCount(card: string, count: number): void {
  const text = renderedText(card);
  expect(text).not.toMatch(
    /\bgoing\b|\battend(?:ing|ance)?\b|available|\bplaces\b|\bspots\b|remaining/i,
  );
  // Omission is explicitly allowed. If the response count survives, its meaning
  // must be historical, not an opportunity to attend. No exact new copy is pinned.
  if (new RegExp(`\\b${count}\\b`).test(text)) expect(text).toMatch(existingResponses);
}

async function card(e: CalRow, member: boolean, isPast: boolean): Promise<string> {
  return jsx(CalCard, {
    e,
    zone: "Europe/London",
    isPast,
    member,
    inviteUrl: "https://discord.gg/example",
    loginReturnTo: cancellationPath,
  }).toString();
}

function gridLinks(html: string): { href: string; visible: string; name: string }[] {
  return [...html.matchAll(/<a\b([^>]*\bdata-cal-jump[^>]*)>([\s\S]*?)<\/a>/g)].map(
    ([, attrs = "", inner = ""]) => ({
      href: (/href="([^"]*)"/.exec(attrs)?.[1] ?? "").replace(/&amp;/g, "&"),
      visible: renderedText(inner),
      name: /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? renderedText(inner),
    }),
  );
}

const viewers = [false, true];

describe("cancelled CalCard acceptance", () => {
  for (const member of viewers) {
    for (const isPast of [false, true]) {
      const label = `${member ? "member" : "guest"}, ${isPast ? "past" : "upcoming"}`;
      it(`retains the plain title, time range and cancellation badge (${label})`, async () => {
        const html = await card(cancellationEvent(), member, isPast);
        expect(html).toContain("Chess night");
        expect(renderedText(html)).toMatch(/20:00.*22:00/);
        expect(html).toContain('data-testid="event-cancelled"');
        expect(html).not.toContain('/e/01ARZ3NDEKTSV4RRFFQ69G5FAA"');
        expect(html).toContain('id="event-01ARZ3NDEKTSV4RRFFQ69G5FAA"');
      });
      it(`emits no event-specific participation invitation (${label})`, async () => {
        for (const rsvpOpen of [true, false]) {
          expectNoCancelledInvitation(await card(cancellationEvent({ rsvpOpen }), member, isPast));
        }
      });
      it.each([0, 73])(
        `omits or explains existing responses, never attendance (${label}, %i)`,
        async (count) => {
          expectCancelledCount(
            await card(
              cancellationEvent({ goingCount: count, goingOccupancy: count }),
              member,
              isPast,
            ),
            count,
          );
        },
      );
    }
  }

  it.each(viewers)(
    "preserves published and Discord-transient actions/counts (member=%s)",
    async (member) => {
      const published = await card(publishedScheduleEvent(), member, false);
      expect(renderedText(published)).toContain("7 going");
      expect(published).toContain('href="/e/01ARZ3NDEKTSV4RRFFQ69G5FAB"');
      expect(published.includes("Sign in")).toBe(!member);
      if (!member) {
        expect(published).toContain(
          "/join/discord?next=%2Fevents%3Fview%3Dcalendar%26month%3D2099-01%26past%3D1",
        );
      }
      const transient = await card(discordScheduleEvent(), member, false);
      expect(renderedText(transient)).toContain("RSVP in Discord");
      expect(transient).toContain('href="https://discord.gg/example"');
      expect(renderedText(transient)).not.toMatch(/going|existing responses|cancelled/i);
      for (const row of [publishedScheduleEvent(), discordScheduleEvent()]) {
        const past = await card(row, member, true);
        expect(renderedText(past)).not.toMatch(/Sign in|RSVP in Discord/i);
      }
    },
  );
});

describe("cancelled MonthGrid acceptance", () => {
  const render = async () =>
    jsx(MonthGrid, {
      state: cancellationState,
      weeks: [
        [
          {
            iso: "2099-01-15",
            day: 15,
            inMonth: true,
            isToday: false,
            events: [cancellationEvent(), publishedScheduleEvent(), discordScheduleEvent()],
          },
        ],
      ],
      zone: "Europe/London",
    }).toString();

  it("visibly distinguishes the cancelled entry without relying on color", async () => {
    const links = gridLinks(await render());
    expect(links).toHaveLength(3);
    // The neutral fixture title cannot itself satisfy the cancellation status.
    expect(links[0]!.visible).toMatch(/cancelled/i);
    expect(links[0]!.visible).toContain("20:00");
    expect(links[0]!.visible).toContain("Chess night");
    expect(
      links
        .slice(1)
        .map((link) => link.visible)
        .join(" "),
    ).not.toMatch(/cancelled/i);
  });

  it("names cancellation accessibly, retaining the full title and day context", async () => {
    const [link] = gridLinks(await render());
    expect(link!.name).toMatch(/cancelled/i);
    expect(link!.name).toContain("Chess night");
    expect(link!.name).toContain("20:00");
    expect(link!.name).toContain("15");
  });

  it("retains the exact native past-aware jump to the retained list card", async () => {
    const [link] = gridLinks(await render());
    expect(link!.href).toBe(
      "/events?event=01ARZ3NDEKTSV4RRFFQ69G5FAA&past=1#event-01ARZ3NDEKTSV4RRFFQ69G5FAA",
    );
    expect(await card(cancellationEvent(), false, false)).toContain(
      'id="event-01ARZ3NDEKTSV4RRFFQ69G5FAA"',
    );
  });
});

let member = false;
const session = (): Session | null =>
  member
    ? {
        id: "123456789012345678",
        username: "Fixture member",
        avatar: null,
        member: true,
        moderator: false,
      }
    : null;
const app = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  app,
  async () => session(),
  async () => session(),
);
const fixtureDb = {} as import("../src/db/index").Db;
const discordSource = {
  upcoming: async () => [discordScheduleEvent()],
  lastReadFailed: () => false,
};
const env = {
  APP_URL: "https://next.example.test",
  DISCORD_INVITE_URL: "https://discord.gg/example",
  ADMIN_DB: fixtureDb,
  DISCORD_EVENTS: discordSource,
} as unknown as Env;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2099-01-01T12:00:00Z"));
  __resetAnonEventCacheForTests();
  const persisted = [cancellationEvent(), publishedScheduleEvent()];
  vi.mocked(listUpcoming).mockResolvedValue({
    rows: persisted,
    total: 2,
    totalPages: 1,
    hasMore: false,
  });
  vi.mocked(listUpcomingForMonth).mockResolvedValue(persisted);
  vi.mocked(listCalendarPast).mockResolvedValue(cancellationData().past);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(viewers)("Hono/Kit mixed schedule cancellation (member=%s)", (viewer) => {
  it.each(["list", "calendar"])(
    "keeps native/fragment %s semantics and navigation",
    async (view) => {
      member = viewer;
      const renders: string[] = [];
      const path = `/events?view=${view}&month=2099-01&past=1`;
      for (const island of [false, true]) {
        const request = new Request(`https://next.example.test${path}`, {
          headers: island ? { "x-two-island": "events-calendar" } : {},
        });
        const response = await app.request(request, undefined, env);
        expect(response.status).toBe(200);
        const data = await loadEventsPage({
          env,
          url: new URL(request.url),
          method: "GET",
          island,
          request,
          setHeaders: () => {},
          deleteJoinCookie: () => {},
          dbForFn: async () => fixtureDb,
          sessionForFn: async () => session(),
          journeyForFn: async () => null,
          discordForFn: () => discordSource,
          now: new Date("2099-01-01T12:00:00Z"),
        });
        const kit = await renderEventsHtml(data, {});
        expect(kit.status).toBe(200);
        renders.push(await response.text(), kit.body);
      }
      const keys = [
        "01ARZ3NDEKTSV4RRFFQ69G5FAA",
        "discord-123456789012345678",
        "01ARZ3NDEKTSV4RRFFQ69G5FAB",
        "01ARZ3NDEKTSV4RRFFQ69G5FAC",
      ];
      for (const html of renders) {
        expect(html).toContain('data-cal-zone="content"');
        expect(html).toContain('name="q"');
        const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
        expect(canonical).toBeDefined();
        expect(canonical).toBe(/<link rel="canonical" href="([^"]+)"/.exec(renders[0]!)?.[1]);
        if (!viewer) expect(renderedText(html)).toContain("Join the Discord");
        if (view === "list") {
          expect([...html.matchAll(/data-event-key="([^"]+)"/g)].map((m) => m[1])).toEqual(keys);
          for (const key of keys)
            expect(renderedCard(html, key)).toBe(renderedCard(renders[0]!, key));
          const published = renderedCard(html, keys[2]!);
          expect(renderedText(published)).toContain("7 going");
          expect(published.includes("Sign in")).toBe(!viewer);
          if (!viewer)
            expect(published).toContain(
              "/join/discord?next=%2Fevents%3Fview%3Dlist%26month%3D2099-01%26past%3D1",
            );
          expect(renderedText(renderedCard(html, keys[1]!))).toContain("RSVP in Discord");
        } else {
          expect(gridLinks(html)).toHaveLength(3);
          expect(gridLinks(html)).toEqual(gridLinks(renders[0]!));
          expect(gridLinks(html)[0]!.href).toBe(
            "/events?event=01ARZ3NDEKTSV4RRFFQ69G5FAA&past=1#event-01ARZ3NDEKTSV4RRFFQ69G5FAA",
          );
        }
      }
      // Compare with independent expectations as well as parity: identical wrong
      // HTML must not satisfy the acceptance test.
      for (const html of renders) {
        if (view === "list") {
          for (const key of [keys[0]!, keys[3]!]) {
            const retained = renderedCard(html, key);
            expectNoCancelledInvitation(retained);
            expectCancelledCount(retained, 73);
            expect(retained).not.toContain(`href="/e/${key}"`);
          }
        } else {
          const jump = gridLinks(html)[0]!;
          expect(jump.visible).toMatch(/cancelled/i);
          expect(jump.name).toMatch(/cancelled/i);
        }
      }
    },
  );
});
