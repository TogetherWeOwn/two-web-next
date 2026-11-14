import { expect, it } from "vitest";
import { createKitSsrRenderer } from "./helpers/kit-ssr-render";

it("renders button and navigation states with safe native semantics", async () => {
  const { renderPage, cleanup } = await createKitSsrRenderer(
    "test/fixtures/kit-button-isolated.svelte",
  );
  try {
    const html = renderPage({});
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const links = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(buttons).toHaveLength(5);
    expect(links).toHaveLength(3);
    expect(buttons[0]).toContain('type="submit"');
    expect(buttons[1]).toContain('type="button"');
    expect(buttons[1]).toContain('aria-disabled="true"');
    expect(buttons[1]).toContain("Event is full");
    expect(buttons[1]).toContain('aria-label="Join Raid Night · Event is full"');
    expect(buttons[2]).toContain('type="button"');
    expect(buttons[2]).toContain('aria-busy="true"');
    expect(buttons[2]).toContain("Saving…");
    expect(buttons[3]).toContain("leave");
    expect(buttons[4]).toContain("on-accent");
    expect(buttons[4]).toMatch(/\blg\b/);
    expect(buttons[4]).toContain("full-width");
    expect(buttons[4]).toContain("Continue");
    expect(links[0]).toContain('href="/e/raid"');
    expect(links[0]).toContain('aria-label="Details for Raid Night"');
    for (const link of links.slice(1)) {
      expect(link).toContain('aria-disabled="true"');
      expect(link).not.toMatch(/\shref=/);
      expect(link).toContain('tabindex="0"');
    }
    expect(links[1]).toContain('aria-label="Reserve Raid Night · Event is full"');
    expect(links[2]).toContain('aria-busy="true"');
  } finally {
    cleanup();
  }
}, 120000);
