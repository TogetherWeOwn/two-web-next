import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEventListQuery } from "../src/admin/event-list";
import { buildEventListView } from "../src/admin/kit-events";
import { EventsPage } from "../src/admin/pages/events-list";

// The inert Kit view must receive escaped feedback through the same server-only
// HTML boundary as the native date controls, not duplicate client templates.
describe("server-rendered UTC window feedback", () => {
  it("escapes inline native filter fields and keeps the filtered clear destination", () => {
    const query = parseEventListQuery({
      q: '<img src=x onerror="alert(1)">',
      status: "draft",
      starts_from: "2032-02-29",
      sort: "title",
      order: "asc",
    });
    const html = String(EventsPage({ query, rows: [], hasNext: false }));
    expect(html).toContain('name="sort" value="title"');
    expect(html).toContain('name="order" value="asc"');
    expect(html).toContain('value="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"');
    expect(html).not.toContain("<img");
    expect(html).toMatch(/<option value="draft" selected(?:="")?>draft<\/option>/);
    expect(html).toContain('href="/admin/events?sort=title&amp;order=asc"');
    expect(html).toContain("Clear filters");
    expect(
      String(EventsPage({ query: parseEventListQuery({}), rows: [], hasNext: false })),
    ).not.toContain("Clear filters");
  });
  it("renders the exact one-sided summary without inventing the absent endpoint", () => {
    const lower = buildEventListView(parseEventListQuery({ starts_from: "2032-02-29" }), []);
    const upper = buildEventListView(parseEventListQuery({ starts_before: "2032-03-02" }), []);
    expect(lower.startsFeedbackHtml).toBe(
      "<p>Showing events that start at or after 2032-02-29 00:00 UTC (included). Event times below stay in UTC.</p>",
    );
    expect(upper.startsFeedbackHtml).toBe(
      "<p>Showing events that start before 2032-03-02 00:00 UTC (excluded). Event times below stay in UTC.</p>",
    );
  });

  it("escapes alert text and pairs the light notice with its dark ink token", () => {
    const query = {
      ...parseEventListQuery({}),
      startsWindow: { error: '<img src=x onerror="alert(1)">' },
    };
    const html = buildEventListView(query, []).startsFeedbackHtml;
    expect(html).toContain('class="notice event-window-notice" role="alert"');
    expect(html).not.toContain("style=");
    expect(readFileSync("web/src/app.css", "utf8")).toMatch(
      /\.kit-admin \.event-window-notice\s*\{\s*color:\s*var\(--ink\);?\s*\}/,
    );
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Showing events");
  });

  it("emits no feedback when no start window is active", () => {
    expect(buildEventListView(parseEventListQuery({}), []).startsFeedbackHtml).toBe("");
  });
});
