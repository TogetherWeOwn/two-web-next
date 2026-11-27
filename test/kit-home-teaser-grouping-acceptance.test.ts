// Kit home teaser grouping acceptance (Tonight / This week / Later).
//
// Owned by the teaser-grouping acceptance handoff: the paired build works
// from this branch and never edits this file; corrections return to the
// acceptance author. Local fixtures only: the real +page.svelte, compiled
// with the web workspace's svelte/compiler and bundled by esbuild (the same
// harness as the Kit home SSR suite), rendered with fake load data and a
// frozen clock — no live fetch, no timer leak.
//
// The Kit page groups with the same shared helper the Hono screen uses
// (`src/events/teaser-groups.ts`, `groupTeaserEvents(rows, now)`): same
// event-timezone day buckets, same order, same headings and testids, pinned
// here through matching boundary renders on both renderers. Direct helper
// units live in the companion helper-acceptance file. Most tests below are
// RED until the builder lands; the empty/unavailable controls stay green
// throughout.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRenderedPage, renderedElements, renderedText } from "../ci/rendered-page.mjs";
import { FALLBACK_RANKS, HOME_JOIN_RESULT_COPY, HOME_NOTICES, JOIN_INTRO } from "../src/home-copy";
import { attr, elements } from "./helpers/kit-edit-controls";
import { decodedOutput } from "./helpers/refused-edit-roster";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

type RenderPage = (data: Record<string, unknown>) => string;

let renderPage: RenderPage;
let scratch = "";

const INVITE_URL = "https://discord.gg/invite";
const APP_URL = "https://example.test";
const NOW = new Date("2030-07-04T18:00:00Z");

function baseData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nowMs: NOW.getTime(),
    session: null,
    sessionUnavailable: false,
    notice: null,
    joinResult: null,
    inviteUrl: INVITE_URL,
    appUrl: APP_URL,
    counts: { memberCount: 42, onlineCount: 7, ranks: [] },
    countsSnapshot: {
      memberCount: 42,
      onlineCount: 7,
      observedAt: NOW.toISOString(),
      stale: false,
    },
    upcomingEvents: [],
    eventsUnavailable: false,
    featured: [],
    imageHosts: "",
    homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS, JOIN_INTRO },
    ...overrides,
  };
}

interface KitCanonicalRow {
  source: "canonical";
  eventKey: string;
  title: string;
  startsAt: Date;
  timezone: string;
  location: string | null;
  goingCount: number;
  goingOccupancy: number;
  capacity: number | null;
}

function canonicalEvent(
  eventKey: string,
  title: string,
  startsAt: string,
  overrides: Partial<KitCanonicalRow> = {},
): KitCanonicalRow {
  return {
    source: "canonical",
    eventKey,
    title,
    startsAt: new Date(startsAt),
    timezone: "Europe/London",
    location: null,
    goingCount: 0,
    goingOccupancy: 0,
    capacity: null,
    ...overrides,
  };
}

function discordEvent(
  discordId: string,
  title: string,
  startsAt: string,
  timezone = "Europe/London",
): Record<string, unknown> {
  return {
    source: "discord",
    discordId,
    title,
    startsAt: new Date(startsAt),
    timezone,
    location: null,
  };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-teaser-grouping-"));
  const entry = join(scratch, "kit-teaser-grouping-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const outfile = join(scratch, "kit-teaser-grouping-bundle.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "kit-teaser-grouping-svelte-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js } = compile(source, {
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
  const mod = (await import(pathToFileURL(outfile).href)) as unknown as {
    renderPage: RenderPage;
  };
  renderPage = mod.renderPage;
}, 60000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const renderHome = (data = baseData()) => parseRenderedPage(renderPage(data));

type Markup = Parameters<typeof elements>[0];
type Element = ReturnType<typeof elements>[number];
type TeaserGroupKey = "tonight" | "this-week" | "later";

const GROUP_LABELS: Record<TeaserGroupKey, string> = {
  tonight: "Tonight",
  "this-week": "This week",
  later: "Later",
};

function byTestId(root: Markup, id: string): Element | undefined {
  return elements(root).find((node) => attr(node, "data-testid") === id);
}

function groupNodes(root: Markup): Element[] {
  return elements(root).filter((node) =>
    attr(node, "data-testid")?.startsWith("home-events-group-"),
  );
}

function cardNodes(root: Markup): Element[] {
  return elements(root).filter(
    (node) => node.tagName === "li" && attr(node, "class")?.split(/\s+/).includes("card"),
  );
}

function expectTeaserGroups(page: Markup, expected: [TeaserGroupKey, ...string[]][]) {
  const list = byTestId(page, "home-events-list");
  if (list?.tagName !== "ul") throw new Error("missing home-events-list ul");
  const groups = groupNodes(page);
  expect(groups.map((node) => attr(node, "data-testid"))).toEqual(
    expected.map(([key]) => `home-events-group-${key}`),
  );
  const groupedCards = expected.flatMap(([key, ...titles], index) => {
    const group = groups[index];
    if (!group) throw new Error(`missing ${key} group`);
    expect(group.tagName === "li" && group.parentNode === list, key).toBe(true);
    const headings = [...renderedElements(group, { tag: "h3" })];
    expect(headings.map((node) => renderedText(node).trim())).toEqual([GROUP_LABELS[key]]);
    const [rows] = [...renderedElements(group, { tag: "ul" })];
    expect(rows?.parentNode === group, key).toBe(true);
    const cards = cardNodes(group);
    expect(cards.every((node) => node.parentNode === rows)).toBe(true);
    expect(
      cards.map((card) => [...renderedElements(card, { tag: "h4" })].map(renderedText)),
    ).toEqual(titles.map((title) => [title]));
    return cards;
  });
  expect(cardNodes(list).map((card) => groupedCards.indexOf(card))).toEqual(
    groupedCards.map((_, index) => index),
  );
  const siblings = list.parentNode?.childNodes ?? [];
  const links = siblings
    .slice(siblings.indexOf(list) + 1)
    .flatMap((node) =>
      [...renderedElements(node, { tag: "a" })].filter((link) => attr(link, "href") === "/events"),
    );
  expect(links.map(renderedText)).toEqual([expect.stringContaining("See all events")]);
  return groupedCards;
}

function cardLink(card: Element | undefined, href: string): Element {
  const link =
    card && [...renderedElements(card, { tag: "a" })].find((node) => attr(node, "href") === href);
  if (!link) throw new Error(`missing ${href} link in teaser card`);
  return link;
}

describe("Kit teaser grouping acceptance: grouped render", () => {
  it("groups three upcoming rows into Tonight / This week / Later in start order", () => {
    const page = renderHome(
      baseData({
        upcomingEvents: [
          canonicalEvent("tonight-1", "Tonight game night", "2030-07-04T19:00:00Z", {
            goingCount: 2,
            goingOccupancy: 2,
          }),
          canonicalEvent("week-1", "This week game night", "2030-07-05T10:00:00Z", {
            goingCount: 1,
            goingOccupancy: 1,
            capacity: 4,
          }),
          canonicalEvent("later-1", "Later game night", "2030-07-13T10:00:00Z"),
        ],
      }),
    );
    const [tonight, week] = expectTeaserGroups(page, [
      ["tonight", "Tonight game night"],
      ["this-week", "This week game night"],
      ["later", "Later game night"],
    ]);
    const tonightLink = cardLink(tonight, "/e/tonight-1");
    expect([...renderedElements(tonightLink, { tag: "time" })].map(renderedText)).toEqual([
      "Thu 4 Jul, 20:00 (Europe/London)",
    ]);
    expect(renderedText(tonightLink)).toContain("2 going");
    expect(renderedText(cardLink(week, "/e/week-1"))).toContain("1 of 4 going");
    expect(byTestId(page, "home-events-empty")).toBeUndefined();
  });

  it("renders a lone later row under its own heading with list and link intact", () => {
    const page = renderHome(
      baseData({
        upcomingEvents: [canonicalEvent("later-1", "Later game night", "2030-07-13T10:00:00Z")],
      }),
    );
    expectTeaserGroups(page, [["later", "Later game night"]]);
  });

  it("omits empty groups when every row lands tonight", () => {
    const page = renderHome(
      baseData({
        upcomingEvents: [
          canonicalEvent("tonight-1", "Tonight game night", "2030-07-04T19:00:00Z"),
          canonicalEvent("tonight-2", "Second tonight game", "2030-07-04T20:00:00Z"),
        ],
      }),
    );
    expectTeaserGroups(page, [["tonight", "Tonight game night", "Second tonight game"]]);
  });

  it("splits a midnight boundary: 23:59 tonight, 00:01 this week", () => {
    const page = renderHome(
      baseData({
        nowMs: Date.parse("2030-07-04T23:30:00Z"),
        upcomingEvents: [
          canonicalEvent("late-1", "Late game night", "2030-07-04T23:59:00Z", {
            timezone: "UTC",
          }),
          canonicalEvent("early-1", "Early game night", "2030-07-05T00:01:00Z", {
            timezone: "UTC",
          }),
        ],
      }),
    );
    expectTeaserGroups(page, [
      ["tonight", "Late game night"],
      ["this-week", "Early game night"],
    ]);
  });

  it("buckets the same instant per event zone: UTC tomorrow, Auckland tonight", () => {
    const page = renderHome(
      baseData({
        nowMs: Date.parse("2030-06-01T23:30:00Z"),
        upcomingEvents: [
          canonicalEvent("utc-1", "UTC tomorrow game", "2030-06-02T00:30:00Z", {
            timezone: "UTC",
          }),
          canonicalEvent("auckland-1", "Auckland tonight game", "2030-06-02T00:30:00Z", {
            timezone: "Pacific/Auckland",
          }),
        ],
      }),
    );
    expectTeaserGroups(page, [
      ["tonight", "Auckland tonight game"],
      ["this-week", "UTC tomorrow game"],
    ]);
  });

  it("reads an invalid zone as UTC for both bucket and label", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [
          canonicalEvent("tonight-1", "Tonight game night", "2030-07-04T19:00:00Z", {
            timezone: "UTC",
          }),
          canonicalEvent("week-1", "This week game night", "2030-07-05T10:00:00Z", {
            timezone: "Invalid/Zone",
          }),
        ],
      }),
    );
    const [, week] = expectTeaserGroups(parseRenderedPage(html), [
      ["tonight", "Tonight game night"],
      ["this-week", "This week game night"],
    ]);
    expect(renderedText(cardLink(week, "/e/week-1"))).toContain("(UTC)");
    expect(decodedOutput(html)).not.toContain("Invalid/Zone");
    // The HTML parser can discard raw bytes such as later duplicate attributes.
    expect(html).not.toContain("Invalid/Zone");
  });

  it("keeps going counts, the Full marker and Discord rows scoped to their groups", () => {
    const page = renderHome(
      baseData({
        upcomingEvents: [
          canonicalEvent("full-1", "Full tonight game", "2030-07-04T19:00:00Z", {
            goingCount: 1,
            goingOccupancy: 2,
            capacity: 2,
          }),
          canonicalEvent("open-1", "Open week game", "2030-07-05T10:00:00Z", {
            goingCount: 1,
            goingOccupancy: 1,
            capacity: 4,
          }),
          discordEvent("discord-99", "Discord later game", "2030-07-13T10:00:00Z"),
        ],
      }),
    );
    const [tonight, week, later] = expectTeaserGroups(page, [
      ["tonight", "Full tonight game"],
      ["this-week", "Open week game"],
      ["later", "Discord later game"],
    ]);
    const full = cardLink(tonight, "/e/full-1");
    expect(renderedText(full)).toContain("1 of 2 going");
    const marker = byTestId(full, "event-spots-left");
    expect(marker && renderedText(marker)).toBe("Full");
    expect(renderedText(cardLink(week, "/e/open-1"))).toContain("1 of 4 going");
    expect(week && byTestId(week, "event-spots-left")).toBeUndefined();
    const discord = cardLink(later, INVITE_URL);
    expect(attr(discord, "data-testid")).toBe("home-event-discord");
    expect(renderedText(discord)).toContain("RSVP in Discord");
    expect(later && renderedText(later)).not.toContain("going");
  });

  it("renders grouped with no client script: group blocks carry no island", () => {
    const page = renderHome(
      baseData({
        upcomingEvents: [
          canonicalEvent("tonight-1", "Tonight game night", "2030-07-04T19:00:00Z"),
          canonicalEvent("week-1", "This week game night", "2030-07-05T10:00:00Z"),
          canonicalEvent("later-1", "Later game night", "2030-07-13T10:00:00Z"),
        ],
      }),
    );
    expectTeaserGroups(page, [
      ["tonight", "Tonight game night"],
      ["this-week", "This week game night"],
      ["later", "Later game night"],
    ]);
    for (const group of groupNodes(page)) {
      expect(elements(group).some((node) => attr(node, "data-island") !== undefined)).toBe(false);
      expect(elements(group).some((node) => node.tagName === "script")).toBe(false);
    }
  });
});

describe("Kit teaser grouping acceptance: unchanged behavior controls", () => {
  it("names the empty schedule and keeps the join entry point", () => {
    const page = renderHome();
    const empty = byTestId(page, "home-events-empty");
    expect(empty && renderedText(empty)).toContain("Nothing scheduled yet.");
    const join = byTestId(page, "home-events-join");
    expect(join?.tagName).toBe("a");
    expect(join && attr(join, "href")).toBe("/join");
    expect(byTestId(page, "home-events-list")).toBeUndefined();
    expect(groupNodes(page)).toHaveLength(0);
  });

  it("states the events outage without hiding the rest of the page", () => {
    const page = renderHome(baseData({ eventsUnavailable: true }));
    const outage = byTestId(page, "home-events-empty");
    expect(outage && attr(outage, "data-state")).toBe("unavailable");
    expect(outage && renderedText(outage)).toContain("Game nights are unavailable right now.");
    expect(byTestId(page, "member-count")).toBeDefined();
    expect(byTestId(page, "home-events-list")).toBeUndefined();
    expect(groupNodes(page)).toHaveLength(0);
  });
});
