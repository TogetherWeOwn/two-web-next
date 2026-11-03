import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "ci/check-design-kit-drift.mjs");

test("design-kit drift selftest passes on the vendored pin", () => {
  const out = execFileSync("node", [SCRIPT, "--selftest"], { encoding: "utf8" });
  const last = out.trim().split("\n").at(-1);
  assert.deepEqual(JSON.parse(last), {
    ok: true,
    tag: readFileSync(join(ROOT, "vendor/design-kit/VERSION"), "utf8").trim(),
    mode: "selftest",
  });
});

test("required CI checks kit provenance and adapters after installing dependencies", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const job = workflow.split("\n  check:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
  const step =
    job.split("      - name: Design-kit provenance and adapter drift\n")[1]?.split("      - ")[0] ??
    "";
  assert.match(
    step,
    /if: \(needs\.scope\.outputs\.docs_only != 'true' && needs\.scope\.outputs\.draft != 'true'\)/,
  );
  assert.ok(
    step.includes(
      "run: npm run check:design-kit-drift:selftest && npm run check:design-kit-drift && npm run check:ember-sync:selftest && npm run check:ember-sync",
    ),
  );
  assert.ok(
    job.indexOf("run: npm ci --no-audit --no-fund") <
      job.indexOf("- name: Design-kit provenance and adapter drift"),
  );
});

test("vendored kit outputs carry the generated headers", () => {
  assert.ok(
    readFileSync(join(ROOT, "vendor/design-kit/tokens.css"), "utf8").startsWith("/* DO NOT EDIT"),
  );
  assert.ok(
    readFileSync(join(ROOT, "vendor/design-kit/tokens.ts"), "utf8").startsWith("// DO NOT EDIT"),
  );
});
