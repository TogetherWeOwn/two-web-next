// Kit navigation acceptance: ordinary sign-in and discoverable member destinations.
//
// Test files only: the paired build consumes this branch unmodified and never
// edits this file. Failing-first: the Kit default header currently starts the
// join journey for ordinary Sign in, member-aware Kit pages hide the board
// link away from the board, and detail/cancelled descendants mark Events as
// the current page. The Hono sections below are the green control: they pin
// the oracle behavior the Kit build must match.
//
// Coverage is the real href/visibility/ARIA matrix on both renderers,
// including Unicode/query return paths. No source-text pins: every assertion
// runs against SSR output (Svelte compiler + esbuild for Kit, Hono JSX and
// worker requests for the oracle). No wall-clock races: renders are
// synchronous fixtures with explicit data, no timers.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteHeader } from "../src/pages";
import type { Session } from "../src/env";
import type { Env } from "../src/env";
import { aboutPageData } from "../src/about-content";
import { FALLBACK_RANKS, HOME_JOIN_RESULT_COPY, HOME_NOTICES } from "../src/home-copy";
import { loginUrl } from "../src/islands/contracts";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { renderEventsHtml } from "../src/kit-events-html";
import app from "./app";
import { EVENT_KEY, pageShellFixture } from "./helpers/page-shells";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const baseEnv = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "test-guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
} as unknown as Env;

// Return destinations that must survive safe encoding: a bare schedule path,
// a Unicode search with query punctuation, and a paged detail path.
const SIMPLE_NEXT = "/events";
const UNICODE_NEXT = "/events?q=café 🎮&view=calendar&month=2030-01";
const DETAIL_NEXT = `/e/${EVENT_KEY}?attendees=2`;
const PAST_NEXT = "/events/past?page=3";

const ordinaryUrl = (next: string | null): string =>
  next ? `/auth/discord?next=${encodeURIComponent(next)}` : "/auth/discord";

const memberSession: Session = {
  id: "member-1",
  username: "Vic",
  avatar: null,
  member: true,
  moderator: false,
};

const nonMemberSession: Session = {
  id: "prospect-1",
  username: "Newcomer",
  avatar: null,
  member: false,
  moderator: false,
};

const honoHeader = (props: Parameters<typeof SiteHeader>[0]): string =>
  SiteHeader(props)!.toString() as string;

const primaryNavOf = (html: string): string => {
  const nav = html.match(/<nav[^>]*aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/);
  if (!nav) throw new Error("Primary nav is missing");
  return nav[1]!;
};

const headerOf = (html: string): string => {
  const header = html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/);
  if (!header) throw new Error("header is missing");
  return header[1]!;
};

const assertSkipAndLandmarks = (html: string, opts: { account: boolean }): void => {
  expect(html.match(/<a\b[^>]*href="#main"[^>]*>/g)).toHaveLength(1);
  expect(html).toContain('class="skip-link" href="#main"');
  expect(html).toContain("Skip to content");
  expect(html.match(/<main\b[^>]*>/g)).toHaveLength(1);
  const main = html.match(/<main\b[^>]*>/)![0]!;
  expect(main).toContain('id="main"');
  expect(main).toContain('tabindex="-1"');
  for (const nav of html.match(/<nav\b[^>]*>/g) ?? []) expect(nav).toMatch(/aria-label="[^"]+"/);
  if (opts.account) {
    expect(html).toContain('aria-label="Account"');
  } else {
    expect(html).not.toContain('aria-label="Account"');
  }
};

const assertPrimaryOrder = (html: string, opts: { leaderboard: boolean }): void => {
  const nav = primaryNavOf(html);
  const home = nav.indexOf('href="/"');
  const events = nav.indexOf('href="/events"');
  expect(home).toBeGreaterThanOrEqual(0);
  expect(events).toBeGreaterThanOrEqual(0);
  expect(home).toBeLessThan(events);
  if (opts.leaderboard) {
    const board = nav.indexOf('href="/leaderboards/members"');
    expect(board).toBeGreaterThanOrEqual(0);
    expect(events).toBeLessThan(board);
  } else {
    expect(nav).not.toContain('href="/leaderboards/members"');
  }
};

// ---------------------------------------------------------------------------
// Kit SSR harness: the real Svelte pages, compiled with the web workspace's
// own compiler and bundled by esbuild (same shape as the board render test).
// ---------------------------------------------------------------------------

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

type KitRenders = {
  renderSiteHeader: (props: Record<string, unknown>) => string;
  renderHome: (data: Record<string, unknown>) => string;
  renderEventDetail: (model: Record<string, unknown>) => string;
  renderEventGone: (model: Record<string, unknown>) => string;
  renderBoard: (data: Record<string, unknown>) => string;
  renderAbout: (data: Record<string, unknown>) => string;
  renderPast: (data: Record<string, unknown>) => string;
  applicationModules: string[];
};

let kit: KitRenders;
let kitScratch = "";

const baseHomeData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  session: null,
  sessionUnavailable: false,
  notice: null,
  joinResult: null,
  inviteUrl: "https://discord.gg/invite",
  appUrl: APP_URL,
  counts: {
    memberCount: 42,
    onlineCount: 7,
    ranks: FALLBACK_RANKS,
  },
  upcomingEvents: [],
  eventsUnavailable: false,
  featured: [],
  imageHosts: "",
  homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS },
  ...overrides,
});

const kitMemberSession = {
  userId: "member-1",
  username: "Vic",
  avatar: null,
  member: true,
  moderator: false,
};

const kitNonMemberSession = {
  userId: "prospect-1",
  username: "Newcomer",
  avatar: null,
  member: false,
  moderator: false,
};

const baseDetailModel = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  eventKey: EVENT_KEY,
  title: "Fixture game night",
  game: "Chess",
  description: "Play together.",
  shareDescription: "Play together.",
  location: "Lobby",
  status: "published",
  isDraft: false,
  isPast: false,
  goingCount: 3,
  goingOccupancy: 3,
  capacity: 10,
  rsvpOpen: true,
  rsvpClosed: null,
  canonical: `${APP_URL}/e/${EVENT_KEY}`,
  path: `/e/${EVENT_KEY}`,
  attendeesRefreshHref: `/e/${EVENT_KEY}`,
  robots: null,
  markdownAlternate: `/e/${EVENT_KEY}.md`,
  icsUrl: `${APP_URL}/events/${EVENT_KEY}.ics`,
  googleCalendarUrl: null,
  copyLink: `${APP_URL}/e/${EVENT_KEY}`,
  whenText: "Friday, 1 January 2030, 20:00",
  endsWhenText: "Friday, 1 January 2030, 22:00",
  zoneLabel: "UTC",
  timeDatetime: "2030-01-01T20:00:00.000Z",
  attendees: [],
  attendeesPaging: { page: 1, prevHref: null, nextHref: null },
  answer: null,
  waitlistPosition: null,
  neighbors: { previous: null, next: null },
  related: [],
  showJoinPitch: true,
  joinReturnTo: `/e/${EVENT_KEY}`,
  joinResult: null,
  viewerMember: false,
  viewerModerator: false,
  viewerUsername: null,
  endsAt: "2030-01-01T22:00:00.000Z",
  jsonLd: "{}",
  siteJsonLd: "{}",
  ...overrides,
});

const baseGoneModel = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: "Cancelled game night",
  game: "Chess",
  eventKey: EVENT_KEY,
  icsUrl: `${APP_URL}/events/${EVENT_KEY}.ics`,
  markdownAlternate: `/e/${EVENT_KEY}.md`,
  upcomingUrl: "/events",
  related: [],
  jsonLd: "{}",
  siteJsonLd: "{}",
  ...overrides,
});

const baseBoardData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  season: "all",
  scope: "overall",
  activity: null,
  rows: [{ username: "Vic", count: 3, rank: 1, isViewer: true }],
  viewerUsername: "Vic",
  available: true,
  appUrl: APP_URL,
  ...overrides,
});

const basePastData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  rows: [],
  page: 3,
  hasMore: false,
  totalPages: 3,
  appUrl: APP_URL,
  q: "",
  ...overrides,
});

const baseScheduleData = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  state: { view: "list", month: "2030-01", q: "", past: false, page: 1 },
  upcoming: [],
  past: [],
  zone: "Europe/London",
  now: new Date("2030-01-01T20:00:00Z"),
  totalPages: 1,
  emptyState: "never",
  games: [],
  gameFilter: null,
  robots: undefined,
  discordFailed: false,
  member: false,
  moderator: false,
  inviteUrl: "https://discord.gg/invite",
  appUrl: APP_URL,
  canonical: `${APP_URL}/events`,
  loginReturnTo: SIMPLE_NEXT,
  joinResult: null,
  queryTooLong: false,
  ...overrides,
});

const scheduleHeaders = {
  "cache-control": "public, max-age=60",
  vary: "Cookie, X-Two-Island",
  "x-two-events-cacheable": "true",
};

beforeAll(async () => {
  kitScratch = mkdtempSync(join(tmpdir(), "kit-navigation-"));
  const entry = join(kitScratch, "kit-navigation-entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import SiteHeader from ${JSON.stringify(join(root, "web/src/lib/SiteHeader.svelte"))};
import HomePage from ${JSON.stringify(join(root, "web/src/routes/+page.svelte"))};
import EventDetail from ${JSON.stringify(join(root, "web/src/lib/EventDetail.svelte"))};
import EventGone from ${JSON.stringify(join(root, "web/src/lib/EventGone.svelte"))};
import BoardPage from ${JSON.stringify(join(root, "web/src/routes/leaderboards/members/+page.svelte"))};
import AboutPage from ${JSON.stringify(join(root, "web/src/routes/about/+page.svelte"))};
import PastPage from ${JSON.stringify(join(root, "web/src/routes/events/past/+page.svelte"))};
import { LEAF_CRITICAL_CSS } from ${JSON.stringify(join(root, "src/leaf-critical-css.ts"))};
const wrap = (head, body) => "<head>" + head + "</head><body>" + body + "</body>";
export function renderSiteHeader(props) {
  const { head, body } = render(SiteHeader, { props });
  return wrap(head, body);
}
export function renderHome(data) {
  const { head, body } = render(HomePage, { props: { data } });
  return wrap(head, body);
}
export function renderEventDetail(model) {
  const { head, body } = render(EventDetail, { props: { model } });
  return wrap(head, body);
}
export function renderEventGone(model) {
  const { head, body } = render(EventGone, { props: { model } });
  return wrap(head, body);
}
export function renderBoard(data) {
  const { head, body } = render(BoardPage, { props: { data } });
  return wrap(head, body);
}
export function renderAbout(data) {
  const { head, body } = render(AboutPage, { props: { data: { ...data, leafCss: LEAF_CRITICAL_CSS } } });
  return wrap(head, body);
}
export function renderPast(data) {
  const { head, body } = render(PastPage, { props: { data } });
  return wrap(head, body);
}
`,
  );
  const outfile = join(kitScratch, "kit-navigation.mjs");
  const result = await build({
    metafile: true,
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
        name: "kit-navigation-svelte-ssr",
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
  const renders = (await import(pathToFileURL(outfile).href)) as Omit<
    KitRenders,
    "applicationModules"
  >;
  const applicationModules = Object.keys(result.metafile.inputs).filter(
    (module) => !module.includes("node_modules/"),
  );
  kit = { ...renders, applicationModules };
}, 60_000);

afterAll(() => {
  rmSync(kitScratch, { recursive: true, force: true });
});

beforeEach(() => {
  // Every render in this suite is a local fixture: nothing reaches Discord,
  // a preview service or a staging/production database.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("navigation acceptance tests must remain local");
    }),
  );
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Oracle: Hono header behavior. All green; the Kit build must match this.
// ---------------------------------------------------------------------------

describe("oracle: Hono ordinary sign-in", () => {
  it.each([
    [null, "/auth/discord"],
    [SIMPLE_NEXT, ordinaryUrl(SIMPLE_NEXT)],
    [UNICODE_NEXT, ordinaryUrl(UNICODE_NEXT)],
    [DETAIL_NEXT, ordinaryUrl(DETAIL_NEXT)],
  ] as const)("signs %s through the ordinary round trip", (loginReturnTo, href) => {
    const html = honoHeader({ active: "events", loginReturnTo });
    expect(html).toContain(`href="${href}" data-testid="signin"`);
    expect(html).toContain("Sign in with Discord");
    expect(html).not.toContain("/join/discord");
  });

  it("keeps the join journey on the RSVP contract, never the header", () => {
    expect(loginUrl(SIMPLE_NEXT)).toBe(`/join/discord?next=${encodeURIComponent(SIMPLE_NEXT)}`);
    expect(loginUrl(null)).toBe("/join/discord");
    const header = honoHeader({ active: "events", loginReturnTo: SIMPLE_NEXT });
    expect(header).not.toContain(loginUrl(SIMPLE_NEXT));
  });
});

describe("oracle: Hono membership-based board navigation", () => {
  it.each([
    ["guest", null, false],
    ["signed-in non-member", nonMemberSession, false],
    ["member", memberSession, true],
  ] as const)("offers the board link to members only (%s)", (_label, session, offered) => {
    const nav = primaryNavOf(honoHeader({ session, active: "home" }));
    expect(nav.includes('href="/leaderboards/members"')).toBe(offered);
  });

  it("marks the board link current only on the board itself", () => {
    const onBoard = primaryNavOf(honoHeader({ session: memberSession, active: "leaderboard" }));
    expect(onBoard).toContain(
      '<a href="/leaderboards/members" aria-current="page">Leaderboard</a>',
    );
    expect(onBoard).toContain('<a href="/events">Events</a>');
    const away = primaryNavOf(honoHeader({ session: memberSession, active: "home" }));
    expect(away).toContain('<a href="/leaderboards/members">Leaderboard</a>');
    expect(away).not.toContain('href="/leaderboards/members" aria-current');
  });
});

describe("oracle: Hono current-section semantics", () => {
  it("marks the schedule as the current page", () => {
    const nav = primaryNavOf(honoHeader({ active: "events", loginReturnTo: SIMPLE_NEXT }));
    expect(nav).toContain('<a href="/events" aria-current="page">Events</a>');
  });

  it("marks detail descendants as the current location, not page", () => {
    const nav = primaryNavOf(
      honoHeader({ session: memberSession, active: "event", loginReturnTo: DETAIL_NEXT }),
    );
    expect(nav).toContain('<a href="/events" aria-current="location">Events</a>');
    expect(nav).not.toContain('aria-current="page">Events');
  });

  it("marks home as the current page with Events unmarked", () => {
    const nav = primaryNavOf(honoHeader({ session: memberSession, active: "home" }));
    expect(nav).toContain('<a href="/" aria-current="page">Home</a>');
    expect(nav).toContain('<a href="/events">Events</a>');
  });
});

describe("oracle: Hono account overrides stay intact", () => {
  it("renders an explicit CTA instead of the default sign-in", () => {
    const html = honoHeader({
      cta: { href: "/auth/discord?next=%2Fprofile", label: "Continue" },
    });
    expect(html).toContain('href="/auth/discord?next=%2Fprofile" data-testid="signin"');
    expect(html).toContain("Continue");
    expect(html).not.toContain("Sign in with Discord");
  });

  it("renders the join action on static leaves for every visitor", () => {
    const html = honoHeader({ joinAction: true });
    expect(html).toContain(
      '<div><span class="account-caption">Welcome, guest</span><a class="btn" href="/join">Join with Discord</a></div>',
    );
    expect(html).not.toContain('data-testid="signin"');
  });

  it("lets children replace the account area", () => {
    const html = honoHeader({
      active: "events",
      loginReturnTo: SIMPLE_NEXT,
      children: undefined,
    });
    // Without children the default guest chrome renders; with member children
    // the schedule shell passes Open Discord instead (pinned by integration).
    expect(html).toContain('data-testid="signin"');
  });

  it("drops the account area on sessionless pages", () => {
    const html = honoHeader({ active: "event", account: false });
    expect(html).not.toContain('aria-label="Account"');
    expect(html).not.toContain('data-testid="signin"');
    expect(html).not.toContain("Sign out");
  });

  it("renders member chrome for signed-in viewers without a sign-in link", () => {
    const html = honoHeader({ session: memberSession, active: "home" });
    expect(html).toContain('<form method="post" action="/logout">');
    expect(html).toContain('<span class="account-caption">Signed in</span>');
    expect(html).toContain('<span class="who">Vic</span>');
    expect(html).not.toContain('data-testid="signin"');
  });
});

describe("oracle: Hono served schedule/detail/cancelled/board/static", () => {
  it("serves the guest schedule with ordinary sign-in, page semantics and no board link", async () => {
    const fixture = pageShellFixture();
    const res = await app.request(`${fixture.env.APP_URL}/events`, {}, fixture.env);
    expect(res.status).toBe(200);
    const html = await res.text();
    const header = headerOf(html);
    expect(header).toContain(`href="${ordinaryUrl("/events")}" data-testid="signin"`);
    expect(primaryNavOf(html)).toContain('<a href="/events" aria-current="page">Events</a>');
    expect(primaryNavOf(html)).not.toContain('href="/leaderboards/members"');
    expect(html).toContain(
      `href="/join?next=${encodeURIComponent("/events")}">Join the Discord</a>`,
    );
  });

  it("serves guest detail with ordinary sign-in, location semantics and no board link", async () => {
    const fixture = pageShellFixture();
    const res = await app.request(`${fixture.env.APP_URL}/e/${EVENT_KEY}`, {}, fixture.env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(headerOf(html)).toContain(
      `href="${ordinaryUrl(`/e/${EVENT_KEY}`)}" data-testid="signin"`,
    );
    expect(primaryNavOf(html)).toContain('<a href="/events" aria-current="location">Events</a>');
    expect(primaryNavOf(html)).not.toContain('href="/leaderboards/members"');
  });

  it("serves member detail with the board link, location semantics and member chrome", async () => {
    const html = await (await pageShellFixture().request(`/e/${EVENT_KEY}`)).text();
    expect(primaryNavOf(html)).toContain('<a href="/leaderboards/members">Leaderboard</a>');
    expect(primaryNavOf(html)).toContain('<a href="/events" aria-current="location">Events</a>');
    expect(headerOf(html)).toContain('<form method="post" action="/logout">');
    expect(headerOf(html)).not.toContain('data-testid="signin"');
  });

  it("serves cancelled detail sessionless: location, no account, no board link", async () => {
    const res = await pageShellFixture("cancelled").request(`/e/${EVENT_KEY}`);
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(primaryNavOf(html)).toContain('<a href="/events" aria-current="location">Events</a>');
    expect(html).not.toContain('aria-label="Account"');
    expect(primaryNavOf(html)).not.toContain('href="/leaderboards/members"');
  });

  it("serves the member board with its own item current and member chrome", async () => {
    const res = await pageShellFixture().request("/leaderboards/members");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(primaryNavOf(html)).toContain(
      '<a href="/leaderboards/members" aria-current="page">Leaderboard</a>',
    );
    expect(primaryNavOf(html)).toContain('<a href="/events">Events</a>');
    expect(headerOf(html)).toContain('<span class="who">Fixture member</span>');
  });

  it("serves static leaves with join chrome, no board link and no current section", async () => {
    const html = await (await app.request(`${APP_URL}/about`, {}, baseEnv)).text();
    expect(headerOf(html)).toContain('<a class="btn" href="/join">Join with Discord</a>');
    expect(primaryNavOf(html)).not.toContain('href="/leaderboards/members"');
    expect(primaryNavOf(html)).not.toContain("aria-current");
  });

  it("keeps static leaves and cancelled detail sessionless under a throwing store", async () => {
    const throwing = () =>
      new Proxy(
        {},
        {
          get: () => {
            throw new Error("static and cancelled reads must not touch the session store");
          },
        },
      );
    const env = {
      ...baseEnv,
      SESSION_STORE: throwing(),
      DATABASE_URL: "postgres://agent-testdb:5432/unused",
    } as unknown as Env;
    for (const path of ["/about", "/faq", "/rules", "/privacy"]) {
      const res = await app.request(`${APP_URL}${path}`, {}, env);
      expect(res.status, path).toBe(200);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Kit default header: ordinary sign-in, no invented board link, intact shell.
// ---------------------------------------------------------------------------

describe("kit default header: ordinary sign-in", () => {
  it.each([[null], [SIMPLE_NEXT], [UNICODE_NEXT], [DETAIL_NEXT]] as const)(
    "signs %s through the ordinary round trip",
    (loginReturnTo) => {
      const html = kit.renderSiteHeader({ loginReturnTo });
      expect(html).toContain(`href="${ordinaryUrl(loginReturnTo)}" data-testid="signin"`);
      expect(html).toContain("Sign in with Discord");
    },
  );

  it("never starts the join journey from the default sign-in", () => {
    for (const loginReturnTo of [null, SIMPLE_NEXT, UNICODE_NEXT]) {
      const html = kit.renderSiteHeader({ loginReturnTo });
      expect(html).not.toContain("/join/discord");
    }
  });

  it("offers no board link without membership, even with a return destination", () => {
    for (const loginReturnTo of [null, SIMPLE_NEXT, UNICODE_NEXT]) {
      const nav = primaryNavOf(kit.renderSiteHeader({ loginReturnTo }));
      expect(nav).not.toContain('href="/leaderboards/members"');
    }
  });

  it("drops the account area when hidden, like the sessionless oracle", () => {
    const html = kit.renderSiteHeader({ loginReturnTo: SIMPLE_NEXT, hideAccount: true });
    expect(html).not.toContain('aria-label="Account"');
    expect(html).not.toContain('data-testid="signin"');
    expect(html).not.toContain("Sign out");
  });

  it("preserves the skip target, landmarks and keyboard order", () => {
    const html = kit.renderSiteHeader({ loginReturnTo: SIMPLE_NEXT });
    expect(html).toContain('class="skip-link" href="#main"');
    expect(html).toContain("Skip to content");
    for (const nav of html.match(/<nav\b[^>]*>/g) ?? []) expect(nav).toMatch(/aria-label="[^"]+"/);
    assertPrimaryOrder(html, { leaderboard: false });
    const header = headerOf(`<header>${html}</header>`);
    expect(header.indexOf('aria-label="Primary"')).toBeLessThan(
      header.indexOf('aria-label="Account"'),
    );
  });
});

// ---------------------------------------------------------------------------
// Kit home: member-aware board discovery with intact account chrome.
// ---------------------------------------------------------------------------

describe("kit home: board discovery", () => {
  it("exposes the board link to members away from the board", () => {
    const nav = primaryNavOf(kit.renderHome(baseHomeData({ session: kitMemberSession })));
    expect(nav).toContain('<a href="/leaderboards/members">Leaderboard</a>');
  });

  it("offers no board link to guests", () => {
    const html = kit.renderHome(baseHomeData({ session: null }));
    expect(primaryNavOf(html)).not.toContain('href="/leaderboards/members"');
    expect(headerOf(html)).toContain('href="/auth/discord" data-testid="signin"');
    expect(headerOf(html)).toContain("Welcome, guest");
  });

  it("offers no board link to signed-in non-members", () => {
    const html = kit.renderHome(baseHomeData({ session: kitNonMemberSession }));
    expect(primaryNavOf(html)).not.toContain('href="/leaderboards/members"');
    expect(headerOf(html)).toContain('<form method="post" action="/logout">');
    expect(headerOf(html)).toContain('<span class="who">Newcomer</span>');
  });

  it("renders member chrome for members without a sign-in link", () => {
    const header = headerOf(kit.renderHome(baseHomeData({ session: kitMemberSession })));
    expect(header).toContain('<form method="post" action="/logout">');
    expect(header).toContain('<span class="account-caption">Signed in</span>');
    expect(header).toContain('<span class="who">Vic</span>');
    expect(header).not.toContain('data-testid="signin"');
  });

  it("marks home current with Events unmarked", () => {
    for (const session of [null, kitNonMemberSession, kitMemberSession]) {
      const nav = primaryNavOf(kit.renderHome(baseHomeData({ session })));
      expect(nav).toContain('<a href="/" aria-current="page">Home</a>');
      expect(nav).toContain('<a href="/events">Events</a>');
    }
  });

  it("preserves the skip target, landmarks and keyboard order for guests", () => {
    const guest = kit.renderHome(baseHomeData({ session: null }));
    assertSkipAndLandmarks(guest, { account: true });
    assertPrimaryOrder(guest, { leaderboard: false });
  });

  it("keeps the member board link last in keyboard order", () => {
    const member = kit.renderHome(baseHomeData({ session: kitMemberSession }));
    assertSkipAndLandmarks(member, { account: true });
    assertPrimaryOrder(member, { leaderboard: true });
  });
});

// ---------------------------------------------------------------------------
// Kit event detail: ordinary header sign-in, member board link, location.
// ---------------------------------------------------------------------------

describe("kit event detail: header and navigation", () => {
  it("signs guests through the ordinary round trip with the page destination", () => {
    const html = kit.renderEventDetail(baseDetailModel({ path: DETAIL_NEXT }));
    expect(headerOf(html)).toContain(`href="${ordinaryUrl(DETAIL_NEXT)}" data-testid="signin"`);
    expect(headerOf(html)).not.toContain("/join/discord");
  });

  it("exposes the board link to members away from the board", () => {
    const nav = primaryNavOf(
      kit.renderEventDetail(
        baseDetailModel({ viewerMember: true, viewerUsername: "Vic", showJoinPitch: false }),
      ),
    );
    expect(nav).toContain('<a href="/leaderboards/members">Leaderboard</a>');
  });

  it("offers no board link to guests or signed-in non-members", () => {
    const guest = primaryNavOf(kit.renderEventDetail(baseDetailModel()));
    expect(guest).not.toContain('href="/leaderboards/members"');
    const nonMember = primaryNavOf(
      kit.renderEventDetail(baseDetailModel({ viewerMember: false, viewerUsername: "Newcomer" })),
    );
    expect(nonMember).not.toContain('href="/leaderboards/members"');
  });

  it.each([[false], [true]] as const)(
    "marks Events as the current location (member=%s)",
    (viewerMember) => {
      const nav = primaryNavOf(
        kit.renderEventDetail(
          baseDetailModel({
            viewerMember,
            viewerUsername: viewerMember ? "Vic" : null,
            showJoinPitch: !viewerMember,
          }),
        ),
      );
      expect(nav).toContain('<a href="/events" aria-current="location">Events</a>');
      expect(nav).not.toContain('aria-current="page">Events');
    },
  );

  it("renders member chrome for signed-in viewers without a header sign-in link", () => {
    const header = headerOf(
      kit.renderEventDetail(baseDetailModel({ viewerMember: true, viewerUsername: "Vic" })),
    );
    expect(header).toContain('<form method="post" action="/logout">');
    expect(header).toContain('<span class="who">Vic</span>');
    expect(header).not.toContain('data-testid="signin"');
  });

  it("preserves the skip target, landmarks and keyboard order for guests", () => {
    const guest = kit.renderEventDetail(baseDetailModel());
    assertSkipAndLandmarks(guest, { account: true });
    assertPrimaryOrder(guest, { leaderboard: false });
  });

  it("keeps the member board link last in keyboard order", () => {
    const member = kit.renderEventDetail(
      baseDetailModel({ viewerMember: true, viewerUsername: "Vic", showJoinPitch: false }),
    );
    assertSkipAndLandmarks(member, { account: true });
    assertPrimaryOrder(member, { leaderboard: true });
  });
});

describe("kit event detail: join and RSVP entry points keep the join flow", () => {
  it("keeps the RSVP guest entry on the join journey", () => {
    const joinReturnTo = `/e/${EVENT_KEY}?attendees=2`;
    const html = kit.renderEventDetail(baseDetailModel({ joinReturnTo }));
    const expected = loginUrl(joinReturnTo);
    expect(expected).toContain("/join/discord?next=");
    expect(html).toContain(`data-login-url="${expected}"`);
    expect(html).toContain(`<a href="${expected}">Log in with Discord</a>`);
    expect(html).not.toContain(`data-login-url="${ordinaryUrl(joinReturnTo)}"`);
  });

  it("keeps the join pitch on the join funnel with the page destination", () => {
    const path = `/e/${EVENT_KEY}`;
    const html = kit.renderEventDetail(baseDetailModel({ path, showJoinPitch: true }));
    expect(html).toContain('data-testid="event-join-pitch"');
    expect(html).toContain(`href="/join?next=${encodeURIComponent(path)}"`);
  });

  it("shows no guest RSVP entry or pitch to members", () => {
    const html = kit.renderEventDetail(
      baseDetailModel({ viewerMember: true, viewerUsername: "Vic", showJoinPitch: false }),
    );
    expect(html).not.toContain("Log in with Discord");
    expect(html).not.toContain('data-testid="event-join-pitch"');
  });
});

// ---------------------------------------------------------------------------
// Kit cancelled detail: location semantics without session or account.
// ---------------------------------------------------------------------------

describe("kit cancelled detail: sessionless location", () => {
  it("marks Events as the current location, not page", () => {
    const nav = primaryNavOf(kit.renderEventGone(baseGoneModel()));
    expect(nav).toContain('<a href="/events" aria-current="location">Events</a>');
    expect(nav).not.toContain('aria-current="page">Events');
  });

  it("carries no account area and no board link", () => {
    const html = kit.renderEventGone(baseGoneModel());
    expect(html).not.toContain('aria-label="Account"');
    expect(html).not.toContain('data-testid="signin"');
    expect(html).not.toContain("Sign out");
    expect(primaryNavOf(html)).not.toContain('href="/leaderboards/members"');
    expect(html).toContain('data-testid="event-cancelled"');
  });

  it("preserves the skip target, landmarks and keyboard order", () => {
    const html = kit.renderEventGone(baseGoneModel());
    assertSkipAndLandmarks(html, { account: false });
    assertPrimaryOrder(html, { leaderboard: false });
  });
});

// ---------------------------------------------------------------------------
// Kit board, schedule, archive and static leaves.
// ---------------------------------------------------------------------------

describe("kit member board: own item current with member chrome", () => {
  it("marks the board current with Events unmarked", () => {
    const nav = primaryNavOf(kit.renderBoard(baseBoardData()));
    expect(nav).toContain('<a href="/leaderboards/members" aria-current="page">Leaderboard</a>');
    expect(nav).toContain('<a href="/events">Events</a>');
  });

  it("serves member chrome, never guest chrome", () => {
    const header = headerOf(kit.renderBoard(baseBoardData()));
    expect(header).toContain('<form method="post" action="/logout">');
    expect(header).toContain('<span class="who">Vic</span>');
    expect(header).not.toContain("Welcome, guest");
    expect(header).not.toContain("Sign in with Discord");
  });
});

describe("kit schedule: ordinary sign-in, page semantics, no invented link", () => {
  it.each([[SIMPLE_NEXT], [UNICODE_NEXT], [PAST_NEXT]] as const)(
    "signs %s through the ordinary round trip",
    async (loginReturnTo) => {
      const rendered = await renderEventsHtml(
        { ...baseScheduleData({ loginReturnTo }) } as never,
        scheduleHeaders,
      );
      expect(rendered.body).toContain(`href="${ordinaryUrl(loginReturnTo)}" data-testid="signin"`);
    },
  );

  it("marks the schedule as the current page", async () => {
    const rendered = await renderEventsHtml({ ...baseScheduleData() } as never, scheduleHeaders);
    expect(primaryNavOf(rendered.body)).toContain(
      '<a href="/events" aria-current="page">Events</a>',
    );
  });

  it.each([[false], [true]] as const)("carries no board link (member=%s)", async (member) => {
    const rendered = await renderEventsHtml(
      { ...baseScheduleData({ member }) } as never,
      scheduleHeaders,
    );
    expect(primaryNavOf(rendered.body)).not.toContain('href="/leaderboards/members"');
  });

  it("keeps the guest join CTA on the join funnel and member chrome intact", async () => {
    const guest = await renderEventsHtml(
      { ...baseScheduleData({ member: false, loginReturnTo: UNICODE_NEXT }) } as never,
      scheduleHeaders,
    );
    expect(guest.body).toContain(
      `href="/join?next=${encodeURIComponent(UNICODE_NEXT)}">Join the Discord</a>`,
    );
    const member = await renderEventsHtml(
      { ...baseScheduleData({ member: true }) } as never,
      scheduleHeaders,
    );
    expect(headerOf(member.body)).toContain('<a class="btn" href="/discord">Open Discord</a>');
    expect(headerOf(member.body)).not.toContain('data-testid="signin"');
  });
});

describe("kit past archive: ordinary sign-in with schedule semantics", () => {
  it("signs through the ordinary round trip with the normalized destination", () => {
    const html = kit.renderPast(basePastData({ page: 3, q: "" }));
    expect(headerOf(html)).toContain(`href="${ordinaryUrl(PAST_NEXT)}" data-testid="signin"`);
    expect(headerOf(html)).not.toContain("/join/discord");
  });

  it("marks the schedule as the current page with no board link", () => {
    const nav = primaryNavOf(kit.renderPast(basePastData()));
    expect(nav).toContain('<a href="/events" aria-current="page">Events</a>');
    expect(nav).not.toContain('href="/leaderboards/members"');
  });
});

describe("kit static leaf: join chrome without session or board link", () => {
  it("renders join chrome for every visitor without a sign-in link", () => {
    const html = kit.renderAbout(aboutPageData(APP_URL));
    expect(headerOf(html)).toContain(
      '<div><span class="account-caption">Welcome, guest</span><a class="btn" href="/join">Join with Discord</a></div>',
    );
    expect(headerOf(html)).not.toContain('data-testid="signin"');
    expect(headerOf(html)).not.toContain("Sign out");
  });

  it("carries no board link and no current primary section", () => {
    const nav = primaryNavOf(kit.renderAbout(aboutPageData(APP_URL)));
    expect(nav).not.toContain('href="/leaderboards/members"');
    expect(nav).not.toContain("aria-current");
  });

  it("bundles no database or session modules", () => {
    const forbidden = kit.applicationModules.filter((module) =>
      /(?:^|[\\/])(?:db|database|session)(?:[\\/.]|$)/i.test(module),
    );
    expect(forbidden).toEqual([]);
  });

  it("preserves the skip target, landmarks and keyboard order", () => {
    const html = kit.renderAbout(aboutPageData(APP_URL));
    assertSkipAndLandmarks(html, { account: true });
    assertPrimaryOrder(html, { leaderboard: false });
  });
});
