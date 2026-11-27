// Kit home port contract: GET / renders from the shared server models with
// independently degraded panels — session-aware header, join notices, flash,
// featured content, upcoming events and bot-owned count/rank views.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DefaultTreeAdapterMap, parse } from "parse5";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FALLBACK_RANKS,
  HOME_JOIN_RESULT_COPY,
  HOME_NOTICES,
  JOIN_INTRO,
  applyHomeFlashConsumption,
  applyHomeResponsePolicy,
  parseHomeNotice,
  resolveHomeFlash,
  resolveHomePageState,
} from "../src/home-copy";
import { NOTICES } from "../src/page-shell";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";
import { siteJsonLd } from "../src/seo-json-ld";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "web/src/routes/+page.server.ts");
const pagePath = join(root, "web/src/routes/+page.svelte");
const manifestPath = join(root, "src/route-ownership.ts");
const { parseRenderedPage } = createRequire(import.meta.url)("../ci/rendered-page.mjs") as {
  parseRenderedPage: typeof parse;
};

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Kit home port: shared server models, no duplicated content", () => {
  it("loads every panel from the shared Hono-side readers", () => {
    const server = read(serverPath) + read(join(root, "src/kit-home-panels.ts"));
    expect(server).toContain("readCounts");
    expect(server).toContain("cachedHomeUpcoming");
    expect(server).toContain("discordEventsSource");
    expect(server).toContain("cachedFeatured");
    expect(server).toContain("dbFor");
    expect(server).toContain("inviteDestination");
    // Session, notice, flash and cache policy ride the framework-free
    // response helper (which itself calls resolveHomePageState and
    // applyHomeFlashConsumption, pinned behaviorally below).
    expect(server).toContain("applyHomeResponsePolicy");
  });

  it("renders every panel from shared copy and formatting helpers", () => {
    const page = read(pagePath);
    expect(page).toContain("HOME_NOTICES");
    expect(page).toContain("HOME_JOIN_RESULT_COPY");
    expect(page).toContain("FALLBACK_RANKS");
    expect(page).toContain("cardTimeLabel");
    expect(page).toContain("isValidZone");
    expect(page).toContain("featuredImageSrc");
    expect(page).toContain("canonicalUrl");
    expect(page).toContain("siteJsonLd");
  });

  it("copies no notice, banner or rank sentence into the Kit route", () => {
    const page = read(pagePath);
    const sentences = [...Object.values(HOME_NOTICES), ...Object.values(HOME_JOIN_RESULT_COPY)];
    for (const sentence of sentences) expect(page).not.toContain(sentence);
    for (const rank of FALLBACK_RANKS) expect(page).not.toContain(`<dt>${rank.label}</dt>`);
    // The svelte references the shared constant by name, never the literal:
    // no distinctive sentence may appear under the Kit route directory.
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(svelte|ts)$/.test(entry.name)) {
          if (read(path).includes(HOME_NOTICES.signin_denied)) hits.push(path);
        }
      }
    };
    walk(join(root, "web/src/routes"));
    expect(hits).toEqual([]);
  });

  it("keeps the Hono shell on the identical copy source", () => {
    expect(NOTICES).toEqual({ ...HOME_NOTICES });
  });
});

describe("Kit home port: request posture", () => {
  it("stays server-rendered with no client bundle", () => {
    const server = read(serverPath);
    expect(server).toContain("csr = false");
    // private, no-store is asserted behaviorally through
    // applyHomeResponsePolicy below, not via substring (the load comment also
    // contains the phrase, so a grep cannot pin the header).
  });

  it("delegates session, notice, flash and cache policy to the shared helper", () => {
    const server = read(serverPath);
    // Call-site pins (with the call paren/keys) so the import line alone
    // cannot satisfy them.
    expect(server).toContain("applyHomeResponsePolicy({");
    expect(server).toContain('noticeRaw: url.searchParams.get("n")');
    expect(server).toContain("method: request.method");
    expect(server).toContain("cookieName: JOIN_RESULT_COOKIE");
    // The load stays a thin binding: no inline session mapping, flash
    // resolution, consumption call or direct cache header that could drift
    // from the helper.
    expect(server).not.toContain("resolveHomePageState({");
    expect(server).not.toContain("applyHomeFlashConsumption({");
    expect(server).not.toContain('setHeaders({ "cache-control"');
    expect(server).not.toContain("locals.status ===");
    expect(server).not.toContain("locals.joinResult");
  });

  it("adds no live Discord call to rendering", () => {
    const server = read(serverPath);
    expect(server).not.toContain("fetch(");
    expect(server).not.toContain("discord.com/api");
  });
});

describe("Kit home port: manifest", () => {
  it("enables only the home GET entry with its member-read boundary", () => {
    const manifest = read(manifestPath);
    expect(manifest).toMatch(/path:\s*"\/"/);
    expect(manifest).toMatch(/method:\s*"GET",\s*path:\s*"\/",\s*enabled:\s*true/);
    expect(manifest).toMatch(
      /path:\s*"\/"[^}]*reads:\s*\{\s*resource:\s*"member",\s*action:\s*"list",\s*route:\s*"home"\s*\}/,
    );
  });
});

describe("Kit home port: script source wiring", () => {
  it("keeps the route's public voice script behind the load flag", () => {
    const page = read(pagePath);
    const island = 'src="/islands/kit-public-voice.js"';
    expect(page.match(/<script[^>]+\bsrc="[^"]+"/g)).toEqual([`<script ${island}`]);
    expect(page.match(/src="\/islands\/[^"]+"/g)).toEqual([island]);
    expect(page).toMatch(
      /\{#if data\.publicVoiceEnabled\}[^{}]+\{@html publicVoiceIsland\}\s*\{\/if\}/,
    );
    expect(page).not.toContain("unsafe-inline");
  });

  it("emits JSON-LD as markup, never as raw script content", () => {
    const page = read(pagePath);
    // Svelte parses <script> content as raw text: {@html} inside one renders
    // literally, so the shared payload travels in a markup string instead.
    expect(page).toContain('<JsonLd testid="site-jsonld" json={siteGraph} />');
    expect(page).not.toContain("{@html siteJsonLd(appUrl)}</script>");
  });
});

describe("Kit home port: rendered page structure", () => {
  const appUrl = "https://example.test";
  const inviteUrl = "https://discord.gg/invite";
  const nowMs = Date.UTC(2030, 6, 19, 12);
  const observedAt = "2030-07-19T11:00:00.000Z";
  const countsSnapshot = { memberCount: 42, onlineCount: 7, observedAt, stale: false };
  const session = { userId: "1", username: "Player", avatar: null, moderator: false };
  const event = { title: "Game night", startsAt: new Date(nowMs + 3600e3), timezone: "UTC" };
  let renderPage: RenderPage;
  let cleanup: (() => void) | undefined;

  beforeAll(async () => {
    ({ renderPage, cleanup } = await createKitSsrRenderer("web/src/routes/+page.svelte"));
  });
  afterAll(() => cleanup?.());

  function render(overrides: Record<string, unknown> = {}) {
    return parseRenderedPage(
      renderPage({
        appUrl,
        inviteUrl,
        nowMs,
        countsSnapshot,
        session: null,
        sessionUnavailable: false,
        notice: null,
        joinResult: null,
        counts: { memberCount: 42, onlineCount: 7, ranks: [] },
        featured: [],
        imageHosts: "",
        upcomingEvents: [],
        eventsUnavailable: false,
        homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS, JOIN_INTRO },
        ...overrides,
      }),
    );
  }

  function matching(
    root: DefaultTreeAdapterMap["node"],
    tag: string,
    attrs: Record<string, string> = {},
  ) {
    return elements(root).filter(
      (el) =>
        el.tagName === tag &&
        Object.entries(attrs).every(([key, value]) => attr(el, key) === value),
    );
  }

  function one(root: DefaultTreeAdapterMap["node"], tag: string, attrs?: Record<string, string>) {
    const [element, ...duplicates] = matching(root, tag, attrs);
    if (!element || duplicates.length) {
      throw new Error(
        `Expected one ${tag} with ${JSON.stringify(attrs ?? {})}, found ${element ? 1 + duplicates.length : 0}`,
      );
    }
    return element;
  }

  const testId = (id: string) => ({ "data-testid": id });
  const heroAttrs = { "aria-labelledby": "home-heading" };
  const eventsAttrs = { "aria-labelledby": "home-events-heading" };

  it("renders the guest, member, non-member and outage account and hero actions", () => {
    for (const sessionUnavailable of [false, true]) {
      const page = render({ sessionUnavailable });
      const account = one(one(page, "header"), "nav", { "aria-label": "Account" });
      expect(textOf(account)).toContain("Welcome, guest");
      expect(attr(one(account, "a", testId("signin")), "href")).toBe("/auth/discord");
      const hero = one(page, "section", heroAttrs);
      const link = one(hero, "a", testId(sessionUnavailable ? "discord-join" : "join"));
      expect(attr(link, "href")).toBe(sessionUnavailable ? "/discord" : "/auth/discord");
      expect(textOf(link)).toBe(
        sessionUnavailable ? "Join with an invite link" : "Join with Discord",
      );
    }
    for (const member of [true, false]) {
      const page = render({ session: { ...session, member } });
      const form = one(one(page, "header"), "form", { method: "post", action: "/logout" });
      expect(textOf(form)).toContain("Signed in");
      expect(textOf(one(form, "span", { class: "who" }))).toBe(session.username);
      const hero = one(page, "section", heroAttrs);
      const discord = matching(hero, "a", { href: inviteUrl });
      expect(discord.map(textOf)).toEqual(member ? ["Open Discord"] : []);
      expect(matching(hero, "a", testId("join")).map((link) => attr(link, "href"))).toEqual(
        member ? [] : ["/auth/discord"],
      );
    }
  });

  it("renders the hero, notice slot and exact page metadata", () => {
    const page = render({ notice: "joined" });
    const head = one(page, "head");
    expect(textOf(one(head, "title"))).toBe("Together We Own — the lobby is open");
    const stylesheets = matching(head, "link", { rel: "stylesheet" });
    expect(stylesheets.map((link) => attr(link, "href"))).toEqual(["/styles.css", "/theme.css"]);
    const intro = "We spent most of our life private. Now you can just turn up.";
    expect(attr(one(head, "meta", { name: "description" }), "content")).toBe(intro);
    const theme = one(page, "div", { "data-theme": "home" });
    one(one(theme, "header"), "a", { href: "/", "aria-current": "page" });
    const hero = one(theme, "section", heroAttrs);
    const heading = one(hero, "h1", { id: "home-heading" });
    expect(textOf(heading).trim()).toBe("The lobby is open.");
    expect(textOf(one(heading, "em"))).toBe("open");
    expect(textOf(hero)).toContain("A close-knit gaming clan / mostly evenings / 18+");
    expect(textOf(hero)).toContain(intro);
    const notice = one(theme, "p", testId("notice"));
    expect(textOf(notice)).toBe(HOME_NOTICES.joined);
    expect(elements(theme).indexOf(notice)).toBeLessThan(elements(theme).indexOf(hero));
    const flash = one(render({ joinResult: "already_member" }), "p", testId("join-result"));
    expect(textOf(one(flash, "a", testId("reinvite-link")))).toBe(HOME_JOIN_RESULT_COPY.reinvite);
  });

  it("renders grouped community, featured and upcoming event panels with their own links", () => {
    const page = render({
      featured: [{ id: "f1", title: "Night report", imageUrl: `${appUrl}/report.png` }],
      upcomingEvents: [
        { ...event, source: "canonical", eventKey: "night/one", goingCount: 1, capacity: null },
        { ...event, source: "discord", discordId: "123" },
      ],
    });
    const featured = one(page, "section", testId("featured-content"));
    one(featured, "h2", { id: "featured-heading" });
    one(one(featured, "article", testId("featured-item")), "img", {
      src: "/report.png",
      referrerpolicy: "no-referrer",
      loading: "lazy",
      decoding: "async",
    });
    const community = one(page, "section", testId("home-guest-intro"));
    one(community, "h2", { id: "community-heading" });
    const discord = one(community, "section", { "aria-labelledby": "discord-heading" });
    one(discord, "h3", { id: "discord-heading" });
    one(discord, "a", { ...testId("home-widget-link"), href: "/join#join-heading" });
    one(discord, "a", { ...testId("home-discord-invite"), href: "/discord" });
    const events = one(page, "section", eventsAttrs);
    one(events, "h2", { id: "home-events-heading" });
    const list = one(events, "ul", testId("home-events-list"));
    const group = one(list, "li", testId("home-events-group-tonight"));
    const rows = one(group, "ul");
    expect(
      rows.childNodes.filter((node) => "tagName" in node).map((row) => attr(row, "data-source")),
    ).toEqual(["canonical", "discord"]);
    one(one(rows, "li", { "data-source": "canonical" }), "a", { href: "/e/night%2Fone" });
    const discordRow = one(rows, "li", { "data-source": "discord" });
    one(discordRow, "a", { ...testId("home-event-discord"), href: inviteUrl });
    expect(textOf(discordRow)).toContain("RSVP in Discord");
    expect(textOf(one(events, "a", { href: "/events" }))).toContain("See all events");
  });

  it("keeps counts, ranks, featured content and the schedule independently degraded", () => {
    const page = render({ countsSnapshot: { ...countsSnapshot, stale: true } });
    const counts = one(one(page, "section", heroAttrs), "p", testId("member-count"));
    expect(attr(one(counts, "time"), "datetime")).toBe(observedAt);
    const ladder = one(page, "section", { "aria-label": "Community ladder" });
    expect(matching(one(ladder, "dl", testId("rank-stack")), "dt").map(textOf)).toEqual(
      FALLBACK_RANKS.map(({ label }) => label),
    );
    const events = one(page, "section", eventsAttrs);
    one(events, "a", { ...testId("home-events-join"), href: "/join" });
    const empty = one(events, "div", { ...testId("home-events-empty"), "data-state": "empty" });
    expect(textOf(one(empty, "h3")).trim()).toBe("Nothing scheduled yet.");
    expect(matching(page, "section", testId("featured-content"))).toEqual([]);
    const unavailable = render({
      countsSnapshot: null,
      eventsUnavailable: true,
      counts: { ranks: [{ key: "prospect", label: "Prospect", memberCount: 0 }] },
      upcomingEvents: [{ ...event, source: "discord", discordId: "123" }],
    });
    expect(matching(unavailable, "p", testId("member-count"))).toEqual([]);
    expect(matching(unavailable, "ul", testId("home-events-list"))).toEqual([]);
    const status = one(one(unavailable, "section", eventsAttrs), "div", {
      ...testId("home-events-empty"),
      "data-state": "unavailable",
    });
    expect(textOf(one(status, "h3")).trim()).toBe("Game nights are unavailable right now.");
    const ranks = one(unavailable, "dl", testId("rank-stack"));
    expect(textOf(one(one(ranks, "div", { "data-rank": "prospect" }), "dd"))).toBe("unclaimed");
  });

  it("renders inert site JSON-LD and only the flag-gated public voice script", () => {
    for (const publicVoiceEnabled of [false, true]) {
      const page = render({ publicVoiceEnabled });
      const jsonLd = one(page, "script", testId("site-jsonld"));
      expect(attr(jsonLd, "type")).toBe("application/ld+json");
      expect(attr(jsonLd, "src")).toBeUndefined();
      expect(textOf(jsonLd)).toBe(siteJsonLd(appUrl));
      const scripts = matching(page, "script").filter((script) => script !== jsonLd);
      expect(scripts.map((script) => [attr(script, "src"), attr(script, "defer")])).toEqual(
        publicVoiceEnabled ? [["/islands/kit-public-voice.js", ""]] : [],
      );
    }
  });
});

describe("home-copy: notice validation and flash precedence", () => {
  it("accepts exactly the six Hono notice keys", () => {
    for (const key of Object.keys(HOME_NOTICES)) {
      expect(parseHomeNotice(key)).toBe(key);
    }
    expect(parseHomeNotice(null)).toBeNull();
    expect(parseHomeNotice("joined ")).toBeNull();
    expect(parseHomeNotice("constructor")).toBeNull();
    expect(parseHomeNotice("__proto__")).toBeNull();
    expect(parseHomeNotice("join_failed;drop")).toBeNull();
  });

  it("lets a failure explanation win over a stale success flash", () => {
    expect(resolveHomeFlash("join_failed", "added")).toBeNull();
    expect(resolveHomeFlash("signin_failed", "already_member")).toBeNull();
    expect(resolveHomeFlash("signin_denied", "added")).toBeNull();
    expect(resolveHomeFlash("signin_unavailable", "added")).toBeNull();
    expect(resolveHomeFlash("joined", "added")).toBe("added");
    expect(resolveHomeFlash("already_member", "already_member")).toBe("already_member");
    expect(resolveHomeFlash(null, "added")).toBe("added");
    expect(resolveHomeFlash(null, null)).toBeNull();
  });

  it("keeps the ladder fallback and banner copy byte-identical to Hono", () => {
    expect(FALLBACK_RANKS.map((r) => r.label)).toEqual([
      "Prospect",
      "Member",
      "Soldier",
      "Veteran",
      "Legend",
    ]);
    for (const rank of FALLBACK_RANKS) {
      expect(rank.key).toBe(rank.label.toLowerCase());
      expect(rank.memberCount).toBeNull();
    }
    expect(HOME_JOIN_RESULT_COPY.added).toBe(
      "You are in. Finish Discord's rules screening before you can post.",
    );
    expect(HOME_JOIN_RESULT_COPY.reinvite).toBe("Rejoin with the Discord invite");
  });
});

describe("home page state: the load's session, notice and flash decisions", () => {
  it("reports an outage as indeterminate, never as a logout", () => {
    expect(resolveHomePageState({ status: "unknown", noticeRaw: null, flash: null })).toEqual({
      sessionUnavailable: true,
      notice: null,
      joinResult: null,
    });
    expect(
      resolveHomePageState({ status: "guest", noticeRaw: null, flash: null }).sessionUnavailable,
    ).toBe(false);
    expect(
      resolveHomePageState({ status: "authenticated", noticeRaw: null, flash: null })
        .sessionUnavailable,
    ).toBe(false);
    expect(
      resolveHomePageState({ status: undefined, noticeRaw: null, flash: null }).sessionUnavailable,
    ).toBe(false);
  });

  it("validates ?n= to exactly the six Hono keys", () => {
    expect(resolveHomePageState({ status: "guest", noticeRaw: "joined", flash: null }).notice).toBe(
      "joined",
    );
    expect(
      resolveHomePageState({ status: "guest", noticeRaw: "join_failed;drop", flash: null }).notice,
    ).toBeNull();
    expect(
      resolveHomePageState({ status: "guest", noticeRaw: "__proto__", flash: null }).notice,
    ).toBeNull();
  });

  it("lets a failure notice win over a stale success flash", () => {
    expect(
      resolveHomePageState({ status: "guest", noticeRaw: "join_failed", flash: "added" })
        .joinResult,
    ).toBeNull();
    expect(
      resolveHomePageState({ status: "guest", noticeRaw: "joined", flash: "added" }).joinResult,
    ).toBe("added");
    expect(
      resolveHomePageState({ status: "guest", noticeRaw: null, flash: "already_member" })
        .joinResult,
    ).toBe("already_member");
  });

  it("still resolves the flash during a session outage", () => {
    // Hono's sessionUnavailable and flash reads are independent: an outage
    // keeps the guest header while the banner still renders.
    expect(
      resolveHomePageState({ status: "unknown", noticeRaw: "joined", flash: "added" }),
    ).toEqual({ sessionUnavailable: true, notice: "joined", joinResult: "added" });
  });
});

describe("home flash consumption: Hono takeJoinResult parity", () => {
  function harness() {
    const deleted: Array<{ name: string; options: Record<string, unknown> }> = [];
    const cookies = {
      delete: (name: string, options: Record<string, unknown>) => deleted.push({ name, options }),
    };
    return { deleted, cookies };
  }

  it("deletes the flash on the first GET with Hono's cookie attributes", async () => {
    for (const flash of ["added", "already_member"] as const) {
      const { deleted, cookies } = harness();
      applyHomeFlashConsumption({
        method: "GET",
        flash,
        cookieName: JOIN_RESULT_COOKIE,
        cookies,
      });
      expect(deleted).toEqual([
        {
          name: "__Host-two_join_result",
          options: { path: "/", secure: true, httpOnly: true, sameSite: "lax" },
        },
      ]);
    }
  });

  it("deletes even when a failure notice suppresses the banner", () => {
    // Hono consumes before the precedence check, so a suppressed flash never
    // repeats: consumption takes the raw flash, not the resolved banner.
    const { deleted, cookies } = harness();
    const state = resolveHomePageState({
      status: "guest",
      noticeRaw: "join_failed",
      flash: "added",
    });
    expect(state.joinResult).toBeNull();
    applyHomeFlashConsumption({
      method: "GET",
      flash: "added",
      cookieName: JOIN_RESULT_COOKIE,
      cookies,
    });
    expect(deleted).toHaveLength(1);
  });

  it("leaves HEAD and POST flashes pending and emits no delete without a flash", () => {
    for (const method of ["HEAD", "POST"]) {
      const { deleted, cookies } = harness();
      applyHomeFlashConsumption({
        method,
        flash: "added",
        cookieName: JOIN_RESULT_COOKIE,
        cookies,
      });
      expect(deleted).toEqual([]);
    }
    const { deleted, cookies } = harness();
    applyHomeFlashConsumption({
      method: "GET",
      flash: null,
      cookieName: JOIN_RESULT_COOKIE,
      cookies,
    });
    expect(deleted).toEqual([]);
  });
});

describe("home response policy: the load's session, flash and cache wiring", () => {
  const memberSession = {
    userId: "member-1",
    username: "Member",
    avatar: null,
    member: true,
    moderator: false,
  };

  function harness() {
    const deleted: Array<{ name: string; options: Record<string, unknown> }> = [];
    const headers: Record<string, string> = {};
    const cookies = {
      delete: (name: string, options: Record<string, unknown>) => deleted.push({ name, options }),
    };
    const setHeaders = (values: Record<string, string>) => Object.assign(headers, values);
    return { deleted, headers, cookies, setHeaders };
  }

  it("maps an authenticated session through with a private header and a delete", () => {
    const { deleted, headers, cookies, setHeaders } = harness();
    const out = applyHomeResponsePolicy({
      locals: { status: "authenticated", session: memberSession, joinResult: "added" },
      noticeRaw: "joined",
      method: "GET",
      cookieName: JOIN_RESULT_COOKIE,
      cookies,
      setHeaders,
    });
    expect(out).toEqual({
      session: memberSession,
      sessionUnavailable: false,
      notice: "joined",
      joinResult: "added",
    });
    expect(headers).toEqual({ "cache-control": "private, no-store" });
    expect(deleted).toEqual([
      {
        name: "__Host-two_join_result",
        options: { path: "/", secure: true, httpOnly: true, sameSite: "lax" },
      },
    ]);
  });

  it("renders guests and absent bridges without a session but still private", () => {
    for (const locals of [
      { status: "guest" as const, session: memberSession, joinResult: null },
      { status: undefined, session: memberSession, joinResult: null },
    ]) {
      const { deleted, headers, cookies, setHeaders } = harness();
      const out = applyHomeResponsePolicy({
        locals,
        noticeRaw: null,
        method: "GET",
        cookieName: JOIN_RESULT_COOKIE,
        cookies,
        setHeaders,
      });
      expect(out.session).toBeNull();
      expect(out.sessionUnavailable).toBe(false);
      expect(out.joinResult).toBeNull();
      expect(headers).toEqual({ "cache-control": "private, no-store" });
      expect(deleted).toEqual([]);
    }
  });

  it("keeps the guest header during an outage while the flash still renders", () => {
    const { deleted, headers, cookies, setHeaders } = harness();
    const out = applyHomeResponsePolicy({
      locals: { status: "unknown", session: memberSession, joinResult: "added" },
      noticeRaw: "joined",
      method: "GET",
      cookieName: JOIN_RESULT_COOKIE,
      cookies,
      setHeaders,
    });
    expect(out.session).toBeNull();
    expect(out.sessionUnavailable).toBe(true);
    expect(out.joinResult).toBe("added");
    expect(headers).toEqual({ "cache-control": "private, no-store" });
    expect(deleted).toHaveLength(1);
  });

  it("consumes the raw flash even when a failure notice suppresses the banner", () => {
    const { deleted, headers, cookies, setHeaders } = harness();
    const out = applyHomeResponsePolicy({
      locals: { status: "guest", session: null, joinResult: "added" },
      noticeRaw: "join_failed",
      method: "GET",
      cookieName: JOIN_RESULT_COOKIE,
      cookies,
      setHeaders,
    });
    expect(out.notice).toBe("join_failed");
    expect(out.joinResult).toBeNull();
    expect(headers).toEqual({ "cache-control": "private, no-store" });
    expect(deleted).toHaveLength(1);
  });

  it("rejects a hostile ?n= without dropping the flash or the header", () => {
    const { deleted, headers, cookies, setHeaders } = harness();
    const out = applyHomeResponsePolicy({
      locals: { status: "guest", session: null, joinResult: "added" },
      noticeRaw: "join_failed;drop",
      method: "GET",
      cookieName: JOIN_RESULT_COOKIE,
      cookies,
      setHeaders,
    });
    expect(out.notice).toBeNull();
    expect(out.joinResult).toBe("added");
    expect(headers).toEqual({ "cache-control": "private, no-store" });
    expect(deleted).toHaveLength(1);
  });

  it("leaves HEAD and POST flashes pending but keeps every response private", () => {
    for (const method of ["HEAD", "POST"]) {
      const { deleted, headers, cookies, setHeaders } = harness();
      const out = applyHomeResponsePolicy({
        locals: { status: "guest", session: null, joinResult: "added" },
        noticeRaw: null,
        method,
        cookieName: JOIN_RESULT_COOKIE,
        cookies,
        setHeaders,
      });
      expect(out.joinResult).toBe("added");
      expect(headers).toEqual({ "cache-control": "private, no-store" });
      expect(deleted).toEqual([]);
    }
  });

  it("emits no delete without a flash but still stays private", () => {
    const { deleted, headers, cookies, setHeaders } = harness();
    const out = applyHomeResponsePolicy({
      locals: { status: "guest", session: null, joinResult: null },
      noticeRaw: null,
      method: "GET",
      cookieName: JOIN_RESULT_COOKIE,
      cookies,
      setHeaders,
    });
    expect(out.joinResult).toBeNull();
    expect(headers).toEqual({ "cache-control": "private, no-store" });
    expect(deleted).toEqual([]);
  });
});
