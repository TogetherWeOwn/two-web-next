import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, extname } from "node:path";
import { test } from "node:test";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const SUITES = [
  {
    file: "test/profile-native-length.test.ts",
    env: "A11Y_BROWSER_TESTS",
    title: "native browser submission and real island binder",
    min: 15,
  },
  {
    file: "test/featured-native-length.test.ts",
    env: "FEATURED_NATIVE_BROWSER_TESTS",
    title: "native featured headline and image description",
    min: 36,
  },
  {
    file: "test/calendar-search-unicode-boundaries.test.ts",
    env: "CALENDAR_SEARCH_BROWSER_TESTS",
    title: "native calendar search input (real Chromium typing/paste)",
    min: 21,
  },
  {
    file: "ci/a11y-lifecycle.test.mjs",
    env: "A11Y_BROWSER_TESTS",
    title: "audit lifecycle real Chromium signal cleanup",
    min: 2,
  },
];

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = workflow.split("\n  a11y:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
const steps = job.split(/\n(?=      - )/);
const stepRunning = (file) => steps.find((step) => step.includes(`npx vitest run ${file} `));
const chromiumInstall = job.indexOf("npx playwright install --with-deps chromium");

test("the a11y job does not bypass its steps at job level", () => {
  assert.doesNotMatch(job, /^    continue-on-error:/m);
});

for (const suite of SUITES) {
  test(`a11y job runs ${suite.file} with its opt-in, a JSON report and the executed-count verifier`, async () => {
    const step = stepRunning(suite.file);
    assert(step, `a11y job must run ${suite.file}`);
    const artifact = `artifacts/a11y/${basename(suite.file).replace(/\.test\.(ts|mjs)$/, "")}.json`;
    assert.match(step, new RegExp(`\\n        env:\\n          ${suite.env}: "true"\\n`));
    assert.match(
      step,
      new RegExp(
        `\\n          npx vitest run ${escape(suite.file)} --reporter=default --reporter=json --outputFile\\.json=${escape(artifact)}\\n`,
      ),
    );
    assert.match(
      step,
      new RegExp(
        `\\n          node ci/a11y-require-executed\\.mjs ${escape(artifact)} "${escape(suite.title)}" ${suite.min}\\s*$`,
      ),
    );
    assert.doesNotMatch(step, /^\s*(?:- )?(?:if|continue-on-error):/m);
    assert(chromiumInstall >= 0, "a11y job must install Chromium");
    assert(chromiumInstall < job.indexOf(step));

    const source = await readFile(new URL(`../${suite.file}`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`skipIf\\(process\\.env\\.${suite.env} !== "true"\\)`));
    assert.match(source, new RegExp(`"${escape(suite.title)}"`));
  });
}

// Every browser gate is named *_BROWSER_TESTS, so the scan keys on that name.
async function browserGatedSuites() {
  const found = [];
  for (const dir of ["test", "ci"]) {
    for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url), {
      recursive: true,
    })) {
      if (![".ts", ".mjs"].includes(extname(entry))) continue;
      if (basename(entry) === basename(import.meta.filename)) continue;
      const file = `${dir}/${entry}`;
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      for (const [, env] of source.matchAll(/process\.env\.([A-Z0-9_]*_BROWSER_TESTS)\b/g))
        found.push({ file, env });
    }
  }
  return found;
}

test("the README Browser regressions table lists every browser-gated suite", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.split("\n### Browser regressions\n")[1]?.split(/\n#{2,3} /)[0] ?? "";
  assert(section, "README must keep the Browser regressions section");
  const gated = await browserGatedSuites();
  for (const suite of SUITES)
    assert(
      gated.some(({ file }) => file === suite.file),
      suite.file,
    );
  for (const { file, env } of gated) {
    const row = new RegExp(`^\\|\\s*\`${escape(file)}\`\\s*\\|\\s*\`${env}\``, "m");
    assert.match(section, row, `README table must list ${file} with ${env}`);
  }
});
