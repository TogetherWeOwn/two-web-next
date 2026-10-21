// Kit home SSR render contract: the real +page.svelte, compiled with the web
// workspace's svelte/compiler and bundled by esbuild (the same harness as
// ci/kit-preview-e2e.mjs), rendered with fake load data. String presence in
// source cannot catch a wrong branch — these renders fail the three mutants
// the source-grep suite missed: a hardcoded sessionUnavailable, a skipped
// flash precedence, and `{:else if session}` in the hero.
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
const JSON_LD_BLOCK =
  /<script type="application\/ld\+json" data-testid="([^"]+)">([\s\S]*?)<\/script>/g;

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

const memberSession = {
  userId: "member-1",
  username: "Member",
  avatar: null,
  member: true,
  moderator: false,
};

const nonMemberSession = {
  ...memberSession,
  userId: "player-1",
  username: "Player",
  member: false,
};

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-home-render-"));
  const entry = join(scratch, "kit-home-render-entry.mjs");
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
  const outfile = join(scratch, "kit-home-render-bundle.mjs");
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
        name: "kit-home-render-svelte-ssr",
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

describe("Kit home SSR render: session-aware header and hero", () => {
  it("renders the guest header with the Discord join entry point", () => {
    const html = renderPage(baseData());
    expect(html).toContain('data-testid="signin"');
    expect(html).toContain('data-testid="join"');
    expect(html).not.toContain('data-testid="join-result"');
    expect(html).not.toContain('data-testid="notice"');
  });

  it("renders the member header with the invite URL and no join entry point", () => {
    const html = renderPage(baseData({ session: memberSession }));
    expect(html).toContain('<form method="post" action="/logout">');
    expect(html).toContain("Member");
    expect(html).toContain(`href="${INVITE_URL}">Open Discord</a>`);
    expect(html).not.toContain('data-testid="signin"');
    expect(html).not.toContain('data-testid="join"');
  });

  it("renders the Discord join entry point for a signed-in non-member", () => {
    // Kills the `{:else if session}` hero mutant, which hands non-members
    // the member's Open Discord button.
    const html = renderPage(baseData({ session: nonMemberSession }));
    expect(html).toContain('data-testid="join"');
    expect(html).not.toContain(`href="${INVITE_URL}">Open Discord</a>`);
  });

  it("offers the invite-link hero during a session outage, even with live events", () => {
    // Kills the `sessionUnavailable = false` mutant: with no events outage
    // the fallback link below the hero cannot mask the missing hero button.
    const html = renderPage(baseData({ sessionUnavailable: true, eventsUnavailable: false }));
    expect(html).toContain("Welcome, guest");
    expect(html).toContain('data-testid="discord-join">Join with an invite link</a>');
  });
});

describe("Kit home SSR render: notice slot and one-shot flash", () => {
  it("renders the flashed confirmation ahead of any notice", () => {
    const html = renderPage(baseData({ notice: "joined", joinResult: "added" }));
    expect(html).toContain('data-testid="join-result"');
    expect(html).toContain(HOME_JOIN_RESULT_COPY.added);
    expect(html).not.toContain('data-testid="notice"');
  });

  it("renders the reinvite action for an already-member flash", () => {
    const html = renderPage(baseData({ joinResult: "already_member" }));
    expect(html).toContain(HOME_JOIN_RESULT_COPY.alreadyInServer);
    expect(html).toContain('data-testid="reinvite-link"');
  });

  it("renders a failure notice with no banner when the flash is suppressed", () => {
    const html = renderPage(baseData({ notice: "join_failed", joinResult: null }));
    expect(html).toContain('data-testid="notice"');
    expect(html).toContain(HOME_NOTICES.join_failed);
    expect(html).not.toContain('data-testid="join-result"');
  });
});

describe("Kit home SSR render: independently degraded panels", () => {
  it("hides stale counts instead of inventing values", () => {
    const html = renderPage(
      baseData({ counts: { memberCount: null, onlineCount: null, ranks: [] } }),
    );
    expect(html).not.toContain('data-testid="member-count"');
    // The ladder still names the ranks with the shared fallback.
    expect(html).toContain('data-testid="rank-stack"');
    expect(html).toContain("Prospect");
    expect(html).toContain("Legend");
  });

  it("reads a zero rank as unclaimed", () => {
    const html = renderPage(
      baseData({
        counts: {
          memberCount: 10,
          onlineCount: null,
          ranks: [{ key: "prospect", label: "Prospect", memberCount: 0 }],
        },
      }),
    );
    expect(html).toContain("unclaimed");
  });

  it("names the empty schedule and keeps the join entry point", () => {
    const html = renderPage(baseData());
    expect(html).toContain('data-testid="home-events-empty"');
    expect(html).toContain("Nothing scheduled yet.");
    expect(html).toContain('data-testid="home-events-join"');
  });

  it("states the events outage without hiding the rest of the page", () => {
    const html = renderPage(baseData({ eventsUnavailable: true }));
    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain("Game nights are unavailable right now.");
    expect(html).toContain('data-testid="member-count"');
  });

  it("renders visible featured rows and a canonical event link", () => {
    const html = renderPage(
      baseData({
        featured: [{ id: "f1", title: "Night report", body: "We played.", url: null }],
        upcomingEvents: [
          {
            source: "canonical",
            eventKey: "game-night-1",
            title: "Game night",
            startsAt: new Date(Date.UTC(2026, 9, 20, 19, 0, 0)),
            timezone: "Europe/London",
            location: null,
            goingCount: 3,
            capacity: null,
          },
        ],
      }),
    );
    expect(html).toContain('data-testid="featured-content"');
    expect(html).toContain('data-testid="featured-item"');
    expect(html).toContain("Night report");
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain('href="/e/game-night-1"');
    expect(html).toContain("3 going");
  });

  it("keeps the exact Hono title, canonical URL and JSON-LD marker", () => {
    const html = renderPage(baseData());
    expect(html).toContain("Together We Own — the lobby is open");
    expect(html).toContain(`<link rel="canonical" href="${APP_URL}/"`);
    expect(html).toContain('data-testid="site-jsonld"');
  });
});

describe("Kit home SSR render: one escaped structured-data block and one head identity", () => {
  it("emits exactly one site JSON-LD block that parses to the Organization and WebSite graph", () => {
    const html = renderPage(baseData({ session: memberSession }));
    const blocks = [...html.matchAll(JSON_LD_BLOCK)];
    expect(blocks.map((m) => m[1])).toEqual(["site-jsonld"]);
    const graph = JSON.parse(blocks[0]![2]!) as { "@graph": { "@type": string; "@id": string }[] };
    expect(graph["@graph"].map((node) => node["@type"])).toEqual(["Organization", "WebSite"]);
    expect(graph["@graph"][1]!["@id"]).toBe(`${APP_URL}/#website`);
  });

  it("renders one canonical link and one og:url in the head", () => {
    const html = renderPage(baseData());
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html.match(/property="og:url"/g)).toHaveLength(1);
  });
});
