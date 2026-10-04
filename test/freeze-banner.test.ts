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

  it("flag on skips non-document responses untouched", async () => {
    // /auth/discord is a 302 redirect: no HTML document, no banner, same status.
    const res = await app.request("/auth/discord", {}, onEnv);
    expect(res.status).toBe(302);
    expect(await res.text()).not.toContain(FREEZE_BANNER_TESTID);
  });
});
