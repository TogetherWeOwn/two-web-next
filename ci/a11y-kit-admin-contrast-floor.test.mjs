// Pins the executed-case floor for ci/kit-admin-contrast.test.mjs to the cases
// the suite declares, so lowering the floor in ci.yml (or dropping cases while
// leaving the floor stale) fails without a Kit build or Chromium.
// The check job's ci/a11y-*.test.mjs glob runs this file.
// Run: node --test ci/a11y-kit-admin-contrast-floor.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const SUITE = "Kit admin contrast";
const SUITE_FILE = "ci/kit-admin-contrast.test.mjs";

test("Kit admin contrast floor matches every declared case", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const floors = [
    ...workflow.matchAll(
      /\n {10}node ci\/rsvp-focus-require-executed\.mjs artifacts\/kit-admin-contrast\/report\.tap "Kit admin contrast" (\d+)\n/g,
    ),
  ];
  assert.equal(floors.length, 1, "ci.yml must verify the Kit admin contrast TAP exactly once");
  const floor = Number(floors[0][1]);

  const source = await readFile(new URL(`../${SUITE_FILE}`, import.meta.url), "utf8");
  assert(source.includes(`describe("${SUITE}"`), "the suite must keep its verifier title");
  const loop = source.match(
    /for \(const width of \[([^\]]+)\]\) \{\n\s+for \(const name of \[([^\]]+)\]\) \{\n\s+test\(`Kit admin contrast: \$\{name\} at \$\{width\}`/,
  );
  assert(loop, "the suite must keep its width × fixture loop");
  const widths = loop[1].split(",").map((width) => width.trim());
  const names = [...loop[2].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(widths, ["1280", "390"], "the loop must cover desktop and mobile");
  assert.equal(new Set(names).size, names.length, "fixture names must be unique");
  // Every node:test call, whatever its title syntax or indentation; `.test(` is
  // RegExp#test. The width × fixture loop accounts for exactly one call.
  const calls = (source.match(/(?<![.\w])test(?:\.\w+)?\(/g) ?? []).length;
  const singles = calls - 1;

  assert.equal(
    floor,
    widths.length * names.length + singles,
    `the floor must equal ${widths.length} widths × ${names.length} fixtures + ${singles} single cases`,
  );
});
