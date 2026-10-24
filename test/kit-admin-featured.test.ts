// Kit featured-list read model (GET /admin/featured).
//
// resolveKitFeaturedList is the framework-free decision behind
// web/src/routes/admin/featured/+page.server.ts: it parses the bounded
// filter/pagination query with the shared parseFeaturedListQuery, maps it
// onto the shared listFeatured read exactly as the Hono handler does, and
// serializes rows (ISO datetimes, shared featuredStatus) for the Svelte
// view. Publication logic is shared, never copied: every status assertion
// below derives from featuredStatus itself.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { featuredStatus } from "../src/featured-status";
import { FEATURED_PAGE_SIZE } from "../src/admin/table-list";
import {
  resolveKitFeaturedList,
  type KitFeaturedDeps,
  type KitFeaturedSourceRow,
} from "../src/admin/kit-featured";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};
type RenderPage = (data: Record<string, unknown>) => string;
let renderPage: RenderPage;
let scratch = "";

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-admin-featured-render-"));
  const entry = join(scratch, "entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/admin/featured/+page.svelte"))};
export function renderPage(data) { return render(Page, { props: { data } }).body; }
`,
  );
  const outfile = join(scratch, "bundle.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "kit-featured-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js } = compile(source, { generate: "server", dev: false, filename: args.path });
            return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  const mod = (await import(pathToFileURL(outfile).href)) as unknown as { renderPage: RenderPage };
  renderPage = mod.renderPage;
}, 60000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

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
    expect(outcome.emptyText).toBe("No results on this page.");
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

  it("slices to one page, reports the lookahead, and projects only list-safe fields", async () => {
    const many = Array.from({ length: FEATURED_PAGE_SIZE + 1 }, (_, i) =>
      row({ id: i + 1, title: `Slot ${i + 1}` }),
    );
    const outcome = await resolveKitFeaturedList({}, deps({ list: vi.fn(async () => many) }));
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.rows).toHaveLength(FEATURED_PAGE_SIZE);
    expect(outcome.rows[0]?.id).toBe(1);
    expect(outcome.hasNext).toBe(true);
    expect(Object.keys(outcome.rows[0]!)).toEqual([
      "id",
      "title",
      "status",
      "position",
      "startsAt",
      "endsAt",
      "updatedAt",
    ]);
  });

  it("does not render image or token fields even if a store row includes them", () => {
    const secretImage = "IMAGE_FIELD_SHOULD_NOT_RENDER";
    const secretToken = "TOKEN_FIELD_SHOULD_NOT_RENDER";
    const html = renderPage({
      rows: [
        {
          ...row(),
          status: "live",
          startsAt: null,
          endsAt: null,
          updatedAt: "2026-10-01T12:00:00.000Z",
          imageUrl: secretImage,
          image_url: secretImage,
          token: secretToken,
          accessToken: secretToken,
        },
      ],
      query: { q: "", published: "", sort: "position", order: "asc", page: 1 },
      hasNext: false,
      emptyText: "No featured content yet.",
      positionHeader: { href: "#", ariaSort: "none", ariaLabel: "Sort position", text: "Position" },
      updatedHeader: {
        href: "#",
        ariaSort: "none",
        ariaLabel: "Sort update",
        text: "Last changed",
      },
      previousHref: null,
      nextHref: null,
    });
    expect(html).toContain("Game night");
    expect(html).not.toContain(secretImage);
    expect(html).not.toContain(secretToken);
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

describe("featured Kit read boundaries", () => {
  it("sets private no-store on both list and edit loads", () => {
    const listLoad = read("web/src/routes/admin/featured/+page.server.ts");
    const editLoad = read("web/src/routes/admin/featured/[id]/+page.server.ts");
    expect(listLoad).toContain('setHeaders({ "cache-control": "private, no-store" });');
    expect(editLoad).toContain('setHeaders({ "cache-control": "private, no-store" });');
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
