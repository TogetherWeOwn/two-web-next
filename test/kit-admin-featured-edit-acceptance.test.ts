// Acceptance coverage for the featured edit form Kit port (PR #859):
// feat(admin): port featured edit form to SvelteKit behind Hono ownership.
//
// Test-Author card: test files only, no source changes. Written from the
// card spec (edit preview copy, saved link/image render, Hono-ownership
// gating), not from the implementation. The "staged" blocks fail on main
// (the Kit edit files and the disabled manifest entry are absent) and on
// the current #859 head where the preview still diverges from the Hono
// panel it replaces; they pass once the Land card lands #859 with the
// preview at FeaturedContentItem parity. The "served stability" blocks
// pass before and after: the Hono handlers keep answering while the
// manifest entry stays disabled, so landing must not change live traffic.
//
// Source-text by design, like test/kit-admin-featured-edit.test.ts on the
// PR branch: the root Vitest suite cannot compile .svelte, and these pins
// name the exact markup the admin E2E selectors and the homepage preview
// parity depend on.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_MANIFEST, resolveRouteOwner } from "../src/route-ownership";

const ROOT = join(__dirname, "..");
const RESOLVER = join(ROOT, "src/admin/kit-featured-edit.ts");
const PAGE_SERVER = join(ROOT, "web/src/routes/admin/featured/[id]/+page.server.ts");
const PAGE = join(ROOT, "web/src/routes/admin/featured/[id]/+page.svelte");

function readOrFail(path: string): string {
  expect(existsSync(path), `staged file is missing: ${path}`).toBe(true);
  return readFileSync(path, "utf8");
}

function containsAny(source: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(source));
}

const baseRow = {
  id: 7,
  legacyId: null,
  title: "Game night",
  body: "Bring a friend",
  url: "https://example.test/game-night",
  imageUrl: "https://cdn.discordapp.com/attachments/1/2/game.png",
  imageAlt: "Players around a table",
  isPublished: true,
  position: 2,
  startsAt: null,
  endsAt: null,
  createdBy: null,
  createdAt: new Date("2026-10-01T12:00:00.000Z"),
  updatedAt: new Date("2026-10-01T12:00:00.000Z"),
  startsAtText: null,
  endsAtText: null,
};

async function loadResolver() {
  expect(existsSync(RESOLVER), `staged file is missing: ${RESOLVER}`).toBe(true);
  const spec = "../src/admin/kit-featured-edit";
  return import(/* @vite-ignore */ spec);
}

describe("acceptance: Hono-ownership gating (Kit renders, Hono owns mutations)", () => {
  it("ships a disabled GET entry for the edit form with the Hono read declaration", () => {
    const entry = ROUTE_MANIFEST.find(
      (candidate) => candidate.method === "GET" && candidate.path === "/admin/featured/:id",
    );
    expect(entry, "ROUTE_MANIFEST has no GET /admin/featured/:id entry").toBeDefined();
    expect(entry).toMatchObject({
      method: "GET",
      path: "/admin/featured/:id",
      enabled: false,
      reads: {
        resource: "featured_contents",
        action: "view",
        route: "admin.featured.edit",
      },
    });
  });

  it("keeps resolving edit reads and every mutation verb to Hono while disabled", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/admin/featured/7" })).toBe("hono");
    expect(resolveRouteOwner({ method: "HEAD", path: "/admin/featured/7" })).toBe("hono");
    expect(resolveRouteOwner({ method: "POST", path: "/admin/featured/7" })).toBe("hono");
    expect(resolveRouteOwner({ method: "POST", path: "/admin/featured/7/delete" })).toBe("hono");
    expect(
      ROUTE_MANIFEST.some(
        (entry) => entry.method === "POST" && entry.path.startsWith("/admin/featured"),
      ),
      "manifest must carry no Kit-owned featured mutation",
    ).toBe(false);
  });

  it("stages a read-only Kit load: no form actions and no write-store imports", () => {
    const source = readOrFail(PAGE_SERVER);
    expect(source, "Kit load must not define SvelteKit form actions").not.toMatch(
      /export\s+const\s+actions/,
    );
    expect(
      source,
      "Kit load must not import a Hono write authority (update/delete/create/parse)",
    ).not.toMatch(
      /import[^;]*\b(updateFeatured|deleteFeatured|createFeatured|parseFeaturedForm)\b/,
    );
    expect(source, "Kit load must read through the shared getFeatured").toContain("getFeatured");
  });

  it("posts both ported forms to the unchanged Hono endpoints, never to a Kit action", () => {
    const source = readOrFail(PAGE);
    expect(source).toContain('method="post"');
    expect(source).toContain("action={`/admin/featured/${data.view.id}`}");
    expect(source).toContain("action={`/admin/featured/${data.view.id}/delete`}");
    expect(source, "forms must not target a SvelteKit ?/ action").not.toContain("?/");
    expect(source, "delete must stay a POST form, never a link").not.toMatch(
      /<a[^>]+href=\{`\/admin\/featured\/\$\{data\.view\.id\}\/delete`\}/,
    );
  });
});

describe("acceptance: edit preview copy", () => {
  it("resolver separates the checked-at instant from the last-saved instant", async () => {
    const { resolveKitFeaturedEdit } = await loadResolver();
    const now = new Date("2026-10-14T09:30:00.000Z");
    const outcome = await resolveKitFeaturedEdit("7", {
      db: {} as never,
      get: async () => baseRow,
      now,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("expected ok");
    const view = outcome.view as { checkedAt?: string; updatedAt: string };
    // The Hono panel renders "checked at {now}", not the row's updatedAt:
    // the two instants differ whenever the slot was saved before the view.
    expect(view.checkedAt, "view carries no checkedAt instant").toBe(now.toISOString());
    expect(view.updatedAt).toBe(baseRow.updatedAt.toISOString());
    expect(view.checkedAt).not.toBe(view.updatedAt);
  });

  it("renders the preview checked-at copy from checkedAt, not from updatedAt", () => {
    const source = readOrFail(PAGE);
    expect(source).toContain("Last saved content, checked at");
    expect(source).toContain("Save changes to refresh this preview.");
    expect(
      containsAny(source, [
        /<time[^>]*datetime=\{data\.view\.checkedAt\}/,
        /<time[^>]*datetime=\{checkedAt\}/,
      ]),
      "preview time element must bind the checked-at instant",
    ).toBe(true);
    expect(
      source,
      "preview must not present the last-saved instant as the checked-at instant",
    ).not.toMatch(/checked at\s*<time[^>]*datetime=\{data\.view\.updatedAt\}/);
  });
});

describe("acceptance: saved link/image render in the preview", () => {
  it("renders the saved slot as the homepage featured item, with the headline as the link", () => {
    const source = readOrFail(PAGE);
    expect(source, "preview must reuse the homepage item testid").toContain(
      'data-testid="featured-item"',
    );
    expect(source, "preview item must be an article card like the homepage item").toMatch(
      /<article[^>]*class="card"/,
    );
    expect(
      containsAny(source, [
        /<a href=\{data\.view\.values\.url\}>\{data\.view\.title\}<\/a>/,
        /<a href=\{data\.view\.values\.url\}>\s*\{data\.view\.title\}\s*<\/a>/,
      ]),
      "saved link must wrap the saved headline, as FeaturedContentItem renders it",
    ).toBe(true);
    expect(
      source,
      "preview must not render a bare 'Link' anchor instead of the headline",
    ).not.toContain(">Link</a>");
  });

  it("renders the saved image through the shared image policy, not the raw saved URL", () => {
    const source = readOrFail(PAGE);
    expect(
      source,
      "preview image must go through featuredImageSrc so blocked hosts are suppressed",
    ).toContain("featuredImageSrc(");
    expect(
      source,
      "preview must not render the raw saved image_url (bypasses the host policy)",
    ).not.toContain("src={data.view.values.image_url}");
  });

  it("falls back to the headline for empty image alt text and keeps the homepage image shape", () => {
    const source = readOrFail(PAGE);
    expect(
      containsAny(source, [
        /image_alt\?\.trim\(\)\s*\|\|\s*data\.view\.title/,
        /imageAlt\?\.trim\(\)\s*\|\|\s*data\.view\.title/,
        /alt=\{[^}]*\|\|\s*data\.view\.title\s*\}/,
      ]),
      "image alt must fall back to the headline when the saved description is blank",
    ).toBe(true);
    expect(source).toContain('class="featured-image"');
    expect(source).toContain('width="640"');
    expect(source).toContain('height="360"');
  });

  it("resolver keeps a hidden slot hidden: visible stays false for an unpublished slot", async () => {
    const { resolveKitFeaturedEdit } = await loadResolver();
    const outcome = await resolveKitFeaturedEdit("7", {
      db: {} as never,
      get: async () => ({ ...baseRow, isPublished: false }),
      now: new Date("2026-10-14T09:30:00.000Z"),
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.visible).toBe(false);
    const source = readOrFail(PAGE);
    expect(source, "hidden slots must render the hidden-slot note, not saved link/image").toContain(
      'data-testid="featured-preview-hidden"',
    );
  });
});
