// Single registry of every browser suite the a11y job must really execute.
// SUITES is the source of truth: each entry pins one workflow step (opt-in
// env or unconditional config, JSON report, executed-count verifier with its
// exact title and minimum), and the reverse scan at the bottom fails when a
// *_BROWSER_TESTS-gated file or a ci/*-browser.vitest.ts config exists
// without an entry (or a named bespoke exception). Run this file directly:
// node --test ci/a11y-native-browser-suites.test.mjs
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
    file: "test/profile-composition-browser.test.ts",
    env: "A11Y_BROWSER_TESTS",
    title: "composition feedback in a real browser",
    min: 6,
  },
  {
    file: "test/profile-refused-draft-recovery-acceptance.test.ts",
    env: "A11Y_BROWSER_TESTS",
    title: "refused-draft recovery in a real browser",
    min: 2,
  },
  {
    file: "test/admin-event-native-unicode.test.ts",
    env: "ADMIN_EVENT_BROWSER_TESTS",
    title: "native admin event text limits",
    min: 48,
    artifact: "artifacts/a11y/admin-native-unicode.json",
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
  {
    file: "test/profile-local-time-save.test.ts",
    env: "A11Y_BROWSER_TESTS",
    title: "profile local time after save in Chromium",
    min: 40,
  },
  {
    file: "test/event-chosen-timezone.test.ts",
    env: "A11Y_BROWSER_TESTS",
    title: "event chosen timezone browser acceptance",
    min: 30,
  },
  // Unconditional suites (env: null) run through their own Vitest config, so
  // they carry no opt-in to skip. Their describes expand from a template, so
  // sourceTitle pins the template while verifiers record every expanded
  // exact title with its minimum. Where the workflow verifies through a
  // shell loop, verifierLoops and titleTemplate rebuild that trailer and
  // must expand to exactly the recorded verifiers.
  {
    file: "ci/schedule-search-context-browser.test.ts",
    config: "ci/schedule-search-context-browser.vitest.ts",
    env: null,
    artifact: "artifacts/a11y/schedule-search-context.json",
    sourceTitle: "${twin} schedule committed match context in Chromium",
    verifiers: [
      { title: "Hono schedule committed match context in Chromium", min: 5 },
      { title: "Kit schedule committed match context in Chromium", min: 5 },
    ],
  },
  {
    file: "ci/calendar-subscription-browser.test.ts",
    config: "ci/calendar-subscription-browser.vitest.ts",
    env: null,
    artifact: "artifacts/a11y/calendar-subscription.json",
    sourceTitle: "%s real-browser subscription acceptance",
    verifiers: [
      { title: "hono-calendar real-browser subscription acceptance", min: 10 },
      { title: "hono-archive real-browser subscription acceptance", min: 10 },
      { title: "kit-calendar real-browser subscription acceptance", min: 10 },
      { title: "kit-archive real-browser subscription acceptance", min: 10 },
    ],
    titleTemplate: "$surface real-browser subscription acceptance",
    verifierLoops: [
      { name: "surface", values: ["hono-calendar", "hono-archive", "kit-calendar", "kit-archive"] },
    ],
  },
  {
    file: "ci/calendar-game-recovery-browser.test.ts",
    config: "ci/calendar-game-recovery-browser.vitest.ts",
    env: null,
    artifact: "artifacts/a11y/calendar-game-recovery.json",
    sourceTitle: "${twin} ${bundle} real game recovery",
    verifiers: [
      { title: "Hono source real game recovery", min: 14 },
      { title: "Hono shipped real game recovery", min: 14 },
      { title: "Kit source real game recovery", min: 14 },
      { title: "Kit shipped real game recovery", min: 14 },
    ],
    titleTemplate: "$surface $bundle real game recovery",
    verifierLoops: [
      { name: "surface", values: ["Hono", "Kit"] },
      { name: "bundle", values: ["source", "shipped"] },
    ],
  },
];

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = workflow.split("\n  a11y:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
const steps = job.split(/\n(?=      - )/);
const runCommand = (suite) =>
  suite.config
    ? `npx vitest run --config ${suite.config} ${suite.file} `
    : `npx vitest run ${suite.file} `;
const stepRunning = (suite) => steps.find((step) => step.includes(runCommand(suite)));
const chromiumInstall = job.indexOf("npx playwright install --with-deps chromium");
const kitDepsInstall = job.indexOf("npm ci --prefix web --include=dev");

test("the a11y job does not bypass its steps at job level", () => {
  assert.doesNotMatch(job, /^    continue-on-error:/m);
});

for (const suite of SUITES) {
  const posture = suite.env ? "with its opt-in" : "unconditionally";
  test(`a11y job runs ${suite.file} ${posture}, with a JSON report and the executed-count verifier`, async () => {
    const step = stepRunning(suite);
    assert(step, `a11y job must run ${suite.file}`);
    const artifact =
      suite.artifact ??
      `artifacts/a11y/${basename(suite.file).replace(/\.test\.(ts|mjs)$/, "")}.json`;
    if (suite.env) {
      assert.match(step, new RegExp(`\\n        env:\\n          ${suite.env}: "true"\\n`));
    } else {
      assert.doesNotMatch(
        step,
        /\n        env:\n/,
        `${suite.file} is unconditional and must not gain an opt-in env`,
      );
    }
    assert.match(
      step,
      new RegExp(
        `\\n          ${escape(runCommand(suite).trimEnd())} --reporter=default --reporter=json --outputFile\\.json=${escape(artifact)}\\n`,
      ),
    );
    const verifierLine = (title, min) =>
      `\\n          node ci/a11y-require-executed\\.mjs ${escape(artifact)} "${escape(title)}" ${min}`;
    const childSuites = suite.childSuites ?? [];
    if (suite.verifierLoops) {
      const mins = new Set(suite.verifiers.map((verifier) => verifier.min));
      assert.equal(mins.size, 1, `${suite.file} loop verifiers must share one minimum`);
      let expanded = [suite.titleTemplate];
      for (const loop of suite.verifierLoops)
        expanded = expanded.flatMap((title) =>
          loop.values.map((value) => title.replaceAll(`$${loop.name}`, value)),
        );
      assert.deepEqual(
        expanded,
        suite.verifiers.map((verifier) => verifier.title),
        `${suite.file} verifier loops must expand to its recorded titles`,
      );
      const block = suite.verifierLoops.map(
        (loop, depth) => `${"  ".repeat(depth)}for ${loop.name} in ${loop.values.join(" ")}; do`,
      );
      block.push(
        `${"  ".repeat(suite.verifierLoops.length)}node ci/a11y-require-executed.mjs ${artifact} "${suite.titleTemplate}" ${suite.verifiers[0].min}`,
      );
      for (let depth = suite.verifierLoops.length - 1; depth >= 0; depth--)
        block.push(`${"  ".repeat(depth)}done`);
      assert.match(
        step,
        new RegExp(
          "\\n          " + block.map((line) => escape(line)).join("\\n          ") + "\\s*$",
        ),
        `${suite.file} step must end with its exact verifier loop`,
      );
    } else {
      const explicitVerifiers = suite.verifiers ?? [
        { title: suite.title, min: suite.min },
        ...childSuites.map((child) => ({ title: child.title, min: child.min })),
      ];
      assert.match(
        step,
        new RegExp(
          explicitVerifiers.map(({ title, min }) => verifierLine(title, min)).join("") + "\\s*$",
        ),
      );
    }
    assert.doesNotMatch(step, /^\s*(?:- )?(?:if|continue-on-error):/m);
    assert(chromiumInstall >= 0, "a11y job must install Chromium");
    assert(chromiumInstall < job.indexOf(step));
    if (suite.config) {
      assert(
        kitDepsInstall >= 0 && kitDepsInstall < job.indexOf(step),
        `Kit install must precede the ${suite.file} step`,
      );
      const configSource = await readFile(new URL(`../${suite.config}`, import.meta.url), "utf8");
      assert.match(configSource, new RegExp(`include: \\["${escape(suite.file)}"\\]`));
    }

    const source = await readFile(new URL(`../${suite.file}`, import.meta.url), "utf8");
    if (suite.env) {
      assert.match(source, new RegExp(`skipIf\\(process\\.env\\.${suite.env} !== "true"\\)`));
    } else {
      assert.doesNotMatch(
        source,
        /_BROWSER_TESTS/,
        `${suite.file} is unconditional and must not gain an opt-out gate`,
      );
    }
    if (suite.sourceTitle) {
      assert(source.includes(suite.sourceTitle), `${suite.file} must keep its suite template`);
    } else {
      assert.match(source, new RegExp(`"${escape(suite.title)}"`));
    }
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
      `\\n          ${RSVP_ENV}=true node --test --test-reporter=tap --test-reporter-destination=artifacts/a11y/rsvp-focus\\.tap --test-reporter=spec --test-reporter-destination=stdout ${escape(RSVP_FILE)}\\n`,
    ),
    "the RSVP step must run the Chromium gate with readable spec stdout beside its TAP report",
  );
  // Spec stdout is additive evidence: the TAP file still feeds the verifier
  // below, the gate runs exactly once, and its exit status must not be
  // hidden behind a pipe, tee, redirection or fallback.
  const rsvpRun =
    step.split("\n").find((line) => line.includes(RSVP_FILE) && line.includes("node --test")) ?? "";
  assert.equal(
    (step.match(new RegExp(`node --test .*${escape(RSVP_FILE)}`, "g")) ?? []).length,
    1,
    "the RSVP browser gate must run exactly once",
  );
  assert.equal(
    (
      step.match(
        /--test-reporter=tap --test-reporter-destination=artifacts\/a11y\/rsvp-focus\.tap/g,
      ) ?? []
    ).length,
    1,
    "the RSVP step must keep exactly one TAP reporter bound to its artifact",
  );
  assert.equal(
    (step.match(/--test-reporter=spec --test-reporter-destination=stdout/g) ?? []).length,
    1,
    "the RSVP step must bind exactly one spec reporter to stdout",
  );
  assert.doesNotMatch(
    rsvpRun,
    /\||\btee\b|>>?\s|&&|;/,
    "the RSVP step must not pipe, tee, redirect or chain the test command",
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

  const uploadStep = steps.find(
    (entry) =>
      entry.includes("actions/upload-artifact@") && entry.includes("path: artifacts/a11y/"),
  );
  assert(uploadStep, "a11y job must upload artifacts/a11y/ so the RSVP TAP evidence survives");
  assert.match(
    uploadStep,
    /\n        if: always\(\)\n/,
    "the a11y evidence upload must always run",
  );
  assert.match(
    uploadStep,
    /\n          if-no-files-found: error\n/,
    "missing a11y evidence must fail the upload",
  );
  assert.match(
    uploadStep,
    /\n          retention-days: 14\n/,
    "the a11y evidence upload must keep 14-day retention",
  );

  const source = await readFile(new URL(`../${RSVP_FILE}`, import.meta.url), "utf8");
  assert.match(source, new RegExp(`process\\.env\\.${RSVP_ENV} !== "true"`));
  for (const title of RSVP_CASES)
    assert.match(source, new RegExp(`^\\s+it\\("${escape(title)}"`, "m"), title);

  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const row = readme.split("\n").find((line) => line.startsWith(`| \`${RSVP_FILE}\` |`));
  assert.match(row ?? "", /rsvp-focus-require-executed\.mjs/);
  assert.doesNotMatch(row ?? "", /no executed-count verifier yet/);
});

const SHARE_FILE = "ci/event-native-share-browser.test.mjs";
const SHARE_SUITE = "Native event sharing";
const SHARE_MIN = 34;

test("a11y job runs ci/event-native-share-browser.test.mjs unconditionally after Chromium and Kit installs", async () => {
  const step = steps.find(
    (entry) => entry.includes(SHARE_FILE) && entry.includes("node --import tsx --test"),
  );
  assert(step, `a11y job must run ${SHARE_FILE}`);
  assert.match(
    step,
    new RegExp(
      `\\n          node --import tsx --test --test-reporter=tap --test-reporter-destination=artifacts/a11y/event-native-share\\.tap ${escape(SHARE_FILE)}\\n`,
    ),
    "the native-share step must run the Chromium gate with its TAP report",
  );
  assert.match(
    step,
    new RegExp(
      `\\n          node ci/rsvp-focus-require-executed\\.mjs artifacts/a11y/event-native-share\\.tap "${escape(SHARE_SUITE)}" ${SHARE_MIN}\\s*$`,
    ),
    "the native-share step must fail an all-skipped run via the executed-count verifier",
  );
  assert.doesNotMatch(step, /^\s*(?:- )?(?:if|continue-on-error):/m);
  assert(chromiumInstall >= 0, "a11y job must install Chromium");
  assert(
    chromiumInstall < job.indexOf(step),
    "Chromium install must precede the native-share step",
  );
  const kitInstall = job.indexOf("npm ci --prefix web --include=dev");
  assert(
    kitInstall >= 0 && kitInstall < job.indexOf(step),
    "Kit install must precede the native-share step",
  );

  const source = await readFile(new URL(`../${SHARE_FILE}`, import.meta.url), "utf8");
  assert.match(source, /No opt-in skips/, "the suite must stay unconditional");
  assert.doesNotMatch(source, /_BROWSER_TESTS/, "the suite must not gain an opt-out gate");

  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const row = readme.split("\n").find((line) => line.startsWith(`| \`${SHARE_FILE}\` |`));
  assert.match(row ?? "", /rsvp-focus-require-executed\.mjs/);
  assert.match(row ?? "", /None—always runs/);
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
  for (const suite of SUITES) {
    if (suite.env)
      assert(
        gated.some(({ file, env }) => file === suite.file && env === suite.env),
        suite.file,
      );
    const row = section.split("\n").find((line) => line.startsWith(`| \`${suite.file}\` |`));
    assert(row, `README table must list ${suite.file} with its local command`);
    if (!suite.env) assert.match(row, /None—always runs/, suite.file);
    if (suite.config)
      assert.match(
        row,
        new RegExp(`--config ${escape(suite.config)}`),
        `README row must give the config command for ${suite.file}`,
      );
  }
  for (const { file, env } of gated) {
    const row = new RegExp(`^\\|\\s*\`${escape(file)}\`\\s*\\|\\s*\`${env}\``, "m");
    assert.match(section, row, `README table must list ${file} with ${env}`);
  }
});

// Reverse direction: registration must be complete, not just consistent for
// the entries someone remembered to add. The RSVP suite is the one bespoke
// exception: it is a node --test TAP suite pinned by its dedicated test
// above, not by the Vitest SUITES loop.
const BESPOKE_GATED_EXCEPTIONS = [{ file: RSVP_FILE, env: RSVP_ENV }];

function unregisteredGated(gated, suites, exceptions) {
  const registered = new Map();
  for (const suite of suites) if (suite.env) registered.set(suite.file, suite.env);
  for (const exception of exceptions) registered.set(exception.file, exception.env);
  return gated
    .filter(({ file, env }) => registered.get(file) !== env)
    .map(({ file, env }) => `${file} (${env})`);
}

function unregisteredConfigs(configFiles, suites) {
  const registered = new Set(suites.map((suite) => suite.config).filter(Boolean));
  return configFiles.filter((file) => !registered.has(file));
}

async function browserVitestConfigs() {
  const found = [];
  for (const entry of await readdir(new URL("../ci/", import.meta.url)))
    if (/-browser\.vitest\.ts$/.test(entry)) found.push(`ci/${entry}`);
  return found.sort();
}

test("every browser-gated suite and browser Vitest config is registered in SUITES", async () => {
  const gated = await browserGatedSuites();
  assert.deepEqual(unregisteredGated(gated, SUITES, BESPOKE_GATED_EXCEPTIONS), []);
  assert.deepEqual(unregisteredConfigs(await browserVitestConfigs(), SUITES), []);
});

test("the reverse registry scan rejects planted removals and additions (fixture)", () => {
  const refused = {
    file: "test/profile-refused-draft-recovery-acceptance.test.ts",
    env: "A11Y_BROWSER_TESTS",
  };
  const withoutRefused = SUITES.filter((suite) => suite.file !== refused.file);
  // Planted removal: dropping a SUITES entry must surface its gated file.
  assert.deepEqual(unregisteredGated([refused], withoutRefused, []), [
    `${refused.file} (A11Y_BROWSER_TESTS)`,
  ]);
  assert.deepEqual(unregisteredGated([refused], SUITES, []), []);
  // A newly gated file nobody registered is unregistered, and renaming the
  // gate env on a registered file does not silently inherit its entry.
  assert.deepEqual(
    unregisteredGated(
      [{ file: "test/planted-browser.test.ts", env: "PLANTED_BROWSER_TESTS" }],
      SUITES,
      BESPOKE_GATED_EXCEPTIONS,
    ),
    ["test/planted-browser.test.ts (PLANTED_BROWSER_TESTS)"],
  );
  assert.deepEqual(
    unregisteredGated([{ file: refused.file, env: "RENAMED_BROWSER_TESTS" }], SUITES, []),
    [`${refused.file} (RENAMED_BROWSER_TESTS)`],
  );
  // The bespoke exception covers only its exact file and env.
  assert.deepEqual(
    unregisteredGated([{ file: RSVP_FILE, env: RSVP_ENV }], SUITES, BESPOKE_GATED_EXCEPTIONS),
    [],
  );
  assert.deepEqual(unregisteredConfigs(["ci/planted-browser.vitest.ts"], SUITES), [
    "ci/planted-browser.vitest.ts",
  ]);
  assert.deepEqual(unregisteredConfigs(["ci/calendar-subscription-browser.vitest.ts"], SUITES), []);
});
