import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = workflow.split("\n  check:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
const e2eWorkflow = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");

test("the Playwright loader links the parity config before the runner guard refuses local execution", () => {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.RUNNER_OS;
  // --list never starts a server or browser. The real isolation guard must
  // reject this off-runner invocation, but module linking must succeed first.
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/playwright/cli.js",
      "test",
      "--config",
      "playwright.kit-parity.config.ts",
      "--list",
    ],
    { cwd: repo, env, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /Browser smoke runs only in GitHub Actions on Linux/);
  assert.doesNotMatch(output, /ERR_IMPORT_ATTRIBUTE_MISSING/);
});

test("the isolated Kit fixture config supplies every secret required by the /up journey", () => {
  const readiness = readFileSync(new URL("../src/up-config.ts", import.meta.url), "utf8");
  const required = readiness.match(/REQUIRED_SECRETS = \[([\s\S]*?)\]/)?.[1];
  assert(required, "readiness secret inventory must exist");
  const worker = readFileSync(new URL("./kit-worker-dev.mjs", import.meta.url), "utf8");
  const vars = worker.match(/vars: \{([\s\S]*?)\n    \}/)?.[1];
  assert(vars, "fixture vars must exist");
  for (const [, name] of required.matchAll(/"([A-Z_]+)"/g)) {
    assert.match(
      vars,
      new RegExp(`${name}: \\"[^\\"]+\\"`),
      `${name} must have a synthetic fixture value`,
    );
  }
  assert.match(worker, /CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false"/);
  assert.match(worker, /CLOUDFLARE_INCLUDE_PROCESS_ENV: "false"/);
});

test("the Kit fixture owns the member board only on its loopback worker", () => {
  const worker = readFileSync(new URL("./kit-worker-dev.mjs", import.meta.url), "utf8");
  assert.match(worker, /KIT_PARITY_FIXTURE_MEMBER_BOARD: "true"/);
  const hooks = readFileSync(new URL("../web/src/hooks.server.ts", import.meta.url), "utf8");
  assert.match(hooks, /fixtureMemberBoard: env\.KIT_PARITY_FIXTURE_MEMBER_BOARD === "true"/);
  assert.match(hooks, /afterMemberRead:/);
  const ownership = readFileSync(new URL("../src/route-ownership.ts", import.meta.url), "utf8");
  // The override is loopback-gated in the tested core, and no deployed Kit
  // config (web/wrangler.jsonc, the preview Worker) sets the flag.
  assert.match(ownership, /fixtureManifestFor/);
  const deployed = readFileSync(new URL("../web/wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(deployed, /KIT_PARITY_FIXTURE_MEMBER_BOARD/);
  const spec = readFileSync(new URL("../e2e/kit-parity/parity.spec.ts", import.meta.url), "utf8");
  assert.match(spec, /kitFixtureOwnsMemberBoard/);
});

test("the Kit fixture owns the live event detail only on its loopback worker", () => {
  const worker = readFileSync(new URL("./kit-worker-dev.mjs", import.meta.url), "utf8");
  assert.match(worker, /KIT_PARITY_FIXTURE_EVENT_DETAIL: "true"/);
  const hooks = readFileSync(new URL("../web/src/hooks.server.ts", import.meta.url), "utf8");
  assert.match(hooks, /fixtureEventDetail: env\.KIT_PARITY_FIXTURE_EVENT_DETAIL === "true"/);
  const ownership = readFileSync(new URL("../src/route-ownership.ts", import.meta.url), "utf8");
  assert.match(ownership, /KIT_PARITY_FIXTURE_EVENT_DETAIL/);
  const deployed = readFileSync(new URL("../web/wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(deployed, /KIT_PARITY_FIXTURE_EVENT_DETAIL/);
  const spec = readFileSync(new URL("../e2e/kit-parity/parity.spec.ts", import.meta.url), "utf8");
  assert.match(spec, /kitFixtureOwnsEventDetail/);
  const helper = readFileSync(new URL("../e2e/kit-parity.ts", import.meta.url), "utf8");
  assert.match(helper, /kitFixtureOwnsEventDetail/);
});

test("both loopback parity workers inject the same healthy-empty Discord seam", () => {
  // The cross-target events-calendar comparison renders the partial-source
  // notice only when a target reports a Discord failure, so both loopback
  // workers must simulate the same healthy-empty state or the sections
  // diverge. The Kit wrapper MUST assign onto the incoming env object: Kit
  // reads the ambient `cloudflare:workers` env (the entrypoint's original
  // object), so a spread copy passed to worker.fetch is invisible to it and
  // Kit falls back to a live read the fixture fetch stub refuses.
  const worker = readFileSync(new URL("./kit-worker-dev.mjs", import.meta.url), "utf8");
  assert.match(
    worker,
    /env\.DISCORD_EVENTS = \{ upcoming: async \(\) => \[\], lastReadFailed: \(\) => false \};/,
  );
  assert.doesNotMatch(worker, /\{\s*\.\.\.env,\s*DISCORD_EVENTS/);
  const hono = readFileSync(new URL("../e2e/worker.ts", import.meta.url), "utf8");
  assert.match(
    hono,
    /DISCORD_EVENTS: \{ upcoming: async \(\) => \[\], lastReadFailed: \(\) => false \}/,
  );
});

test("both loopback parity workers share the raised read budget", () => {
  // The Kit fixture enforces the same `events-read:anon` bucket as the Hono
  // loopback worker (same disposable Postgres, no forwarded client headers),
  // so its generated vars carry the same override (docs/event-read-admission.md).
  const worker = readFileSync(new URL("./kit-worker-dev.mjs", import.meta.url), "utf8");
  assert.match(worker, /E2E_PUBLIC_READ_BUDGET: "600"/);
  const hono = readFileSync(new URL("../e2e/wrangler.jsonc", import.meta.url), "utf8");
  assert.match(hono, /"E2E_PUBLIC_READ_BUDGET": "600"/);
});

test("Kit snapshot updates are pinned and generated Kit baselines fail the CI guard", () => {
  const config = readFileSync(
    new URL("../playwright.kit-parity.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(config, /^  updateSnapshots: "missing",$/m);
  // A missing template would send new images outside the workflow's checked directory.
  assert.ok(
    config.includes('snapshotPathTemplate: "{testDir}/../visual/__screenshots-kit__/{arg}{ext}"'),
  );
  const e2e = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
  const step = e2e
    .split(/\n      - /)
    .find((entry) => entry.startsWith("name: Uncommitted visual baselines\n"));
  assert(step, "browser-smoke must reject uncommitted visual baselines");
  assert.match(
    step,
    /git status --porcelain -- e2e\/visual\/__screenshots__ e2e\/visual\/__screenshots-kit__/,
  );
});

test("visual tests re-seed and verify the board state after worker restarts", () => {
  const spec = readFileSync(new URL("../e2e/kit-parity/parity.spec.ts", import.meta.url), "utf8");
  const rsvpHelper = spec.match(
    /function memberGoingRsvp\(\): Promise<void> \{([\s\S]*?)\n\}/,
  )?.[1];
  assert(rsvpHelper, "member RSVP helper must exist");
  assert.match(
    rsvpHelper,
    /expect\(\[200, 201\], "ranked RSVP created or refreshed"\)\.toContain\(response\.status\(\)\)/,
  );
  assert.match(rsvpHelper, /memberCookie\(hono\)/);
  assert.match(rsvpHelper, /\.catch\(\(error: unknown\) => \{\s*memberRsvpPromise = null;/);

  const visuals = spec.match(
    /test\.describe\("kit: member-board visuals", \(\) => \{([\s\S]*?)\n\}\);/,
  )?.[1];
  assert(visuals, "Kit member-board visual tests must exist");
  const honoPoll = visuals.indexOf("api(hono).get(");
  const seedRsvp = visuals.indexOf("await memberGoingRsvp();");
  const kitPoll = visuals.indexOf("api(kit).get(");
  const loadComplete = visuals.indexOf('await page.waitForLoadState("networkidle");');
  const rankedRow = visuals.indexOf("const rankedRow");
  const emptyBoard = visuals.indexOf("Nobody is ranked for this season and game yet.");
  const screenshot = visuals.indexOf("toHaveScreenshot(");
  assert(honoPoll >= 0 && honoPoll < seedRsvp && seedRsvp < kitPoll);
  assert(loadComplete >= 0 && loadComplete < rankedRow && rankedRow < screenshot);
  assert(emptyBoard >= 0 && emptyBoard < screenshot);
  assert.match(visuals, /getByRole\("rowheader", \{ name: "QA Member" \}\)/);
  assert.match(visuals, /rankedRow\.getByRole\("cell"\)\)\.toHaveText\(\["1", "1"\]\)/);
  assert.match(visuals, /test\.setTimeout\(120_000\)/);
});

test("Kit visual baselines run on the clean seed before mutating browser journeys", () => {
  const step = (name) => e2eWorkflow.indexOf(`- name: ${name}`);
  const kitVisual = step("Kit visual regression");
  const honoVisual = step("Visual regression");
  const browserJourneys = step("Critical browser journeys");
  const parityJourneys = step("Kit journey parity (Hono vs built Kit Worker)");
  assert(kitVisual >= 0, "the dedicated Kit events-index visual step must exist");
  assert(kitVisual < honoVisual, "Kit visual must run before Hono visual fixture setup");
  assert(honoVisual < browserJourneys, "Hono visual must run before mutating journeys");
  assert(browserJourneys < parityJourneys, "parity journeys remain after browser mutations");
  assert.match(
    e2eWorkflow,
    /name: Kit visual regression\n\s+run: npx playwright test --config playwright\.kit-visual\.config\.ts/,
  );
  assert.match(
    e2eWorkflow,
    /name: Kit journey parity \(Hono vs built Kit Worker\)[\s\S]*?run: >-\n\s+npx playwright test --config playwright\.kit-parity\.config\.ts\s+e2e\/kit-parity\/parity\.spec\.ts/,
  );
});

test("the member RSVP cleanup flag is armed before parsing the response", () => {
  const spec = readFileSync(new URL("../e2e/kit-parity/parity.spec.ts", import.meta.url), "utf8");
  const memberGoingRsvp = spec.match(
    /function memberGoingRsvp\(\): Promise<void> \{([\s\S]*?)\n\}/,
  )?.[1];
  assert(memberGoingRsvp, "memberGoingRsvp must exist");
  assert.match(
    memberGoingRsvp,
    /expect\(\[200, 201\], "ranked RSVP created or refreshed"\)\.toContain\(response\.status\(\)\);\s*memberRsvpCreated = true;\s*const body = \(await response\.json\(\)\)/,
  );
});

test("the ranked RSVP is established before the first cache-settling /events GET", () => {
  // The cross-target events-calendar comparison races the documented
  // isolate-local anon-cache convergence window (src/events/anon-cache.ts:
  // other isolates converge only on expiry, 60 s on /events) unless every
  // settled guest entry already carries the ranked count. The RSVP PUT
  // retires only the Hono worker's isolate, so the ranked RSVP must be
  // established before the first anonymous GET /events settles an entry on
  // either isolate; otherwise the Kit entry holds count=0 and the
  // comparison passes only when over 60 s elapsed since that GET.
  const spec = readFileSync(new URL("../e2e/kit-parity/parity.spec.ts", import.meta.url), "utf8");
  const lines = spec.split("\n");
  const rsvpLine = lines.findIndex((line) => /^\s*await memberGoingRsvp\(\);/.test(line)) + 1;
  const getLine = lines.findIndex((line) => /\.get\("\/events"\)/.test(line)) + 1;
  assert(rsvpLine > 0, "memberGoingRsvp must be called at least once");
  assert(getLine > 0, "an anonymous GET /events must exist");
  assert(
    rsvpLine < getLine,
    `ranked RSVP established at line ${rsvpLine}, after the first cache-settling GET /events at line ${getLine}`,
  );
});

test("the required check runs the parity selftests in their own fail-closed step", () => {
  const step = job
    .split(/\n      - /)
    .find((entry) => entry.startsWith("name: Kit parity gate selftests\n"));
  assert(
    step,
    "check must run the parity gate selftests independently of its pinned coverage command",
  );
  assert.match(
    step,
    /^        if: \(needs\.scope\.outputs\.docs_only != 'true' && needs\.scope\.outputs\.draft != 'true'\)$/m,
  );
  assert.doesNotMatch(step, /continue-on-error:/);
  assert.equal(
    step.match(/^        run: (.+)$/m)?.[1],
    "node --test ci/kit-parity-gates.test.mjs ci/kit-parity-origin.test.mjs ci/check-kit-parity.test.mjs ci/check-kit-perf.test.mjs ci/bundle-inventory-acceptance.test.mjs ci/kit-visual-accept.test.mjs ci/kit-parity-ci-wiring.test.mjs ci/kit-section-normalization.test.mjs",
  );
});
