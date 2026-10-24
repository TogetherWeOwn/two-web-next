import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("dashboard diagnostic review regressions", () => {
  it("pins the Kit outcome-link focus selector to the visible foreground outline rule", () => {
    const page = read("../web/src/routes/admin/+page.svelte");
    const style = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? "";
    const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const linkFocusRule = rules.find((rule) =>
      rule[1]!.split(",").some((selector) => selector.trim() === ".admin-table a:focus-visible"),
    );
    // A scroll-region selector or currentColor in an unrelated rule cannot
    // protect the new links from the shared sheet's dark default outline.
    expect(linkFocusRule).toBeDefined();
    expect(linkFocusRule?.[2]).toMatch(/\boutline-color\s*:\s*currentColor\s*;/);
  });

  it("troubleshoots visible unavailable diagnostics rather than omitted sections", () => {
    const guide = read("../docs/moderator-admin-guide.md");
    const row = /^\| Dashboard[^\n]+$/m.exec(guide)?.[0] ?? "";
    expect(row).toContain("unavailable for this load");
    expect(row).toContain("Both headings stay visible");
    expect(row).toContain("not zero or a successful empty result");
    expect(row).toContain("other section can still show its result");
    expect(row).toContain("1.5 s budget");
    expect(row).toContain("time with timezone");
    expect(row).toContain("signed-session 503 or missing database configuration");
    expect(row).toContain("panel itself is unavailable");
    expect(row).not.toMatch(/missing on|omits? (?:its |the )?section/);
  });
});
