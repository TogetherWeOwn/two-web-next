// route-inventory: GET /members/:user/live
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import {
  LINKS_PATH,
  LIVE_PATH,
  STREAM_ORIGIN,
  STREAM_USER,
  streamingLiveFixture,
  TWITCH,
  YOUTUBE,
} from "./helpers/streaming-live";

function decode(value: string) {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

function attr(html: string, attribute: string) {
  const match = html.match(new RegExp(`\\b${attribute}="([^"]*)"`));
  expect(match, `expected rendered ${attribute}`).not.toBeNull();
  return decode(match![1]!);
}

function link(html: string, marker: string) {
  const tag = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].find((match) =>
    match[0].includes(marker),
  );
  expect(tag, `expected usable ${marker} anchor in server HTML`).toBeDefined();
  return attr(tag![0], "href");
}

async function page(f: ReturnType<typeof streamingLiveFixture>, path = LIVE_PATH) {
  const res = await app.request(path, {}, f.env);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const document = await res.text();
  const main = document.match(/<main\b[^>]*>([\s\S]*?)<\/main>/);
  expect(main, "the public live content must have a main landmark").not.toBeNull();
  return { res, html: main![1]! };
}

function state(html: string, expected: "live" | "offline" | "unavailable") {
  expect(html).toContain(`data-stream-state="${expected}"`);
}

function publicCache(res: Response) {
  const cache = res.headers.get("cache-control") ?? "";
  expect(cache).toMatch(/(?:^|,)\s*public(?:,|$)/);
  expect(cache).toMatch(/(?:^|,)\s*max-age=60(?:,|$)/);
  expect(cache).not.toMatch(/private|no-store/);
  expect(res.headers.getSetCookie()).toEqual([]);
}

afterEach(() => vi.unstubAllGlobals());

describe("public member live page: real application route, fixture reads only", () => {
  it("is public, server-rendered and cacheable for 60s without a session", async () => {
    const f = streamingLiveFixture();
    const network = vi.fn(() => {
      throw new Error("Public page attempted an unconfigured external request");
    });
    vi.stubGlobal("fetch", network);
    const { res, html } = await page(f);
    publicCache(res);
    state(html, "live");
    expect(html).toContain("Casey Example");
    expect(html).toMatch(/<h1\b/);
    expect(f.memberCalls).toContain(STREAM_USER);
    expect(f.statusCalls).toEqual([f.member.input!.uid]);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([TWITCH, YOUTUBE])(
    "prefers a live $provider embed and loads no fallback player",
    async (destination) => {
      const f = streamingLiveFixture();
      f.member.destinations = [{ ...destination }];
      const { html } = await page(f);
      state(html, "live");
      const player = new URL(attr(html, "data-stream-player-src"));
      expect(player.hostname).toBe(new URL(destination.embedUrl!).hostname);
      expect(player.pathname).toBe(new URL(destination.embedUrl!).pathname);
      expect(html).not.toContain("/manifest/video.m3u8");
      expect(link(html, "data-stream-watch")).toBe(destination.watchUrl);
      if (destination.provider === "twitch") {
        expect(player.searchParams.get("channel")).toBe("casey_example");
        expect(player.searchParams.getAll("parent")).toEqual(["next.example.test"]);
      } else {
        expect(player.pathname).toBe("/embed/abcdefghijk");
      }
    },
  );

  it("skips a configured but offline Twitch destination in favor of live YouTube", async () => {
    const f = streamingLiveFixture();
    f.member.destinations = [{ ...TWITCH, live: false }, { ...YOUTUBE }];
    const { html } = await page(f);
    expect(new URL(attr(html, "data-stream-player-src")).hostname).toBe("www.youtube-nocookie.com");
    expect(html).not.toContain("/manifest/video.m3u8");
  });

  it("does not play a disabled destination even if its last upstream status said live", async () => {
    const f = streamingLiveFixture();
    f.member.destinations = [{ ...TWITCH, enabled: false }, { ...YOUTUBE }];
    const { html } = await page(f);
    expect(new URL(attr(html, "data-stream-player-src")).hostname).toBe("www.youtube-nocookie.com");
  });

  it.each(["none", "custom", "offline", "disabled"])(
    "renders live watch-links with no inline player when no eligible embed exists (%s)",
    async (reason) => {
      const f = streamingLiveFixture();
      f.member.destinations =
        reason === "none"
          ? []
          : [
              {
                ...TWITCH,
                provider: reason === "custom" ? "custom" : "twitch",
                enabled: reason !== "disabled",
                live: reason !== "offline",
                embedUrl: reason === "custom" ? null : TWITCH.embedUrl,
              },
            ];
      const { html } = await page(f);
      state(html, "live");
      // Rev 3: under D4 Cloudflare exposes no playback URL, so v1 renders
      // watch-links with no inline TWO player instead of an HLS fallback.
      expect(html).not.toContain("data-stream-player-src");
      expect(html).not.toMatch(/<iframe\b[^>]*\bsrc="https?:/);
      expect(html).not.toMatch(/<video\b[^>]*\bsrc="https?:/);
      expect(html).not.toContain("/manifest/video.m3u8");
      if (reason === "none") {
        expect(html).not.toContain("data-stream-watch");
        expect(html).not.toContain("data-stream-follow");
      } else {
        expect(link(html, "data-stream-watch")).toBe(TWITCH.watchUrl);
        expect(link(html, "data-stream-follow")).toBe(TWITCH.watchUrl);
      }
      const report = new URL(link(html, "data-stream-report"), STREAM_ORIGIN);
      expect(report.origin).toBe(STREAM_ORIGIN);
    },
  );

  it.each([TWITCH, YOUTUBE])(
    "defers the $provider frame until activation and cannot autoplay with sound",
    async (destination) => {
      const f = streamingLiveFixture();
      f.member.destinations = [{ ...destination }];
      const { html } = await page(f);
      expect(html).not.toMatch(/<iframe\b[^>]*\bsrc="https?:/);
      expect(html).not.toMatch(/<video\b[^>]*\bsrc="https?:/);
      expect(html).toMatch(/<button\b[^>]*data-stream-play/);
      const player = new URL(attr(html, "data-stream-player-src"));
      const autoplay = ["1", "true"].includes(
        player.searchParams.get("autoplay") ??
          (destination.provider === "twitch" ? "true" : "false"),
      );
      const muted = ["1", "true"].includes(
        player.searchParams.get("muted") ?? player.searchParams.get("mute") ?? "",
      );
      expect(!autoplay || muted).toBe(true);
      expect(link(html, "data-stream-watch")).toBe(destination.watchUrl);
    },
  );

  it("renders offline recovery, follow links and a join-TWO CTA without loading a player", async () => {
    const f = streamingLiveFixture();
    f.status({ live: false, sessionId: null });
    const { res, html } = await page(f);
    state(html, "offline");
    publicCache(res);
    expect(html).toContain("Fridays at 18:00 UTC");
    expect(html).toMatch(/<time\b[^>]*datetime="2026-10-20T18:00:00(?:\.000)?Z"/);
    expect(link(html, "data-stream-follow")).toBe(TWITCH.watchUrl);
    const join = new URL(link(html, "data-stream-join"), STREAM_ORIGIN);
    expect(join.origin).toBe(STREAM_ORIGIN);
    expect(join.pathname).toMatch(/^\/join(?:\/discord)?$/);
    expect(html).not.toContain("data-stream-player-src");
    expect(html).not.toMatch(/<(?:iframe|video)\b/);
    expect(html).not.toMatch(/href="[^"<>]*(?:checkout|\/streaming\/subscribe)/);
  });

  it("does not invent a last-live timestamp or schedule when neither exists", async () => {
    const f = streamingLiveFixture();
    f.status({ live: false, sessionId: null });
    f.member.lastLiveAt = null;
    f.member.schedule = null;
    const { html } = await page(f);
    state(html, "offline");
    expect(html).not.toMatch(/<time\b/);
    expect(html).not.toMatch(/Invalid Date|undefined|\bnull\b/);
    expect(link(html, "data-stream-follow")).toBe(TWITCH.watchUrl);
    expect(link(html, "data-stream-join")).toMatch(/^\//);
  });

  it("shares one status read across live-page and link-banner viewers until the TTL boundary", async () => {
    const f = streamingLiveFixture();
    const uid = f.member.input!.uid;
    state((await page(f)).html, "live");
    const links = (await page(f, LINKS_PATH)).html;
    expect(link(links, "data-stream-live-banner")).toBe(LIVE_PATH);
    expect(f.statusCalls).toEqual([uid]);
    f.status({ live: false, sessionId: null });
    f.at(59_999);
    state((await page(f)).html, "live");
    expect(f.statusCalls).toEqual([uid]);
    f.at(60_000);
    state((await page(f)).html, "offline");
    expect((await page(f, LINKS_PATH)).html).not.toContain("data-stream-live-banner");
    expect(f.statusCalls).toEqual([uid, uid]);
  });

  it.each(["entitlement", "input", "global"])(
    "hides the banner and player after a %s disable, despite a still-cached live status",
    async (scope) => {
      const f = streamingLiveFixture();
      state((await page(f)).html, "live");
      if (scope === "entitlement") f.member.entitled = false;
      if (scope === "input") f.member.input!.enabled = false;
      if (scope === "global") f.globalEnabled(false);
      f.at(60_000);
      const { html } = await page(f);
      expect(html).not.toContain('data-stream-state="live"');
      expect(html).not.toContain("data-stream-player-src");
      expect((await page(f, LINKS_PATH)).html).not.toContain("data-stream-live-banner");
    },
  );

  it("degrades a status outage without breaking free links or claiming a known live state", async () => {
    const f = streamingLiveFixture();
    f.failStatus(true);
    const { html } = await page(f);
    expect(html).not.toContain('data-stream-state="live"');
    expect(html).toMatch(/offline|unavailable|try again|status/i);
    expect(html).not.toContain("data-stream-player-src");
    expect(link(html, "data-stream-follow")).toBe(TWITCH.watchUrl);
    expect((await page(f, LINKS_PATH)).html).not.toContain("data-stream-live-banner");
    f.failStatus(false);
    f.at(60_000);
    state((await page(f)).html, "live");
  });

  it("returns a real 404 for a missing member, without polling any live input", async () => {
    const f = streamingLiveFixture();
    f.removeMember();
    const res = await app.request(LIVE_PATH, {}, f.env);
    expect(res.status).toBe(404);
    expect(f.memberCalls).toContain(STREAM_USER);
    expect(f.statusCalls).toEqual([]);
    expect(await res.text()).not.toContain("data-stream-player-src");
  });

  it("carries public report context into a same-site reporting flow, not a moderator-only page", async () => {
    const f = streamingLiveFixture();
    const { html } = await page(f);
    const report = new URL(link(html, "data-stream-report"), STREAM_ORIGIN);
    expect(report.origin).toBe(STREAM_ORIGIN);
    expect(report.pathname).toMatch(/report/i);
    expect(report.pathname).not.toMatch(/^\/admin(?:\/|$)/);
    expect(report.searchParams.get("user")).toBe(STREAM_USER);
    expect(report.searchParams.get("session")).toBe("broadcast-a");
    expect(report.searchParams.get("at")).toBe("2026-10-21T12:00:00.000Z");
    const entry = await app.request(report.pathname + report.search, {}, f.env);
    expect([200, 302, 303]).toContain(entry.status);
    if (entry.status !== 200) {
      const login = new URL(entry.headers.get("location")!, STREAM_ORIGIN);
      expect(login.origin).toBe(STREAM_ORIGIN);
      expect(login.pathname).toMatch(/^\/auth\/discord(?:\/|$)/);
      // Signing in must not lose which stream the viewer wanted to report.
      expect(decodeURIComponent(login.search)).toContain(report.pathname);
    }
  });

  it("confines frames to approved players while retaining anti-framing headers", async () => {
    const { res } = await page(streamingLiveFixture());
    const csp = res.headers.get("content-security-policy") ?? "";
    const sources = csp
      .match(/(?:^|;)\s*frame-src\s+([^;]+)/)?.[1]
      ?.trim()
      .split(/\s+/);
    expect(sources).toBeDefined();
    expect(new Set(sources)).toEqual(
      new Set([
        "https://player.twitch.tv",
        "https://www.youtube.com",
        "https://www.youtube-nocookie.com",
        // *.cloudflarestream.com stays pinned for the Plus-recording
        // fast-follow even though v1 renders no Cloudflare player (Rev 3).
        "https://*.cloudflarestream.com",
      ]),
    );
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const other = await app.request("/about", {}, streamingLiveFixture().env);
    expect(other.headers.get("content-security-policy")).toMatch(/frame-src 'none'/);
  });

  it.each([
    "https://player.twitch.tv.evil.example/?channel=casey_example",
    "https://www.youtube-nocookie.com.evil.example/embed/abcdefghijk",
    "javascript:alert(1)",
  ])("never activates an unapproved destination frame: %s", async (embedUrl) => {
    const f = streamingLiveFixture();
    f.member.destinations = [{ ...TWITCH, embedUrl }];
    const { html } = await page(f);
    // Rev 3: the fallback for an unapproved frame is no-player watch-links.
    expect(html).not.toContain("data-stream-player-src");
    expect(html).not.toMatch(/<iframe\b[^>]*\bsrc="https?:/);
    expect(html).not.toMatch(/<video\b[^>]*\bsrc="https?:/);
    expect(link(html, "data-stream-watch")).toBe(TWITCH.watchUrl);
    expect(html).not.toContain(embedUrl);
  });

  it("escapes member-controlled content rather than creating active markup", async () => {
    const f = streamingLiveFixture();
    f.member.displayName = '<img src=x onerror="alert(1)">';
    f.member.schedule = '<script>alert("schedule")</script>';
    f.status({ live: false, sessionId: null });
    const { html } = await page(f);
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('<script>alert("schedule")</script>');
  });
});
