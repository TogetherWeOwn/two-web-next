// Kit member-board SSR render contract: the real
// web/src/routes/leaderboards/members/+page.svelte, compiled with the web
// workspace's svelte/compiler and bundled by esbuild (the same harness as
// test/kit-about-parity.test.ts), rendered with fake load data. The board is
// members-only, so its chrome must be the member chrome Hono serves from
// src/page-shell.tsx (Signed in + viewer name + Sign out form), never the
// Shell default guest chrome. The executed parity journey caught the guest
// default in CI; this render pins it hermetically.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { parseActivityParam } from "../src/leaderboards/members";
import {
  frozenSeasonFixture,
  prepareSeasonBoardFixtures,
  renderMemberBoard,
} from "./fixtures/member-board-viewer";
import {
  discordGuestLinks,
  documentElements,
  element,
  elements,
  fallbackText,
  parseRenderedPage,
  renderedAttribute,
  responseValues,
  rowCells,
  text,
} from "./helpers/rendered-dom.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type BoardData = Record<string, unknown>;
let renderPage: (data: BoardData) => string;
let scratch = "";

function baseData(overrides: BoardData = {}): BoardData {
  return {
    season: "all",
    scope: "overall",
    activity: null,
    rows: [{ username: "Vic", count: 3, rank: 1, isViewer: true }],
    viewerUsername: "Vic",
    available: true,
    appUrl: "https://example.test",
    ...overrides,
  };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-members-render-"));
  const entry = join(scratch, "kit-members-render-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/leaderboards/members/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const outfile = join(scratch, "kit-members-render.mjs");
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
        name: "kit-members-svelte-ssr",
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
  ({ renderPage } = (await import(pathToFileURL(outfile).href)) as {
    renderPage: (data: BoardData) => string;
  });
});

function boardRows(page: ReturnType<typeof parseRenderedPage>) {
  return elements(element(page, "tbody"), "tr").map((row) =>
    rowCells(row).map((cell) => [cell.tagName, renderedAttribute(cell, "scope"), text(cell)]),
  );
}

function tablesWithoutScripting(html: string) {
  return documentElements(parseRenderedPage(html, { scriptingEnabled: false }), "table");
}

it("detects ranking tables in noscript content", () => {
  const html = "<noscript><table><tr><td>1</td><td>9</td></tr></table></noscript>";
  expect(documentElements(parseRenderedPage(html), "table")).toHaveLength(0);
  expect(tablesWithoutScripting(html)).toHaveLength(1);
});

describe("Isolated Kit season board render", () => {
  beforeAll(prepareSeasonBoardFixtures);

  it("describes Going sign-ups, keeps tied positions and offers a privacy opt-out link", () => {
    const page = parseRenderedPage(
      renderMemberBoard("season", "overall", true, false, {
        rows: [
          { username: "Vic", count: 3, rank: 1, isViewer: true },
          { username: "Mira", count: 3, rank: 2, isViewer: false },
        ],
      }),
    );
    expect(boardRows(page)).toEqual([
      [
        ["td", undefined, "1"],
        ["th", "row", "Vic (you)"],
        ["td", undefined, "3 · Tied"],
      ],
      [
        ["td", undefined, "2"],
        ["th", "row", "Mira"],
        ["td", undefined, "3 · Tied"],
      ],
    ]);
    expect(text(page)).toContain("current Going sign-ups for published or past events");
    const privacyHint = elements(page, "p").find((paragraph) =>
      text(paragraph).includes("opt out of leaderboards in your profile settings"),
    );
    assert(privacyHint, "Expected the privacy opt-out paragraph");
    expect(text(element(privacyHint, "a", { href: "/profile" }))).toBe("profile settings");
  });

  it("round-trips an accepted game spelling whose lowercase exceeds the limit", () => {
    const activityInput = `${"A".repeat(99)}İ`;
    const activity = activityInput.toLowerCase();
    expect(parseActivityParam(activity)).toMatchObject({ ok: false });
    const page = parseRenderedPage(
      renderMemberBoard("season", "relative", true, false, { activity, activityInput }),
    );
    const games = elements(page, "a")
      .map((link) => renderedAttribute(link, "href"))
      .filter((href): href is string => href?.startsWith("/leaderboards/members?") === true)
      .map((href) => new URL(href, "https://example.test").searchParams)
      .filter((params) => params.has("activity"));
    expect(games).toHaveLength(6);
    for (const game of games) {
      expect(parseActivityParam(game.get("activity"))).toEqual({ ok: true, game: activity });
    }
    expect(
      renderedAttribute(element(page, "input", { name: "activity", type: "text" }), "value"),
    ).toBe(activityInput);
  });

  it("labels synthetic ranks as frozen attendance and omits sign-up controls", () => {
    const html = renderMemberBoard("season", "overall", true, false, frozenSeasonFixture("ranked"));
    const page = parseRenderedPage(html);
    const copy = text(page);
    expect(copy).toContain("Members ranked by events with a frozen attendance record.");
    expect(copy).toContain("met the event’s voice attendance threshold");
    expect(text(element(page, "caption"))).toBe("Recorded events, season 2000-02");
    expect(elements(page, "th", { scope: "col" }).map(text)).toContain("Recorded events");
    const leaders = element(page, "ol", { "aria-label": "Leading recorded event counts" });
    expect(elements(leaders, "span").map(text)).toEqual(
      expect.arrayContaining(["8 recorded events", "1 recorded event"]),
    );
    expect(boardRows(page)).toContainEqual([
      ["td", undefined, "2"],
      ["th", "row", "Fixture viewer (you)"],
      ["td", undefined, "1"],
    ]);
    expect(copy).not.toMatch(/Going counts|sign-ups|Played|Filter the leaderboard|Board scope/);
    const forbidden = /42 recorded events|12 recorded events|fixture-echo-event/;
    expect(copy).not.toMatch(forbidden);
    expect(responseValues(page, html)).not.toContainEqual(expect.stringMatching(forbidden));
    expect(elements(page, "form", { "aria-label": "Filter the leaderboard" })).toEqual([]);
    expect(elements(page, "nav", { "aria-label": "Board scope" })).toEqual([]);
  });

  it.each([
    ["opted-out", "You are opted out of leaderboards."],
    ["zero", "You have 0 recorded events this season."],
  ] as const)("withholds stale ranking positions for a %s viewer", (state, message) => {
    const fixture = frozenSeasonFixture(state);
    const html = renderMemberBoard("season", "overall", true, false, {
      ...fixture,
      result: {
        status: "ready",
        viewer: state,
        rows: [
          { username: "Private fixture marker", rank: 1, count: 9, isViewer: true },
          { username: "Fixture neighbor", rank: 2, count: 8, isViewer: false },
        ],
      },
    } satisfies typeof fixture);
    const page = parseRenderedPage(html);
    expect(text(element(page, "p", { role: "status" }))).toBe(message);
    expect(documentElements(page, "table")).toEqual([]);
    expect(tablesWithoutScripting(html)).toEqual([]);
    const forbidden = /Private fixture marker|Fixture neighbor|temporarily unavailable/;
    expect(text(page)).not.toMatch(forbidden);
    expect(responseValues(page, html)).not.toContainEqual(expect.stringMatching(forbidden));
  });

  it.each([
    ["opted-out", "You are opted out of leaderboards.", true],
    ["zero", "You have 0 recorded events this season.", false],
    ["unavailable", "Attendance standings are temporarily unavailable.", false],
  ] as const)("renders a distinct %s frozen result", (state, message, hasRows) => {
    const html = renderMemberBoard("season", "overall", true, false, frozenSeasonFixture(state));
    const page = parseRenderedPage(html);
    expect(text(element(page, "p", { role: "status" }))).toBe(message);
    expect(elements(page, "table")).toHaveLength(hasRows ? 1 : 0);
    expect(documentElements(page, "table")).toHaveLength(hasRows ? 1 : 0);
    expect(tablesWithoutScripting(html)).toHaveLength(hasRows ? 1 : 0);
    const forbidden = /Fixture viewer \(you\)|Answer going/;
    expect(text(page)).not.toMatch(forbidden);
    expect(responseValues(page, html)).not.toContainEqual(expect.stringMatching(forbidden));
  });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("Kit member board render", () => {
  it("serves member chrome (Signed in, viewer name, Sign out), never guest chrome", () => {
    const html = renderPage(baseData());
    const page = parseRenderedPage(html);
    const account = element(page, "nav", { "aria-label": "Account" });
    const signOut = elements(account, "form", { method: "post", action: "/logout" }).find(
      (form) => elements(form, "span", { class: "account-caption" }).length > 0,
    );
    assert(signOut, "Expected the logout form with the account caption");
    expect(text(element(signOut, "span", { class: "account-caption" }))).toBe("Signed in");
    expect(text(element(signOut, "span", { class: "who" }))).toBe("Vic");
    expect(text(element(signOut, "button", { type: "submit" }))).toBe("Sign out");
    const guestCopy = /Welcome, guest|Sign in with Discord/;
    expect(text(page)).not.toMatch(guestCopy);
    const noScriptPage = parseRenderedPage(html, { scriptingEnabled: false });
    expect(fallbackText(noScriptPage)).not.toMatch(guestCopy);
    expect(discordGuestLinks(noScriptPage)).toEqual([]);
    // The viewer's own row is marked from the server-side isViewer flag.
    const viewerRow = element(page, "tr", { "aria-current": "true" });
    expect(text(element(viewerRow, "th", { scope: "row" }))).toBe("Vic");
  });

  it("links the board in the Primary nav as the current page, as Hono does, not Events", () => {
    const nav = element(parseRenderedPage(renderPage(baseData())), "nav", {
      "aria-label": "Primary",
    });
    expect(text(element(nav, "a", { href: "/leaderboards/members", "aria-current": "page" }))).toBe(
      "Leaderboard",
    );
    // Events is a sibling section here, never the current page.
    const events = element(nav, "a", { href: "/events" });
    expect(text(events)).toBe("Events");
    expect(renderedAttribute(events, "aria-current")).toBeUndefined();
  });
});
