import { afterEach, beforeEach, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { POLICY_MARKDOWN } from "../src/privacy-content";
import { renderPolicyMarkdown } from "../src/privacy";

// /join is not listed here: it renders the next-game-night card from the
// homepage teaser's cached merged read, so unlike these static leaves it may
// touch the event binding. Its shell assertions live in the dedicated test
// below, without the no-binding-read pin.
const paths = ["/about", "/faq", "/rules", "/privacy"] as const;
const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
  RULES_LAST_UPDATED: "2026-09-01",
};

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("static theme tests must stay offline");
    }),
  ),
);
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it.each(paths)(
  "%s shares the base theme without reading any database or session binding",
  async (path) => {
    const readStore = vi.fn(() => {
      throw new Error("static leaves must not read persistence");
    });
    const noDbEnv = { ...env };
    for (const key of [
      "DATABASE_URL",
      "DB",
      "AGENT_DB",
      "SESSION_STORE",
      "ROSTER_STORE",
      "JOIN_DEPS",
    ]) {
      Object.defineProperty(noDbEnv, key, { get: readStore });
    }
    const response = await app.request(
      path,
      { headers: { cookie: "__Host-two_session=forged" } },
      noDbEnv,
    );
    expect(response.status).toBe(200);
    expect(readStore).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toHaveLength(0);
    const html = await response.text();
    expect(html).toContain('<body class="base-theme content-theme"><a class="skip-link"');
    // Content leaves inline the stylesheets: no render-blocking CSS
    // requests, with the real rules verifiable inside the style block.
    expect(html).toContain("<style>");
    expect(html).toContain(".content-page");
    expect(html).not.toContain('rel="stylesheet"');
    // Content leaves render no Display text so they preload no font.
    expect(html).not.toContain('.woff2" as="font"');
    expect(html).toContain('class="bar site-header"');
    expect(html).toContain('src="/logo.svg" width="64" height="64"');
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('aria-label="Site"');
    expect(html).toContain(`<link rel="canonical" href="${env.APP_URL}${path}"`);
    expect(html).not.toContain('<meta name="robots"');
    expect(html.match(/<script\b[^>]*>/gi) ?? []).toEqual([]);
    expect(html).not.toContain('action="/logout"');
    expect(html).toContain(`<a href="${path}" aria-current="page">`);
    expect(html).not.toContain("<iframe");
    expect(response.headers.get("content-security-policy")).toContain("frame-src 'none'");
  },
);

it("/join shares the base theme", async () => {
  // The no-binding-read pin above does not apply here: /join renders the
  // next-game-night card from the homepage teaser's cached merged read. With
  // no binding configured the read degrades to today's static page, which is
  // what this env asserts: same shell, no session, no event content.
  const response = await app.request(
    "/join",
    { headers: { cookie: "__Host-two_session=forged" } },
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toHaveLength(0);
  const html = await response.text();
  expect(html).toContain('<body class="base-theme join-theme"><a class="skip-link"');
  expect(html).toContain('rel="stylesheet" href="/theme.css"');
  // Only the join shell still preloads Display.
  expect(html).toContain('href="/fonts/display-latin-700.woff2" as="font"');
  expect(html).toContain('class="bar site-header"');
  expect(html).toContain('src="/logo.svg" width="64" height="64"');
  expect(html).toContain('aria-label="Primary"');
  expect(html).toContain('aria-label="Site"');
  expect(html).toContain(`<link rel="canonical" href="${env.APP_URL}/join"`);
  expect(html).not.toContain('<meta name="robots"');
  expect(html.match(/<script\b[^>]*>/gi) ?? []).toEqual([
    '<script src="/islands/join-widget.js" defer="">',
  ]);
  expect(html).not.toContain('action="/logout"');
  expect(html).not.toContain('data-testid="join-next-event"');
});

it("keeps versioned privacy HTML and the rules date unchanged inside the content shell", async () => {
  const privacy = await (await app.request("/privacy", {}, env)).text();
  expect(privacy).toContain(
    `<div data-testid="privacy-policy">${renderPolicyMarkdown(POLICY_MARKDOWN)}</div>`,
  );
  expect(privacy).toContain('data-testid="privacy-version">Version 6');
  const rules = await (await app.request("/rules", {}, env)).text();
  expect(rules).toContain('<time datetime="2026-09-01">1 September 2026</time>');
  expect(rules.match(/<li class="card">/g)).toHaveLength(5);
});

it("/faq skips rendering offscreen sections until scrolled near (LCP)", async () => {
  // /faq is the stable ~2.3 s LCP outlier because it carries by far the most
  // below-fold DOM (8 sections, 15 cards); its LCP element (h1) sits outside
  // these subtrees, so first paint is unaffected. Sibling leaves showed only
  // 15-70 ms margins inside demonstrated runner noise (e.g. /about measured
  // 1003 ms then 2043 ms on consecutive heads with no app change), so no
  // defect was found there to fix.
  const html = await (await app.request("/faq", {}, env)).text();
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  expect(style).toContain("[data-testid='faq-list']>section");
  expect(style).toContain("content-visibility:auto");
  expect(style).toContain("contain-intrinsic-size:auto 20rem");
});

it("keeps the join targets, guarded return path, widget and fallback in the auth layout", async () => {
  const next = "/events?month=2026-10";
  const html = await (await app.request(`/join?next=${encodeURIComponent(next)}`, {}, env)).text();
  expect(html).toMatch(/href="\/auth\/discord"[^>]*data-testid="signin"/);
  expect(html).toContain(`href="/join/discord?next=${encodeURIComponent(next)}"`);
  expect(html).toContain('href="https://discord.gg/fixture" data-testid="join-invite"');
  expect(html).toContain('data-testid="join-widget-load"');
  expect(html).toContain('<script src="/islands/join-widget.js" defer=""></script>');
  expect(html).not.toContain("<iframe");
  const fallback = await (
    await app.request("/join?next=https://evil.test", {}, { ...env, DISCORD_GUILD_ID: "unset" })
  ).text();
  expect(fallback).toContain('href="/join/discord"');
  expect(fallback).toContain(
    "Live server preview is unavailable — the join button above still works.",
  );
  expect(fallback).not.toContain("<iframe");
});

it.each(["/events"])(
  "%s is not a static leaf: without a database it fails closed",
  async (path) => {
    // The schedule opts into its own theme (base-theme schedule-theme), covered
    // with local fixtures in page-shells.test.ts; it never borrows the content shell.
    // The no-database refusal is the shared branded 503 (homepage-theme error
    // shell), which ships the shared theme stylesheet like every branded error page.
    const response = await app.request(path, {}, env);
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).not.toContain("content-theme");
    expect(html).toContain('id="error-heading"');
    expect(html).toContain("We will be right back");
  },
);
