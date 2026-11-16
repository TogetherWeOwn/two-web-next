import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    s: string,
    o: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};
const SCENARIOS = [
  "default",
  "calendar",
  "hit",
  "miss",
  "outOfRange",
  "plainSearch",
  "gameOnly",
  "error",
];
const Q = "q=Tom+%26+%22Jerry%22+%2B%C3%A9";
const G = "game=Rock+%26+Roll";
const FEED = `https://example.test/events.ics?${G}`;

const tag = (b: string, id: string) =>
  new RegExp(`<[a-z]+\\b[^>]*data-testid="${id}"[^>]*>`).exec(b)?.[0] ?? "";
const attr = (t: string, n: string) =>
  new RegExp(`\\s${n}="([^"]*)"`).exec(t)?.[1]?.replaceAll("&amp;", "&");
const href = (b: string, id: string) => attr(tag(b, id), "href");
const text = (b: string, id: string) =>
  new RegExp(`data-testid="${id}"[^>]*>([^<]*)</p>`).exec(b)?.[1];

it("renders calendar controls: escaped query links, hooks, search, game and subscription states", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-calendar-controls-"));
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "bundle.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import Fixture from ${JSON.stringify(join(root, "test/fixtures/kit-calendar-controls.svelte"))};
export const bodies = Object.fromEntries(${JSON.stringify(SCENARIOS)}.map((scenario) => [scenario, render(Fixture, { props: { scenario } }).body]));`,
    );
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      plugins: [
        {
          name: "calendar-controls-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
              contents: compile(readFileSync(args.path, "utf8"), {
                generate: "server",
                dev: false,
                filename: args.path,
              }).js.code,
              loader: "js",
              resolveDir: dirname(args.path),
            }));
          },
        },
      ],
    });
    const { bodies: b } = (await import(pathToFileURL(outfile).href)) as {
      bodies: Record<string, string>;
    };

    // Default: list view, unscoped feed, hooks, no search, past closed.
    const d = b.default!;
    expect(tag(d, "events-view-list")).toContain('aria-current="page"');
    expect(href(d, "events-view-calendar")).toBe("/events?view=calendar&month=2026-03");
    expect(text(d, "events-view-status")).toBe("Showing events as a list.");
    for (const id of ["events-search-status", "events-past-status", "calendar-month-status"])
      expect(text(d, id)).toBe("");
    expect(href(d, "events-past-archive-link")).toBe("/events/past");
    expect(href(d, "events-subscribe")).toBe("webcal://example.test/events.ics");
    expect(d).toContain('href="https://example.test/events.ics"');
    expect(d).not.toContain("events-search-clear");
    expect(d).not.toContain('name="past"');
    expect(d.match(/role="status"/g)).toHaveLength(5);
    for (const zone of ["head", "subscribe", "actions"])
      expect(d).toContain(`data-cal-zone="${zone}"`);
    const copy = tag(d, "subscription-copy-button");
    expect(attr(copy, "data-copy-link")).toBe("https://example.test/events.ics");
    expect(copy).toMatch(/data-copy-feed/);
    expect(copy).toMatch(/\shidden/);
    expect(tag(d, "subscription-copy-status")).toContain("data-copy-toast");
    expect(tag(d, "subscription-feed-url")).toContain("readonly");
    expect(d).toContain("Calendar feed URL</label>");
    expect(d).toMatch(/<form method="get" action="\/events" role="search">/);
    expect(tag(d, "events-search")).toContain('name="q"');
    expect(tag(d, "events-game-filter")).toContain('name="game"');
    expect(d).toMatch(/<option value="" selected[^>]*>All games<\/option>/);

    // Calendar view with past open.
    const c = b.calendar!;
    expect(tag(c, "events-view-calendar")).toContain('aria-current="page"');
    expect(text(c, "events-view-status")).toBe("Showing events as a calendar.");
    expect(text(c, "calendar-month-status")).toBe("March 2026");
    expect(text(c, "events-past-status")).toBe("Showing past events.");
    expect(c).toMatch(/<input type="hidden" name="past" value="1"/);

    // Search + game: escaping across links, value, labels and selection.
    const h = b.hit!;
    expect(href(h, "events-view-list")).toBe(`/events?${Q}&${G}&past=1`);
    expect(href(h, "events-view-calendar")).toBe(
      `/events?${Q}&${G}&past=1&view=calendar&month=2026-03`,
    );
    expect(href(h, "events-search-clear")).toBe(`/events?${G}&past=1`);
    expect(href(h, "events-past-archive-link")).toBe(`/events/past?${Q}`);
    expect(h).toContain("Continue search in past events</a>");
    expect(href(h, "events-subscribe")).toBe(`webcal://${FEED.slice(8)}`);
    expect(attr(tag(h, "subscription-feed-url"), "value")).toBe(FEED);
    expect(attr(tag(h, "subscription-copy-button"), "data-copy-link")).toBe(FEED);
    expect(h).toContain("Rock &amp; Roll calendar feed URL</label>");
    expect(tag(h, "events-search")).toContain('value="Tom &amp; &quot;Jerry&quot; +é"');
    expect(h).toMatch(/<option value="Rock &amp; Roll" selected/);
    expect(h).not.toMatch(/<option value="" selected/);

    // Search statuses.
    const S = '“Tom &amp; "Jerry" +é”';
    const T = "“Rock &amp; Roll”";
    expect(text(h, "events-search-status")).toBe(`Results for ${S} in ${T}.`);
    expect(text(b.outOfRange!, "events-search-status")).toBe(`Results for ${S} in ${T}.`);
    expect(text(b.miss!, "events-search-status")).toBe(`Nothing matches ${S} in ${T}.`);
    expect(text(b.plainSearch!, "events-search-status")).toBe(`Results for ${S}`);
    expect(href(b.plainSearch!, "events-search-clear")).toBe("/events?past=1");

    // Game only, and the error state.
    expect(text(b.gameOnly!, "events-search-status")).toBe(`Showing events for ${T}.`);
    expect(b.gameOnly).not.toContain("events-search-clear");
    expect(href(b.gameOnly!, "events-subscribe")).toBe(`webcal://${FEED.slice(8)}`);
    expect(text(b.error!, "events-search-status")).toBe("");
    expect(href(b.error!, "events-search-clear")).toBe(`/events?${G}&past=1`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
