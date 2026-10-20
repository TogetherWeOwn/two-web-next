// Protected acceptance handoff: both real dashboard renderers, local rows only.
// Catches a missing/misdirected resource card, unscoped headers, an inaccessible
// or misplaced scroll wrapper, and a widget labelled by a missing/wrong heading.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminDashboard } from "../src/admin/pages";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};
const actor = { id: "fixture-mod", username: "Fixture moderator" };
const at = new Date("2026-10-20T12:00:00.000Z");
const funnel = { added: 7, rate_limited: 2 };
const zeroSearches = [{ query: "fixture chess", searches: 3, lastSearchedAt: at }];

type State = "populated" | "empty" | "unavailable";
type RenderKit = (data: Record<string, unknown>) => string;
let renderKit: RenderKit;
let scratch = "";

// Same real SSR compilation recipe as kit-admin-featured.test.ts. No route load,
// database, network, browser opt-in, source-grep assertions or renderer mocks.
beforeAll(async () => {
  scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "dashboard-twin-ssr-"),
  );
  const entry = join(scratch, "entry.mjs");
  writeFileSync(
    entry,
    `import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/admin/+page.svelte"))};
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
        name: "dashboard-twin-ssr",
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

const renderers = [
  {
    name: "Hono",
    render(state: State) {
      return String(
        jsx(AdminDashboard, {
          actor,
          funnel: state === "unavailable" ? undefined : state === "empty" ? {} : funnel,
          zeroSearches: state === "unavailable" ? undefined : state === "empty" ? [] : zeroSearches,
        }),
      );
    },
  },
  {
    name: "Kit",
    render(state: State) {
      return renderKit({
        actor,
        retentionDays: 90,
        funnel: state === "unavailable" ? undefined : state === "empty" ? {} : funnel,
        zeroSearches:
          state === "unavailable"
            ? undefined
            : state === "empty"
              ? []
              : zeroSearches.map((row) => ({
                  ...row,
                  lastSearchedAt: row.lastSearchedAt.toISOString(),
                })),
      });
    },
  },
];

type Element = { attrs: string; body: string };
const text = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->|<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
const attr = (element: Element, name: string) =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(element.attrs)?.[1];
const elements = (html: string, tag: string): Element[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => ({
    attrs: match[1]!,
    body: match[2]!,
  }));

function byTestId(html: string, testid: string): Element {
  const matches = [
    ...html.matchAll(
      new RegExp(
        `<([a-z][\\w-]*)\\b([^>]*\\bdata-testid="${testid}"[^>]*)>([\\s\\S]*?)</\\1>`,
        "g",
      ),
    ),
  ];
  expect(matches, `exactly one rendered ${testid}`).toHaveLength(1);
  return { attrs: matches[0]![2]!, body: matches[0]![3]! };
}

const cards = [
  { title: "Events", href: "/admin/events" },
  { title: "Featured content", href: "/admin/featured" },
  { title: "Activity log", href: "/admin/activity-log" },
  { title: "Join attempts", href: "/admin/join-attempts" },
];
const widgets = [
  {
    id: "join-funnel",
    heading: "Join funnel, last 90 days",
    regionLabel: "Join funnel",
    headers: ["Outcome", "Attempts"],
  },
  {
    id: "top-zero-searches",
    heading: "Top searches with no results",
    regionLabel: "Top searches with no results",
    headers: ["Search", "Misses", "Last searched"],
  },
];

for (const renderer of renderers) {
  describe(`${renderer.name} dashboard shared card/table acceptance`, () => {
    it.each<State>(["populated", "empty", "unavailable"])(
      "offers all four resource cards even when analytics are %s",
      (state) => {
        const links = elements(renderer.render(state), "li")
          .filter((item) => attr(item, "class")?.split(/\s+/).includes("card"))
          .flatMap((item) => elements(item.body, "h2"))
          .flatMap((heading) => elements(heading.body, "a"))
          .map((link) => ({ title: text(link.body), href: attr(link, "href") }));
        expect(links).toHaveLength(4);
        expect(links).toEqual(expect.arrayContaining(cards));
      },
    );

    for (const widget of widgets) {
      it(`${widget.id} has its real column headers, each scoped to its column`, () => {
        const section = byTestId(renderer.render("populated"), widget.id);
        const tables = elements(section.body, "table");
        expect(tables).toHaveLength(1);
        const headers = elements(tables[0]!.body, "th");
        expect(headers.map((header) => text(header.body))).toEqual(widget.headers);
        expect(headers.map((header) => attr(header, "scope"))).toEqual(
          widget.headers.map(() => "col"),
        );
      });

      it(`${widget.id} puts its table inside the labelled keyboard-focusable scroll region`, () => {
        const html = renderer.render("populated");
        const section = byTestId(html, widget.id);
        const region = byTestId(section.body, `${widget.id}-table-scroll`);
        expect(attr(region, "class")?.split(/\s+/)).toContain("admin-table-scroll");
        expect(attr(region, "role")).toBe("region");
        expect(attr(region, "tabindex")).toBe("0");
        expect(attr(region, "aria-label")).toBe(widget.regionLabel);
        const hintId = attr(region, "aria-describedby");
        expect(hintId, "region references a real scroll hint").toBeTruthy();
        const hints = elements(section.body, "p").filter((p) => attr(p, "id") === hintId);
        expect(hints).toHaveLength(1);
        expect(text(hints[0]!.body)).toBe(
          "Scroll horizontally to see all columns on smaller screens.",
        );
        expect(elements(region.body, "table")).toHaveLength(1);
        expect(elements(region.body, "th")).toHaveLength(widget.headers.length);
      });

      it.each<State>(["populated", "empty"])(
        `${widget.id} labels its %s section by its own unique heading`,
        (state) => {
          const html = renderer.render(state);
          const section = byTestId(html, widget.id);
          const headingId = attr(section, "aria-labelledby");
          expect(headingId, "widget must reference its heading").toBeTruthy();
          const headings = elements(section.body, "h2");
          expect(headings).toHaveLength(1);
          expect(attr(headings[0]!, "id")).toBe(headingId);
          expect(text(headings[0]!.body)).toBe(widget.heading);
          const ids = [...html.matchAll(/\bid="([^"]*)"/g)].map((match) => match[1]);
          expect(ids.filter((id) => id === headingId)).toHaveLength(1);
        },
      );
    }

    it("renders the supplied nonzero data so an empty or omitted table cannot pass", () => {
      const html = renderer.render("populated");
      const funnelSection = byTestId(html, "join-funnel");
      const rows = elements(funnelSection.body, "tr").map((row) =>
        elements(row.body, "td").map((cell) => text(cell.body)),
      );
      expect(rows).toContainEqual(["added", "7"]);
      expect(rows).toContainEqual(["rate_limited", "2"]);
      const searchSection = byTestId(html, "top-zero-searches");
      const searchRows = elements(searchSection.body, "tr").map((row) =>
        elements(row.body, "td").map((cell) => text(cell.body)),
      );
      expect(searchRows.some((row) => row[0] === "fixture chess" && row[1] === "3")).toBe(true);
    });

    it("preserves the distinct empty and unavailable widget states", () => {
      const empty = renderer.render("empty");
      expect(text(byTestId(empty, "join-funnel-empty").body)).toBe(
        "No join attempts in the window.",
      );
      expect(text(byTestId(empty, "top-zero-searches-empty").body)).toBe("No missed searches.");
      const unavailable = renderer.render("unavailable");
      expect(unavailable).not.toMatch(/data-testid="(?:join-funnel|top-zero-searches)"/);
    });
  });
}
