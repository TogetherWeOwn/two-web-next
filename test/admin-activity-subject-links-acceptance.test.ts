// Moderator navigation acceptance: activity-log subject links (U1, criterion 1).
// Both activity-log twins link validated Next-written subjects directly to
// their canonical saved editors; unknown/legacy/malformed types or IDs stay
// inert escaped text. Next writes exactly two subject shapes (established by
// src/admin/store-event-writes.ts and src/admin/store-featured.ts):
// ("Event", uppercase ULID eventKey) and ("FeaturedContent", decimal row id).
// Canonical editors: GET /admin/events/:key and GET /admin/featured/:id
// (src/admin/routes.tsx; the /:key/edit form is a legacy redirect, not the
// canonical target). The resolver must be strict and read-free: no legacy
// morph guessing, no lookup reads. The well-formed-but-nonexistent key case
// below proves the read-free half: a resolver that looked rows up would
// leave a missing row inert, but the contract links on shape alone.
// Fixture-only: both real renderers (Hono JSX + Kit SSR), no DATABASE_URL,
// no network, no browser. Twin parity pins the shared semantics without
// pinning the builder's module path.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActivityLogPage } from "../src/admin/pages/activity-log";
import type { ActivityLogViewerRow } from "../src/admin/reads";
import { activityLogEmptyText, type ActivityLogQuery } from "../src/admin/table-list";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

// Established fixture key (admin-activity-log.test.ts): uppercase ULID, the
// exact form newEventKey mints. MISSING_KEY is shape-valid but stored
// nowhere; EXPECTED links for it prove resolution needs no lookup read.
const EVENT_KEY = "01J00000000000000000000015";
const MISSING_KEY = "01K00000000000000000000099";
const FEATURED_ID = "42";
const CAUSER = "123456789012345678";
const AT = new Date("2026-10-20T12:00:00.000Z");
const QUERY: ActivityLogQuery = { subject: "", causer: "", page: 1 };

type SubjectCase = {
  name: string;
  subjectType: string | null;
  subjectId: string | null;
  /** Expected editor href, or null when the subject must stay inert text. */
  href: string | null;
};

const LINKED: SubjectCase[] = [
  {
    name: "Event with a canonical ULID key",
    subjectType: "Event",
    subjectId: EVENT_KEY,
    href: `/admin/events/${EVENT_KEY}`,
  },
  {
    name: "Event with a shape-valid but nonexistent key (no lookup read)",
    subjectType: "Event",
    subjectId: MISSING_KEY,
    href: `/admin/events/${MISSING_KEY}`,
  },
  {
    name: "FeaturedContent with a decimal row id",
    subjectType: "FeaturedContent",
    subjectId: FEATURED_ID,
    href: `/admin/featured/${FEATURED_ID}`,
  },
];

const INERT: SubjectCase[] = [
  { name: "null subject type", subjectType: null, subjectId: FEATURED_ID, href: null },
  { name: "null subject id", subjectType: "Event", subjectId: null, href: null },
  { name: "null subject pair", subjectType: null, subjectId: null, href: null },
  { name: "unknown subject type", subjectType: "Webhook", subjectId: "1", href: null },
  { name: "legacy Laravel morph", subjectType: "App\\Models\\Event", subjectId: "15", href: null },
  { name: "lowercase event type", subjectType: "event", subjectId: EVENT_KEY, href: null },
  { name: "plural event type", subjectType: "events", subjectId: EVENT_KEY, href: null },
  { name: "legacy numeric event id", subjectType: "Event", subjectId: "15", href: null },
  { name: "empty event id", subjectType: "Event", subjectId: "", href: null },
  { name: "blank event id", subjectType: "Event", subjectId: "not a key!", href: null },
  {
    name: "truncated ULID",
    subjectType: "Event",
    subjectId: "01J0000000000000000000001",
    href: null,
  },
  {
    name: "lowercase ULID (never the minted form)",
    subjectType: "Event",
    subjectId: EVENT_KEY.toLowerCase(),
    href: null,
  },
  {
    name: "padded ULID",
    subjectType: "Event",
    subjectId: ` ${EVENT_KEY} `,
    href: null,
  },
  { name: "path traversal id", subjectType: "Event", subjectId: "../../admin", href: null },
  {
    name: "script-bearing id",
    subjectType: "Event",
    subjectId: '"><script>alert(1)</script>',
    href: null,
  },
  {
    name: "markup-bearing type",
    subjectType: "<img src=x onerror=alert(1)>",
    subjectId: FEATURED_ID,
    href: null,
  },
  { name: "empty featured id", subjectType: "FeaturedContent", subjectId: "", href: null },
  { name: "non-numeric featured id", subjectType: "FeaturedContent", subjectId: "abc", href: null },
  { name: "negative featured id", subjectType: "FeaturedContent", subjectId: "-3", href: null },
  { name: "decimal featured id", subjectType: "FeaturedContent", subjectId: "4.5", href: null },
  { name: "zero featured id", subjectType: "FeaturedContent", subjectId: "0", href: null },
  { name: "padded featured id", subjectType: "FeaturedContent", subjectId: " 42", href: null },
  { name: "ULID featured id", subjectType: "FeaturedContent", subjectId: EVENT_KEY, href: null },
];

type RenderKit = (data: Record<string, unknown>) => string;
let renderKit: RenderKit;
let scratch = "";

// Same real SSR compilation recipe as
// admin-dashboard-twin-parity-acceptance.test.ts. No route load, database,
// network, browser opt-in, source-grep assertions or renderer mocks.
beforeAll(async () => {
  scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "activity-links-twin-ssr-"),
  );
  const entry = join(scratch, "entry.mjs");
  writeFileSync(
    entry,
    `import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/admin/activity-log/+page.svelte"))};
export function renderKit(data) { return render(Page, { props: { data } }).body; }
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
    tsconfigRaw: {},
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "activity-links-twin-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const { js } = compile(readFileSync(args.path, "utf8"), {
              generate: "server",
              dev: false,
              filename: args.path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  const mod = (await import(pathToFileURL(outfile).href)) as { renderKit: RenderKit };
  renderKit = mod.renderKit;
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function honoRow(c: SubjectCase): ActivityLogViewerRow {
  return {
    id: 7,
    description: "updated event Friday games",
    subjectType: c.subjectType,
    subjectId: c.subjectId,
    causerId: CAUSER,
    event: "updated",
    createdAt: AT,
  };
}

const renderers = [
  {
    name: "Hono",
    render(cases: SubjectCase[], query: ActivityLogQuery = QUERY, hasNext = false) {
      return String(jsx(ActivityLogPage, { rows: cases.map(honoRow), query, hasNext }));
    },
  },
  {
    name: "Kit",
    render(cases: SubjectCase[], query: ActivityLogQuery = QUERY, hasNext = false) {
      return renderKit({
        rows: cases.map((c) => ({ ...honoRow(c), createdAt: AT.toISOString() })),
        query,
        hasNext,
      });
    },
  },
];

type Element = { attrs: string; body: string };
// Test-only markup walkers, mirroring the dashboard twin acceptance: the
// text walker advances token by token instead of a `<...>` regex replace so
// the helper does not read as an HTML sanitizer.
function text(html: string): string {
  let out = "";
  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[index] === "<") {
      const close = html.indexOf(">", index);
      if (close === -1) break;
      index = close + 1;
      continue;
    }
    const next = html.indexOf("<", index);
    out += html.slice(index, next === -1 ? html.length : next);
    index = next === -1 ? html.length : next;
  }
  return out.replace(/\s+/g, " ").trim();
}
const attr = (element: Element, name: string) =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(element.attrs)?.[1];
const elements = (html: string, tag: string): Element[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => ({
    attrs: match[1]!,
    body: match[2]!,
  }));

/** Subject cells are the fourth column of every body row, in render order. */
function subjectCells(html: string): Element[] {
  return elements(html, "tr")
    .map((row) => elements(row.body, "td"))
    .filter((cells) => cells.length === 4)
    .map((cells) => cells[3]!);
}

for (const renderer of renderers) {
  describe(`${renderer.name} activity-log subject links`, () => {
    it.each(LINKED)("links $name to its canonical saved editor", (c) => {
      const cells = subjectCells(renderer.render([c]));
      expect(cells).toHaveLength(1);
      const links = elements(cells[0]!.body, "a");
      expect(links, "exactly one native anchor in the subject cell").toHaveLength(1);
      expect(attr(links[0]!, "href")).toBe(c.href);
      expect(
        text(links[0]!.body).length,
        "link carries a meaningful keyboard name",
      ).toBeGreaterThan(0);
    });

    it.each(INERT)("leaves $name inert", (c) => {
      const cells = subjectCells(renderer.render([c]));
      expect(cells).toHaveLength(1);
      expect(elements(cells[0]!.body, "a")).toHaveLength(0);
    });

    it("escapes hostile subjects instead of linking or executing them", () => {
      const hostile = INERT.filter(
        (c) => c.subjectId?.includes("<") || c.subjectType?.includes("<"),
      );
      expect(hostile.length).toBeGreaterThan(0);
      const html = renderer.render(hostile);
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;");
      for (const cell of subjectCells(html)) {
        expect(elements(cell.body, "a")).toHaveLength(0);
      }
    });

    it("keeps the event suffix visible next to a linked subject", () => {
      const cells = subjectCells(renderer.render([LINKED[0]!]));
      expect(text(cells[0]!.body)).toContain("(updated)");
    });

    it("links every row of a mixed page independently", () => {
      const page = [LINKED[0]!, INERT[4]!, LINKED[2]!, INERT[7]!];
      const cells = subjectCells(renderer.render(page));
      expect(cells).toHaveLength(4);
      for (const [index, c] of page.entries()) {
        const links = elements(cells[index]!.body, "a");
        if (c.href === null) {
          expect(links, c.name).toHaveLength(0);
        } else {
          expect(
            links.map((link) => attr(link, "href")),
            c.name,
          ).toEqual([c.href]);
        }
      }
    });
  });

  describe(`${renderer.name} activity-log unchanged controls`, () => {
    const html = () => renderer.render([LINKED[0]!]);

    it("keeps the Who/What/When/Subject columns", () => {
      const headers = elements(html(), "th").map((header) => text(header.body));
      expect(headers).toEqual(["Who", "What", "When", "Subject"]);
    });

    it("keeps the read-only GET filter form", () => {
      const page = html();
      const forms = elements(page, "form");
      expect(forms).toHaveLength(1);
      expect(attr(forms[0]!, "method")).toBe("get");
      expect(attr(forms[0]!, "action")).toBe("/admin/activity-log");
      expect(page).toContain(">Subject<");
      expect(page).toContain(">Causer<");
      expect(page).toContain(">Filter<");
      expect(page).not.toContain('method="post"');
    });

    it("keeps the paging actions", () => {
      const page = renderer.render([LINKED[0]!], { subject: "", causer: "", page: 2 }, true);
      const nav = elements(page, "nav").filter(
        (item) => attr(item, "aria-label") === "Activity pages",
      );
      expect(nav).toHaveLength(1);
      const links = elements(nav[0]!.body, "a").map((link) => ({
        rel: attr(link, "rel"),
        href: attr(link, "href"),
        name: text(link.body),
      }));
      expect(links).toEqual([
        { rel: "prev", href: expect.stringContaining("page=1"), name: "Previous" },
        { rel: "next", href: expect.stringContaining("page=3"), name: "Next" },
      ]);
    });

    it("keeps the empty copy with no subject links", () => {
      for (const query of [QUERY, { subject: "Event", causer: "", page: 1 }]) {
        const page = renderer.render([], query);
        expect(page).toContain(activityLogEmptyText(query));
        expect(subjectCells(page)).toHaveLength(0);
      }
    });

    it("keeps rendering the causer snowflake", () => {
      expect(html()).toContain(CAUSER);
    });

    it("labels a legacy causer id instead of reading it as a Discord identity", () => {
      const row = { ...honoRow(LINKED[0]!), causerId: "legacy-9" };
      const page =
        renderer.name === "Hono"
          ? String(jsx(ActivityLogPage, { rows: [row], query: QUERY, hasNext: false }))
          : renderKit({
              rows: [{ ...row, createdAt: AT.toISOString() }],
              query: QUERY,
              hasNext: false,
            });
      expect(page).toContain("legacy-9 (legacy ID)");
    });
  });
}

describe("activity-log subject-link twin parity", () => {
  it("resolves every linked subject to the same editor href in both twins", () => {
    const hrefs = renderers.map((renderer) =>
      LINKED.map((c) => {
        const links = elements(subjectCells(renderer.render([c]))[0]!.body, "a");
        expect(links, `${renderer.name}: ${c.name}`).toHaveLength(1);
        return attr(links[0]!, "href");
      }),
    );
    expect(hrefs[1]).toEqual(hrefs[0]);
  });
});
