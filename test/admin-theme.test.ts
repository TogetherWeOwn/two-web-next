// Kit admin token register: the shared AdminShell links /admin-theme.css
// after the frozen Hono /styles.css, and the sheet stays token-bound and
// .kit-admin-scoped, so Hono keeps its light palette and public Kit routes
// never acquire the wrapper. The biome format-ignore pins the generated
// bytes: without it the formatter rewrites the minified public sheet and
// the build:assets drift check fails.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Top-level selectors of a minified sheet, with @media wrappers unwrapped. */
function selectors(css: string): string[] {
  const unwrapped = css.replace(/@media[^{]+\{/g, "{");
  return unwrapped
    .split("}")
    .map((chunk) => chunk.split("{")[0] ?? "")
    .map((selector) => selector.trim())
    .filter((selector) => selector && !selector.startsWith("@"));
}

describe("admin theme sheet", () => {
  it("is linked from AdminShell after the Hono sheet", () => {
    const shell = read("web/src/lib/AdminShell.svelte");
    const base = shell.indexOf('href="/styles.css"');
    const theme = shell.indexOf('href="/admin-theme.css"');
    expect(base).toBeGreaterThan(-1);
    expect(theme).toBeGreaterThan(base);
  });

  it("renders the generated alias wrapper so every token resolves", () => {
    // The sheet is served as a static file and never passes through
    // Tailwind, so the kit `@theme` variables (`--color-*`, `--space-*`,
    // ...) are pruned from the Kit bundle — an undefined `var()` makes
    // the winning declaration compute to `unset` and discards the Hono
    // value underneath. The `.base-theme` aliases are plain CSS in the
    // bundle, so the wrapper must carry that class, exactly as the
    // public Shell does. Deleting it must fail this test.
    const shell = read("web/src/lib/AdminShell.svelte");
    expect(shell).toContain('class="base-theme kit-admin"');
  });

  it("uses kit tokens, never hex literals", () => {
    const css = read("public/admin-theme.css");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toContain("var(--g1)");
    expect(css).toContain("var(--focus-ring,");
    expect(css).toContain("var(--font-data");
    expect(css).toContain("var(--space-1");
  });

  it("keeps the focused skip link legible on hover", () => {
    // The generic anchor hover also excludes .btn: with only .skip-link
    // excluded, the selector scores (0,3,1) and beats .btn:hover (0,3,0)
    // on <a class="btn">, painting --accent-hi text on the --accent-hi
    // button background. Editing the exclusion must fail here.
    const css = read("public/admin-theme.css");
    expect(css).toContain(":not(.skip-link,.btn):hover");
    expect(css).not.toContain(":not(.skip-link):hover");
    expect(css).toContain(".btn:hover");
  });

  it("loads the kit data font face so timestamps render Fragment Mono", () => {
    // The data-font variable alone does not render the kit face: admin
    // pages link /styles.css, /admin-rsvp-review.css and this sheet only,
    // never /theme.css which carries the Hono @font-face rules. Without
    // this rule timestamps fall back to the system monospace. Deleting
    // it must fail this test.
    const css = read("public/admin-theme.css");
    expect(css).toContain("@font-face{font-family:Fragment Mono");
    expect(css).toContain("/fonts/fragment-mono-latin-400.woff2");
    expect(css).toContain('var(--font-data, "Fragment Mono", ui-monospace, monospace)');
  });

  it("clears the browser chrome on button-styled buttons", () => {
    // The frozen /styles.css `.btn` never resets border/font on <button>,
    // so Save/Publish/Search/Create kept a bevelled UA outline and a
    // small UA font while anchor .btn beside them did not. Clearing both
    // makes the two primary actions render as one rank. Deleting either
    // declaration must fail this test.
    const css = read("public/admin-theme.css");
    expect(css).toMatch(/\.kit-admin \.btn\{[^}]*border:0[^}]*font:inherit/);
  });

  it("keeps checkboxes and radios under their labels", () => {
    // The frozen `.field input { width: 100% }` stretched the Published
    // checkbox across the whole 34rem row, floating it far from its
    // label. The override is width-only: label/control order is untouched.
    const css = read("public/admin-theme.css");
    expect(css).toMatch(
      /\.kit-admin \.field :is\(input\[type=checkbox\],input\[type=radio\]\)\{width:auto\}/,
    );
  });

  it("renders every timestamp in the kit data font", () => {
    // The preview check time ("checked at ... (UTC)") is a bare <time>
    // outside the tables, so a table-scoped `time` selector missed it.
    // The data-font rule now matches `.kit-admin time` wholesale.
    const css = read("public/admin-theme.css");
    expect(css).toMatch(/\.kit-admin time\{font-family:/);
  });

  it("scopes every rule under .kit-admin", () => {
    const css = read("public/admin-theme.css");
    const found = selectors(css);
    expect(found.length).toBeGreaterThan(20);
    for (const selector of found) {
      expect(selector.startsWith(".kit-admin"), `unscoped selector: ${selector}`).toBe(true);
    }
  });

  it("keeps the generated bytes out of the formatter", () => {
    const biome = read("biome.json");
    expect(biome).toContain("public/admin-theme.css");
    expect(biome).toContain("assets/admin-theme.css");
  });
});
