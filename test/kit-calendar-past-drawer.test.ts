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
    const { bodies: b } = (await import(pathToFileURL(outfile).href)) as {
      bodies: Record<string, string>;
    };
    const tag = (html: string, id: string) =>
      new RegExp(`<[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    const href = (html: string, id: string) =>
      /\shref="([^"]*)"/.exec(tag(html, id))?.[1]?.replaceAll("&amp;", "&");
    const query = "q=Tom+%26+%22Jerry%22&game=Rock+%26+Roll&past=1";
    expect(href(b.pager!, "events-pager-first")).toBe(`/events?${query}`);
    expect(href(b.pager!, "events-pager-prev")).toBe(`/events?${query}`);
    expect(href(b.pager!, "events-pager-next")).toBe(`/events?${query}&page=3`);
    expect(href(b.pager!, "events-pager-last")).toBe(`/events?${query}&page=4`);
    expect(tag(b.pager!, "events-pager-status")).toContain('role="status"');
    expect(b.pager).not.toContain("events-out-of-range");
    expect(tag(b.oor!, "events-out-of-range")).toContain('role="status"');
    expect(b.oor).toContain("Page 9 is outside the schedule");
    expect(href(b.oor!, "events-pager-first")).toBe("/events?game=Rock+%26+Roll");
    expect(href(b.oor!, "events-pager-prev")).toBe("/events?game=Rock+%26+Roll&page=3");
    expect(b.oor).not.toContain("events-pager-next");
    expect(b.oor).not.toContain("events-pager-last");
    expect(b.single).not.toContain("events-pager");
    expect(b.single).not.toContain("events-past-toggle");
    expect(href(b.listOpen!, "events-past-toggle")).toBe("/events?game=Rock+%26+Roll&page=2");
    expect(b.listOpen).toContain('data-testid="events-past-list"');
    expect(b.listOpen).not.toContain("<mark>");
    expect(b.closed).toContain('href="/events?game=Rock+%26+Roll&amp;past=1&amp;page=2"');
    expect(b.closed).not.toContain('data-testid="events-past-list"');
    expect(b.open).toContain('href="/events?game=Rock+%26+Roll&amp;page=2"');
    expect(b.calendar).toContain("view=calendar");
    for (const html of [b.open!, b.search!, b.searchForced!]) {
      expect(html).toContain('data-testid="events-past-list"');
      expect(html).toContain("Past description");
      expect(html).not.toContain("<mark>");
      expect(html).not.toContain('data-testid="signin"');
      expect(html).not.toContain('data-testid="event-discord-rsvp"');
    }
    expect(b.search).not.toContain('data-testid="events-past-toggle"');
    expect(b.searchForced).not.toContain('data-testid="events-past-toggle"');
    expect(b.empty).not.toContain('data-testid="events-past-toggle"');
    expect(b.empty).not.toContain('data-testid="events-past-list"');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
