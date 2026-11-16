import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKitSsrRenderer } from "./helpers/kit-ssr-render";

let html: string;
let cleanup: () => void;

beforeAll(async () => {
  const renderer = await createKitSsrRenderer("test/fixtures/kit-footer.svelte");
  cleanup = renderer.cleanup;
  html = renderer.renderPage({});
});

afterAll(() => cleanup?.());

describe("Ember footer", () => {
  it("renders the community description and labelled footer navigation", () => {
    expect(html).toMatch(/<footer\b/);
    expect(html).toContain("Together We Own · adult gaming community · founded");
    expect(html).toContain("1998");
    expect(html).toMatch(/<nav\b[^>]*aria-label="Footer"/);
    for (const [path, label] of [
      ["/about", "About"],
      ["/faq", "FAQ"],
      ["/rules", "House rules"],
      ["/privacy", "Privacy"],
    ]) {
      expect(html).toContain(`href="${path}"`);
      expect(html).toContain(`>${label}</a>`);
    }
  });
});
