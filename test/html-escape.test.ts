// Pinned contract for src/html-escape.ts: Hono-identical text escaping for
// the Kit views that must match Hono JSX bytes (Svelte interpolation leaves
// `>` raw, Hono escapes it). Pure unit tests, no database.
import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/html-escape";

describe("escapeHtml", () => {
  it("escapes the Hono five without touching anything else", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      `&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;`,
    );
    expect(escapeHtml(`Fish & 'chips' > mush`)).toBe(`Fish &amp; &#39;chips&#39; &gt; mush`);
    expect(escapeHtml(`Beta Hall — Room 2`)).toBe(`Beta Hall — Room 2`);
    expect(escapeHtml(``)).toBe(``);
  });

  it("escapes ampersands first so entities never double-encode", () => {
    expect(escapeHtml(`&lt;already&gt;`)).toBe(`&amp;lt;already&amp;gt;`);
  });

  it("leaves no markup-opening characters for {@html} renders", () => {
    for (const hostile of [
      `<script>alert("x")</script>`,
      `"><img src=x onerror=alert(1)>`,
      `{{constructor}}`,
    ]) {
      const out = escapeHtml(hostile);
      expect(out).not.toContain(`<`);
      expect(out).not.toContain(`>`);
      expect(out).not.toContain(`"`);
    }
  });
});
