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
];

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = workflow.split("\n  a11y:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
const steps = job.split(/\n(?=      - )/);
const stepRunning = (file) => steps.find((step) => step.includes(`npx vitest run ${file} `));

for (const suite of SUITES) {
  test(`a11y job runs ${suite.file} with its opt-in, a JSON report and the executed-count verifier`, async () => {
    const step = stepRunning(suite.file);
    assert(step, `a11y job must run ${suite.file}`);
    const artifact = `artifacts/a11y/${basename(suite.file, ".test.ts")}.json`;
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
    assert.doesNotMatch(step, /continue-on-error:|\n        if:/);
    assert(job.indexOf("npx playwright install --with-deps chromium") < job.indexOf(step));

    const source = await readFile(new URL(`../${suite.file}`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`skipIf\\(process\\.env\\.${suite.env} !== "true"\\)`));
    assert.match(source, new RegExp(`"${escape(suite.title)}"`));
  });
}

async function browserGatedSuites() {
  const found = [];
  for (const dir of ["test", "ci"]) {
    for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url), {
      recursive: true,
    })) {
      const file = `${dir}/${entry}`;
      if (
        [".ts", ".mjs"].includes(extname(entry)) &&
        basename(entry) !== basename(import.meta.filename)
      ) {
        const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
        for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+) !== "true"/g))
          found.push({ file, env: match[1] });
      }
    }
  }
  return found;
}

test("the README Browser regressions section lists every browser-gated suite", async () => {
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
    assert(section.includes(file), `README must list ${file}`);
    assert(section.includes(env), `README must name ${env}`);
  }
});
