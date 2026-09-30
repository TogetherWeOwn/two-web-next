import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { FeaturedFormPage, FeaturedPage } from "../src/admin/pages";
import type { FeaturedRow } from "../src/admin/store";
import { currentlyVisible, FeaturedContentItem, featuredStatus, type FeaturedWindow } from "../src/featured";

const now = new Date("2026-09-30T20:00:00Z");
const before = new Date(now.getTime() - 1);
const after = new Date(now.getTime() + 1);
const row: FeaturedRow = {
  id: 1, title: "Friday games", body: "Bring a friend.\nEveryone is welcome.",
  url: "https://example.test/games", imageUrl: "https://example.test/photo.jpg", imageAlt: "Friends playing together",
  isPublished: true, position: 0, startsAt: before, endsAt: after, createdBy: "moderator",
  createdAt: before, updatedAt: before,
};
const states = [
  ["live", { isPublished: true, startsAt: before, endsAt: after }],
  ["scheduled", { isPublished: true, startsAt: after, endsAt: null }],
  ["expired", { isPublished: true, startsAt: null, endsAt: before }],
  ["unpublished", { isPublished: false, startsAt: before, endsAt: after }],
] as const;
const edit = (saved: FeaturedRow, values: Record<string, unknown> = {}, errors: Record<string, string> = {}) =>
  String(jsx(FeaturedFormPage, { mode: "edit", row: saved, values, errors, now }));
const item = (saved: FeaturedRow) => String(jsx(FeaturedContentItem, { row: saved, now }));

// Local rows only: these tests never open a database or public/staging endpoint.
describe("featured publish-window status", () => {
  it.each(states)("%s badge agrees with the shared public visibility predicate", (status, window) => {
    const saved = { ...row, ...window };
    expect(featuredStatus(saved, now)).toBe(status);
    expect(currentlyVisible(saved, now)).toBe(status === "live");
    const table = String(jsx(FeaturedPage, { rows: [saved], now }));
    expect(table).toContain(`data-status="${status}">${status}</span>`);
    expect(edit(saved)).toContain(`data-status="${status}">${status}</span>`);
    expect(item(saved).includes('data-testid="featured-item"')).toBe(status === "live");
  });

  it.each([
    { startsAt: null, endsAt: null },
    { startsAt: now, endsAt: null },
    { startsAt: null, endsAt: now },
    { startsAt: before, endsAt: now },
    { startsAt: now, endsAt: after },
  ])("includes open bounds and the exact start/end instant: %j", (bounds) => {
    expect(featuredStatus({ ...row, ...bounds }, now)).toBe("live");
  });

  it.each([
    { startsAt: null, endsAt: null },
    { startsAt: after, endsAt: null },
    { startsAt: null, endsAt: before },
  ])("the publish toggle wins over every window: %j", (bounds) => {
    const window: FeaturedWindow = { ...bounds, isPublished: false };
    expect(featuredStatus(window, now)).toBe("unpublished");
    expect(currentlyVisible(window, now)).toBe(false);
  });

  it("captures one clock for every row in the table", () => {
    const html = String(jsx(FeaturedPage, { rows: [row, { ...row, id: 2 }], now }));
    expect(html.match(/data-status="live"/g)).toHaveLength(2);
  });
});

describe("featured SSR preview", () => {
  it("is byte-identical to the shared public item markup for the same row and clock", () => {
    const publicItem = item(row);
    expect(publicItem).toContain('<article class="card featured-card"');
    expect(edit(row).match(/<article\b[\s\S]*?<\/article>/g)).toEqual([publicItem]);
    expect(publicItem).toContain('alt="Friends playing together"');
    expect(publicItem).toContain('href="https://example.test/games"');
    expect(publicItem).toContain("Bring a friend.\nEveryone is welcome.");
  });

  it.each(states.filter(([status]) => status !== "live"))("hides %s items exactly as the public presenter does", (_status, window) => {
    const saved = { ...row, ...window };
    expect(item(saved)).toBe("");
    expect(edit(saved)).toContain('data-testid="featured-preview-hidden"');
    expect(edit(saved)).not.toContain("<article");
  });

  it("labels the last-saved preview, including after an invalid submitted edit", () => {
    const html = edit(row, { title: "Unsaved headline", url: "javascript:alert(1)" }, { url: "Use http(s)." });
    expect(html).toContain("Last saved content");
    expect(html).toContain("Save changes to refresh this preview");
    expect(html).toContain(`<time datetime="${now.toISOString()}">`);
    expect(html).toContain('data-testid="form-errors"');
    expect(html.match(/<article\b[\s\S]*?<\/article>/g)).toEqual([item(row)]);
  });

  it("does not imply a saved preview on a new form", () => {
    expect(String(jsx(FeaturedFormPage, { mode: "new", values: {}, errors: {}, now }))).not.toContain('data-testid="featured-preview"');
  });

  it("renders a minimal card without optional content", () => {
    const html = item({ ...row, body: null, url: null, imageUrl: null, imageAlt: null });
    expect(html).toContain("<h3>Friday games</h3>");
    expect(html).not.toMatch(/<(?:a|img|p)\b/);
  });

  it("escapes content and refuses unsafe links/images or missing image descriptions", () => {
    const html = item({ ...row, title: '<script>alert("x")</script>', body: "<b>Not HTML</b>", url: "javascript:alert(1)", imageUrl: "data:image/svg+xml,evil" });
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Not HTML&lt;/b&gt;");
    expect(html).not.toMatch(/<(?:script|img|a)\b/);
    expect(item({ ...row, imageAlt: null })).not.toContain("<img");
  });

  it("has no inline script, stylesheet, style attribute or event handlers", () => {
    for (const html of [edit(row), String(jsx(FeaturedPage, { rows: [row], now })), item(row)]) {
      expect(html).not.toMatch(/<(?:script|style)\b|\sstyle=|\son\w+=/i);
    }
    expect(edit(row)).toContain('<link rel="stylesheet" href="/admin.css"/>');
  });
});
