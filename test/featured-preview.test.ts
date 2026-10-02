import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { FeaturedFormPage, FeaturedPage } from "../src/admin/pages";
import type { FeaturedRow } from "../src/admin/store";
import { parseFeaturedListQuery } from "../src/admin/table-list";
import { currentlyVisible, featuredStatus, type FeaturedWindow } from "../src/featured-status";
import { FeaturedContentItem, Home } from "../src/pages";

const now = new Date("2026-09-30T20:00:00Z");
const before = new Date(now.getTime() - 1);
const after = new Date(now.getTime() + 1);
const appUrl = "https://next.example.test";
const query = parseFeaturedListQuery({});
const row: FeaturedRow = {
  id: 1, legacyId: null, title: "Friday games", body: "Bring a friend.\nEveryone is welcome.",
  url: "https://example.test/games", imageUrl: "https://cdn.discordapp.com/photo.jpg", imageAlt: "Friends playing together",
  isPublished: true, position: 0, startsAt: before, endsAt: after, createdBy: "moderator",
  createdAt: before, updatedAt: before,
};
const states = [
  ["live", { isPublished: true, startsAt: before, endsAt: after }],
  ["scheduled", { isPublished: true, startsAt: after, endsAt: null }],
  ["expired", { isPublished: true, startsAt: null, endsAt: before }],
  ["unpublished", { isPublished: false, startsAt: before, endsAt: after }],
] as const;
const edit = (saved: FeaturedRow, values: Record<string, unknown> = {}, errors: Record<string, string> = {}, imageHosts?: string) =>
  String(jsx(FeaturedFormPage, { mode: "edit", row: saved, values, errors, now, appUrl, imageHosts }));
const item = (saved: FeaturedRow) => String(jsx(FeaturedContentItem, { row: saved, appUrl }));
const home = (saved: FeaturedRow, imageHosts?: string) => String(jsx(Home, {
  session: null, notice: null, inviteUrl: "https://discord.gg/fixture", appUrl, imageHosts,
  counts: { memberCount: null, onlineCount: null, ranks: [] },
  upcomingEvents: [], eventsUnavailable: false, featured: [saved],
}));
const articles = (html: string) => html.match(/<article\b[\s\S]*?<\/article>/g);
// The dirty-navigation island is an external script with no inline code:
// strip island tags before asserting the page carries no inline script/style.
const withoutIslands = (html: string) => html.replace(/<script\b[^>]*src="\/islands\/[^"]*"[^>]*><\/script>/g, "");

// Local rows only: these tests never open a database or public/staging endpoint.
describe("featured publish-window status", () => {
  it.each(states)("%s badge agrees with preview visibility", (status, window) => {
    const saved = { ...row, ...window };
    expect(featuredStatus(saved, now)).toBe(status);
    expect(currentlyVisible(saved, now)).toBe(status === "live");
    const table = String(jsx(FeaturedPage, { rows: [saved], query, now }));
    expect(table).toContain(`data-status="${status}">${status}</span>`);
    expect(edit(saved)).toContain(`data-status="${status}">${status}</span>`);
    expect(edit(saved).includes('data-testid="featured-item"')).toBe(status === "live");
  });

  it.each([
    { startsAt: null, endsAt: null },
    { startsAt: now, endsAt: null },
    { startsAt: before, endsAt: after },
    { startsAt: now, endsAt: after },
  ])("includes open bounds and the exact start instant: %j", (bounds) => {
    expect(featuredStatus({ ...row, ...bounds }, now)).toBe("live");
  });

  it.each([null, before, now])("excludes the exact end instant with start %s, matching the homepage query", (startsAt) => {
    const saved = { ...row, startsAt, endsAt: now };
    expect(featuredStatus(saved, now)).toBe("expired");
    expect(currentlyVisible(saved, now)).toBe(false);
    expect(edit(saved)).toContain('data-testid="featured-preview-hidden"');
    expect(edit(saved)).not.toContain("<article");
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

  it("preserves filters, accessible sorting and last-changed times alongside status badges", () => {
    const filtered = parseFeaturedListQuery({ published: "1", q: "Friday", sort: "updated_at", order: "desc" });
    const html = String(jsx(FeaturedPage, { rows: [row], query: filtered, now }));
    expect(html).toContain('name="q" type="search" value="Friday"');
    expect(html).toContain('value="1" selected');
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('aria-label="Sort by last changed ascending"');
    expect(html).toContain("sort=updated_at&amp;order=asc&amp;published=1&amp;q=Friday");
    expect(html).toContain('<th scope="col">Status</th>');
    expect(html).toContain('data-status="live">live</span>');
    expect(html).toContain(`<time datetime="${row.updatedAt.toISOString()}">`);
    const empty = String(jsx(FeaturedPage, { rows: [], query: filtered, now }));
    expect(empty).toContain('colspan="5" data-testid="featured-empty"');
    expect(empty).toContain("No featured content matches these filters.");
  });

  it("keeps the native table in a named keyboard-focusable scroll region with complete UTC bounds", () => {
    const html = String(jsx(FeaturedPage, { rows: [row], query, now }));
    expect(html).toContain('class="featured-table-scroll" role="region" aria-label="Featured content list" aria-describedby="featured-scroll-hint" tabindex="0"');
    expect(html).toContain('id="featured-scroll-hint">Scroll horizontally to see all columns on smaller screens.');
    expect(html).toContain(`<span class="featured-window-bound"><time datetime="${before.toISOString()}">${before.toISOString()}</time></span>`);
    expect(html).toContain(`<span class="featured-window-bound">→ <time datetime="${after.toISOString()}">${after.toISOString()}</time></span>`);
    expect(html).toContain('href="/admin/featured/1">Friday games</a>');
    expect(html.match(/<th\b/g)).toHaveLength(5);
    expect(html.match(/<time\b/g)).toHaveLength(3);
    const open = String(jsx(FeaturedPage, { rows: [{ ...row, startsAt: null, endsAt: null }], query, now }));
    expect(open).toContain('<span class="featured-window-bound">—</span>');
    expect(open).toContain('<span class="featured-window-bound">→ —</span>');
  });

  it("captures one clock for every row in the table and adds the bounded-width table class", () => {
    const html = String(jsx(FeaturedPage, { rows: [row, { ...row, id: 2 }], query, now }));
    expect(html.match(/data-status="live"/g)).toHaveLength(2);
    expect(html).toContain('class="admin-table featured-table"');
  });
});

describe("featured SSR preview", () => {
  it("is byte-identical to the actual homepage article for the same saved row", () => {
    const publicItem = item(row);
    expect(articles(home(row))).toEqual([publicItem]);
    expect(articles(edit(row))).toEqual([publicItem]);
    expect(publicItem).toContain('alt="Friends playing together"');
    expect(publicItem).toContain('href="https://example.test/games"');
    expect(publicItem).toContain("Bring a friend.\nEveryone is welcome.");
  });

  it("preserves long saved content in the scoped wrapping preview without changing the homepage article", () => {
    const saved = { ...row, title: "a".repeat(255), body: `https://example.test/${"a".repeat(400)}` };
    const html = edit(saved);
    expect(html).toContain('class="featured-form"');
    expect(html).toContain('class="featured-preview"');
    expect(articles(html)).toEqual(articles(home(saved)));
    expect(articles(html)?.[0]).toContain(saved.title);
    expect(articles(html)?.[0]).toContain(`<p>${saved.body}</p>`);
    expect(withoutIslands(html)).not.toMatch(/<(?:script|style)\b|\sstyle=|\son\w+=/i);
  });

  it.each(states.filter(([status]) => status !== "live"))("hides %s items", (_status, window) => {
    const saved = { ...row, ...window };
    expect(edit(saved)).toContain('data-testid="featured-preview-hidden"');
    expect(edit(saved)).not.toContain("<article");
  });

  it("labels the last-saved preview, including after an invalid submitted edit", () => {
    const html = edit(row, { title: "Unsaved headline", url: "javascript:alert(1)" }, { url: "Use http(s)." });
    expect(html).toContain("Last saved content");
    expect(html).toContain("Save changes to refresh this preview");
    expect(html).toContain(`<time datetime="${now.toISOString()}">`);
    expect(html).toContain('data-testid="form-errors"');
    expect(articles(html)).toEqual([item(row)]);
  });

  it("does not imply a saved preview on a new form", () => {
    expect(String(jsx(FeaturedFormPage, { mode: "new", values: {}, errors: {}, now, appUrl }))).not.toContain('data-testid="featured-preview"');
  });

  it("renders a minimal card without optional content", () => {
    const html = item({ ...row, body: null, url: null, imageUrl: null, imageAlt: null });
    expect(html).toContain("<h3>Friday games</h3>");
    expect(html).not.toMatch(/<(?:a|img|p)\b/);
  });

  it("escapes content and uses the homepage's image-description fallback", () => {
    const html = item({ ...row, title: '<script>alert("x")</script>', body: "<b>Not HTML</b>", url: null, imageUrl: "data:image/svg+xml,evil" });
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Not HTML&lt;/b&gt;");
    expect(html).not.toMatch(/<(?:script|img|a)\b/);
    expect(item({ ...row, imageAlt: null })).toContain('alt="Friday games"');
  });

  it.each([
    ["https://cdn.discordapp.com/photo.jpg", undefined, "https://cdn.discordapp.com/photo.jpg"],
    ["https://images.unsplash.com/photo.jpg", "images.unsplash.com", "https://images.unsplash.com/photo.jpg"],
    ["https://images.unsplash.com/photo.jpg", undefined, null],
    ["https://next.example.test/photo.jpg", undefined, "/photo.jpg"],
    ["https://images.example.test/photo.jpg", undefined, null],
    ["http://cdn.discordapp.com/photo.jpg", undefined, null],
  ])("shares homepage image rendering policy for %s (hosts: %s)", (imageUrl, imageHosts, src) => {
    const saved = { ...row, imageUrl };
    expect(articles(edit(saved, {}, {}, imageHosts))).toEqual(articles(home(saved, imageHosts)));
    if (src) expect(edit(saved, {}, {}, imageHosts)).toContain(`src="${src}"`);
    else expect(edit(saved, {}, {}, imageHosts)).not.toContain("<img");
  });

  it("has no inline script, stylesheet, style attribute or event handlers", () => {
    for (const html of [edit(row), String(jsx(FeaturedPage, { rows: [row], query, now })), item(row)]) {
      expect(withoutIslands(html)).not.toMatch(/<(?:script|style)\b|\sstyle=|\son\w+=/i);
    }
    expect(edit(row)).toContain('<link rel="stylesheet" href="/styles.css"/>');
  });
});
