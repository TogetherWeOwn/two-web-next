import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";

let renderPage: RenderPage;
let cleanup: () => void;

beforeAll(async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/kit-ember-shell.svelte");
  renderPage = renderer.renderPage;
  cleanup = renderer.cleanup;
});

afterAll(() => cleanup?.());

describe("Ember shell", () => {
  it("renders one skip link and ordered header, main content and footer without JavaScript", () => {
    const html = renderPage({});
    expect(html.match(/href="#main"/g)).toHaveLength(1);
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toMatch(/<main\b[^>]*id="main"[^>]*tabindex="-1"/);
    expect(html.indexOf("<header")).toBeLessThan(html.indexOf("<main"));
    expect(html.indexOf("<main")).toBeLessThan(html.indexOf("<footer"));
    expect(html).toContain("Shell content");
    expect(html).toContain('aria-label="Footer"');
    expect(html).toContain('href="/auth/discord"');
  });

  it("forwards navigation, membership and sign-in return state", () => {
    const html = renderPage({ activeNav: "events", member: true, loginReturnTo: "/events" });
    expect(html).toMatch(/href="\/events"\s+aria-current="page"/);
    expect(html).toContain('href="/leaderboards/members"');
    expect(html).toContain('href="/auth/discord?next=%2Fevents"');
  });

  it("forwards custom account content and gives hidden-account state precedence", () => {
    const html = renderPage({ customAccount: true });
    expect(html).toContain('href="/profile"');
    expect(html).not.toContain('data-testid="signin"');

    const hidden = renderPage({ customAccount: true, hideAccount: true });
    expect(hidden).not.toContain('href="/profile"');
    expect(hidden).not.toContain('aria-label="Account"');
  });

  it("offers guest Join without assuming membership implies authentication", () => {
    const guest = renderPage({ member: true, menuFallbackOnly: true });
    expect(guest.match(/href="\/join"/g)).toHaveLength(2); // Bar and sheet, one visible at a time.
    expect(guest).toContain('href="/leaderboards/members"');
    expect(guest).toContain('href="/about"');
    expect(guest).not.toContain("Welcome, guest");
    expect(guest).not.toContain("site-header-menu.js");
    expect(renderPage({ authenticated: true })).not.toContain('href="/join"');
    expect(renderPage({ hideJoin: true })).not.toContain('href="/join"');
  });

  it("omits the account area when requested", () => {
    const html = renderPage({ hideAccount: true });
    expect(html).not.toContain('aria-label="Account"');
    expect(html).not.toContain('data-testid="signin"');
    expect(html).toContain('aria-label="Primary"');
  });
});
