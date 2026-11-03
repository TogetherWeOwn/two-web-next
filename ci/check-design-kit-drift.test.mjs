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

test("vendored kit outputs carry the generated headers", () => {
  assert.ok(
    readFileSync(join(ROOT, "vendor/design-kit/tokens.css"), "utf8").startsWith("/* DO NOT EDIT"),
  );
  assert.ok(
    readFileSync(join(ROOT, "vendor/design-kit/tokens.ts"), "utf8").startsWith("// DO NOT EDIT"),
  );
});
