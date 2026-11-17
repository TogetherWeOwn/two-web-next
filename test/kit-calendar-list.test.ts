import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

// SSR regression for the Kit calendar list primitives (CalendarList, CalendarCard,
// CalendarPastDrawer). Props follow web/src/lib/calendar-list.ts; adapt the
// scenario builders below if those public types change.
const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    s: string,
    o: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

const ENTRY = `import { render } from "svelte/server";
import CalendarList from ${JSON.stringify(join(root, "web/src/lib/CalendarList.svelte"))};
const t0 = new Date("2030-06-01T18:00:00Z");
const card = (key, o = {}) => ({
  kind: "event", key, eventKey: key, title: "Game night " + key, titleSegments: null,
  zone: "UTC", startsAt: t0, endsAt: null, location: null, description: null, passage: null,
  availability: { state: "open", text: "Spots open", ongoing: false },
  status: "published", game: null, host: "", goingCount: 1, goingOccupancy: 1, capacity: null, ...o,
});
const discord = { kind: "discord", key: "discord-9", title: "Discord only", titleSegments: null,
  zone: "UTC", startsAt: t0, endsAt: null, location: null, description: null, passage: null,
  availability: { state: "transient", text: "Via Discord", ongoing: false } };
const state = { view: "list", month: "2030-06", q: "", past: false, page: 1 };
const base = { state, upcoming: [card("a")], past: [], totalPages: 1, outOfRange: false, showPast: false,
  member: false, inviteUrl: "https://discord.test/invite", loginReturnTo: "/events?page=2" };
const run = (o) => render(CalendarList, { props: { ...base, ...o } }).body;
const searchState = { ...state, q: 'Tom & "Jerry"', game: "Rock & Roll", past: true, page: 2 };
const pastCard = card("old", { status: "past", availability: { state: "past", text: "Ended", ongoing: false } });
export const bodies = {
  pager: run({ state: searchState, totalPages: 4, showPast: true }),
  oor: run({ state: { ...state, page: 9 }, totalPages: 3, outOfRange: true, upcoming: [] }),
  single: run({}),
  pastOpen: run({ state: { ...state, past: true }, past: [pastCard], showPast: true }),
  pastSearch: run({ state: { ...state, q: "old", past: true }, past: [pastCard], showPast: true }),
  pastSegments: run({ past: [card("old", { titleSegments: [{ text: "old", match: true }],
    passage: [{ text: "old", match: true }], description: "Past description" })], showPast: true }),
  pastClosed: run({ past: [pastCard] }),
  pastFiltered: run({ state: { ...state, game: "Rock & Roll", page: 2 }, past: [pastCard] }),
  pastFilteredOpen: run({ state: { ...state, game: "Rock & Roll", page: 2, past: true },
    past: [pastCard], showPast: true }),
  visitor: run({ upcoming: [card("a"), discord, card("x", { status: "cancelled", availability: null })] }),
  member: run({ member: true, upcoming: [card("a"), discord] }),
  marks: run({ upcoming: [card("a", { titleSegments: [
    { text: "<b>", match: false }, { text: "Tom & ", match: true }, { text: "x", match: false }] })] }),
};
`;

const tag = (b: string, id: string) =>
  new RegExp(`<[a-z]+\\b[^>]*data-testid="${id}"[^>]*>`).exec(b)?.[0] ?? "";
const href = (b: string, id: string) =>
  /\shref="([^"]*)"/.exec(tag(b, id))?.[1]?.replaceAll("&amp;", "&");
const Q = "q=Tom+%26+%22Jerry%22&game=Rock+%26+Roll&past=1";

it("renders calendar list primitives: pager, past drawer, actions and escaped search spans", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-calendar-list-"));
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
          name: "calendar-list-ssr",
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

    // Pager keeps and escapes q/game/past across every link; page one drops `page`.
    const p = b.pager!;
    expect(href(p, "events-pager-first")).toBe(`/events?${Q}`);
    expect(href(p, "events-pager-prev")).toBe(`/events?${Q}`);
    expect(href(p, "events-pager-next")).toBe(`/events?${Q}&page=3`);
    expect(href(p, "events-pager-last")).toBe(`/events?${Q}&page=4`);
    expect(tag(p, "events-pager-status")).toContain('role="status"');
    expect(p).not.toContain("events-out-of-range");

    // Out of range: announced, previous clamps to the last page, no forward links.
    const o = b.oor!;
    expect(tag(o, "events-out-of-range")).toContain('role="status"');
    expect(o).toContain("Page 9 is outside the schedule");
    expect(href(o, "events-pager-first")).toBe("/events");
    expect(href(o, "events-pager-prev")).toBe("/events?page=3");
    expect(o).not.toContain("events-pager-next");
    expect(o).not.toContain("events-pager-last");

    // A single in-range page renders no pager.
    expect(b.single).not.toContain("events-pager");

    // Past toggle: show when closed, hide only for a manual (non-search) preview.
    expect(href(b.pastClosed!, "events-past-toggle")).toBe("/events?past=1");
    expect(b.pastClosed).not.toContain("events-past-list");
    expect(href(b.pastOpen!, "events-past-toggle")).toBe("/events");
    expect(href(b.pastFiltered!, "events-past-toggle")).toBe(
      "/events?game=Rock+%26+Roll&past=1&page=2",
    );
    expect(href(b.pastFilteredOpen!, "events-past-toggle")).toBe(
      "/events?game=Rock+%26+Roll&page=2",
    );
    expect(b.pastOpen).toContain('data-testid="events-past-list"');
    expect(b.pastSearch).toContain('data-testid="events-past-list"');
    expect(b.pastSearch).not.toContain("events-past-toggle");
    expect(b.pastSegments).toContain("Past description");
    expect(b.pastSegments).not.toContain("<mark>");
    expect(b.single).not.toContain("events-past-toggle");

    // Past cards never invite participation, even for a signed-out viewer.
    const past = /<ul[^>]*events-past-list[\s\S]*?<\/ul>/.exec(b.pastOpen!)?.[0] ?? "";
    expect(past).toContain("event-card");
    for (const id of ["signin", "event-discord-rsvp"]) expect(past).not.toContain(id);

    // Visitor: sign-in carries the return path; Discord rows get the invite; cancelled gets neither.
    const v = b.visitor!;
    const cards = v.split("<li>").slice(1);
    expect(cards).toHaveLength(3);
    expect(href(cards[0]!, "signin")).toBe("/join/discord?next=%2Fevents%3Fpage%3D2");
    expect(href(cards[1]!, "event-discord-rsvp")).toBe("https://discord.test/invite");
    expect(cards[1]).not.toContain('data-testid="signin"');
    expect(cards[1]).not.toContain('href="/e/');
    expect(cards[2]).toContain('data-testid="event-cancelled"');
    expect(cards[2]).not.toContain('data-testid="signin"');
    expect(cards[2]).not.toContain('href="/e/');
    expect(cards[0]).toContain('href="/e/a"');
    expect(cards[0]).toContain("Spots open");

    // Member: no sign-in, Discord rows still link out.
    expect(b.member).not.toContain('data-testid="signin"');
    expect(b.member).toContain('data-testid="event-discord-rsvp"');

    // Search segments are escaped text; only matches wrap in <mark>.
    expect(b.marks).toMatch(
      /&lt;b(?:>|&gt;)(?:<!--[^>]*-->)*<mark>Tom &amp; <\/mark>(?:<!--[^>]*-->)*x/,
    );
    expect(b.marks).not.toContain("<b>");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
