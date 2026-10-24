// Kit featured-edit page contract: the Svelte port of FeaturedFormPage
// mode="edit" (src/admin/pages/featured-form.tsx) keeps the Hono panel's
// no-JS behaviour so flipping the manifest entry cannot silently drop a
// control, a field name, a POST destination or the delete action. The Hono
// POST /admin/featured/:id and POST /admin/featured/:id/delete controllers
// stay the single write authorities until a later write slice lands: both
// ported forms keep submitting to the unchanged Hono handlers
// (parseFeaturedForm + updateFeatured/deleteFeatured, 422 re-render / 303
// redirect) during mixed mode. The guarded
// /admin/featured-contents/:id/edit legacy redirect stays Hono-owned too.
//
// Source-text by design: the root Vitest suite cannot compile .svelte, and
// these pins are the exact selectors the admin E2E suite drives.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { featuredStatus } from "../src/featured-status";
import { parseRecordId } from "../src/admin/record-id";
import { resolveKitFeaturedEdit } from "../src/admin/kit-featured-edit";

const source = readFileSync(
  fileURLToPath(
    new URL("../web/src/routes/admin/featured/[id]/+page.svelte", import.meta.url).href,
  ),
  "utf8",
);
const load = readFileSync(
  fileURLToPath(
    new URL("../web/src/routes/admin/featured/[id]/+page.server.ts", import.meta.url).href,
  ),
  "utf8",
);

describe("Kit featured-edit page contract", () => {
  it("posts plain no-JS forms to the Hono-owned edit and delete endpoints", () => {
    expect(source).toContain('method="post"');
    expect(source).toContain("/admin/featured/");
    expect(source).toContain("/delete");
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

  it("keeps the Hono edit controls, hints, actions and delete affordance the E2E suite drives", () => {
    expect(source).toContain('data-testid="save-featured"');
    expect(source).toContain('testId="delete-featured"');
    expect(source).toContain('href="/admin/featured"');
    expect(source).toContain("cdn.discordapp.com");
    expect(source).toContain("screen-reader");
    expect(source).toContain('type="checkbox"');
    expect(source).toContain("Position (lower appears first)");
    expect(source).toContain("Show from (UTC");
    expect(source).toContain("Show until (UTC");
    expect(source).toContain("Save");
    expect(source).toContain("<TerminalReview");
    expect(source).toContain('kind="delete"');
    expect(source).toContain("title={data.view.title}");
  });

  it("keeps the homepage preview with the shared status and the hidden-slot note", () => {
    expect(source).toContain('data-testid="featured-preview"');
    expect(source).toContain("Homepage preview");
    expect(source).toContain("refresh this preview");
    expect(source).toContain("featured-preview-hidden");
    expect(source).toContain("<img");
    expect(source).toContain("href={data.view.previewUrl}");
    expect(source).not.toContain("href={data.view.values.url}");
    expect(source).toContain("value={data.view.values.url}");
  });

  it("renders the preview image through the shared policy with the alt fallback and evaluation time", () => {
    expect(source).toContain("data.view.imageSrc");
    expect(source).toContain("data.view.imageAlt");
    expect(source).toContain('referrerpolicy="no-referrer"');
    expect(source).toContain("data.view.checkedAt");
    expect(source).not.toContain("src={data.view.values.image_url}");
  });

  it("mounts the progressive dirty-draft/double-submit guard island and no client handlers, so repeat submits cannot apply twice with JS and the page works without it", () => {
    expect(source).toContain('data-event-editor=""');
    expect(source).toContain("/islands/admin-event-editor.js");
    expect(source).not.toMatch(/on:[a-z]+=/);
  });

  it("renders inside the admin chrome with the edited title and ships no hydration bundle", () => {
    expect(source).toContain("AdminShell");
    expect(source).toContain("Edit ");
    expect(load).toContain("csr = false");
  });

  it("authorizes through the shared layout guard before doing any work", () => {
    expect(load).toContain("await parent()");
    expect(load).toContain("private, no-store");
  });

  it("maps a missing database and a missing row to the Hono 503/404 outcomes", () => {
    expect(load).toContain("503");
    expect(load).toContain("404");
    expect(load).toContain("Featured content not found");
  });

  it("passes the site origin and image hosts into the preview policy", () => {
    expect(load).toContain("env.APP_URL");
    expect(load).toContain("env.FEATURED_IMAGE_HOSTS");
  });
});

describe("Kit featured-edit route ownership", () => {
  it("registers a disabled GET entry with the Hono edit reads", async () => {
    const { ROUTE_MANIFEST } = await import("../src/route-ownership");
    const entry = ROUTE_MANIFEST.find(
      (r) => r.method === "GET" && r.path === "/admin/featured/:id",
    );
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
});

describe("resolveKitFeaturedEdit", () => {
  const baseRow = {
    id: 7,
    legacyId: null,
    title: "Game night",
    body: "Bring a friend",
    url: null,
    imageUrl: null,
    imageAlt: null,
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

  it.each(["1", "7", "2147483647"])(
    "admits canonical ID %s and reads that record",
    async (rawId) => {
      const get = vi.fn(async () => ({ ...baseRow, id: Number(rawId) }));
      const outcome = await resolveKitFeaturedEdit(rawId, { db: {} as never, get });
      expect(outcome.kind).toBe("ok");
      expect(get).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledWith(expect.anything(), Number(rawId));
    },
  );

  it.each(["", "0", "07", "+7", "7.0", " 7", "7 ", "1e1", "0x1", "-7", "2147483648"])(
    "404s malformed or non-canonical ID %j before any record lookup",
    async (rawId) => {
      const get = vi.fn(async () => baseRow);
      const outcome = await resolveKitFeaturedEdit(rawId, { db: {} as never, get });
      expect(outcome).toEqual({ kind: "notFound" });
      expect(get).not.toHaveBeenCalled();
      expect(parseRecordId(rawId)).toBeNull();
    },
  );

  it("answers unavailable with no database, like the Hono dbOr503 503", async () => {
    const get = vi.fn(async () => baseRow);
    await expect(resolveKitFeaturedEdit("7", { db: null, get })).resolves.toEqual({
      kind: "unavailable",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("404s a missing row and maps a classified outage to unavailable", async () => {
    await expect(
      resolveKitFeaturedEdit("7", { db: {} as never, get: async () => null }),
    ).resolves.toEqual({ kind: "notFound" });
    const outage = Object.assign(new Error("connection terminated"), {
      name: "PostgresError",
      code: "57P01",
    });
    await expect(
      resolveKitFeaturedEdit("7", {
        db: {} as never,
        get: async () => Promise.reject(outage),
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    const boom = new Error("boom");
    await expect(
      resolveKitFeaturedEdit("7", {
        db: {} as never,
        get: async () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
  });

  it("returns the Hono edit view: values, shared status and ISO datetimes", async () => {
    const outcome = await resolveKitFeaturedEdit("7", {
      db: {} as never,
      get: async () => baseRow,
      now: new Date("2026-09-30T20:00:00.000Z"),
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.id).toBe(7);
    expect(outcome.view.values).toMatchObject({
      title: "Game night",
      body: "Bring a friend",
      position: "2",
      is_published: "on",
      starts_at: "",
      ends_at: "",
    });
    expect(outcome.view.status).toBe(featuredStatus(baseRow, new Date("2026-09-30T20:00:00.000Z")));
    expect(outcome.view.updatedAt).toBe("2026-10-01T12:00:00.000Z");
    expect(outcome.view.checkedAt).toBe("2026-09-30T20:00:00.000Z");
    expect(outcome.view.imageSrc).toBeNull();
    expect(outcome.view.imageAlt).toBe("Game night");
  });

  it("suppresses an off-allowlist preview host like the homepage", async () => {
    const outcome = await resolveKitFeaturedEdit("7", {
      db: {} as never,
      get: async () => ({ ...baseRow, imageUrl: "https://evil.example/x.png" }),
      now: new Date("2026-09-30T20:00:00.000Z"),
      appUrl: "https://next.example.test",
      imageHosts: "images.unsplash.com",
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.imageSrc).toBeNull();
  });

  it("keeps an allowlisted-host preview image like the homepage", async () => {
    const outcome = await resolveKitFeaturedEdit("7", {
      db: {} as never,
      get: async () => ({ ...baseRow, imageUrl: "https://images.unsplash.com/x.png" }),
      now: new Date("2026-09-30T20:00:00.000Z"),
      appUrl: "https://next.example.test",
      imageHosts: "images.unsplash.com",
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.imageSrc).toBe("https://images.unsplash.com/x.png");
  });

  it("rewrites a same-site absolute preview URL to a path with the alt fallback", async () => {
    const outcome = await resolveKitFeaturedEdit("7", {
      db: {} as never,
      get: async () => ({
        ...baseRow,
        imageUrl: "https://next.example.test/photo.png",
        imageAlt: "  ",
      }),
      now: new Date("2026-09-30T20:00:00.000Z"),
      appUrl: "https://next.example.test",
      imageHosts: "images.unsplash.com",
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.view.imageSrc).toBe("/photo.png");
    expect(outcome.view.imageAlt).toBe("Game night");
  });
});
