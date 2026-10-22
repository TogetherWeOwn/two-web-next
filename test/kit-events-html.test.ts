import { describe, expect, it } from "vitest";
import { renderEventsHtml } from "../src/kit-events-html";
import {
  EVENTS_CALENDAR_GRID_TESTID,
  EVENTS_CALENDAR_TESTID,
  EVENTS_EMPTY_COPY,
  EVENTS_SEARCH_TOO_LONG_COPY,
} from "../src/islands/contracts";

const baseData = () => ({
  state: { view: "list", month: "2026-10", q: "", past: false, page: 1 },
  upcoming: [],
  past: [],
  zone: "Europe/London",
  now: new Date("2026-10-13T12:00:00Z"),
  totalPages: 1,
  emptyState: null,
  robots: undefined,
  discordFailed: false,
  member: false,
  moderator: false,
  inviteUrl: "https://discord.gg/example",
  appUrl: "https://example.test",
  canonical: "https://example.test/events",
  loginReturnTo: "/events",
  joinResult: null,
  queryTooLong: false,
});

const headers = {
  "cache-control": "public, max-age=60",
  vary: "Cookie, X-Two-Island",
  "x-two-events-cacheable": "true",
};

describe("Kit events list HTML render", () => {
  it("renders the Hono calendar screen for a never-ran model", async () => {
    const rendered = await renderEventsHtml(
      { ...baseData(), emptyState: "never" } as never,
      headers,
    );

    expect(rendered.status).toBe(200);
    expect(rendered.headers["content-type"]).toBe("text/html; charset=UTF-8");
    expect(rendered.headers["cache-control"]).toBe("public, max-age=60");
    expect(rendered.headers["vary"]).toBe("Cookie, X-Two-Island");
    expect(rendered.body).toContain(`data-testid="${EVENTS_CALENDAR_TESTID}"`);
    expect(rendered.body).toContain('<script src="/islands/events-calendar.js"');
    expect(rendered.body).toContain(EVENTS_EMPTY_COPY.neverTitle);
    expect(rendered.body).toContain('href="https://example.test/events"');
    expect(rendered.body).toContain("/join?next=%2Fevents");
    expect(rendered.body).not.toContain('data-testid="join-result"');
  });

  it("renders the month grid for a calendar view", async () => {
    const rendered = await renderEventsHtml(
      {
        ...baseData(),
        state: { view: "calendar", month: "2026-10", q: "", past: false, page: 1 },
        emptyState: null,
      } as never,
      headers,
    );

    expect(rendered.body).toContain(`data-testid="${EVENTS_CALENDAR_GRID_TESTID}"`);
  });

  it("renders the join banner only when the flash survives", async () => {
    const withFlash = await renderEventsHtml(
      { ...baseData(), emptyState: "never", joinResult: "added" } as never,
      { ...headers, "cache-control": "private, no-store" },
    );
    expect(withFlash.body).toContain('data-testid="join-result"');

    const withoutFlash = await renderEventsHtml({ ...baseData(), emptyState: "never" } as never, {
      ...headers,
      "cache-control": "private, no-store",
    });
    expect(withoutFlash.body).not.toContain('data-testid="join-result"');
  });

  it("injects the restored-write banner first inside <main> without echoing the destination", async () => {
    const banner =
      '<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div>';
    const rendered = await renderEventsHtml(
      { ...baseData(), emptyState: "never" } as never,
      headers,
      {
        restoredWrite: "/profile?edit=1",
      },
    );

    expect(rendered.body).toContain(banner);
    const main = rendered.body.indexOf("<main");
    expect(rendered.body.indexOf('data-testid="auth-error"')).toBeGreaterThan(main);
    expect(rendered.body.indexOf('data-testid="auth-error"')).toBeLessThan(
      rendered.body.indexOf(`data-testid="${EVENTS_CALENDAR_TESTID}"`),
    );
    expect(rendered.body).not.toContain("/profile?edit=1");
  });

  it("renders byte-identical HTML when the restored notice is absent", async () => {
    const data = { ...baseData(), emptyState: "never" } as never;
    const implicit = await renderEventsHtml(data, headers);
    const explicitNull = await renderEventsHtml(data, headers, { restoredWrite: null });

    expect(implicit.body).toBe(explicitNull.body);
    expect(implicit.body).not.toContain('data-testid="auth-error"');
  });

  it("renders the too-long notice without echoing the query", async () => {
    const sentinel = `qq${"z".repeat(300)}`;
    const rendered = await renderEventsHtml(
      { queryTooLong: true, appUrl: "https://example.test" },
      {
        "cache-control": "no-store, private",
        vary: "Cookie, X-Two-Island",
        "x-two-events-too-long": "true",
      },
    );

    expect(rendered.status).toBe(200);
    expect(rendered.body).toContain(EVENTS_SEARCH_TOO_LONG_COPY);
    expect(rendered.body).not.toContain(sentinel);
    expect(rendered.body).toContain('href="https://example.test/events"');
  });
});
