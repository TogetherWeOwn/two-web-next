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
const state = { view: "list", month: "2030-06", q: "", game: "Rock & Roll", past: false, page: 2 };
const card = { kind: "event", key: "old", eventKey: "old", title: "Old game",
  titleSegments: [{ text: "Old", match: true }], zone: "UTC", startsAt: new Date("2030-06-01T18:00:00Z"),
  endsAt: null, location: null, description: "Past description", passage: [{ text: "Past", match: true }],
  availability: { state: "past", text: "Ended", ongoing: false }, status: "past", game: null,
  host: "", goingCount: 1, goingOccupancy: 1, capacity: null };
const base = { state, past: [card], showPast: false, member: false,
  inviteUrl: "https://discord.test/invite", loginReturnTo: "/events?page=2" };
const run = (o) => render(Drawer, { props: { ...base, ...o } }).body;
export const bodies = {
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
