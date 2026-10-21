// Kit home port contract: GET / renders from the shared server models with
// independently degraded panels — session-aware header, join notices, flash,
// featured content, upcoming events and bot-owned count/rank views.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOTICES } from "../src/page-shell";
import {
  FALLBACK_RANKS,
  HOME_JOIN_RESULT_COPY,
  HOME_NOTICES,
  applyHomeFlashConsumption,
  applyHomeResponsePolicy,
  parseHomeNotice,
  resolveHomeFlash,
  resolveHomePageState,
} from "../src/home-copy";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "web/src/routes/+page.server.ts");
const pagePath = join(root, "web/src/routes/+page.svelte");
const manifestPath = join(root, "src/route-ownership.ts");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("Kit home port: shared server models, no duplicated content", () => {
  it("loads every panel from the shared Hono-side readers", () => {
    const server = read(serverPath);
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
  it("registers a public, Hono-owned manifest entry", () => {
    const manifest = read(manifestPath);
    expect(manifest).toMatch(/path:\s*"\/"/);
    expect(manifest).toMatch(/path:\s*"\/[^}]*reads:\s*"public"/);
    // Stays on Hono until the enablement review: flipping enabled flips
    // ownership, and the parity ledger fails any enabled route with no run.
    expect(manifest).toMatch(/method:\s*"GET",\s*path:\s*"\/",\s*enabled:\s*false/);
  });
});

describe("Kit home port: header, hero and metadata chrome", () => {
  it("renders the session-aware header states", () => {
    const page = read(pagePath);
    // Guest chrome mirrors the Hono SiteHeader default: caption plus the
    // ordinary-login round trip, never the join journey link.
    expect(page).toContain("Welcome, guest");
    expect(page).toContain('href="/auth/discord"');
    expect(page).toContain('data-testid="signin"');
    // Member chrome mirrors the Hono logout form with the viewer name.
    expect(page).toContain('action="/logout"');
    expect(page).toContain("Signed in");
    expect(page).toContain('class="who"');
    // Session outage keeps the guest header while the hero offers the invite.
    expect(page).toContain("sessionUnavailable");
    expect(page).toContain("Join with an invite link");
    // The hero gates Open Discord on membership: a bare `{:else if session}`
    // would hand non-members the member button (the SSR render test pins the
    // rendered output for both states).
    expect(page).toMatch(/\{\:else if session\?\.member\}/);
  });

  it("renders the hero, notice slot and exact page metadata", () => {
    const page = read(pagePath);
    expect(page).toContain('id="home-heading"');
    expect(page).toContain("The lobby is open.");
    expect(page).toContain("A close-knit gaming clan / mostly evenings / 18+");
    expect(page).toContain("We spent most of our life private. Now you can just turn up.");
    expect(page).toContain('data-testid="notice"');
    expect(page).toContain('data-testid="join-result"');
    expect(page).toContain('data-testid="reinvite-link"');
    expect(page).toContain('data-testid="join"');
    expect(page).toContain('data-testid="discord-join"');
    expect(page).toContain('theme="home"');
    expect(page).toContain('activeNav="home"');
    expect(page).toContain("Together We Own — the lobby is open");
    expect(page).toContain('testid="site-jsonld"');
  });

  it("renders counts, ranks, featured, events and community panels", () => {
    const page = read(pagePath);
    expect(page).toContain('data-testid="member-count"');
    expect(page).toContain('data-testid="rank-stack"');
    expect(page).toContain('data-testid="featured-content"');
    expect(page).toContain('data-testid="featured-item"');
    expect(page).toContain('data-testid="home-events-list"');
    expect(page).toContain('data-testid="home-events-empty"');
    expect(page).toContain('data-testid="home-events-join"');
    expect(page).toContain('data-testid="home-widget-link"');
    expect(page).toContain('data-testid="home-discord-invite"');
    expect(page).toContain('id="featured-heading"');
    expect(page).toContain('id="community-heading"');
    expect(page).toContain('id="discord-heading"');
    expect(page).toContain('id="home-events-heading"');
    expect(page).toContain("Community ladder");
    expect(page).toContain('href="/join#join-heading"');
    expect(page).toContain('href="/events"');
  });

  it("keeps each panel independently degraded", () => {
    const page = read(pagePath);
    // Stale or missing counts hide the numeral instead of inventing one.
    expect(page).toContain("counts.memberCount !=");
    // An empty ladder still names the ranks; a zero rank reads unclaimed.
    expect(page).toContain("unclaimed");
    // Featured renders only for visible rows; an empty events read states why.
    expect(page).toContain("featured.length > 0");
    expect(page).toContain("upcomingEvents.length > 0");
    expect(page).toContain('"unavailable"');
    expect(page).toContain('"empty"');
    expect(page).toContain("Game nights are unavailable right now.");
    expect(page).toContain("Nothing scheduled yet.");
  });

  it("preserves the featured image host policy and event links", () => {
    const page = read(pagePath);
    expect(page).toContain('referrerpolicy="no-referrer"');
    expect(page).toContain('loading="lazy"');
    expect(page).toContain('decoding="async"');
    expect(page).toContain('href="/discord"');
    expect(page).toContain("/e/${encodeURIComponent(");
    expect(page).toContain("RSVP in Discord");
  });

  it("ships no JavaScript on the page", () => {
    const page = read(pagePath);
    expect(page).not.toContain("<script src");
    expect(page).not.toContain("unsafe-inline");
    expect(page).not.toContain('src="/islands/');
  });

  it("emits JSON-LD as markup, never as raw script content", () => {
    const page = read(pagePath);
    // Svelte parses <script> content as raw text: {@html} inside one renders
    // literally, so the shared payload travels in a markup string instead.
    expect(page).toContain('<JsonLd testid="site-jsonld" json={siteGraph} />');
    expect(page).not.toContain("{@html siteJsonLd(appUrl)}</script>");
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
