// F3 acceptance: the Kit home teaser matches Hono on fullness.
//
// Owned by the F3 acceptance card: the paired build works from this branch
// and never edits this file; corrections return to the acceptance card.
// Local fixtures only: the real +page.svelte, compiled with the web
// workspace's svelte/compiler and bundled by esbuild (the same harness as
// the Kit home SSR suite), rendered with fake load data.
//
// Contract pinned here:
// - Capped teaser rows render "N of M going" via the shared `goingCountText`
//   helper, never pasted copy.
// - A full teaser row carries the same Full marker as Hono and detail: the
//   `event-spots-left` node rendering "Full". The teaser verdict reads the
//   attributable `goingCount` it carries (`HomeEvent` gains capacity only).
// - Uncapped rows render exactly as today (bare "N going", no marker node);
//   Discord rows keep "RSVP in Discord" with no count and no marker.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FALLBACK_RANKS, HOME_JOIN_RESULT_COPY, HOME_NOTICES } from "../src/home-copy";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
// svelte lives in the web workspace only; the root workspace never sees it,
// so the compiler type is structural (no svelte types in the root tsconfig).
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

type RenderPage = (data: Record<string, unknown>) => string;

let renderPage: RenderPage;
let scratch = "";

const INVITE_URL = "https://discord.gg/invite";
const APP_URL = "https://example.test";

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
  return {
    source: "canonical",
    eventKey: "game-night-1",
    title: "Game night",
    startsAt: new Date(Date.UTC(2030, 6, 20, 19, 0, 0)),
    timezone: "Europe/London",
    location: null,
    goingCount: 2,
    capacity: 10,
    ...overrides,
  };
}

/** The one teaser row linking `key`, so a sibling's marker cannot satisfy the pin. */
function teaserRow(html: string, key: string): string {
  const hit = html.split('<li class="card"').find((chunk) => chunk.includes(`/e/${key}"`));
  if (!hit) throw new Error(`no teaser row for ${key}`);
  return hit.split("</li>")[0]!;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-fullness-teaser-"));
  const entry = join(scratch, "kit-fullness-teaser-entry.mjs");
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
  const outfile = join(scratch, "kit-fullness-teaser-bundle.mjs");
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
        name: "kit-fullness-teaser-svelte-ssr",
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

describe("F3 fullness acceptance: Kit teaser", () => {
  it("renders a capped teaser row as N of M going", () => {
    const html = renderPage(baseData({ upcomingEvents: [canonicalEvent()] }));
    expect(teaserRow(html, "game-night-1")).toContain("2 of 10 going");
  });

  it("marks a full teaser row with the same Full marker plus testid", () => {
    const html = renderPage(
      baseData({ upcomingEvents: [canonicalEvent({ goingCount: 2, capacity: 2 })] }),
    );
    const row = teaserRow(html, "game-night-1");
    expect(row).toContain("2 of 2 going");
    expect(row).toContain('data-testid="event-spots-left"');
    expect(row).toContain(">Full<");
  });

  it("renders uncapped teaser rows exactly as today: bare count, no marker", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [
          canonicalEvent({ eventKey: "uncapped-night", goingCount: 3, capacity: null }),
          canonicalEvent({ eventKey: "capped-night", goingCount: 1, capacity: 4 }),
        ],
      }),
    );
    // The capped sibling proves the negative below is scoped, not vacuous;
    // its own count format is pinned above, so only presence is asserted here.
    expect(teaserRow(html, "capped-night")).toContain("Game night");
    const row = teaserRow(html, "uncapped-night");
    expect(row).toContain("3 going");
    expect(row).not.toContain("event-spots-left");
  });

  it("keeps Discord rows on RSVP in Discord with no count and no marker", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [
          {
            source: "discord",
            discordId: "discord-1",
            title: "Discord game night",
            startsAt: new Date(Date.UTC(2030, 6, 20, 19, 0, 0)),
            timezone: "Europe/London",
            location: null,
          },
        ],
      }),
    );
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain("RSVP in Discord");
    expect(html).not.toContain("going</p>");
    expect(html).not.toContain("event-spots-left");
  });

  it("renders the teaser count via the shared goingCountText helper", () => {
    // The Kit teaser must not paste its own "N of M going" copy: one helper
    // keeps cards, teasers and detail on the same words.
    const page = readFileSync(join(root, "web/src/routes/+page.svelte"), "utf8");
    expect(page).toContain("goingCountText");
  });
});
