import { type DefaultTreeAdapterMap, parse } from "parse5";
import { describe, expect, it } from "vitest";
import { renderEventsHtml } from "../src/kit-events-html";
import {
  EVENTS_CALENDAR_GRID_TESTID,
  EVENTS_CALENDAR_TESTID,
  EVENTS_EMPTY_COPY,
  EVENTS_SEARCH_TOO_LONG_COPY,
} from "../src/islands/contracts";
import {
  attribute,
  elements,
  tag,
  testId,
  text,
} from "./helpers/schedule-search-context-acceptance";

const baseData = () => ({
  state: { view: "list", month: "2026-10", q: "", game: null, past: false, page: 1 },
  upcoming: [],
  past: [],
  games: [],
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

function sourceTestId(
  root: DefaultTreeAdapterMap["node"],
  id: string,
): DefaultTreeAdapterMap["element"][] {
  return [
    ...testId(root, id),
    ...tag(root, "template").flatMap((template) =>
      "content" in template
        ? sourceTestId((template as DefaultTreeAdapterMap["template"]).content, id)
        : [],
    ),
  ];
}

function canonicalLinks(page: DefaultTreeAdapterMap["document"]) {
  return tag(page, "link")
    .filter((link) => attribute(link, "rel") === "canonical")
    .map((link) => attribute(link, "href"));
}

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
    const page = parse(rendered.body);
    const [calendar] = testId(page, EVENTS_CALENDAR_TESTID);
    expect(calendar).toBeDefined();
    expect(tag(page, "script").map((script) => attribute(script, "src"))).toContain(
      "/islands/events-calendar.js",
    );
    expect(calendar && text(calendar)).toContain(EVENTS_EMPTY_COPY.neverTitle);
    expect(canonicalLinks(page)).toContain("https://example.test/events");
    expect(tag(page, "a").map((link) => attribute(link, "href"))).toContain("/join?next=%2Fevents");
    expect(
      sourceTestId(parse(rendered.body, { scriptingEnabled: false }), "join-result"),
    ).toHaveLength(0);
    // Also reject the private marker in comments and other unparsed wire bytes.
    expect(rendered.body).not.toContain('data-testid="join-result"');
  });

  it("renders the month grid for a calendar view", async () => {
    const rendered = await renderEventsHtml(
      {
        ...baseData(),
        state: { view: "calendar", month: "2026-10", q: "", game: null, past: false, page: 1 },
        emptyState: null,
      } as never,
      headers,
    );

    expect(testId(parse(rendered.body), EVENTS_CALENDAR_GRID_TESTID)).toHaveLength(1);
  });

  it("renders the join banner only when the flash survives", async () => {
    const withFlash = await renderEventsHtml(
      { ...baseData(), emptyState: "never", joinResult: "added" } as never,
      { ...headers, "cache-control": "private, no-store" },
    );
    expect(testId(parse(withFlash.body), "join-result")).toHaveLength(1);

    const withoutFlash = await renderEventsHtml({ ...baseData(), emptyState: "never" } as never, {
      ...headers,
      "cache-control": "private, no-store",
    });
    expect(
      sourceTestId(parse(withoutFlash.body, { scriptingEnabled: false }), "join-result"),
    ).toHaveLength(0);
    expect(withoutFlash.body).not.toContain('data-testid="join-result"');
  });

  it("renders the restored-write notice first in main only when requested", async () => {
    const data = { ...baseData(), emptyState: "never", joinResult: "added" } as never;
    const shown = await renderEventsHtml(data, headers, true);
    const page = parse(shown.body, { scriptingEnabled: false });
    const [main] = tag(page, "main");
    const notices = sourceTestId(page, "auth-error");
    expect(notices).toHaveLength(1);
    const [notice] = notices;
    expect(main?.childNodes[0]).toBe(notice);
    expect(notice?.tagName).toBe("div");
    expect(notice && attribute(notice, "role")).toBe("status");
    expect(notice && attribute(notice, "tabindex")).toBe("-1");
    const markers = elements(
      page,
      (node) => node === notice || attribute(node, "data-testid") === "join-result",
    );
    expect(markers.map((node) => attribute(node, "data-testid"))).toEqual([
      "auth-error",
      "join-result",
    ]);
    const clean = await renderEventsHtml(data, headers);
    expect(sourceTestId(parse(clean.body, { scriptingEnabled: false }), "auth-error")).toHaveLength(
      0,
    );
    expect(clean.body).not.toContain('data-testid="auth-error"');
    const refused = await renderEventsHtml(
      { queryTooLong: true, appUrl: "https://example.test" },
      headers,
      true,
    );
    expect(
      sourceTestId(parse(refused.body, { scriptingEnabled: false }), "auth-error"),
    ).toHaveLength(0);
    expect(refused.body).not.toContain('data-testid="auth-error"');
  });

  it("renders the too-long notice without echoing the query", async () => {
    const sentinel = `qq${"z".repeat(300)}`;
    const data = baseData();
    const refused = { ...data, queryTooLong: true as const, state: { ...data.state, q: sentinel } };
    const rendered = await renderEventsHtml(refused, {
      "cache-control": "no-store, private",
      vary: "Cookie, X-Two-Island",
      "x-two-events-too-long": "true",
    });

    expect(rendered.status).toBe(200);
    const page = parse(rendered.body);
    const [alert] = elements(page, (node) => attribute(node, "role") === "alert");
    expect(alert && text(alert).trim()).toBe(EVENTS_SEARCH_TOO_LONG_COPY);
    // A refused query must stay out of the wire bytes, including comments.
    expect(rendered.body).not.toContain(sentinel);
    expect(canonicalLinks(page)).toContain("https://example.test/events");
  });
});
