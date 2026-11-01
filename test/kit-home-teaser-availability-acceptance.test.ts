// Acceptance: the Kit homepage teaser shows game, host and availability
// like the schedule card, matching the Hono twin row for row.
//
// Owned by the acceptance card: the paired build works from this branch and
// never edits this file; corrections return to the acceptance card.
// Local fixtures only: the real +page.svelte, compiled with the web
// workspace's svelte/compiler and bundled by esbuild (the same harness as
// the Kit home SSR suite), rendered with fake load data in the widened
// `listHomeUpcoming` shape (`game`, `organizer_name`, `status`, `endsAt`,
// `rsvpOpen` join the existing teaser fields; the Hono/read acceptance file
// pins that projection and its query count).
// Exact command: npx vitest run test/kit-home-teaser-availability-acceptance.test.ts
//
// Contract pinned here mirrors the Hono file: trimmed game and
// `Hosted by {host}` under `event-card-host` only when non-blank, one
// `event-schedule-availability` snapshot ("RSVPs paused", "N seat(s) left"
// from seat occupancy, "No seat limit", "Ended", "Discord-managed"), and
// exactly one `event-spots-left` "Full" marker on a full row.
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
const FINITE_SEATS = /\b\d+\s+seats?\s+left\b/;

// Frozen render instant for the closed/full boundary pins below, mirroring
// the Hono twin's NOW. The page reads `new Date()` at render, so freezing
// the clock pins the end = now-1ms / now / now+1ms boundary exactly.
const KIT_NOW = new Date("2030-07-04T18:00:00Z");

function freezeKitNow() {
  vi.useFakeTimers();
  vi.setSystemTime(KIT_NOW);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// Render-time availability reads the live clock in the page, so every
// instant here is relative to the test run, never a fixed calendar date.
function inHours(hours: number): Date {
  return new Date(Date.now() + hours * 3600_000);
}

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

function canonicalEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const startsAt = inHours(26);
  return {
    source: "canonical",
    eventKey: "game-night-1",
    title: "Game night",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: "Voice lobby",
    game: "Wingspan",
    organizer_name: "Mara Host",
    status: "published",
    rsvpOpen: true,
    goingCount: 1,
    goingOccupancy: 1,
    capacity: 10,
    ...overrides,
  };
}

function discordEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "discord",
    discordId: "discord-1",
    title: "Discord game night",
    startsAt: inHours(26),
    timezone: "Europe/London",
    location: "Lobby voice room",
    ...overrides,
  };
}

/** The one teaser row linking `key`, so a sibling's marker cannot satisfy the pin. */
function teaserRow(html: string, key: string): string {
  const hit = html.split('<li class="card"').find((chunk) => chunk.includes(`/e/${key}"`));
  if (!hit) throw new Error(`no teaser row for ${key}`);
  return hit.split("</li>")[0]!;
}

/** The one Discord teaser row carrying `title` (it has no detail link). */
function discordRow(html: string, title: string): string {
  const hit = html
    .split('<li class="card"')
    .find((chunk) => chunk.includes('data-source="discord"') && chunk.includes(title));
  if (!hit) throw new Error(`no discord teaser row for ${title}`);
  return hit.split("</li>")[0]!;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-home-teaser-avail-"));
  const entry = join(scratch, "kit-home-teaser-avail-entry.mjs");
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
  const outfile = join(scratch, "kit-home-teaser-avail-bundle.mjs");
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
        name: "kit-home-teaser-avail-svelte-ssr",
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

describe("Kit teaser: game, host and availability", () => {
  it("shows game, host and occupancy-based seats left (singular and plural)", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [
          // Occupancy diverges: 3 seats taken, only 1 named. Seats left must
          // read occupancy, never the named count.
          canonicalEvent({
            eventKey: "singular-night",
            capacity: 4,
            goingCount: 1,
            goingOccupancy: 3,
          }),
          canonicalEvent({
            eventKey: "plural-night",
            game: "Coup",
            organizer_name: "Jo Host",
            capacity: 10,
            goingCount: 2,
            goingOccupancy: 2,
          }),
        ],
      }),
    );
    const singular = teaserRow(html, "singular-night");
    expect(singular).toContain("Wingspan");
    expect(singular).toContain('data-testid="event-card-host"');
    expect(singular).toContain("Hosted by Mara Host");
    expect(singular).toContain("1 of 4 going");
    expect(singular).toContain('data-testid="event-schedule-availability"');
    expect(singular).toContain("1 seat left");
    expect(singular).not.toContain("3 seats left");
    expect(singular).not.toContain("event-spots-left");

    const plural = teaserRow(html, "plural-night");
    expect(plural).toContain("Coup");
    expect(plural).toContain("Hosted by Jo Host");
    expect(plural).toContain("8 seats left");
    expect(plural).not.toContain("event-spots-left");
  });

  it("reads paused on a paused canonical row, capped or uncapped, advertising no seats", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [
          canonicalEvent({ eventKey: "paused-capped", rsvpOpen: false, capacity: 10 }),
          canonicalEvent({ eventKey: "paused-open", rsvpOpen: false, capacity: null }),
        ],
      }),
    );
    for (const key of ["paused-capped", "paused-open"]) {
      const row = teaserRow(html, key);
      expect(row).toContain('data-testid="event-schedule-availability"');
      expect(row).toContain("RSVPs paused");
      expect(row).not.toMatch(FINITE_SEATS);
      expect(row).not.toContain("No seat limit");
      expect(row).not.toContain("event-spots-left");
    }
  });

  it("reads No seat limit on an open uncapped row with no invented finite count", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [canonicalEvent({ capacity: null, goingCount: 3, goingOccupancy: 3 })],
      }),
    );
    const row = teaserRow(html, "game-night-1");
    expect(row).toContain("3 going");
    expect(row).toContain('data-testid="event-schedule-availability"');
    expect(row).toContain("No seat limit");
    expect(row).not.toMatch(FINITE_SEATS);
    expect(row).not.toContain("event-spots-left");
  });

  it("marks an exactly-full row once only: the Full marker, no second availability node", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [canonicalEvent({ capacity: 2, goingCount: 1, goingOccupancy: 2 })],
      }),
    );
    const row = teaserRow(html, "game-night-1");
    expect(row).toContain("1 of 2 going");
    expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(1);
    expect(occurrences(row, ">Full<")).toBe(1);
    expect(row).not.toContain("event-schedule-availability");
    expect(row).not.toContain("0 seats left");
  });

  it("reads Ended, never seats, on a row that ended between read and render", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [
          canonicalEvent({
            eventKey: "ended-just-now",
            startsAt: inHours(-2),
            endsAt: inHours(-0.02),
          }),
          canonicalEvent({
            eventKey: "ends-at-render",
            startsAt: inHours(-2),
            // A hair in the past at render: the read admitted it, the render
            // must not offer its seats.
            endsAt: new Date(Date.now() - 1),
          }),
        ],
      }),
    );
    for (const key of ["ended-just-now", "ends-at-render"]) {
      const row = teaserRow(html, key);
      expect(row).toContain("Game night");
      expect(row).toContain('data-testid="event-schedule-availability"');
      expect(row).toContain("Ended");
      expect(row).not.toMatch(FINITE_SEATS);
      expect(row).not.toContain("No seat limit");
      expect(row).not.toContain("RSVPs paused");
      expect(row).not.toContain("event-spots-left");
      expect(row).not.toContain(">Full<");
    }
  });

  it("omits blank game/host entirely: no empty labels beside a populated control row", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [
          canonicalEvent({ eventKey: "hosted-night" }),
          canonicalEvent({ eventKey: "blank-night", game: "   ", organizer_name: "   " }),
          canonicalEvent({ eventKey: "null-night", game: null, organizer_name: null }),
        ],
      }),
    );
    const control = teaserRow(html, "hosted-night");
    expect(control).toContain("Wingspan");
    expect(control).toContain("Hosted by Mara Host");
    for (const key of ["blank-night", "null-night"]) {
      const row = teaserRow(html, key);
      expect(row).toContain("Game night");
      expect(row).toContain("seats left");
      expect(row).not.toContain("Hosted by");
      expect(row).not.toContain("event-card-host");
      expect(row).not.toMatch(/<p>\s*<\/p>/);
    }
  });

  it("escapes hostile game and host text", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [
          canonicalEvent({
            game: '<script>alert("game")</script>',
            organizer_name: '<img src=x onerror="alert(1)">',
          }),
        ],
      }),
    );
    const row = teaserRow(html, "game-night-1");
    expect(row).toContain("&lt;script&gt;");
    expect(row).toContain("Hosted by &lt;img");
    expect(row).not.toContain("<script>alert");
    expect(row).not.toContain("<img src=x");
  });

  it("reads Discord-managed on a Discord row and keeps its invite link", () => {
    const html = renderPage(baseData({ upcomingEvents: [discordEvent()] }));
    expect(html).toContain('data-testid="home-events-list"');
    const row = discordRow(html, "Discord game night");
    expect(row).toContain(`href="${INVITE_URL}"`);
    expect(row).toContain('data-testid="home-event-discord"');
    expect(row).toContain('data-testid="event-schedule-availability"');
    expect(row).toContain("Discord-managed");
    expect(row).toContain("RSVP in Discord");
    expect(row).not.toContain("going");
    expect(row).not.toContain("Hosted by");
    expect(row).not.toContain("event-spots-left");
    expect(row).not.toMatch(FINITE_SEATS);
  });

  it("reads paused, never Full, on paused rows that are full or overfull", () => {
    freezeKitNow();
    const html = renderPage(
      baseData({
        upcomingEvents: [
          canonicalEvent({
            eventKey: "paused-full",
            rsvpOpen: false,
            capacity: 4,
            goingCount: 1,
            goingOccupancy: 4,
          }),
          canonicalEvent({
            eventKey: "paused-overfull",
            rsvpOpen: false,
            capacity: 4,
            goingCount: 1,
            goingOccupancy: 6,
          }),
        ],
      }),
    );
    for (const key of ["paused-full", "paused-overfull"]) {
      const row = teaserRow(html, key);
      expect(row).toContain("RSVPs paused");
      expect(occurrences(row, 'data-testid="event-schedule-availability"')).toBe(1);
      expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(0);
      expect(row).not.toContain(">Full<");
      expect(row).not.toMatch(FINITE_SEATS);
      expect(row).not.toContain("No seat limit");
      expect(row).not.toContain("Ended");
    }
  });

  it("reads Ended, never Full, on ended rows that are full or overfull, with a Full control past the end boundary", () => {
    freezeKitNow();
    const minus1 = new Date(KIT_NOW.getTime() - 1);
    const plus1 = new Date(KIT_NOW.getTime() + 1);
    const pastStart = new Date(KIT_NOW.getTime() - 7200_000);
    const html = renderPage(
      baseData({
        upcomingEvents: [
          canonicalEvent({
            eventKey: "ended-full-minus1",
            startsAt: pastStart,
            endsAt: minus1,
            goingCount: 1,
            goingOccupancy: 4,
            capacity: 4,
          }),
          canonicalEvent({
            eventKey: "ended-full-now",
            startsAt: pastStart,
            endsAt: KIT_NOW,
            goingCount: 1,
            goingOccupancy: 4,
            capacity: 4,
          }),
          canonicalEvent({
            eventKey: "ended-overfull-minus1",
            startsAt: pastStart,
            endsAt: minus1,
            goingCount: 1,
            goingOccupancy: 6,
            capacity: 4,
          }),
          canonicalEvent({
            eventKey: "ended-overfull-now",
            startsAt: pastStart,
            endsAt: KIT_NOW,
            goingCount: 1,
            goingOccupancy: 6,
            capacity: 4,
          }),
          canonicalEvent({
            eventKey: "open-full-plus1",
            startsAt: pastStart,
            endsAt: plus1,
            goingCount: 1,
            goingOccupancy: 4,
            capacity: 4,
          }),
          canonicalEvent({
            eventKey: "open-overfull-plus1",
            startsAt: pastStart,
            endsAt: plus1,
            goingCount: 1,
            goingOccupancy: 6,
            capacity: 4,
          }),
        ],
      }),
    );
    for (const key of [
      "ended-full-minus1",
      "ended-full-now",
      "ended-overfull-minus1",
      "ended-overfull-now",
    ]) {
      const row = teaserRow(html, key);
      expect(row).toContain("Game night");
      expect(row).toContain("Ended");
      expect(occurrences(row, 'data-testid="event-schedule-availability"')).toBe(1);
      expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(0);
      expect(row).not.toContain(">Full<");
      expect(row).not.toMatch(FINITE_SEATS);
      expect(row).not.toContain("No seat limit");
      expect(row).not.toContain("RSVPs paused");
    }
    for (const key of ["open-full-plus1", "open-overfull-plus1"]) {
      const row = teaserRow(html, key);
      expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(1);
      expect(occurrences(row, ">Full<")).toBe(1);
      expect(row).not.toContain("event-schedule-availability");
      expect(row).not.toContain("Ended");
      expect(row).not.toContain("0 seats left");
    }
  });

  it("reads Ended over paused when ended, paused over Full when open, on paused rows that are full or overfull", () => {
    freezeKitNow();
    const minus1 = new Date(KIT_NOW.getTime() - 1);
    const plus1 = new Date(KIT_NOW.getTime() + 1);
    const pastStart = new Date(KIT_NOW.getTime() - 7200_000);
    const html = renderPage(
      baseData({
        upcomingEvents: [
          canonicalEvent({
            eventKey: "paused-full-ended-minus1",
            startsAt: pastStart,
            endsAt: minus1,
            rsvpOpen: false,
            goingCount: 1,
            goingOccupancy: 4,
            capacity: 4,
          }),
          canonicalEvent({
            eventKey: "paused-full-ended-now",
            startsAt: pastStart,
            endsAt: KIT_NOW,
            rsvpOpen: false,
            goingCount: 1,
            goingOccupancy: 4,
            capacity: 4,
          }),
          canonicalEvent({
            eventKey: "paused-overfull-ended-minus1",
            startsAt: pastStart,
            endsAt: minus1,
            rsvpOpen: false,
            goingCount: 1,
            goingOccupancy: 6,
            capacity: 4,
          }),
          canonicalEvent({
            eventKey: "paused-overfull-ended-now",
            startsAt: pastStart,
            endsAt: KIT_NOW,
            rsvpOpen: false,
            goingCount: 1,
            goingOccupancy: 6,
            capacity: 4,
          }),
          canonicalEvent({
            eventKey: "paused-full-open-plus1",
            startsAt: pastStart,
            endsAt: plus1,
            rsvpOpen: false,
            goingCount: 1,
            goingOccupancy: 4,
            capacity: 4,
          }),
          canonicalEvent({
            eventKey: "paused-overfull-open-plus1",
            startsAt: pastStart,
            endsAt: plus1,
            rsvpOpen: false,
            goingCount: 1,
            goingOccupancy: 6,
            capacity: 4,
          }),
        ],
      }),
    );
    for (const key of [
      "paused-full-ended-minus1",
      "paused-full-ended-now",
      "paused-overfull-ended-minus1",
      "paused-overfull-ended-now",
    ]) {
      const row = teaserRow(html, key);
      expect(row).toContain("Ended");
      expect(occurrences(row, 'data-testid="event-schedule-availability"')).toBe(1);
      expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(0);
      expect(row).not.toContain(">Full<");
      expect(row).not.toContain("RSVPs paused");
      expect(row).not.toMatch(FINITE_SEATS);
    }
    for (const key of ["paused-full-open-plus1", "paused-overfull-open-plus1"]) {
      const row = teaserRow(html, key);
      expect(row).toContain("RSVPs paused");
      expect(occurrences(row, 'data-testid="event-schedule-availability"')).toBe(1);
      expect(occurrences(row, 'data-testid="event-spots-left"')).toBe(0);
      expect(row).not.toContain(">Full<");
      expect(row).not.toMatch(FINITE_SEATS);
      expect(row).not.toContain("No seat limit");
      expect(row).not.toContain("Ended");
    }
  });

  it("keeps older fixtures without the new fields open, unhosted and crash-free", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [
          {
            source: "canonical",
            eventKey: "legacy-night",
            title: "Legacy game night",
            startsAt: inHours(26),
            timezone: "Europe/London",
            location: null,
            goingCount: 2,
            capacity: 4,
          },
        ],
      }),
    );
    const row = teaserRow(html, "legacy-night");
    expect(row).toContain("2 of 4 going");
    // Missing occupancy falls back to the named count, missing rsvpOpen
    // reads open, missing host renders nothing.
    expect(row).toContain("2 seats left");
    expect(row).not.toContain("RSVPs paused");
    expect(row).not.toContain("Hosted by");
  });
});
