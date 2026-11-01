// Render the real Kit activity-log page to pin output payload exclusion, causer
// labels, subject-free rows, and filter-preserving paging in its HTML.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
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

describe("Kit activity-log rendered output", () => {
  it("renders snowflake, legacy, and null causers while keeping subject-free rows anonymous", () => {
    const html = renderPage(pageData());
    expect(html).toContain("<td>100000000000000111</td>");
    expect(html).toContain("<td>42 (legacy ID)</td>");
    expect(html).toContain("Event 01J00000000000000000000015 (updated)");
    expect(html).toContain("legacy-subject-2 (created)");
    const systemRow = html
      .match(/<tr[^>]*>[\s\S]*?<\/tr>/g)
      ?.find((candidate) => candidate.includes("system sweep"));
    expect(systemRow).toBeDefined();
    expect(systemRow).toContain("<td>—</td><td>system sweep</td>");
    expect(systemRow).toContain(
      '<time datetime="2026-10-01T10:00:00.000Z">2026-10-01T10:00:00.000Z</time></td><td>—</td>',
    );
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
    expect(html).toContain("updated event Alpha");
    expect(html).not.toContain(beforeValue);
    expect(html).not.toContain(afterValue);
  });

  it("preserves active subject and causer filters in previous and next page links", () => {
    const html = renderPage(pageData());
    expect(html).toContain(
      'href="/admin/activity-log?page=1&amp;subject=Event+Alpha&amp;causer=100000000000000111"',
    );
    expect(html).toContain(
      'href="/admin/activity-log?page=3&amp;subject=Event+Alpha&amp;causer=100000000000000111"',
    );
    expect(html).toContain("Page 2");
  });

  it("omits navigation and blank filter parameters on the first and final pages", () => {
    const html = renderPage(
      pageData({ query: { subject: "", causer: "", page: 1 }, hasNext: false }),
    );
    expect(html).toContain("Page 1");
    expect(html).not.toContain('rel="prev"');
    expect(html).not.toContain('rel="next"');
    expect(html).not.toContain("subject=");
    expect(html).not.toContain("causer=");
  });

  it("omits empty filters from links when navigating from a middle page", () => {
    const html = renderPage(
      pageData({ query: { subject: "", causer: "", page: 2 }, hasNext: true }),
    );
    expect(html).toContain('href="/admin/activity-log?page=1"');
    expect(html).toContain('href="/admin/activity-log?page=3"');
    expect(html).not.toContain("subject=");
    expect(html).not.toContain("causer=");
  });

  it("links an empty later filtered page to page 1 and to cleared filters, like Hono", () => {
    const html = renderPage(pageData({ rows: [], hasNext: false }));
    expect(html).toContain("No activity on this page.");
    expect(html).toContain(
      '<a href="/admin/activity-log?page=1&amp;subject=Event+Alpha&amp;causer=100000000000000111">First page of these results</a>',
    );
    expect(html).toContain('<a href="/admin/activity-log?page=1">Clear filters</a>');
    expect(renderPage(pageData())).not.toContain('data-testid="activity-log-recovery"');
  });

  it("URL-encodes special characters in filters before rendering paging links", () => {
    const html = renderPage(
      pageData({ query: { subject: 'Alpha & "Beta"', causer: "42/legacy", page: 2 } }),
    );
    expect(html).toContain(
      'href="/admin/activity-log?page=1&amp;subject=Alpha+%26+%22Beta%22&amp;causer=42%2Flegacy"',
    );
    expect(html).toContain(
      'href="/admin/activity-log?page=3&amp;subject=Alpha+%26+%22Beta%22&amp;causer=42%2Flegacy"',
    );
    expect(html).toContain('value="Alpha &amp; &quot;Beta&quot;"');
    expect(html).toContain('value="42/legacy"');
  });
});
