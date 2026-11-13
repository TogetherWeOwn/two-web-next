import { expect, it } from "vitest";
import { createKitSsrRenderer } from "./helpers/kit-ssr-render";

it("renders filter links with their destinations, selection and zero counts", async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/kit-filter-links.svelte");
  try {
    const body = renderer.renderPage({});
    expect(body).toContain('aria-label="Event views"');
    const links = Array.from(
      body.replace(/<!--.*?-->/gs, "").matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g),
      (match) => match[0],
    );
    expect(links).toHaveLength(4);
    expect(links[0]).toContain('href="/events"');
    expect(links[0]).toContain('aria-current="page"');
    expect(links[0]).toMatch(/>0<\/span>/);
    expect(links[1]).toContain('href="/events/past"');
    expect(links[1]).not.toContain("aria-current");
    expect(links[2]).toContain('href="/events?game=all"');
    expect(links[2]).toContain('aria-current="true"');
    expect(links[2]).toMatch(/>0<\/span>/);
    expect(links[3]).toContain('href="/events?game=other"');
    expect(links[3]).not.toContain("aria-current");
  } finally {
    renderer.cleanup();
  }
}, 120000);
