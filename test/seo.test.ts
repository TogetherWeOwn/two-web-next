import { describe, expect, it } from "vitest";
import app, { FALLBACK_INVITE } from "../src/index";
import { readCounts } from "../src/counts";
import type { Env } from "../src/env";
import { buildRobots, buildSitemapUrls, crawlableEvents, renderSitemap } from "../src/seo";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

describe("funnel leaves (DB-free floor)", () => {
  it("/discord 302s to the configured invite with no-store and sets no cookies", async () => {
    const res = await app.request("/discord", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://discord.gg/configured");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("/discord falls back to the hardcoded invite when config is unusable", async () => {
    const bad = { ...env, DISCORD_INVITE_URL: "https://evil.test/steal" };
    const res = await app.request("/discord", {}, bad);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(FALLBACK_INVITE);
    expect(FALLBACK_INVITE).toBe("https://discord.gg/4GwEDNRTtx");
  });

  it("/discord falls back on non-https invite URLs", async () => {
    const bad = { ...env, DISCORD_INVITE_URL: "http://discord.gg/configured" };
    const res = await app.request("/discord", {}, bad);
    expect(res.headers.get("location")).toBe(FALLBACK_INVITE);
  });

  it("/discord rejects lookalike hosts (suffix match is not Discord)", async () => {
    const bad = { ...env, DISCORD_INVITE_URL: "https://discord.gg.example.com/x" };
    const res = await app.request("/discord", {}, bad);
    expect(res.headers.get("location")).toBe(FALLBACK_INVITE);
  });

  it.each(["/about", "/faq", "/rules"])("%s is a 200 dependency-free leaf with no cookies", async (path) => {
    const res = await app.request(path, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("/about carries the facts and a join link", async () => {
    const html = await (await app.request("/about", {}, env)).text();
    expect(html).toContain("About Together We Own");
    expect(html).toContain('data-testid="about-facts"');
    expect(html).toContain('data-testid="about-join"');
  });

  it("/faq carries the question list and a join link", async () => {
    const html = await (await app.request("/faq", {}, env)).text();
    expect(html).toContain("Frequently asked questions");
    expect(html).toContain('data-testid="faq-list"');
    expect(html).toContain('data-testid="faq-join"');
    expect(html).toContain("Sunday Squad");
  });

  it("/rules carries the five rules and hides the stamp when unconfigured", async () => {
    const html = await (await app.request("/rules", {}, env)).text();
    expect(html).toContain("House rules");
    expect(html).toContain('data-testid="rules-list"');
    expect(html).toContain("18+ only");
    expect(html).toContain("Moderators have the last word");
    expect(html).not.toContain("rules-last-updated");
  });

  it("/rules shows the stamp when configured and hides it when invalid", async () => {
    const dated = { ...env, RULES_LAST_UPDATED: "2026-09-01" };
    const html = await (await app.request("/rules", {}, dated)).text();
    expect(html).toContain('data-testid="rules-last-updated"');
    expect(html).toContain('datetime="2026-09-01"');

    const bad = { ...env, RULES_LAST_UPDATED: "someday" };
    const res = await app.request("/rules", {}, bad);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("rules-last-updated");
  });
});

describe("homepage degraded fallback", () => {
  it("renders 200 with no member count when the bot DB is down", async () => {
    expect(await readCounts(env)).toEqual({ memberCount: null, onlineCount: null });
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('data-testid="member-count"');
    expect(html).toContain("Join with Discord");
  });
});

describe("sitemap + robots (per-env host)", () => {
  it("crawlableEvents keeps published events only: drafts and cancelled stay out", () => {
    const out = crawlableEvents([
      { key: "live", status: "published", updatedAt: "2026-09-01T00:00:00Z" },
      { key: "draft", status: "draft", updatedAt: null },
      { key: "gone", status: "cancelled", updatedAt: null },
    ]);
    expect(out).toEqual([{ key: "live", updatedAt: "2026-09-01T00:00:00Z" }]);
  });

  it("/sitemap_index.xml lists the static leaves, no past archive, valid XML", async () => {
    const res = await app.request("/sitemap_index.xml", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    for (const loc of [
      "https://next.example.test/",
      "https://next.example.test/join",
      "https://next.example.test/about",
      "https://next.example.test/faq",
      "https://next.example.test/rules",
      "https://next.example.test/privacy",
    ]) {
      expect(xml).toContain(`<loc>${loc}</loc>`);
    }
    expect(xml).not.toContain("/events/past");
    expect(xml).not.toContain("/admin");
  });

  it("renderSitemap emits lastmod only when present and escapes XML", () => {
    const xml = renderSitemap(
      buildSitemapUrls("https://next.example.test", [
        { key: "abc", updatedAt: "2026-09-01T00:00:00+00:00" },
        { key: "no-date", updatedAt: null },
      ]),
    );
    expect(xml).toContain("<loc>https://next.example.test/e/abc</loc>");
    expect(xml).toContain("<lastmod>2026-09-01T00:00:00+00:00</lastmod>");
    expect(xml.match(/<lastmod>/g)).toHaveLength(1);
  });

  it("/robots.txt advertises this environment's own sitemap host", async () => {
    const res = await app.request("/robots.txt", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(
      "User-agent: *\nDisallow:\nSitemap: https://next.example.test/sitemap_index.xml\n",
    );
  });

  it("staging advertises the staging host, never the apex (TOG-7071)", async () => {
    const staging = { ...env, APP_URL: "https://staging.example.test" };
    const robots = await (await app.request("/robots.txt", {}, staging)).text();
    expect(robots).toContain("Sitemap: https://staging.example.test/sitemap_index.xml");
    expect(robots).not.toContain("next.example.test");
    expect(buildRobots(staging.APP_URL)).toContain("staging.example.test");
  });
});

describe("share meta parity (TOG-5624)", () => {
  it("home carries canonical + OG/Twitter tags and no og:image", async () => {
    const html = await (await app.request("/", {}, env)).text();
    expect(html).toContain('<link rel="canonical" href="https://next.example.test/"');
    expect(html).toContain('<meta property="og:url" content="https://next.example.test/"');
    expect(html).toContain('<meta property="og:type" content="website"');
    expect(html).toContain('<meta property="og:site_name" content="Together We Own"');
    expect(html).toContain('<meta name="twitter:card" content="summary"');
    expect(html).toContain('<meta property="og:description"');
    expect(html).not.toContain("og:image");
  });

  it("the about leaf carries its self-canonical and keeps feed autodiscovery", async () => {
    const html = await (await app.request("/about", {}, env)).text();
    expect(html).toContain('<link rel="canonical" href="https://next.example.test/about"');
    expect(html).toContain('<meta property="og:url" content="https://next.example.test/about"');
    expect(html).toContain('<meta name="twitter:card" content="summary"');
    expect(html).toContain('type="application/rss+xml"');
    expect(html).toContain('href="/events.rss"');
  });

  it("home advertises the events feed", async () => {
    const html = await (await app.request("/", {}, env)).text();
    expect(html).toContain('href="/events.rss"');
  });
});

describe("URL freeze (W4 slice)", () => {
  it.each(["/", "/join", "/about", "/faq", "/rules", "/privacy", "/sitemap_index.xml", "/robots.txt"])(
    "%s answers",
    async (path) => {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
    },
  );

  it("/discord redirects", async () => {
    expect((await app.request("/discord", {}, env)).status).toBe(302);
  });
});
