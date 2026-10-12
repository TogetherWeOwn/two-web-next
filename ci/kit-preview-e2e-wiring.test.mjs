import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = workflow.split("\n  check:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";

test("the Kit parity job installs Chromium before launching its browser fixture", () => {
  const install = job.indexOf("npx playwright install --with-deps chromium");
  const parity = job.indexOf("node ci/kit-preview-e2e.mjs");

  assert(install >= 0, "check job must install Chromium");
  assert(parity >= 0, "check job must run Kit parity");
  assert(install < parity, "Chromium must be installed before Kit parity runs");
  assert.match(
    job.slice(0, install),
    /name: Cache Kit parity Chromium[\s\S]*?path: ~\/\.cache\/ms-playwright/,
  );
});
