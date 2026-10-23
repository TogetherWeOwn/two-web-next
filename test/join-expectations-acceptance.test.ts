// route-inventory: GET /join
// Newcomer expectations acceptance: the join page tells first-time visitors
// what happens after they connect, on both render twins.
//
// Current gap (RED): the page moves from the heading to the connect
// actions and the presence block with no expectations content. The fixed
// rendering pins a static strip with three truthful steps (connect with
// Discord, come back recognized, pick a game night) linking to existing
// routes only. The strip is server-rendered HTML on both twins, so it works
// with no JavaScript and tabs in DOM order.
//
// Truth source for step two: the callback records the one-shot join-result
// flash and redirects to the synchronous tail's destination
// (src/join/route-callback.ts records then redirects; src/join/service.ts
// finishJoin returns next ?? /?n=joined|already_member). A default newcomer
// with no ?next= lands on home with a notice plus the flash banner, and the
// first of /, /join or /profile consumes the banner. The strip must never
// promise a profile redirect as the default landing.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { discordWidgetHealth, type DiscordWidgetSnapshot } from "../src/discord-widget";
import type { Env } from "../src/env";
import { joinPageCacheControl } from "../src/join/kit-page";
import { finishJoin } from "../src/join/service";
import { JOIN_RESULT_COOKIE } from "../src/return-journey";

const GUILD = "326474832151838730";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: GUILD,
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const snapshot = {
  guildId: GUILD,
  name: "Together We Own",
  inviteUrl: null,
  presenceCount: 42,
  channels: [],
  members: [],
  fetchedAt: 0,
} satisfies DiscordWidgetSnapshot;

const SECRET = env.SESSION_SECRET;

async function signedFlash(result: "added" | "already_member"): Promise<string> {
  return (
    await serializeSigned(JOIN_RESULT_COOKIE, result, SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

async function getJoin(
  cookie?: string,
): Promise<{ status: number; html: string; cache: string | null }> {
  const res = await app.request("/join", cookie ? { headers: { cookie } } : {}, env);
  return { status: res.status, html: await res.text(), cache: res.headers.get("cache-control") };
}

// The strip section this contract pins. Empty string when the page has no
// strip (the current gap), so every RED assertion fails on the missing
// section rather than throwing.
function stripOf(html: string): string {
  const match = html.match(/<section[^>]*data-testid="join-expectations"[^>]*>[\s\S]*?<\/section>/);
  return match?.[0] ?? "";
}

function hrefsOf(strip: string): string[] {
  return [...strip.matchAll(/<a[^>]*href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

// Existing web routes the strip may link to. Internal paths only: the strip
// never links off-site (no invite URLs, no Discord hosts) and never invents
// a route. /events is the game-night list; /e/* detail paths stay allowed so
// a future curated pick keeps passing without a test edit.
const EXISTING_PATHS = new Set([
  "/",
  "/join",
  "/join/discord",
  "/auth/discord",
  "/auth/discord/redirect",
  "/discord",
  "/login",
  "/community",
  "/events",
  "/profile",
  "/members",
  "/leaderboards",
  "/hotzones",
  "/about",
  "/faq",
  "/rules",
  "/privacy",
]);

function isExistingRoute(href: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return false;
  const path = href.split(/[?#]/)[0]!;
  if (EXISTING_PATHS.has(path)) return true;
  if (path.startsWith("/events/") || path.startsWith("/e/")) return true;
  return false;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("join expectations RED: Hono twin renders the static strip", () => {
  it("guest: the page carries the expectations strip with three steps", async () => {
    const { status, html } = await getJoin();
    expect(status).toBe(200);
    const strip = stripOf(html);
    expect(strip, "missing data-testid=join-expectations section").toContain(
      'data-testid="join-expectations"',
    );
    expect(strip).toContain('data-testid="join-expectation-connect"');
    expect(strip).toContain('data-testid="join-expectation-recognized"');
    expect(strip).toContain('data-testid="join-expectation-gamenight"');
  });

  it("guest: the strip heading names what happens after connecting", async () => {
    const { html } = await getJoin();
    const strip = stripOf(html);
    expect(strip, "missing strip").toContain("join-expectations");
    expect(strip).toMatch(/what happens/i);
    expect(strip).toMatch(/after[^<]*connect/i);
  });

  it("member: a signed-in visit renders the same strip", async () => {
    const { status, html } = await getJoin("__Host-two_session=member-cookie");
    expect(status).toBe(200);
    const strip = stripOf(html);
    expect(strip, "member visit lost the expectations strip").toContain(
      'data-testid="join-expectations"',
    );
    expect(strip).toContain("game night");
  });

  it("flash: the one-shot banner and the strip render together, privately cached", async () => {
    const cookie = await signedFlash("added");
    const res = await app.request("/join", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="join-result"');
    const strip = stripOf(html);
    expect(strip, "flash visit lost the expectations strip").toContain(
      'data-testid="join-expectations"',
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("already-member flash: the reinvite banner and the strip render together", async () => {
    const cookie = await signedFlash("already_member");
    const res = await app.request("/join", { headers: { cookie } }, env);
    const html = await res.text();
    expect(html).toContain('data-testid="join-result"');
    expect(html).toContain('data-testid="reinvite-link"');
    expect(stripOf(html), "already-member flash lost the strip").toContain(
      'data-testid="join-expectations"',
    );
  });
});

describe("join expectations RED: step copy and links", () => {
  it("step one connects with Discord through the existing one-click route", async () => {
    const { html } = await getJoin();
    const strip = stripOf(html);
    expect(strip, "missing strip").toContain("join-expectation-connect");
    expect(strip).toMatch(/connect[^<]*discord/i);
    const hrefs = hrefsOf(strip);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.some((h) => h === "/join/discord" || h.startsWith("/join/discord?"))).toBe(true);
  });

  it("step two promises coming back recognized, never a profile redirect", async () => {
    const { html } = await getJoin();
    const strip = stripOf(html);
    expect(strip, "missing strip").toContain("join-expectation-recognized");
    expect(strip).toMatch(/recogniz|signed in/i);
    // The default landing is home with a notice plus the flash banner, not a
    // profile redirect (see the finishJoin truth pins below). A strip that
    // names the profile as the landing page fails here.
    expect(strip).not.toMatch(/land[^<]*profile/i);
    expect(strip).not.toMatch(/redirect[^<]*profile/i);
    expect(strip).not.toMatch(/taken[^<]*profile/i);
    expect(strip).not.toMatch(/profile[^<]*banner/i);
  });

  it("step three picks a game night on the existing events list", async () => {
    const { html } = await getJoin();
    const strip = stripOf(html);
    expect(strip, "missing strip").toContain("join-expectation-gamenight");
    expect(strip).toMatch(/game night/i);
    const hrefs = hrefsOf(strip);
    expect(hrefs.some((h) => h === "/events" || h.startsWith("/events?"))).toBe(true);
  });

  it("every strip link targets an existing route, never off-site or invented", async () => {
    const { html } = await getJoin();
    const strip = stripOf(html);
    const hrefs = hrefsOf(strip);
    expect(hrefs.length, "the strip links nowhere").toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).not.toMatch(/^https?:\/\//);
      expect(href).not.toContain("discord.gg");
      expect(href).not.toContain("discord.com");
      expect(isExistingRoute(href), `strip links to unknown route ${href}`).toBe(true);
    }
  });
});

describe("join expectations RED: no-JS static render and keyboard journey", () => {
  it("the strip is in the raw fetch body with no script dependency", async () => {
    const { html } = await getJoin();
    const strip = stripOf(html);
    expect(strip, "no strip in the server-rendered body").toContain("join-expectations");
    expect(strip).not.toContain("<script");
    expect(strip).not.toContain("data-join-widget");
  });

  it("keyboard: heading, one-click action, then the strip links in DOM order", async () => {
    const { html } = await getJoin();
    const heading = html.indexOf('id="join-heading"');
    const oneClick = html.indexOf('data-testid="join-oneclick"');
    const stripAt = html.indexOf('data-testid="join-expectations"');
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(oneClick).toBeGreaterThan(heading);
    expect(stripAt, "strip missing, so tab order cannot reach it").toBeGreaterThan(oneClick);
    const strip = stripOf(html);
    const hrefs = hrefsOf(strip);
    expect(hrefs.length).toBeGreaterThan(0);
    // Plain anchors with no focus removal: Tab reaches every strip link.
    expect(strip).not.toContain('tabindex="-1"');
    expect(strip).not.toContain("aria-hidden");
    let last = -1;
    for (const href of hrefs) {
      const at = strip.indexOf(`href="${href.replace(/&/g, "&amp;")}"`, last + 1);
      expect(at, `link ${href} out of DOM order`).toBeGreaterThan(last);
      last = at;
    }
  });
});

describe("join expectations RED: Kit twin parity (Svelte source contract)", () => {
  const page = readFileSync(
    new NodeURL("../web/src/routes/join/+page.svelte", import.meta.url),
    "utf8",
  );

  it("the Kit page carries the same expectations strip and step testids", () => {
    for (const needle of [
      'data-testid="join-expectations"',
      'data-testid="join-expectation-connect"',
      'data-testid="join-expectation-recognized"',
      'data-testid="join-expectation-gamenight"',
    ]) {
      expect(page, `Kit page missing ${needle}`).toContain(needle);
    }
  });

  it("the Kit strip keeps the same three step meanings", () => {
    expect(page).toMatch(/connect[^<]*discord/i);
    expect(page).toMatch(/recogniz|signed in/i);
    expect(page).toMatch(/game night/i);
    expect(page).toMatch(/what happens/i);
  });

  it("the Kit strip links to existing routes only and never promises a profile landing", () => {
    const strip = stripOf(page);
    expect(strip, "Kit strip missing").toContain("join-expectations");
    const hrefs = hrefsOf(strip);
    expect(hrefs.length, "Kit strip links nowhere").toBeGreaterThan(0);
    for (const href of hrefs) {
      // Svelte interpolations render the same one-click href the load builds;
      // the static strip links stay literal paths.
      if (href.includes("{")) continue;
      expect(isExistingRoute(href), `Kit strip links to unknown route ${href}`).toBe(true);
    }
    expect(strip).not.toMatch(/land[^<]*profile/i);
    expect(strip).not.toMatch(/redirect[^<]*profile/i);
  });
});

describe("join expectations truth: the real callback landing", () => {
  const bot = (result: "joined" | "already_member") => async () => ({ result, requestId: null });

  it("a default newcomer lands on home with a notice, not on a profile page", async () => {
    expect(await finishJoin(bot("joined"), "g", "u", "tok", null)).toMatchObject({
      kind: "signed_in",
      outcome: "added",
      redirect: "/?n=joined",
    });
    expect(await finishJoin(bot("already_member"), "g", "u", "tok", null)).toMatchObject({
      kind: "signed_in",
      outcome: "already_member",
      redirect: "/?n=already_member",
    });
  });

  it("an explicit safe next still wins over the default home landing", async () => {
    expect(await finishJoin(bot("joined"), "g", "u", "tok", "/events")).toMatchObject({
      redirect: "/events",
    });
  });
});

describe("join expectations controls: cache contract survives the strip", () => {
  it("join-result flash stays private, presence stays 60s, static stays 3600s", () => {
    expect(joinPageCacheControl("added", snapshot)).toBe("private, no-store");
    expect(joinPageCacheControl("already_member", snapshot)).toBe("private, no-store");
    expect(joinPageCacheControl("added", null)).toBe("private, no-store");
    expect(joinPageCacheControl(null, snapshot)).toBe("public, max-age=60");
    expect(joinPageCacheControl(null, null)).toBe("public, max-age=3600");
    expect(joinPageCacheControl(null, undefined)).toBe("public, max-age=3600");
  });

  it("the static page without flash or presence keeps 3600s", async () => {
    vi.spyOn(discordWidgetHealth, "url").mockReturnValue(null);
    vi.spyOn(discordWidgetHealth, "snapshot").mockReturnValue(null);
    const { status, html, cache } = await getJoin();
    expect(status).toBe(200);
    expect(html).toContain('data-testid="join-widget-fallback"');
    expect(cache).toBe("public, max-age=3600");
  });

  it("a rendered presence snapshot keeps the 60s shared TTL", async () => {
    vi.spyOn(discordWidgetHealth, "url").mockReturnValue(
      "https://discord.com/widget?id=326474832151838730&theme=dark",
    );
    vi.spyOn(discordWidgetHealth, "snapshot").mockReturnValue(snapshot);
    const { status, html, cache } = await getJoin();
    expect(status).toBe(200);
    expect(html).toContain('data-testid="join-widget-presence"');
    expect(cache).toBe("public, max-age=60");
  });
});

describe("join expectations controls: existing funnel behavior is unchanged", () => {
  it("heading, intro, one-click and invite fallback still render", async () => {
    const { html } = await getJoin();
    expect(html).toContain('id="join-heading"');
    expect(html).toContain('data-testid="join-oneclick"');
    expect(html).toContain('href="/join/discord"');
    expect(html).toContain('data-testid="join-invite"');
    expect(html).toContain("https://discord.gg/invite");
  });

  it("the no-JS contract keeps the actions and fallback copy in the raw body", async () => {
    vi.spyOn(discordWidgetHealth, "url").mockReturnValue(null);
    vi.spyOn(discordWidgetHealth, "snapshot").mockReturnValue(null);
    const { html } = await getJoin();
    expect(html).toContain('href="/join/discord"');
    expect(html).toContain("Live server preview is unavailable");
  });

  it("the Kit twin keeps every existing action, URL and testid", () => {
    const page = readFileSync(
      new NodeURL("../web/src/routes/join/+page.svelte", import.meta.url),
      "utf8",
    );
    for (const needle of [
      'data-testid="join-oneclick"',
      'data-testid="join-invite"',
      'data-testid="join-widget-presence"',
      'data-testid="join-widget-fallback"',
      'data-testid="join-result"',
      "/join/discord",
      "/auth/discord",
      "/discord",
      "join-layout",
      "join-panel",
      "join-preview",
    ]) {
      expect(page, `Kit page lost ${needle}`).toContain(needle);
    }
  });
});
