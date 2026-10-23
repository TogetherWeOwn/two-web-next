// Kit featured-new page contract: the Svelte port of FeaturedFormPage
// mode="new" (src/admin/pages/featured-form.tsx) keeps the Hono panel's
// no-JS behaviour so flipping the manifest entry cannot silently drop a
// control, a field name or the Hono POST destination. The Hono
// POST /admin/featured controller stays the single write authority until
// the edit slice lands: this form posts to it with the exact Hono field
// names, and Hono's parseFeaturedForm owns validation.
//
// Source-text by design: the root Vitest suite cannot compile .svelte, and
// these pins are the exact selectors the admin E2E suite drives.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../web/src/routes/admin/featured/new/+page.svelte", import.meta.url).href),
  "utf8",
);
const load = readFileSync(
  fileURLToPath(
    new URL("../web/src/routes/admin/featured/new/+page.server.ts", import.meta.url).href,
  ),
  "utf8",
);

describe("Kit featured-new page contract", () => {
  it("posts a plain no-JS form to the Hono-owned create endpoint", () => {
    expect(source).toContain('<form method="post" action="/admin/featured"');
    expect(source).not.toContain("on:submit");
    expect(source).not.toContain("onsubmit");
  });

  it("keeps every Hono field name the server validator reads", () => {
    for (const name of [
      "title",
      "body",
      "url",
      "image_url",
      "image_alt",
      "is_published",
      "position",
      "starts_at",
      "ends_at",
    ]) {
      expect(source).toContain(`name="${name}"`);
    }
  });

  it("keeps the Hono field controls, hints and actions the E2E suite drives", () => {
    expect(source).toContain('data-testid="save-featured"');
    expect(source).toContain('href="/admin/featured"');
    expect(source).toContain("cdn.discordapp.com");
    expect(source).toContain("screen-reader");
    expect(source).toContain('type="checkbox"');
    expect(source).toContain("Position (lower appears first)");
    expect(source).toContain("Show from (UTC");
    expect(source).toContain("Show until (UTC");
  });

  it("mounts the progressive dirty-draft guard island and no client handlers, so the page works with JavaScript disabled", () => {
    expect(source).toContain('data-event-editor=""');
    expect(source).toContain("/islands/admin-event-editor.js");
    expect(source).not.toMatch(/on:[a-z]+=/);
  });

  it("renders inside the admin chrome with its own title and ships no hydration bundle", () => {
    expect(source).toContain("<AdminShell");
    expect(source).toContain('title="New featured slot"');
    expect(source).toContain("<h1>New featured slot</h1>");
    expect(load).toContain("csr = false");
  });

  it("authorizes through the shared layout guard before doing any work", () => {
    expect(load).toContain("await parent()");
    expect(load).toContain("private, no-store");
  });
});

describe("Kit featured-new route ownership", () => {
  it("registers a disabled GET entry with the Hono create reads", async () => {
    const { ROUTE_MANIFEST } = await import("../src/route-ownership");
    const entry = ROUTE_MANIFEST.find(
      (r) => r.method === "GET" && r.path === "/admin/featured/new",
    );
    expect(entry).toMatchObject({
      method: "GET",
      path: "/admin/featured/new",
      enabled: false,
      reads: {
        resource: "featured_contents",
        action: "view",
        route: "admin.featured.create",
      },
    });
  });
});
