import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { parseFragment } from "parse5";
import { expect, it } from "vitest";
import { attr, elements, type textOf } from "./helpers/kit-edit-controls";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { renderedText } = webRequire("../ci/rendered-page.mjs") as { renderedText: typeof textOf };
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    s: string,
    o: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};
const query = 'Tom &copy; "Jerry" +é <b>';
const game = "Rock &copy; Roll <b>";
const Q = "q=Tom+%26copy%3B+%22Jerry%22+%2B%C3%A9+%3Cb%3E";
const G = "game=Rock+%26copy%3B+Roll+%3Cb%3E";
const FEED = `https://example.test/events.ics?${G}`;

type Elements = ReturnType<typeof elements>;
const byTestId = (nodes: Elements, id: string) =>
  nodes.find((el) => attr(el, "data-testid") === id);
const href = (nodes: Elements, id: string) => {
  const link = byTestId(nodes, id);
  return link?.tagName === "a" ? attr(link, "href") : undefined;
};
const text = (nodes: Elements, id: string) => {
  const paragraph = byTestId(nodes, id);
  if (paragraph?.tagName !== "p" || attr(paragraph, "role") !== "status") return;
  if (paragraph.attrs.some(({ name }) => name === "hidden" || name === "aria-hidden")) return;
  if (paragraph.childNodes.some((node) => "tagName" in node)) return;
  return renderedText(paragraph);
};
const selectedGames = (nodes: Elements) =>
  elements(byTestId(nodes, "events-game-filter")!).filter(
    (el) => el.tagName === "option" && attr(el, "selected") !== undefined,
  );
const feedLabel = (nodes: Elements) =>
  nodes.find((el) => el.tagName === "label" && attr(el, "for") === "calendar-feed-url");
const searchForm = (nodes: Elements) =>
  nodes.find((el) => el.tagName === "form" && attr(el, "role") === "search");

it("renders calendar controls: escaped query links, hooks, search, game and subscription states", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-calendar-controls-"));
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "bundle.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import CalendarControls from ${JSON.stringify(join(root, "web/src/lib/CalendarControls.svelte"))};
const q = ${JSON.stringify(query)}, game = ${JSON.stringify(game)};
const state = { view: "list", month: "2026-03", q: "", past: false, page: 1 };
const base = { state, appUrl: "https://example.test", games: ["Chess", game], gameFilter: null,
  searching: false, pastCount: 0, emptyState: null, hasVisibleResults: true, outOfRange: false };
const search = { ...base, searching: true, gameFilter: game, state: { ...state, q, game, past: true } };
const scenarios = {
  default: base,
  calendar: { ...base, pastCount: 3, state: { ...state, view: "calendar", past: true } },
  hit: search,
  miss: { ...search, hasVisibleResults: false },
  outOfRange: { ...search, hasVisibleResults: false, outOfRange: true },
  plainSearch: { ...search, gameFilter: null, state: { ...search.state, game: undefined } },
  gameOnly: { ...base, gameFilter: game, state: { ...state, game } },
  error: { ...search, emptyState: "error" },
};
export const bodies = Object.fromEntries(Object.entries(scenarios).map(([id, props]) =>
  [id, render(CalendarControls, { props }).body]));`,
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
    const { bodies } = (await import(pathToFileURL(outfile).href)) as {
      bodies: Record<string, string>;
    };
    const b = Object.fromEntries(
      Object.entries(bodies).map(([id, html]) => [id, elements(parseFragment(html))]),
    );

    // Default: list view, unscoped feed, hooks, no search, past closed.
    const d = b.default!;
    expect(attr(byTestId(d, "events-view-list")!, "aria-current")).toBe("page");
    expect(href(d, "events-view-calendar")).toBe("/events?view=calendar&month=2026-03");
    expect(text(d, "events-view-status")).toBe("Showing events as a list.");
    for (const id of ["events-search-status", "events-past-status", "calendar-month-status"])
      expect(text(d, id)).toBe("");
    expect(href(d, "events-past-archive-link")).toBe("/events/past");
    expect(href(d, "events-subscribe")).toBe("webcal://example.test/events.ics");
    expect(d.filter((el) => el.tagName === "a").map((el) => attr(el, "href"))).toContain(
      "https://example.test/events.ics",
    );
    expect(byTestId(d, "events-search-clear")).toBeUndefined();
    expect(d.some((el) => attr(el, "name") === "past")).toBe(false);
    expect(d.filter((el) => attr(el, "role") === "status")).toHaveLength(5);
    const zones = d.map((el) => attr(el, "data-cal-zone"));
    for (const zone of ["head", "subscribe", "actions"]) expect(zones).toContain(zone);
    const copy = byTestId(d, "subscription-copy-button")!;
    expect(attr(copy, "data-copy-link")).toBe("https://example.test/events.ics");
    expect(attr(copy, "data-copy-feed")).toBeDefined();
    expect(attr(copy, "hidden")).toBeDefined();
    expect(attr(byTestId(d, "subscription-copy-status")!, "data-copy-toast")).toBeDefined();
    expect(attr(byTestId(d, "subscription-feed-url")!, "readonly")).toBeDefined();
    expect(renderedText(feedLabel(d)!)).toBe("Calendar feed URL");
    const form = searchForm(d);
    expect(form && [attr(form, "method"), attr(form, "action")]).toEqual(["get", "/events"]);
    const search = byTestId(elements(form!), "events-search")!;
    const gameSelect = byTestId(elements(form!), "events-game-filter")!;
    expect([search.tagName, attr(search, "name")]).toEqual(["input", "q"]);
    expect([gameSelect.tagName, attr(gameSelect, "name")]).toEqual(["select", "game"]);
    expect(selectedGames(d).map((el) => [attr(el, "value"), renderedText(el)])).toEqual([
      ["", "All games"],
    ]);

    // Calendar view with past open.
    const c = b.calendar!;
    expect(attr(byTestId(c, "events-view-calendar")!, "aria-current")).toBe("page");
    expect(text(c, "events-view-status")).toBe("Showing events as a calendar.");
    expect(text(c, "calendar-month-status")).toBe("March 2026");
    expect(text(c, "events-past-status")).toBe("Showing past events.");
    const past = elements(searchForm(c)!).find(
      (el) => el.tagName === "input" && attr(el, "name") === "past",
    );
    expect(past && [attr(past, "type"), attr(past, "value")]).toEqual(["hidden", "1"]);

    // Search + game: escaping across links, value, labels and selection.
    const h = b.hit!;
    expect(href(h, "events-view-list")).toBe(`/events?${Q}&${G}&past=1`);
    expect(href(h, "events-view-calendar")).toBe(
      `/events?${Q}&${G}&past=1&view=calendar&month=2026-03`,
    );
    expect(href(h, "events-search-clear")).toBe(`/events?${G}&past=1`);
    expect(href(h, "events-past-archive-link")).toBe(`/events/past?${Q}`);
    const archiveLink = byTestId(h, "events-past-archive-link")!;
    expect(renderedText(archiveLink)).toBe("Continue search in past events");
    expect(href(h, "events-subscribe")).toBe(`webcal://${FEED.slice(8)}`);
    expect(attr(byTestId(h, "subscription-feed-url")!, "value")).toBe(FEED);
    expect(attr(byTestId(h, "subscription-copy-button")!, "data-copy-link")).toBe(FEED);
    expect(renderedText(feedLabel(h)!)).toBe(`${game} calendar feed URL`);
    expect(attr(byTestId(h, "events-search")!, "value")).toBe(query);
    const selected = selectedGames(h);
    expect(selected).toHaveLength(1);
    expect(attr(selected[0]!, "value")).toBe(game);
    expect(renderedText(selected[0]!)).toBe(game);

    // Search statuses.
    const S = `“${query}”`;
    const T = `“${game}”`;
    expect(text(h, "events-search-status")).toBe(`Results for ${S} in ${T}.`);
    expect(text(b.outOfRange!, "events-search-status")).toBe(`Results for ${S} in ${T}.`);
    expect(text(b.miss!, "events-search-status")).toBe(`Nothing matches ${S} in ${T}.`);
    expect(text(b.plainSearch!, "events-search-status")).toBe(`Results for ${S}`);
    expect(href(b.plainSearch!, "events-search-clear")).toBe("/events?past=1");

    // Game only, and the error state.
    expect(text(b.gameOnly!, "events-search-status")).toBe(`Showing events for ${T}.`);
    expect(byTestId(b.gameOnly!, "events-search-clear")).toBeUndefined();
    expect(href(b.gameOnly!, "events-subscribe")).toBe(`webcal://${FEED.slice(8)}`);
    expect(text(b.error!, "events-search-status")).toBe("We couldn't load the calendar.");
    expect(href(b.error!, "events-search-clear")).toBe(`/events?${G}&past=1`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
