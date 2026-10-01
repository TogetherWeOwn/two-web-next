import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home, Layout } from "../src/pages";
import { discordWidgetUrl } from "../src/discord-widget";
import { FALLBACK_INVITE } from "../src/invite";
import type { Session } from "../src/env";
import app from "./app";

const props = {
  session: null as Session | null,
  notice: null,
  inviteUrl: "https://discord.gg/invite",
  appUrl: "https://next.example.test",
  counts: { memberCount: null, onlineCount: null, ranks: [] },
  upcomingEvents: [],
  eventsUnavailable: false,
  featured: [],
};
const session: Session = { id: "fixture", username: "Player <script>", avatar: null, member: false, moderator: false };
const render = (overrides = {}) => Home({ ...props, ...overrides })!.toString();

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("theme tests must remain offline"); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("homepage theme", () => {
  it("opts the homepage into the theme without changing unthemed leaf layouts", () => {
    const html = render();
    expect(html).toContain('<body class="homepage-theme"><a class="skip-link"');
    expect(html).toContain('href="/theme.css"');
    expect(html).toContain('href="/fonts/display-latin-700.woff2" as="font"');
    expect(html).toContain('src="/logo.svg" width="64" height="64" alt="Together We Own"');
    expect(html).not.toContain("<script");
    const leaf = Layout({ title: "Fixture" })!.toString();
    expect(leaf).not.toContain("/theme.css");
    expect(leaf).not.toContain("/fonts/");
  });

  it("retains the guest sign-in and join OAuth entry points", () => {
    const html = render();
    expect(html).toMatch(/href="\/auth\/discord"[^>]*data-testid="signin"/);
    expect(html).toMatch(/href="\/auth\/discord"[^>]*data-testid="join"/);
    expect(html).toContain('href="/events"');
    expect(html).toContain('data-testid="home-events-join"');
  });

  it.each([false, true])("retains logout and the signed-in join state (member=%s)", (member) => {
    const html = render({ session: { ...session, member } });
    expect(html).toContain('<form method="post" action="/logout">');
    expect(html).toContain("Player &lt;script&gt;");
    expect(html).not.toContain('data-testid="signin"');
    expect(html).not.toContain('data-testid="home-events-join"');
    expect(html.includes('data-testid="join"')).toBe(!member);
    if (member) expect(html).toContain('href="https://discord.gg/invite">Open Discord');
  });

  it.each(["joined", "already_member", "join_failed", "signin_failed"])("retains the %s status and invite recovery", (notice) => {
    const html = render({ notice });
    expect(html).toContain('role="status" data-testid="notice"');
    if (notice === "join_failed") expect(html).toContain("Join with an invite link instead");
  });

  it("keeps data and image policy inside the themed layout", () => {
    const html = render({
      counts: { memberCount: 57, onlineCount: 8, ranks: [{ key: "legend", label: "Legend", memberCount: 0 }] },
      featured: [{ id: 1, title: "Community update", body: "Fixture content", url: "/events", imageUrl: "/logo.svg", imageAlt: "TWO" }],
      upcomingEvents: [{ eventKey: "game-night", title: "Co-op evening", startsAt: new Date("2030-07-04T19:00:00Z"), timezone: "UTC", location: "Voice lobby", goingCount: 2 }],
    });
    expect(html).toContain('<strong>57</strong> members');
    expect(html).toContain('<strong>8</strong> online');
    expect(html).toContain('data-testid="featured-item"');
    expect(html).toContain('src="/logo.svg" alt="TWO" width="640" height="360" loading="lazy"');
    expect(html).toContain('href="/e/game-night"');
    expect(html).toContain("2 going");
    expect(html).toContain('aria-label="Community ladder"');
    expect(html).toContain('data-testid="rank-stack"');
    expect(html).toContain('data-rank="legend"><dt>Legend</dt><dd>unclaimed</dd>');
  });

  it.each([null, session, { ...session, member: true }])("links every account state to the existing join preview (%#)", (session) => {
    const html = render({ session });
    expect(html).toContain('href="/join#join-heading" data-testid="home-widget-link"');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("https://discord.com/widget");
  });

  it.each(["", "javascript:alert(1)", "http://discord.gg/invite", "https://invalid.example/invite"])("routes the new invite fallback through normalization (%s)", async (inviteUrl) => {
    const env = {
      APP_URL: props.appUrl, DISCORD_GUILD_ID: "123456789012345678", DISCORD_INVITE_URL: inviteUrl,
      DISCORD_CLIENT_ID: "fixture", DISCORD_CLIENT_SECRET: "fixture", DISCORD_BOT_TOKEN: "fixture",
      SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
    };
    const response = await app.request("/", {}, env);
    expect(await response.text()).toContain('href="/discord" data-testid="home-discord-invite"');
    const redirect = await app.request("/discord", {}, env);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(FALLBACK_INVITE);
    expect(redirect.headers.get("cache-control")).toContain("no-store");
    expect(redirect.headers.get("set-cookie")).toBeNull();
  });

  it("retains the disclosed join-only widget and the linked section target", async () => {
    const response = await app.request("/join", {}, {
      APP_URL: props.appUrl, DISCORD_GUILD_ID: "123456789012345678", DISCORD_INVITE_URL: props.inviteUrl,
      DISCORD_CLIENT_ID: "fixture", DISCORD_CLIENT_SECRET: "fixture", DISCORD_BOT_TOKEN: "fixture",
      SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
    });
    const html = await response.text();
    expect(html).toContain('id="join-heading"');
    expect(html).toContain('src="https://discord.com/widget?id=123456789012345678&amp;theme=dark"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin" loading="lazy" referrerpolicy="no-referrer"');
    expect(html).toContain('data-testid="join-widget"');
  });

  it.each([undefined, "guild", "123", "1234567890&evil=1", "https://evil.test"])("rejects invalid widget identifiers (%s)", (id) => {
    expect(discordWidgetUrl(id)).toBeNull();
  });

  it("allows only self fonts and keeps the homepage frame policy closed", async () => {
    const response = await app.request("/", {}, {
      APP_URL: "https://next.example.test", DISCORD_GUILD_ID: "123456789012345678", DISCORD_INVITE_URL: props.inviteUrl,
      DISCORD_CLIENT_ID: "fixture", DISCORD_CLIENT_SECRET: "fixture", DISCORD_BOT_TOKEN: "fixture",
      SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
    });
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("frame-src 'none';");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("*");
    const html = await response.text();
    expect(html).toContain('data-testid="home-widget-link"');
    expect(html).not.toContain("<iframe");
  });

  it("keeps the responsive, focus and reduced-motion rules external and compact", () => {
    const css = readFileSync(new URL("../public/theme.css", import.meta.url), "utf8");
    expect(css).toContain(".homepage-theme :focus-visible");
    expect(css).toContain("@media (max-width: 48rem)");
    expect(css).toContain("prefers-reduced-motion: no-preference");
    expect(css).not.toContain("@import");
    expect(css).not.toContain("https://");
    expect(css.length).toBeLessThan(12000);
  });
});
