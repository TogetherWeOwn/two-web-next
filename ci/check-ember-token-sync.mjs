// Exact generated adapters, independent of the tag-byte provenance check.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACTS, ROOT, build, parseKit } from "./build-ember-tokens.mjs";

export const CHROME_CONSUMERS = [
  "src/page-shell.tsx",
  "web/src/app.html",
  "public/site.webmanifest",
];

export function check(root = ROOT) {
  build(root, true);
  const kit = parseKit(readFileSync(join(root, "vendor/design-kit/tokens.css"), "utf8"));
  const ground = kit.base.get("--two-color-ground-0");
  for (const path of CHROME_CONSUMERS) {
    const source = readFileSync(join(root, path), "utf8");
    const values = path.endsWith(".webmanifest")
      ? [JSON.parse(source).background_color, JSON.parse(source).theme_color]
      : [...source.matchAll(/<meta\s+name="theme-color"\s+content="([^"]+)"\s*\/?\s*>/g)].map(
          (match) => match[1],
        );
    const count = path.endsWith(".webmanifest") ? 2 : 1;
    if (values.length !== count || values.some((value) => value !== ground))
      throw new Error(`browser chrome token drift: ${path}`);
  }
  return { ok: true, summary: `ember token sync ok (${ARTIFACTS.length} generated adapters)` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--selftest")) {
    console.error("usage: node ci/check-ember-token-sync.mjs [--selftest]");
    process.exitCode = 2;
  } else {
    try {
      const result = check();
      if (args[0] === "--selftest") {
        result.mode = "selftest";
        result.summary = result.summary.replace("sync ok", "sync selftest ok");
      }
      console.error(result.summary);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      process.exitCode = 1;
    }
  }
}
