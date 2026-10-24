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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FALLBACK_RANKS, HOME_JOIN_RESULT_COPY, HOME_NOTICES } from "../src/home-copy";

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
    session: null,
    sessionUnavailable: false,
    notice: null,
    joinResult: null,
    inviteUrl: INVITE_URL,
    appUrl: APP_URL,
    counts: { memberCount: 42, onlineCount: 7, ranks: [] },
    upcomingEvents: [],
    eventsUnavailable: false,
    featured: [],
    imageHosts: "",
    homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS },
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

afterEach(() => {
  vi.useRealTimers();
});

function freezeNow(at: Date = NOW): void {
  vi.useFakeTimers();
  vi.setSystemTime(at);
}

type TeaserGroupKey = "tonight" | "this-week" | "later";

const GROUP_TESTIDS: Record<TeaserGroupKey, string> = {
  tonight: "home-events-group-tonight",
  "this-week": "home-events-group-this-week",
  later: "home-events-group-later",
};

const GROUP_LABELS: Record<TeaserGroupKey, string> = {
  tonight: "Tonight",
  "this-week": "This week",
  later: "Later",
};

/** The group block for `key`, cut at the next group block or "See all events". */
function groupSlice(html: string, key: TeaserGroupKey): string {
  const start = html.indexOf(`data-testid="${GROUP_TESTIDS[key]}"`);
  if (start === -1) throw new Error(`missing group block for ${key}`);
  const rest = html.slice(start);
  const ends: number[] = [];
  for (const other of Object.keys(GROUP_TESTIDS) as TeaserGroupKey[]) {
    if (other === key) continue;
    const at = rest.indexOf(`data-testid="${GROUP_TESTIDS[other]}"`, 1);
    if (at !== -1) ends.push(at);
  }
  const seeAll = rest.indexOf("See all events");
  if (seeAll !== -1) ends.push(seeAll);
  return ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest;
}

function expectGroupHeading(slice: string, key: TeaserGroupKey): void {
  expect(slice).toMatch(new RegExp(`<h3[^>]*>\\s*${GROUP_LABELS[key]}\\s*</h3>`));
}

function teaserCardCount(html: string): number {
  const listAt = html.indexOf('data-testid="home-events-list"');
  if (listAt === -1) throw new Error("missing home-events-list");
  const seeAll = html.indexOf("See all events", listAt);
  if (seeAll === -1) throw new Error("missing See all events link");
  return (html.slice(listAt, seeAll).match(/<li class="card"/g) ?? []).length;
}

/** The one card linking `eventKey` inside the group for `key`. */
function groupTeaserRow(html: string, key: TeaserGroupKey, eventKey: string): string {
  const slice = groupSlice(html, key);
  const hit = slice.split('<li class="card"').find((chunk) => chunk.includes(`/e/${eventKey}"`));
  if (!hit) throw new Error(`no ${eventKey} row under ${key}`);
  return hit.split("</li>")[0]!;
}

describe("Kit teaser grouping acceptance: grouped render", () => {
  it("groups three upcoming rows into Tonight / This week / Later in start order", () => {
    freezeNow();
    const html = renderPage(
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
    expect(html).toContain('data-testid="home-events-list"');
    const tonightAt = html.indexOf(`data-testid="${GROUP_TESTIDS.tonight}"`);
    const weekAt = html.indexOf(`data-testid="${GROUP_TESTIDS["this-week"]}"`);
    const laterAt = html.indexOf(`data-testid="${GROUP_TESTIDS.later}"`);
    expect(tonightAt).toBeGreaterThan(-1);
    expect(weekAt).toBeGreaterThan(tonightAt);
    expect(laterAt).toBeGreaterThan(weekAt);
    expectGroupHeading(groupSlice(html, "tonight"), "tonight");
    expectGroupHeading(groupSlice(html, "this-week"), "this-week");
    expectGroupHeading(groupSlice(html, "later"), "later");
    expect(groupSlice(html, "tonight")).toContain("Tonight game night");
    expect(groupSlice(html, "tonight")).toContain('href="/e/tonight-1"');
    expect(groupSlice(html, "this-week")).toContain("This week game night");
    expect(groupSlice(html, "later")).toContain("Later game night");
    expect(teaserCardCount(html)).toBe(3);
    expect(html).toContain('href="/events"');
    expect(html).toContain("See all events");
    expect(groupSlice(html, "tonight")).toContain("Thu 4 Jul, 20:00 (Europe/London)");
    expect(groupSlice(html, "tonight")).toContain("2 going");
    expect(groupSlice(html, "this-week")).toContain("1 of 4 going");
    expect(html).not.toContain('data-testid="home-events-empty"');
  });

  it("renders a lone later row under its own heading with list and link intact", () => {
    freezeNow();
    const html = renderPage(
      baseData({
        upcomingEvents: [canonicalEvent("later-1", "Later game night", "2030-07-13T10:00:00Z")],
      }),
    );
    expect(html).not.toContain(`data-testid="${GROUP_TESTIDS.tonight}"`);
    expect(html).not.toContain(`data-testid="${GROUP_TESTIDS["this-week"]}"`);
    expectGroupHeading(groupSlice(html, "later"), "later");
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain("See all events");
    expect(teaserCardCount(html)).toBe(1);
  });

  it("omits empty groups when every row lands tonight", () => {
    freezeNow();
    const html = renderPage(
      baseData({
        upcomingEvents: [
          canonicalEvent("tonight-1", "Tonight game night", "2030-07-04T19:00:00Z"),
          canonicalEvent("tonight-2", "Second tonight game", "2030-07-04T20:00:00Z"),
        ],
      }),
    );
    expect(html).toContain(`data-testid="${GROUP_TESTIDS.tonight}"`);
    expect(html).not.toContain(`data-testid="${GROUP_TESTIDS["this-week"]}"`);
    expect(html).not.toContain(`data-testid="${GROUP_TESTIDS.later}"`);
    expect(teaserCardCount(html)).toBe(2);
  });

  it("splits a midnight boundary: 23:59 tonight, 00:01 this week", () => {
    freezeNow(new Date("2030-07-04T23:30:00Z"));
    const html = renderPage(
      baseData({
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
    expect(groupSlice(html, "tonight")).toContain("Late game night");
    expect(groupSlice(html, "this-week")).toContain("Early game night");
    expect(html).not.toContain(`data-testid="${GROUP_TESTIDS.later}"`);
  });

  it("buckets the same instant per event zone: UTC tomorrow, Auckland tonight", () => {
    freezeNow(new Date("2030-06-01T23:30:00Z"));
    const html = renderPage(
      baseData({
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
    expect(groupSlice(html, "this-week")).toContain("UTC tomorrow game");
    expect(groupSlice(html, "tonight")).toContain("Auckland tonight game");
  });

  it("reads an invalid zone as UTC for both bucket and label", () => {
    freezeNow();
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
    expect(groupSlice(html, "tonight")).toContain("Tonight game night");
    const week = groupSlice(html, "this-week");
    expect(week).toContain("This week game night");
    expect(week).toContain("(UTC)");
    expect(html).not.toContain("Invalid/Zone");
  });

  it("keeps going counts, the Full marker and Discord rows scoped to their groups", () => {
    freezeNow();
    const html = renderPage(
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
    const full = groupTeaserRow(html, "tonight", "full-1");
    expect(full).toContain("1 of 2 going");
    expect(full).toContain('data-testid="event-spots-left"');
    expect(full).toContain(">Full<");
    const open = groupTeaserRow(html, "this-week", "open-1");
    expect(open).toContain("1 of 4 going");
    expect(open).not.toContain("event-spots-left");
    const later = groupSlice(html, "later");
    expect(later).toContain('data-testid="home-event-discord"');
    expect(later).toContain("RSVP in Discord");
    expect(later).not.toContain("going");
  });

  it("renders grouped with no client script: group blocks carry no island", () => {
    freezeNow();
    const html = renderPage(
      baseData({
        upcomingEvents: [
          canonicalEvent("tonight-1", "Tonight game night", "2030-07-04T19:00:00Z"),
          canonicalEvent("week-1", "This week game night", "2030-07-05T10:00:00Z"),
          canonicalEvent("later-1", "Later game night", "2030-07-13T10:00:00Z"),
        ],
      }),
    );
    for (const key of Object.keys(GROUP_TESTIDS) as TeaserGroupKey[]) {
      const slice = groupSlice(html, key);
      expectGroupHeading(slice, key);
      expect(slice).not.toContain("data-island");
    }
  });
});

describe("Kit teaser grouping acceptance: unchanged behavior controls", () => {
  it("names the empty schedule and keeps the join entry point", () => {
    const html = renderPage(baseData());
    expect(html).toContain('data-testid="home-events-empty"');
    expect(html).toContain("Nothing scheduled yet.");
    expect(html).toContain('data-testid="home-events-join"');
    expect(html).not.toContain('data-testid="home-events-list"');
    for (const key of Object.keys(GROUP_TESTIDS) as TeaserGroupKey[]) {
      expect(html).not.toContain(`data-testid="${GROUP_TESTIDS[key]}"`);
    }
  });

  it("states the events outage without hiding the rest of the page", () => {
    const html = renderPage(baseData({ eventsUnavailable: true }));
    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain("Game nights are unavailable right now.");
    expect(html).toContain('data-testid="member-count"');
    expect(html).not.toContain('data-testid="home-events-list"');
    for (const key of Object.keys(GROUP_TESTIDS) as TeaserGroupKey[]) {
      expect(html).not.toContain(`data-testid="${GROUP_TESTIDS[key]}"`);
    }
  });
});
