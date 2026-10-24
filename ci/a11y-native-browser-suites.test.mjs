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
    file: "test/member-profile-native-422-baseline.test.ts",
    env: "A11Y_BROWSER_TESTS",
    title: "native 422 baseline in a real browser",
    min: 4,
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
    file: "test/calendar-game-subscription-acceptance.test.ts",
    env: "CALENDAR_GAME_SUBSCRIPTION_BROWSER_TESTS",
    title: "game subscription follows the committed schedule",
    min: 16,
  },
  {
    file: "ci/audit-lifecycle.test.mjs",
    env: "A11Y_BROWSER_TESTS",
    title: "audit lifecycle real Chromium signal cleanup",
    min: 2,
  },
  {
    file: "test/kit-error-shell-render.test.ts",
    env: "KIT_ERROR_SHELL_BROWSER_TESTS",
    title: "Kit error shell rendered accessibility",
    min: 6,
    childSuites: [
      {
        title: "admin failed-read retry: native keyboard/no-JS recovery",
        min: 12,
        registrarFile: "test/helpers/admin-read-retry-browser-acceptance.ts",
        registrar: "registerAdminReadRetryBrowserAcceptance",
      },
    ],
  },
  {
    file: "test/profile-device-timezone.test.ts",
    env: "PROFILE_DEVICE_TIMEZONE_BROWSER_TESTS",
    title: "profile device timezone in Chromium",
    min: 49,
  },
  {
    file: "test/admin-editor-expiry-departure.test.ts",
    env: "ADMIN_EDITOR_EXPIRY_BROWSER_TESTS",
    title: "admin editor expiry departure in Chromium",
    min: 4,
  },
  {
    file: "test/event-device-timezone.test.ts",
    env: "A11Y_BROWSER_TESTS",
    title: "event device timezone browser acceptance",
    min: 30,
  },
  {
    file: "test/event-device-timezone-ends.test.ts",
    env: "A11Y_BROWSER_TESTS",
    title: "event device timezone ends browser acceptance",
    min: 30,
  },
  {
    file: "test/profile-local-time-comparison-acceptance.test.ts",
    env: "A11Y_BROWSER_TESTS",
    title: "profile local time comparison in Chromium",
    min: 72,
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
    const verifierLine = (title, min) =>
      `\\n          node ci/a11y-require-executed\\.mjs ${escape(artifact)} "${escape(title)}" ${min}`;
    const childSuites = suite.childSuites ?? [];
    assert.match(
      step,
      new RegExp(
        verifierLine(suite.title, suite.min) +
          childSuites.map((child) => verifierLine(child.title, child.min)).join("") +
          "\\s*$",
      ),
    );
    assert.doesNotMatch(step, /^\s*(?:- )?(?:if|continue-on-error):/m);
    assert(chromiumInstall >= 0, "a11y job must install Chromium");
    assert(chromiumInstall < job.indexOf(step));

    const source = await readFile(new URL(`../${suite.file}`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`skipIf\\(process\\.env\\.${suite.env} !== "true"\\)`));
    assert.match(source, new RegExp(`"${escape(suite.title)}"`));
    for (const child of childSuites) {
      const registrarSource = await readFile(
        new URL(`../${child.registrarFile}`, import.meta.url),
        "utf8",
      );
      assert.match(registrarSource, new RegExp(`"${escape(child.title)}"`));
      assert.match(source, new RegExp(`\\b${escape(child.registrar)}\\(`));
    }
  });
}

const RSVP_FILE = "ci/rsvp-focus-browser.test.mjs";
const RSVP_ENV = "RSVP_FOCUS_BROWSER_TESTS";
const RSVP_SUITE = "RSVP outcome focus in Chromium";
const RSVP_MIN = 16;
const RSVP_CASES = [
  "keeps keyboard focus on the field the member tabbed to while the write is pending",
  "moves focus to the confirmation when the member stays on the control",
  "keeps focus off the confirmation after a pointer press outside the widget",
  "focuses the unknown-outcome notice when the write times out with focus held",
  "keeps focus on the outside field when the write times out after tabbing away",
  "focuses the session-expired notice on a deferred 401 when focus stays",
  "keeps focus on the outside field when a deferred 401 arrives after moving away",
];

test("a11y job runs ci/rsvp-focus-browser.test.mjs with its opt-in after Chromium install", async () => {
  const step = steps.find((entry) => entry.includes(RSVP_FILE) && entry.includes("node --test"));
  assert(step, `a11y job must run ${RSVP_FILE}`);
  assert.match(
    step,
    new RegExp(
      `\\n          ${RSVP_ENV}=true node --test --test-reporter=tap --test-reporter-destination=artifacts/a11y/rsvp-focus\\.tap ${escape(RSVP_FILE)}\\n`,
    ),
    "the RSVP step must run the Chromium gate with its TAP report",
  );
  assert.match(
    step,
    new RegExp(
      `\\n          node ci/rsvp-focus-require-executed\\.mjs artifacts/a11y/rsvp-focus\\.tap "${escape(RSVP_SUITE)}" ${RSVP_MIN}\\s*$`,
    ),
    "the RSVP step must fail an all-skipped run via the executed-count verifier",
  );
  assert.doesNotMatch(step, /^\s*(?:- )?(?:if|continue-on-error):/m);
  assert.doesNotMatch(step, new RegExp(`${RSVP_ENV}=(?!true)`));
  assert(chromiumInstall >= 0, "a11y job must install Chromium");
  assert(chromiumInstall < job.indexOf(step), "Chromium install must precede the RSVP step");

  const source = await readFile(new URL(`../${RSVP_FILE}`, import.meta.url), "utf8");
  assert.match(source, new RegExp(`process\\.env\\.${RSVP_ENV} !== "true"`));
  for (const title of RSVP_CASES)
    assert.match(source, new RegExp(`^\\s+it\\("${escape(title)}"`, "m"), title);

  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const row = readme.split("\n").find((line) => line.startsWith(`| \`${RSVP_FILE}\` |`));
  assert.match(row ?? "", /rsvp-focus-require-executed\.mjs/);
  assert.doesNotMatch(row ?? "", /no executed-count verifier yet/);
});

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
