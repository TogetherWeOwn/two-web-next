// Kit events-list page contract: the Svelte port of EventsPage
// (src/admin/pages/events-list.tsx) keeps the Hono panel's no-JS behaviour
// and keyboard/mobile table-scroll affordances, so flipping the manifest
// entry cannot silently drop a control, a testid or the scroll region.
//
// Source-text by design: the root Vitest suite cannot compile .svelte, and
// these pins are the exact selectors the admin E2E suite drives.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../web/src/routes/admin/events/+page.svelte", import.meta.url).href),
  "utf8",
);

describe("Kit events-list page contract", () => {
  it("filters through a plain GET form with every Hono field", () => {
    expect(source).toContain('<form method="get" action="/admin/events"');
    for (const name of ["q", "status", "rsvp_open", "series", "fill", "sort", "order"]) {
      expect(source).toContain(`name="${name}"`);
    }
    expect(source).toContain('data-testid="new-event"');
  });

  it("keeps the keyboard/mobile table-scroll region and table testids", () => {
    expect(source).toContain('data-testid="events-table-scroll"');
    expect(source).toContain('role="region"');
    expect(source).toContain('aria-label="Events list"');
    expect(source).toContain("tabindex={0}");
    expect(source).toContain('data-testid="events-table"');
    expect(source).toContain('data-testid="events-empty"');
  });

  it("keeps the sort, fill and paging controls the E2E suite drives", () => {
    expect(source).toContain("aria-sort=");
    expect(source).toContain("event-status-");
    expect(source).toContain("event-fill-");
    expect(source).toContain('rel="prev"');
    expect(source).toContain('rel="next"');
    expect(source).toContain('aria-label="Event pages"');
  });

  it("submits row actions to the Hono-owned mutation endpoints", () => {
    expect(source).toContain("/publish");
    expect(source).toContain("/cancel");
    expect(source).toContain("rsvp-pause");
    expect(source).toContain("rsvp-reopen");
    expect(source).not.toContain("on:click");
    expect(source).not.toContain("onclick");
  });

  it("ships no island script, so the page works with JavaScript disabled", () => {
    // Served /islands/*.js scripts only: the goingCountText source import is
    // a pure helper bundled into SSR output, never a browser script tag.
    expect(source).not.toMatch(/\/islands\/[a-z0-9-]+\.js/);
    expect(source).not.toMatch(/<script src=/);
    expect(source).not.toMatch(/on:[a-z]+=/);
  });

  it("renders inside the admin chrome with its own title and ships no hydration bundle", () => {
    // Group outlet carries no chrome of its own: children own their titles,
    // the Kit twin of the Hono Shell titles. csr=false disables hydration on
    // first load, like the Hono panel that ships no JavaScript.
    expect(source).toContain('<AdminShell title="Events" restoredWrite={data.restoredWrite}>');
    const load = readFileSync(
      fileURLToPath(
        new URL("../web/src/routes/admin/events/+page.server.ts", import.meta.url).href,
      ),
      "utf8",
    );
    expect(load).toContain("csr = false");
  });
});
