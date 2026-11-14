import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => {
    js: { code: string };
  };
};

it("renders decorative presence dots and each tag variant with visible text", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-tag-dot-"));
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "bundle.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import Fixture from ${JSON.stringify(join(root, "test/fixtures/kit-tag-dot.svelte"))};
export const body = render(Fixture).body;`,
    );
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      plugins: [
        {
          name: "tag-dot-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
              contents: compile(readFileSync(args.path, "utf8"), {
                generate: "server",
                dev: false,
                filename: args.path,
              }).js.code,
              loader: "js",
              resolveDir: dirname(args.path),
            }));
          },
        },
      ],
    });
    const { body } = (await import(pathToFileURL(outfile).href)) as { body: string };
    const spans = Array.from(body.matchAll(/<span\b[^>]*>/g), (match) => match[0]);
    const hasClass = (span: string | undefined, name: string) =>
      (span?.match(/\bclass="([^"]*)"/)?.[1] ?? "").split(/\s+/).includes(name);
    const dots = spans.filter((span) => hasClass(span, "live-dot"));
    expect(dots).toHaveLength(2);
    expect(dots.every((dot) => dot.includes('aria-hidden="true"'))).toBe(true);
    expect(hasClass(dots[0], "presence")).toBe(false);
    expect(hasClass(dots[1], "presence")).toBe(true);
    const tags = spans.filter((span) => hasClass(span, "tag"));
    expect(tags).toHaveLength(7);
    for (const [index, variant] of ["live", "you", "echo", "echo", "ok", "warn"].entries()) {
      expect(hasClass(tags[index + 1], variant)).toBe(true);
    }
    for (const label of ["Neutral", "Live", "You", "Echo", "OK", "Warning"]) {
      expect(body).toContain(label);
    }
    const tagDots = spans.filter((span) => hasClass(span, "dot"));
    expect(tagDots).toHaveLength(3);
    expect(tagDots.every((dot) => dot.includes('aria-hidden="true"'))).toBe(true);
    for (const label of ["Echo", "Echo explicitly without dot"]) {
      expect(body).toMatch(
        new RegExp(
          `<span\\b[^>]*class="[^"]*\\becho\\b[^"]*"[^>]*>(?:\\s|<!--[\\s\\S]*?-->)*<span\\b[^>]*class="[^"]*\\bdot\\b[^"]*"[^>]*></span>(?:\\s|<!--[\\s\\S]*?-->)*${label}(?:\\s|<!--[\\s\\S]*?-->)*</span>`,
        ),
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
