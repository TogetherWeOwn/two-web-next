// route-inventory: GET /about
// Cutover step 1: member-facing freeze notice from docs/cutover-freeze.md.
// Flag-gated, off by default: unset (or anything but "true"/"1") renders
// nothing and leaves pages byte-identical. When enabled with real dates, a
// <p class="notice"> carrying the freeze dates and a relative /privacy link
// is prepended inside <main> on public HTML documents. DB-free: /about is a
// static leaf, so no agent-testdb fixture is needed.
import { describe, expect, it } from "vitest";
import app from "./app";
import { freezeBannerEnabled, freezeBannerHtml, FREEZE_BANNER_TESTID } from "../src/freeze-banner";
import type { Env } from "../src/env";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const DATES = "12–14 Oct UTC";

const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const onEnv: Env = { ...baseEnv, FREEZE_BANNER_ENABLED: "true", FREEZE_BANNER_DATES: DATES };

describe("cutover freeze banner flag", () => {
  it.each(["true", "1"])("flag %s enables the banner", (flag) => {
    expect(freezeBannerEnabled({ FREEZE_BANNER_ENABLED: flag })).toBe(true);
  });

  it.each([undefined, "", "false", "0", "yes", "TRUE"])("flag %s stays invisible", (flag) => {
    expect(freezeBannerEnabled({ FREEZE_BANNER_ENABLED: flag })).toBe(false);
    expect(
      freezeBannerHtml({ FREEZE_BANNER_ENABLED: flag, FREEZE_BANNER_DATES: DATES }),
    ).toBeNull();
  });

  it.each([undefined, "", "   "])("flag on without dates (%s) never renders", (dates) => {
    expect(
      freezeBannerHtml({ FREEZE_BANNER_ENABLED: "true", FREEZE_BANNER_DATES: dates }),
    ).toBeNull();
  });

  it("enabled banner carries the dates and a relative /privacy link, never a pasted URL", () => {
    const html = freezeBannerHtml({
      FREEZE_BANNER_ENABLED: "true",
      FREEZE_BANNER_DATES: DATES,
    })!;
    expect(html).toContain(`data-testid="${FREEZE_BANNER_TESTID}"`);
    expect(html).toContain(DATES);
    expect(html).toContain('href="/privacy"');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("dates are HTML-escaped before render", () => {
    const html = freezeBannerHtml({
      FREEZE_BANNER_ENABLED: "1",
      FREEZE_BANNER_DATES: '"><script>alert(1)</script>',
    })!;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("flag off leaves the public page banner-free with shared cache headers", async () => {
    const res = await app.request("/about", {}, baseEnv);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(FREEZE_BANNER_TESTID);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("flag on prepends the banner inside <main> without touching cache headers", async () => {
    const res = await app.request("/about", {}, onEnv);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`data-testid="${FREEZE_BANNER_TESTID}"`);
    expect(html).toContain(DATES);
    expect(html).toContain('href="/privacy"');
    expect(html.indexOf(`data-testid="${FREEZE_BANNER_TESTID}"`)).toBeGreaterThan(
      html.indexOf("<main"),
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("flag on renders one status region first inside <main>", async () => {
    const res = await app.request("/about", {}, onEnv);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Exactly one polite live region on the static leaf: the banner itself.
    expect(html.match(/role="status"/g) ?? []).toHaveLength(1);
    expect(html.match(new RegExp(`data-testid="${FREEZE_BANNER_TESTID}"`, "g")) ?? []).toHaveLength(
      1,
    );
    // Prepended as the first child of <main>: in-flow, no overlay shift.
    expect(html).toMatch(
      new RegExp(
        `<main\\b[^>]*><p class="notice" role="status" data-testid="${FREEZE_BANNER_TESTID}">`,
      ),
    );
  });

  it("flag on changes nothing except the banner insertion", async () => {
    const [offRes, onRes] = await Promise.all([
      app.request("/about", {}, baseEnv),
      app.request("/about", {}, onEnv),
    ]);
    expect(offRes.status).toBe(200);
    expect(onRes.status).toBe(200);
    const offHtml = await offRes.text();
    const onHtml = await onRes.text();
    const banner = freezeBannerHtml(onEnv)!;
    // Byte-identical besides the single insertion: no wrapper, no head edits.
    expect(onHtml.replace(banner, "")).toBe(offHtml);
    expect(onRes.headers.get("cache-control")).toBe(offRes.headers.get("cache-control"));
  });

  it("banner has no layout-affecting attributes beyond the notice class", () => {
    const banner = freezeBannerHtml(onEnv)!;
    const open = banner.match(/^<p\b[^>]*>/)![0];
    expect(open).toBe(`<p class="notice" role="status" data-testid="${FREEZE_BANNER_TESTID}">`);
    expect(open).not.toContain("style=");
    expect(open).not.toMatch(/\b(width|height|hidden|tabindex)\b/);
  });

  it("banner adds no scripts or styles to the page", async () => {
    const [offRes, onRes] = await Promise.all([
      app.request("/about", {}, baseEnv),
      app.request("/about", {}, onEnv),
    ]);
    const offHtml = await offRes.text();
    const onHtml = await onRes.text();
    const bannerEl = onHtml.match(
      new RegExp(`<p\\b[^>]*data-testid="${FREEZE_BANNER_TESTID}"[^>]*>.*?</p>`, "s"),
    )![0];
    expect(bannerEl).not.toContain("<script");
    expect(bannerEl).not.toContain("<style");
    expect(bannerEl).not.toContain("style=");
    const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;
    expect(count(onHtml, /<script\b/g)).toBe(count(offHtml, /<script\b/g));
    expect(count(onHtml, /<style\b/g)).toBe(count(offHtml, /<style\b/g));
    expect(count(onHtml, /style=/g)).toBe(count(offHtml, /style=/g));
  });

  it("banner link is the relative /privacy path only", async () => {
    const res = await app.request("/about", {}, onEnv);
    const bannerEl = (await res.text()).match(
      new RegExp(`<p\\b[^>]*data-testid="${FREEZE_BANNER_TESTID}"[^>]*>.*?</p>`, "s"),
    )![0];
    expect(bannerEl.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(bannerEl).toContain('href="/privacy"');
    expect(bannerEl).not.toMatch(/https?:\/\//);
  });

  it("render-level date injection stays inert", async () => {
    const probe: Env = {
      ...baseEnv,
      FREEZE_BANNER_ENABLED: "1",
      FREEZE_BANNER_DATES: '"><script>alert(1)</script>',
    };
    const res = await app.request("/about", {}, probe);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`data-testid="${FREEZE_BANNER_TESTID}"`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("flag on skips non-document responses untouched", async () => {
    // /auth/discord is a 302 redirect: no HTML document, no banner, same status.
    const res = await app.request("/auth/discord", {}, onEnv);
    expect(res.status).toBe(302);
    expect(await res.text()).not.toContain(FREEZE_BANNER_TESTID);
  });
});
