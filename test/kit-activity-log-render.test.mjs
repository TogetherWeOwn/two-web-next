// Render the real Kit activity-log page to pin output payload exclusion, causer
// labels, subject-free rows, and filter-preserving paging in its HTML.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import {
  element,
  elements,
  parseRenderedPage,
  renderedAttribute,
  responseValues,
  rowCells,
  text,
} from "./helpers/rendered-dom.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const activityLogPage = join(root, "web/src/routes/admin/activity-log/+page.svelte");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler");
let renderPage;

beforeAll(async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import Page from "./web/src/routes/admin/activity-log/+page.svelte";
        export function renderPage(data) {
          return render(Page, { props: { data } }).body;
        }
      `,
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "kit-activity-log-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
            const { js } = compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  const bundled = `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`;
  ({ renderPage } = await import(bundled));
});

const query = { subject: "Event Alpha", causer: "100000000000000111", page: 2 };
const rows = [
  {
    id: 1,
    description: "updated event Alpha",
    subjectType: "Event",
    subjectId: "01J00000000000000000000015",
    causerId: "100000000000000111",
    event: "updated",
    createdAt: "2026-10-01T12:00:00.000Z",
  },
  {
    id: 2,
    description: "imported legacy update",
    subjectType: "Event",
    subjectId: "legacy-subject-2",
    causerId: "42",
    event: "created",
    createdAt: "2026-10-01T11:00:00.000Z",
  },
  {
    id: 3,
    description: "system sweep",
    subjectType: null,
    subjectId: null,
    causerId: null,
    event: "",
    createdAt: "2026-10-01T10:00:00.000Z",
  },
];

function pageData(overrides = {}) {
  return { rows, query, hasNext: true, ...overrides };
}

function activityPage(overrides) {
  return parseRenderedPage(renderPage(pageData(overrides)));
}

function pagingLinks(page) {
  return elements(element(page, "nav", { "aria-label": "Activity pages" }), "a").map((link) => [
    renderedAttribute(link, "rel"),
    renderedAttribute(link, "href"),
  ]);
}

function linkUrls(page) {
  return elements(page, "a")
    .map((link) => renderedAttribute(link, "href"))
    .filter((href) => href !== undefined)
    .map((href) => new URL(href, "https://example.test"));
}

describe("Kit activity-log rendered output", () => {
  it("pins the Who header and data cells during horizontal scrolling", () => {
    const { css } = compile(readFileSync(activityLogPage, "utf8"), {
      generate: "client",
      css: "external",
      filename: activityLogPage,
    });
    const firstColumnRule = css?.code.match(
      /\.admin-table\s+:is\(th:first-child,\s*td:first-child:not\(\[colspan\]\)\)\s*\{([^}]*)\}/,
    )?.[1];
    expect(firstColumnRule).toMatch(/position:\s*sticky\s*;/);
    expect(firstColumnRule).toMatch(/inset-inline-start:\s*0\s*;/);
  });

  it("renders snowflake, legacy, and null causers while keeping subject-free rows anonymous", () => {
    const table = element(activityPage(), "table", { "data-testid": "activity-log-table" });
    const dataRows = elements(element(table, "tbody"), "tr");
    expect(dataRows).toHaveLength(3);
    const cells = dataRows.map(rowCells);
    for (const row of cells) {
      expect(row.map((cell) => cell.tagName)).toEqual(["td", "td", "td", "td"]);
    }
    const [snowflake, legacy, system] = cells.map((row) => row.map(text));
    expect(snowflake[0]).toBe("100000000000000111");
    expect(snowflake[3]).toBe("Event 01J00000000000000000000015 (updated)");
    expect(legacy[0]).toBe("42 (legacy ID)");
    expect(legacy[3]).toBe("Event legacy-subject-2 (created)");
    expect(system[0]).toBe("—");
    expect(system[1]).toBe("system sweep");
    expect(system[3]).toBe("—");
    expect(text(element(dataRows[2], "time", { datetime: "2026-10-01T10:00:00.000Z" }))).toBe(
      "2026-10-01 10:00:00 UTC",
    );
  });

  it("explains the read-only, access-logged and legacy-ID semantics in the page hint", () => {
    const hint = text(element(activityPage(), "p", { class: "hint" }));
    expect(hint).toContain("Read-only. Who changed what, when (UTC).");
    expect(hint).toContain("Views that name a member are access-logged;");
    expect(hint).toContain("imported causer IDs are labeled legacy.");
  });

  it("labels valid instants in UTC and keeps a null instant visible", () => {
    const page = activityPage({
      rows: [...rows, { ...rows[0], id: 4, description: "broken instant", createdAt: null }],
    });
    expect(text(element(page, "time", { datetime: "2026-10-01T12:00:00.000Z" }))).toBe(
      "2026-10-01 12:00:00 UTC",
    );
    const brokenRow = elements(page, "tr").find((row) =>
      rowCells(row).some((cell) => text(cell) === "broken instant"),
    );
    expect(brokenRow).toBeDefined();
    expect(rowCells(brokenRow).map(text)[2]).toBe("Unrenderable time");
    expect(elements(brokenRow, "time")).toEqual([]);
  });

  it("never renders activity properties values supplied on a row", () => {
    const beforeValue = "KIT_ACTIVITY_PROPERTIES_BEFORE_27404";
    const afterValue = "KIT_ACTIVITY_PROPERTIES_AFTER_27404";
    const html = renderPage(
      pageData({
        rows: [
          {
            ...rows[0],
            properties: { attributes: { title: { before: beforeValue, after: afterValue } } },
          },
        ],
      }),
    );
    const page = parseRenderedPage(html);
    expect(elements(page, "td").map(text)).toContain("updated event Alpha");
    const payload = responseValues(page, html);
    expect(payload).not.toContainEqual(expect.stringContaining(beforeValue));
    expect(payload).not.toContainEqual(expect.stringContaining(afterValue));
  });

  it("detects payload values in attributes the parser discards", () => {
    const html = '<p data-value="public" data-value="private fixture marker">copy</p>';
    const page = parseRenderedPage(html);
    expect(renderedAttribute(element(page, "p"), "data-value")).toBe("public");
    expect(responseValues(page, html)).toContainEqual(
      expect.stringContaining("private fixture marker"),
    );
  });

  it("preserves active subject and causer filters in previous and next page links", () => {
    const page = activityPage();
    const links = pagingLinks(page);
    const filters = "subject=Event+Alpha&causer=100000000000000111";
    expect(links).toContainEqual(["prev", `/admin/activity-log?page=1&${filters}`]);
    expect(links).toContainEqual(["next", `/admin/activity-log?page=3&${filters}`]);
    expect(text(element(page, "nav", { "aria-label": "Activity pages" }))).toContain("Page 2");
  });

  it("omits navigation and blank filter parameters on the first and final pages", () => {
    const page = activityPage({ query: { subject: "", causer: "", page: 1 }, hasNext: false });
    expect(text(element(page, "nav", { "aria-label": "Activity pages" }))).toBe("Page 1");
    expect(elements(page, "a", { rel: "prev" })).toEqual([]);
    expect(elements(page, "a", { rel: "next" })).toEqual([]);
    const urls = linkUrls(page);
    expect(urls.some(({ searchParams }) => searchParams.has("subject"))).toBe(false);
    expect(urls.some(({ searchParams }) => searchParams.has("causer"))).toBe(false);
  });

  it("omits empty filters from links when navigating from a middle page", () => {
    const page = activityPage({ query: { subject: "", causer: "", page: 2 }, hasNext: true });
    const links = pagingLinks(page);
    expect(links).toContainEqual(["prev", "/admin/activity-log?page=1"]);
    expect(links).toContainEqual(["next", "/admin/activity-log?page=3"]);
    const urls = linkUrls(page);
    expect(urls.some(({ searchParams }) => searchParams.has("subject"))).toBe(false);
    expect(urls.some(({ searchParams }) => searchParams.has("causer"))).toBe(false);
  });

  it("links an empty later filtered page to page 1 and to cleared filters, like Hono", () => {
    const page = activityPage({ rows: [], hasNext: false });
    expect(text(element(page, "td", { "data-testid": "activity-log-empty" }))).toBe(
      "No activity on this page.",
    );
    const recovery = element(page, "p", { "data-testid": "activity-log-recovery" });
    const first = "/admin/activity-log?page=1&subject=Event+Alpha&causer=100000000000000111";
    expect(text(element(recovery, "a", { href: first }))).toBe("First page of these results");
    expect(text(element(recovery, "a", { href: "/admin/activity-log?page=1" }))).toBe(
      "Clear filters",
    );
    expect(elements(activityPage(), undefined, { "data-testid": "activity-log-recovery" })).toEqual(
      [],
    );
  });

  it("URL-encodes special characters in filters before rendering paging links", () => {
    const page = activityPage({
      query: { subject: 'Alpha & "Beta"', causer: "42/legacy", page: 2 },
    });
    const encoded = "subject=Alpha+%26+%22Beta%22&causer=42%2Flegacy";
    const links = pagingLinks(page);
    expect(links).toContainEqual(["prev", `/admin/activity-log?page=1&${encoded}`]);
    expect(links).toContainEqual(["next", `/admin/activity-log?page=3&${encoded}`]);
    expect(renderedAttribute(element(page, "input", { name: "subject" }), "value")).toBe(
      'Alpha & "Beta"',
    );
    expect(renderedAttribute(element(page, "input", { name: "causer" }), "value")).toBe(
      "42/legacy",
    );
  });
});
