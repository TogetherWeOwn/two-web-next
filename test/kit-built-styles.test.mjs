import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { builtNodeStyles } from "../e2e/kit-built-styles.mjs";

const scratch = [];
function nodeFile(source) {
  const dir = mkdtempSync(join(tmpdir(), "kit-built-styles-"));
  scratch.push(dir);
  const path = join(dir, "0.mjs");
  writeFileSync(path, source);
  return path;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("reads actual stylesheet metadata without executing Workers-only server imports", async () => {
  const path = nodeFile(`
import { env } from "cloudflare:workers";
throw new Error("server code must not run in a CSS-only fixture");
export const stylesheets = ["_app/immutable/assets/0.hash.css", "_app/immutable/assets/shared.hash.css"];
`);
  await expect(builtNodeStyles(path)).resolves.toEqual([
    "_app/immutable/assets/0.hash.css",
    "_app/immutable/assets/shared.hash.css",
  ]);
});

it.each([
  "export const stylesheets = [];",
  "export const stylesheets = [42];",
  "export const stylesheets = [getStylesheet()];",
  'export const stylesheets = ["../../private.css"];',
  "export const component = {};",
])("fails closed instead of silently running an unstyled fixture: %s", async (source) => {
  await expect(builtNodeStyles(nodeFile(source))).rejects.toThrow();
});
