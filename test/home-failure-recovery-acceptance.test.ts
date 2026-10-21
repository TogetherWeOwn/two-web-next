// Acceptance: homepage failure-notice retry and empty-schedule recovery.
//
// Failing-first contract for the sibling build: signin failure notices get a
// retry link, and the empty/unavailable schedule card gets an in-card recovery
// link, on both the Hono renderer and the Kit twin. Local renders only — no
// database, no network, no app.request.
//
// OWNERSHIP: this file is acceptance-owned. The builder builds on this branch
// and must never edit this file; implement in the renderers until it is green.
//
// Pinned testids (the builder implements exactly these):
// - `notice-retry`: the retry link under ?n=signin_failed / ?n=signin_unavailable,
//   href exactly `/auth/discord`.
// - `home-events-empty-link`: the recovery link INSIDE the schedule card,
//   href `/join` when data-state="empty", `/discord` when data-state="unavailable".
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "../src/env";
import { FALLBACK_RANKS, HOME_JOIN_RESULT_COPY, HOME_NOTICES } from "../src/home-copy";
import { Home, type Notice } from "../src/pages";

const INVITE_URL = "https://discord.gg/invite";
const APP_URL = "https://next.example.test";

const honoMember: Session = {
  id: "member-1",
  username: "Member",
  avatar: null,
  member: true,
  moderator: false,
};

const kitMember = {
  userId: "member-1",
  username: "Member",
  avatar: null,
  member: true,
  moderator: false,
};

async function renderHono(
  session: Session | null,
  notice: Notice,
  eventsUnavailable = false,
): Promise<string> {
  return await jsx(Home, {
    session,
    notice,
    inviteUrl: INVITE_URL,
    appUrl: APP_URL,
    counts: { memberCount: null, onlineCount: null, ranks: [] },
    upcomingEvents: [],
    eventsUnavailable,
    featured: [],
  }).toString();
}

// Hono escapes text nodes; the notice sentences only need the apostrophe.
const honoText = (sentence: string): string => sentence.replaceAll("'", "&#39;");

const NOTICE_RETRY_ANCHOR = /<a\b[^>]*data-testid="notice-retry"[^>]*>([\s\S]*?)<\/a>/g;
const EMPTY_LINK_ANCHOR = /<a\b[^>]*data-testid="home-events-empty-link"[^>]*>([\s\S]*?)<\/a>/g;
const GUEST_CTA_ANCHOR = /<a\b[^>]*data-testid="home-events-join"[^>]*>([\s\S]*?)<\/a>/g;

function anchorHref(anchor: string): string | null {
  return anchor.match(/href="([^"]*)"/)?.[1] ?? null;
}

function anchorText(anchor: string): string {
  let stripped = "";
  for (let i = 0; i < anchor.length; ) {
    if (anchor[i] === "<") {
      const close = anchor.indexOf(">", i + 1);
      if (close === -1) {
        stripped += anchor.slice(i);
        break;
      }
      i = close + 1;
    } else {
      stripped += anchor[i];
      i += 1;
    }
  }
  return stripped.replaceAll("&amp;", "&").trim();
}

// The card's own markup, depth-counted to its close so nested builder markup
// cannot cut the scope short (and a link below the card cannot pass).
function emptyCardScope(html: string, state: "empty" | "unavailable"): string {
  const marker = 'data-testid="home-events-empty"';
  const markerIndex = html.indexOf(marker);
  expect(markerIndex).toBeGreaterThan(-1);
  const openIndex = html.lastIndexOf("<div", markerIndex);
  expect(openIndex).toBeGreaterThan(-1);
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = openIndex;
  let depth = 0;
  let end = -1;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html)) !== null) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      end = match.index + match[0].length;
      break;
    }
  }
  expect(end).toBeGreaterThan(openIndex);
  const scope = html.slice(openIndex, end);
  expect(scope).toContain(`data-state="${state}"`);
  return scope;
}

// Kit twin: the real +page.svelte, compiled and SSR-rendered with fake load
// data (the same harness as the Kit home render suite).
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

type RenderPage = (data: Record<string, unknown>) => string;

let renderKit: RenderPage;
let scratch = "";

function baseData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: null,
    sessionUnavailable: false,
    notice: null,
    joinResult: null,
    inviteUrl: INVITE_URL,
    appUrl: APP_URL,
    counts: { memberCount: null, onlineCount: null, ranks: [] },
    upcomingEvents: [],
    eventsUnavailable: false,
    featured: [],
    imageHosts: "",
    homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS },
    ...overrides,
  };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kit-home-recovery-acceptance-"));
  const entry = join(scratch, "kit-home-recovery-entry.mjs");
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
  const outfile = join(scratch, "kit-home-recovery-bundle.mjs");
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
        name: "kit-home-recovery-svelte-ssr",
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
  renderKit = mod.renderPage;
}, 60000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const RETRY_NOTICES = ["signin_failed", "signin_unavailable"] as const;

describe("acceptance: signin failure notices offer a retry (Hono)", () => {
  it.each([
    { notice: "signin_failed" as const, viewer: "guest", session: null },
    { notice: "signin_failed" as const, viewer: "member", session: honoMember },
    { notice: "signin_unavailable" as const, viewer: "guest", session: null },
    { notice: "signin_unavailable" as const, viewer: "member", session: honoMember },
  ])(
    "?n=$notice shows one /auth/discord retry under the notice ($viewer)",
    async ({ notice, session }) => {
      const html = await renderHono(session, notice);
      expect(html).toContain('data-testid="notice"');
      expect(html).toContain(honoText(HOME_NOTICES[notice]));
      const retries = [...html.matchAll(NOTICE_RETRY_ANCHOR)].map((m) => m[0]);
      expect(retries).toHaveLength(1);
      expect(anchorHref(retries[0]!)).toBe("/auth/discord");
      expect(html.indexOf('data-testid="notice"')).toBeLessThan(
        html.indexOf('data-testid="notice-retry"'),
      );
      expect(anchorText(retries[0]!).length).toBeGreaterThan(0);
    },
  );
});

describe("acceptance: signin failure notices offer a retry (Kit)", () => {
  it.each([
    { notice: "signin_failed" as const, viewer: "guest", session: null },
    { notice: "signin_failed" as const, viewer: "member", session: kitMember },
    { notice: "signin_unavailable" as const, viewer: "guest", session: null },
    { notice: "signin_unavailable" as const, viewer: "member", session: kitMember },
  ])(
    "?n=$notice shows one /auth/discord retry under the notice ($viewer)",
    ({ notice, session }) => {
      const html = renderKit(baseData({ notice, session }));
      expect(html).toContain('data-testid="notice"');
      expect(html).toContain(HOME_NOTICES[notice]);
      const retries = [...html.matchAll(NOTICE_RETRY_ANCHOR)].map((m) => m[0]);
      expect(retries).toHaveLength(1);
      expect(anchorHref(retries[0]!)).toBe("/auth/discord");
      expect(html.indexOf('data-testid="notice"')).toBeLessThan(
        html.indexOf('data-testid="notice-retry"'),
      );
      expect(anchorText(retries[0]!).length).toBeGreaterThan(0);
    },
  );
});

describe("acceptance: empty schedule card links recovery (Hono)", () => {
  it.each([
    { state: "empty" as const, href: "/join", viewer: "guest", session: null },
    { state: "empty" as const, href: "/join", viewer: "member", session: honoMember },
    { state: "unavailable" as const, href: "/discord", viewer: "guest", session: null },
    { state: "unavailable" as const, href: "/discord", viewer: "member", session: honoMember },
  ])(
    'data-state="$state" links $href inside the card ($viewer)',
    async ({ state, href, session, viewer }) => {
      const html = await renderHono(session, null, state === "unavailable");
      const scope = emptyCardScope(html, state);
      const links = [...scope.matchAll(EMPTY_LINK_ANCHOR)].map((m) => m[0]);
      expect(links).toHaveLength(1);
      expect(anchorHref(links[0]!)).toBe(href);
      expect(anchorText(links[0]!).length).toBeGreaterThan(0);
      if (viewer === "guest") {
        const ctas = [...html.matchAll(GUEST_CTA_ANCHOR)].map((m) => m[0]);
        expect(ctas).toHaveLength(1);
        expect(anchorHref(ctas[0]!)).toBe("/join");
      } else {
        expect(html).not.toContain('data-testid="home-events-join"');
      }
    },
  );
});

describe("acceptance: empty schedule card links recovery (Kit)", () => {
  it.each([
    { state: "empty" as const, href: "/join", viewer: "guest", session: null },
    { state: "empty" as const, href: "/join", viewer: "member", session: kitMember },
    { state: "unavailable" as const, href: "/discord", viewer: "guest", session: null },
    { state: "unavailable" as const, href: "/discord", viewer: "member", session: kitMember },
  ])(
    'data-state="$state" links $href inside the card ($viewer)',
    ({ state, href, session, viewer }) => {
      const html = renderKit(baseData({ session, eventsUnavailable: state === "unavailable" }));
      const scope = emptyCardScope(html, state);
      const links = [...scope.matchAll(EMPTY_LINK_ANCHOR)].map((m) => m[0]);
      expect(links).toHaveLength(1);
      expect(anchorHref(links[0]!)).toBe(href);
      expect(anchorText(links[0]!).length).toBeGreaterThan(0);
      if (viewer === "guest") {
        const ctas = [...html.matchAll(GUEST_CTA_ANCHOR)].map((m) => m[0]);
        expect(ctas).toHaveLength(1);
        expect(anchorHref(ctas[0]!)).toBe("/join");
      } else {
        expect(html).not.toContain('data-testid="home-events-join"');
      }
    },
  );
});

describe("acceptance: other notices gain no retry link", () => {
  it.each(["signin_denied", "joined", "already_member"] as const)(
    "Hono ?n=%s renders its sentence with no retry",
    async (notice) => {
      const html = await renderHono(null, notice);
      expect(html).toContain('data-testid="notice"');
      expect(html).toContain(honoText(HOME_NOTICES[notice]));
      expect(html).not.toContain('data-testid="notice-retry"');
    },
  );

  it.each(["signin_denied", "joined", "already_member"] as const)(
    "Kit ?n=%s renders its sentence with no retry",
    (notice) => {
      const html = renderKit(baseData({ notice }));
      expect(html).toContain('data-testid="notice"');
      expect(html).toContain(HOME_NOTICES[notice]);
      expect(html).not.toContain('data-testid="notice-retry"');
    },
  );

  it.each([
    { viewer: "guest", session: null },
    { viewer: "member", session: honoMember },
  ])(
    "Hono ?n=join_failed keeps its invite link and gains no retry ($viewer)",
    async ({ session }) => {
      const html = await renderHono(session, "join_failed");
      expect(html).toContain(honoText(HOME_NOTICES.join_failed));
      expect(html).toContain("Join with an invite link instead");
      expect(html).toContain(`href="${INVITE_URL}"`);
      expect(html).not.toContain('data-testid="notice-retry"');
    },
  );

  it.each([
    { viewer: "guest", session: null },
    { viewer: "member", session: kitMember },
  ])("Kit ?n=join_failed keeps its invite link and gains no retry ($viewer)", ({ session }) => {
    const html = renderKit(baseData({ notice: "join_failed", session }));
    expect(html).toContain(HOME_NOTICES.join_failed);
    expect(html).toContain("Join with an invite link instead");
    expect(html).toContain(`href="${INVITE_URL}"`);
    expect(html).not.toContain('data-testid="notice-retry"');
  });
});

describe("acceptance: notice copy is byte-identical", () => {
  it("pins all six sentences at the shared source", () => {
    expect({ ...HOME_NOTICES }).toEqual({
      joined: "You're in. Welcome to the TWO Discord.",
      already_member: "Signed in. You're already in the TWO Discord.",
      join_failed:
        "Signed in, but we couldn't add you to the Discord automatically. Use the invite link below.",
      signin_failed: "Discord sign-in didn't complete. Please try again.",
      signin_denied:
        "You cancelled the Discord sign-in, so we didn't sign you in. Nothing changed — try again whenever you like.",
      signin_unavailable:
        "Discord did not answer just now, so we could not sign you in. This is on Discord, not you — please try again in a minute.",
    });
    expect(RETRY_NOTICES).toEqual(["signin_failed", "signin_unavailable"]);
  });
});
