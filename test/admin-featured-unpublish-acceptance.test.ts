// Acceptance: admin unpublish from the featured list without revalidating
// the whole row.
//
// A moderator-only POST action alongside /featured/:id/delete sets only
// isPublished=false for one featured row. It is body-capped and throttled
// like the sibling action routes, admits only a canonical record ID, answers
// 404 for unknown/non-canonical IDs, and never revalidates any other stored
// field: a published row whose stored image host would fail today's
// full-form validation must still unpublish (that stale field is exactly why
// the full edit POST cannot pull the slot today). The stored row is
// otherwise byte-identical, a dirty-only audit + homepage-cache retirement
// are observed, and a second POST on an already-unpublished row is the pinned
// no-op: same success envelope, no new audit row. The list renderers (Hono
// FeaturedPage and the Kit twin) expose the action only on published rows.
//
// FAIL-FIRST: the unpublish acceptance proofs began RED — the route did
// not exist (404 where 303 is pinned), no list form targeted it, and the Kit
// source carried no such form. The guard/cap/no-op/unknown-ID pins that only
// name the outer shape (401/403 before the route table, 404 for unknown IDs)
// pass both before and after and stop a build from widening those edges.
//
// Registration/rendering proofs run without a database. The unchanged DB
// acceptance cases live under the existing integration gate in admin.test.ts.
// Run both files with a run-owned disposable DB for the full acceptance proof.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { FeaturedPage } from "../src/admin/pages";
import { adminApp } from "../src/admin/routes";
import type { FeaturedRow } from "../src/admin/store";
import { parseFeaturedListQuery } from "../src/admin/table-list";
import { createMemorySessionStore } from "../src/sessions";
import { isThrottleMiddleware } from "../src/throttle";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

describe("unpublish route registration", () => {
  it("registers POST /featured/:id/unpublish behind the shared throttle middleware, like the sibling delete", () => {
    const app = adminApp({ sessionStore: createMemorySessionStore() });
    const hits = app.routes.filter(
      (r) => r.method === "POST" && r.path === "/featured/:id/unpublish",
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((r) => isThrottleMiddleware(r.handler))).toBe(true);
    // Sibling sanity: the delete action this route sits alongside is
    // registered the same way today, so the pin above names a real pattern.
    const sibling = app.routes.filter(
      (r) => r.method === "POST" && r.path === "/featured/:id/delete",
    );
    expect(sibling.some((r) => isThrottleMiddleware(r.handler))).toBe(true);
  });
});

describe("featured list renderers expose unpublish only on published rows", () => {
  const now = new Date("2026-10-26T12:00:00.000Z");
  const base: FeaturedRow = {
    id: 7,
    legacyId: null,
    title: "Published slot",
    body: "Body",
    url: null,
    imageUrl: null,
    imageAlt: null,
    isPublished: true,
    position: 1,
    startsAt: null,
    endsAt: null,
    createdBy: null,
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    updatedAt: new Date("2026-10-01T12:00:00.000Z"),
  };
  const renderHono = (rows: FeaturedRow[]) =>
    String(jsx(FeaturedPage, { rows, query: parseFeaturedListQuery({}), now }));
  const unpublishForm = (id: number) =>
    new RegExp(
      `<form[^>]*method="post"[^>]*action="/admin/featured/${id}/unpublish"|<form[^>]*action="/admin/featured/${id}/unpublish"[^>]*method="post"`,
    );

  it("Hono list: published row carries a POST unpublish form to /admin/featured/:id/unpublish", () => {
    const html = renderHono([base]);
    expect(html).toContain(`data-testid="featured-status-${base.id}"`);
    expect(html).toMatch(unpublishForm(base.id));
    expect(html).toMatch(/>\s*Unpublish\s*<\/button>/);
  });

  it("Hono list: unpublished row carries no unpublish form (action visibility follows isPublished)", () => {
    const draft = { ...base, id: 8, title: "Draft slot", isPublished: false };
    const html = renderHono([draft]);
    expect(html).toContain(`data-testid="featured-status-${draft.id}"`);
    expect(html).not.toMatch(unpublishForm(draft.id));
    expect(html).not.toContain("/unpublish");
  });

  it("Kit list: the Svelte twin posts published rows to the same Hono unpublish endpoint", () => {
    const source = read("web/src/routes/admin/featured/+page.svelte");
    expect(source).toContain("unpublish");
    expect(source).toMatch(
      /<form[^>]*method="post"[^>]*action=\{`\/admin\/featured\/\$\{r\.id\}\/unpublish`\}/,
    );
    expect(source).toMatch(/>\s*Unpublish\s*<\/button>/);
  });
});
