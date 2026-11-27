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
  ) => {
    js: { code: string };
  };
};

const ENTRY = `import { render } from "svelte/server";
import Drawer from ${JSON.stringify(join(root, "web/src/lib/CalendarPastDrawer.svelte"))};
import List from ${JSON.stringify(join(root, "web/src/lib/CalendarList.svelte"))};
const state = { view: "list", month: "2030-06", q: "", game: "Rock & Roll", past: false, page: 2 };
const card = { kind: "event", key: "old", eventKey: "old", title: "Old game",
  titleSegments: [{ text: "Old", match: true }], zone: "UTC", startsAt: new Date("2030-06-01T18:00:00Z"),
  endsAt: null, location: null, description: "Past description", passage: [{ text: "Past", match: true }],
  availability: { state: "past", text: "Ended", ongoing: false }, status: "past", game: null,
  host: "", goingCount: 1, goingOccupancy: 1, capacity: null };
const base = { state, past: [card], showPast: false, member: false,
  inviteUrl: "https://discord.test/invite", loginReturnTo: "/events?page=2" };
const run = (o) => render(Drawer, { props: { ...base, ...o } }).body;
const list = (o) => render(List, { props: { ...base, upcoming: [], totalPages: 1, outOfRange: false, ...o } }).body;
export const bodies = {
  pager: list({ state: { ...state, q: 'Tom & "Jerry"', past: true }, totalPages: 4, showPast: true }),
  oor: list({ state: { ...state, page: 9 }, totalPages: 3, outOfRange: true }),
  single: list({ past: [] }),
  listOpen: list({ state: { ...state, past: true }, showPast: true }),
  closed: run({}),
  open: run({ state: { ...state, past: true }, showPast: true }),
  search: run({ state: { ...state, q: "old", past: true }, showPast: true }),
  searchForced: run({ state: { ...state, q: "old" }, showPast: true }),
  empty: run({ past: [], showPast: true }),
  calendar: run({ state: { ...state, view: "calendar", past: true }, showPast: true }),
};`;

it("renders standalone past drawer toggles and past cards", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-past-drawer-"));
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "bundle.mjs");
    writeFileSync(entry, ENTRY);
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
          name: "past-drawer-ssr",
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
    const htmlOptions = { scriptingEnabled: false };
    const b = Object.fromEntries(
      Object.entries(bodies).map(([id, html]) => [id, elements(parseFragment(html, htmlOptions))]),
    );
    const byTestId = (nodes: ReturnType<typeof elements>, id: string) =>
      nodes.find((el) => attr(el, "data-testid") === id);
    const href = (nodes: ReturnType<typeof elements>, id: string) => {
      const link = byTestId(nodes, id);
      return link?.tagName === "a" ? attr(link, "href") : undefined;
    };
    const query = "q=Tom+%26+%22Jerry%22&game=Rock+%26+Roll&past=1";
    expect(href(b.pager!, "events-pager-first")).toBe(`/events?${query}`);
    expect(href(b.pager!, "events-pager-prev")).toBe(`/events?${query}`);
    expect(href(b.pager!, "events-pager-next")).toBe(`/events?${query}&page=3`);
    expect(href(b.pager!, "events-pager-last")).toBe(`/events?${query}&page=4`);
    expect(attr(byTestId(b.pager!, "events-pager-status")!, "role")).toBe("status");
    expect(byTestId(b.pager!, "events-out-of-range")).toBeUndefined();
    const notice = byTestId(b.oor!, "events-out-of-range")!;
    expect(attr(notice, "role")).toBe("status");
    expect(renderedText(notice)).toContain("Page 9 is outside the schedule");
    expect(href(b.oor!, "events-pager-first")).toBe("/events?game=Rock+%26+Roll");
    expect(href(b.oor!, "events-pager-prev")).toBe("/events?game=Rock+%26+Roll&page=3");
    expect(byTestId(b.oor!, "events-pager-next")).toBeUndefined();
    expect(byTestId(b.oor!, "events-pager-last")).toBeUndefined();
    expect(b.single!.some((el) => attr(el, "data-testid")?.startsWith("events-pager"))).toBe(false);
    expect(byTestId(b.single!, "events-past-toggle")).toBeUndefined();
    expect(href(b.listOpen!, "events-past-toggle")).toBe("/events?game=Rock+%26+Roll&page=2");
    expect(byTestId(b.listOpen!, "events-past-list")).toBeDefined();
    expect(b.listOpen!.some((el) => el.tagName === "mark")).toBe(false);
    expect(href(b.closed!, "events-past-toggle")).toBe("/events?game=Rock+%26+Roll&past=1&page=2");
    expect(byTestId(b.closed!, "events-past-list")).toBeUndefined();
    expect(href(b.open!, "events-past-toggle")).toBe("/events?game=Rock+%26+Roll&page=2");
    expect(href(b.calendar!, "events-past-toggle")).toBe(
      "/events?game=Rock+%26+Roll&view=calendar&month=2030-06",
    );
    for (const nodes of [b.open!, b.search!, b.searchForced!]) {
      const list = byTestId(nodes, "events-past-list");
      expect(list?.tagName).toBe("ul");
      expect(renderedText(list!)).toContain("Past description");
      expect(nodes.some((el) => el.tagName === "mark")).toBe(false);
      expect(byTestId(nodes, "signin")).toBeUndefined();
      expect(byTestId(nodes, "event-discord-rsvp")).toBeUndefined();
    }
    expect(byTestId(b.search!, "events-past-toggle")).toBeUndefined();
    expect(byTestId(b.searchForced!, "events-past-toggle")).toBeUndefined();
    expect(byTestId(b.empty!, "events-past-toggle")).toBeUndefined();
    expect(byTestId(b.empty!, "events-past-list")).toBeUndefined();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
