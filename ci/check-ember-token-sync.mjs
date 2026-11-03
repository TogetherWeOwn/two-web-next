// Exact generated adapters, independent of the tag-byte provenance check.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACTS, build } from "./build-ember-tokens.mjs";

export function check(root) {
  build(root, true);
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
