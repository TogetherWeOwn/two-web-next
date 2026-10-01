// Native GET submissions through the real calendar route with synthetic read models.
// No database, Discord, browser or staging dependencies.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { registerEventRoutes } from "../src/events/routes";
import { listCalendarPast, listUpcoming, type PublicEvent } from "../src/events/reads";

vi.mock("../src/events/reads", async (original) => ({
  ...await original<typeof import("../src/events/reads")>(),
  listUpcoming: vi.fn(),
  listCalendarPast: vi.fn(),
  persistedDiscordIds: vi.fn(async () => new Set<string>()),
}));
vi.mock("../src/events/search-log", async (original) => ({
  ...await original<typeof import("../src/events/search-log")>(),
  recordSearch: vi.fn(async () => {}),
}));

const app = new Hono<{ Bindings: Env }>();
registerEventRoutes(app, async () => null, async () => null);
const env = {
  APP_URL: "https://next.example.test",
  DISCORD_INVITE_URL: "https://discord.gg/example",
  ADMIN_DB: {} as Db,
  DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
} as unknown as Env;

function eventRow(id: number, startsAt: Date): PublicEvent {
  return {
    id, eventKey: `event-${id}`, title: "Game night", game: null, description: null,
    startsAt, endsAt: new Date(startsAt.getTime() + 7200_000), timezone: "UTC",
    location: null, capacity: null, status: "published", discordEventId: null,
    discordSyncFailedAt: null, discordSyncFailureCode: null, createdBy: null, rsvpOpen: true,
    recurrenceFrequency: null, recurrenceCount: null, recurrenceEndsOn: null,
    parentEventId: null, recurrenceIndex: null, createdAt: startsAt, updatedAt: startsAt,
    goingCount: 0,
  };
}

const decode = (value: string) => value.replace(/&(amp|quot|#39|lt|gt);/g, (_, entity: string) =>
  ({ amp: "&", quot: '"', "#39": "'", lt: "<", gt: ">" })[entity]!,
);
const attributes = (tag: string) => Object.fromEntries(
  [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1]!, decode(m[2]!)]),
);

function calendarState(html: string) {
  const root = attributes(html.match(/<section\b[^>]*data-island="events-calendar"[^>]*>/)![0]);
  return { view: root["data-view"], month: root["data-month"], past: root["data-past"] === "1" };
}

function nativeSearch(html: string, query: string) {
  const form = html.match(/<form\b[^>]*role="search"[^>]*>[\s\S]*?<\/form>/)![0];
  const controls = [...form.matchAll(/<input\b[^>]*>/g)].map((m) => attributes(m[0]));
  const params = new URLSearchParams();
  for (const input of controls) {
    if (input.name) params.append(input.name, input.name === "q" ? query : input.value ?? "");
  }
  return { form, controls, params, url: `${attributes(form).action}?${params}` };
}

async function page(path: string) {
  const response = await app.request(path, undefined, env);
  expect(response.status).toBe(200);
  return response.text();
}

beforeEach(() => {
  vi.mocked(listUpcoming).mockResolvedValue([eventRow(1, new Date("2030-01-12T20:00:00Z"))]);
  vi.mocked(listCalendarPast).mockResolvedValue([eventRow(2, new Date("2020-01-12T20:00:00Z"))]);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("calendar native search state", () => {
  it.each([
    { entry: "?view=calendar&month=2030-2&past=1", view: "calendar", month: "2030-02", past: true },
    { entry: "?view=list&month=2030-02&past=1", view: "list", month: "2030-02", past: true },
    { entry: "?view=calendar&month=2030-02", view: "calendar", month: "2030-02", past: false },
    { entry: "", view: "list", month: "2030-01", past: false },
    { entry: "?view=bad&month=2030-13&past=true", view: "list", month: "2030-01", past: false },
    { entry: "?view=calendar&month=2030-02&past=01&q=old", view: "list", month: "2030-02", past: false },
  ])("submits only resolved state from $entry", async ({ entry, view, month, past }) => {
    const html = await page(`/events${entry}`);
    expect(calendarState(html)).toEqual({ view, month, past });
    for (const query of ["game", "", "   "]) {
      const submission = nativeSearch(html, query);
      expect(attributes(submission.form).method).toBe("get");
      expect(submission.params.getAll("q")).toEqual([query]);
      expect(submission.params.getAll("view")).toEqual([view]);
      expect(submission.params.getAll("month")).toEqual([month]);
      expect(submission.params.getAll("past")).toEqual(past ? ["1"] : []);
      expect(submission.controls.filter((c) => c.name !== "q").every((c) => c.type === "hidden")).toBe(true);
      expect(calendarState(await page(submission.url))).toEqual({
        view: query.trim() ? "list" : view, month, past,
      });
    }
  });

  it("replaces the query without forwarding paging or arbitrary and duplicate parameters", async () => {
    const html = await page("/events?view=calendar&month=2030-02&past=1&q=old&page=7&redirect=bad&past=0&view=bad");
    const submission = nativeSearch(html, 'raid & "friends" <game>');
    expect([...submission.params.keys()].sort()).toEqual(["month", "past", "q", "view"]);
    expect(submission.params.getAll("q")).toEqual(['raid & "friends" <game>']);
    expect(submission.params.getAll("past")).toEqual(["1"]);
    const result = await page(submission.url);
    expect(calendarState(result)).toEqual({ view: "list", month: "2030-02", past: true });
    expect(nativeSearch(result, "").params.getAll("q")).toEqual([""]);
  });

  it("does not open the past drawer just because a search reveals past matches", async () => {
    vi.mocked(listUpcoming).mockResolvedValue([]);
    const html = await page("/events?q=game&month=2030-02");
    expect(html).toContain('data-testid="events-past-list"');
    expect(nativeSearch(html, "").params.has("past")).toBe(false);
    expect(calendarState(await page(nativeSearch(html, "").url))).toEqual({
      view: "list", month: "2030-02", past: false,
    });
  });

  it("keeps resolved hidden controls in the swapped actions zone, not the stable input", async () => {
    const { form } = nativeSearch(await page("/events?view=calendar&month=2030-02&past=1"), "game");
    const actions = form.match(/<span\b[^>]*data-cal-zone="actions"[^>]*>[\s\S]*?<\/span>/)![0];
    expect([...actions.matchAll(/name="([^"]+)"/g)].map((m) => m[1])).toEqual(["view", "month", "past"]);
    expect(actions).not.toContain('name="q"');
  });
});
