// Kit featured-list read model (GET /admin/featured).
//
// resolveKitFeaturedList is the framework-free decision behind
// web/src/routes/admin/featured/+page.server.ts: it parses the bounded
// filter/pagination query with the shared parseFeaturedListQuery, maps it
// onto the shared listFeatured read exactly as the Hono handler does, and
// serializes rows (ISO datetimes, shared featuredStatus) for the Svelte
// view. Publication logic is shared, never copied: every status assertion
// below derives from featuredStatus itself.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { featuredStatus } from "../src/featured-status";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");
import { FEATURED_PAGE_SIZE } from "../src/admin/table-list";
import {
  resolveKitFeaturedList,
  type KitFeaturedDeps,
  type KitFeaturedSourceRow,
} from "../src/admin/kit-featured";

function row(overrides: Partial<KitFeaturedSourceRow> = {}): KitFeaturedSourceRow {
  return {
    id: 7,
    title: "Game night",
    isPublished: true,
    position: 3,
    startsAt: null,
    endsAt: null,
    updatedAt: new Date("2026-10-01T12:00:00.000Z"),
    ...overrides,
  };
}

function deps(overrides: Partial<KitFeaturedDeps> = {}) {
  const list = vi.fn(async (): Promise<KitFeaturedSourceRow[]> => [row()]);
  return { db: {} as never, list, ...overrides };
}

describe("resolveKitFeaturedList", () => {
  it("answers unavailable with no database, like the Hono dbOr503 503", async () => {
    const d = deps({ db: null });
    await expect(resolveKitFeaturedList({}, d)).resolves.toEqual({ kind: "unavailable" });
    expect(d.list).not.toHaveBeenCalled();
  });

  it("maps a classified database outage to unavailable, and rethrows anything else", async () => {
    const outage = Object.assign(new Error("connection terminated"), {
      name: "PostgresError",
      code: "57P01",
    });
    await expect(
      resolveKitFeaturedList({}, deps({ list: vi.fn(async () => Promise.reject(outage)) })),
    ).resolves.toEqual({ kind: "unavailable" });
    const boom = new Error("boom");
    await expect(
      resolveKitFeaturedList({}, deps({ list: vi.fn(async () => Promise.reject(boom)) })),
    ).rejects.toBe(boom);
  });

  it("passes the Hono read shape: published flag mapped, page through, one lookahead row", async () => {
    const d = deps({ list: vi.fn(async () => []) });
    const outcome = await resolveKitFeaturedList(
      { published: "1", q: "  night ", sort: "updated_at", order: "desc", page: "2" },
      d,
    );
    expect(d.list).toHaveBeenCalledWith(d.db, {
      published: true,
      q: "night",
      sort: "updated_at",
      order: "desc",
      page: 2,
    });
    expect(outcome).toMatchObject({ kind: "ok", rows: [], hasNext: false });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.emptyText).toBe("No featured content matches these filters.");
  });

  it("leaves the published filter absent when unselected, like the Hono spread", async () => {
    const d = deps({ list: vi.fn(async () => []) });
    await resolveKitFeaturedList({ q: "", sort: "position", order: "asc" }, d);
    expect(d.list).toHaveBeenCalledWith(d.db, {
      published: undefined,
      q: "",
      sort: "position",
      order: "asc",
      page: 1,
    });
  });

  it("slices to one page and reports the lookahead, mirroring the Hono slice", async () => {
    const many = Array.from({ length: FEATURED_PAGE_SIZE + 1 }, (_, i) =>
      row({ id: i + 1, title: `Slot ${i + 1}` }),
    );
    const outcome = await resolveKitFeaturedList({}, deps({ list: vi.fn(async () => many) }));
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.rows).toHaveLength(FEATURED_PAGE_SIZE);
    expect(outcome.rows[0]?.id).toBe(1);
    expect(outcome.hasNext).toBe(true);
  });

  it("serializes datetimes as UTC ISO strings with null bounds kept null", async () => {
    const outcome = await resolveKitFeaturedList(
      {},
      deps({
        list: vi.fn(async () => [
          row({
            startsAt: new Date("2026-10-02T00:00:00.000Z"),
            endsAt: null,
          }),
        ]),
      }),
    );
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.rows[0]).toMatchObject({
      startsAt: "2026-10-02T00:00:00.000Z",
      endsAt: null,
      updatedAt: "2026-10-01T12:00:00.000Z",
    });
  });

  it("shares the homepage publication logic: status equals featuredStatus for every window", async () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const windows = [
      row({ isPublished: true }),
      row({ isPublished: true, startsAt: new Date("2026-10-06T00:00:00.000Z") }),
      row({ isPublished: true, endsAt: new Date("2026-10-05T00:00:00.000Z") }),
      row({ isPublished: false }),
    ];
    const outcome = await resolveKitFeaturedList(
      {},
      deps({ now, list: vi.fn(async () => windows) }),
    );
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.rows.map((r) => r.status)).toEqual([
      "live",
      "scheduled",
      "expired",
      "unpublished",
    ]);
    for (const [i, w] of windows.entries()) {
      expect(outcome.rows[i]?.status).toBe(featuredStatus(w, now));
    }
  });

  it("invites creation on a genuine empty, naming filters only when filtered", async () => {
    const empty = deps({ list: vi.fn(async () => []) });
    const bare = await resolveKitFeaturedList({}, empty);
    if (bare.kind !== "ok") throw new Error("expected ok");
    expect(bare.emptyText).toBe("No featured content yet.");
  });
});

describe("featured Kit chrome (per-child AdminShell)", () => {
  // The admin group outlet carries no chrome of its own (see
  // test/kit-activity-log.test.ts): each child wraps itself so a new slice
  // never inherits the wrong tab title during mixed mode. This pins the
  // featured slice's own title, the Kit twin of its Hono Shell title.
  it("wraps itself in its own AdminShell title", () => {
    expect(read("web/src/routes/admin/featured/+page.svelte")).toContain(
      '<AdminShell title="Featured content">',
    );
  });
});
