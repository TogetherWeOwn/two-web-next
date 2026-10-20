import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./check-auth-perf.mjs", import.meta.url));

test("auth perf selftest passes hermetically", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--selftest"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(
    result.status,
    0,
    `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stdout, /auth perf gate selftest: \d+ cases passed/);
  assert.match(result.stdout, /cookie-stripped member body fails/);
  assert.match(result.stdout, /guest bounce fails the admin journey/);
});

test("budget covers both authenticated journeys with at least five samples", () => {
  const budget = JSON.parse(
    readFileSync(new URL("./auth-perf-budget.json", import.meta.url), "utf8"),
  );
  assert.ok(budget.samples >= 5, "calibration requires five or more samples per journey");
  for (const id of ["member-rsvp", "moderator-admin"]) {
    const entry = budget.journeys[id];
    assert.ok(entry, `${id} must be budgeted`);
    assert.ok(entry.path.startsWith("/"), `${id} path must be absolute`);
    assert.ok(entry.maxMedianMs > 0 && entry.maxSingleMs >= entry.maxMedianMs);
  }
});

test("ceilings never relax above their shipped values (tightening stays green)", () => {
  const budget = JSON.parse(
    readFileSync(new URL("./auth-perf-budget.json", import.meta.url), "utf8"),
  );
  // Shipped M4.4 ceilings (ci/auth-perf-budget.json): a 10x bump must go red,
  // a decrease (planned tightening) must stay green, so pin an upper bound,
  // not an exact value. Threshold changes need their own reviewed PR and must
  // never relax a ceiling to make CI green.
  const SHIPPED = {
    "member-rsvp": { maxMedianMs: 1500, maxSingleMs: 3000 },
    "moderator-admin": { maxMedianMs: 1500, maxSingleMs: 3000 },
  };
  for (const [id, shipped] of Object.entries(SHIPPED)) {
    const entry = budget.journeys[id];
    assert.ok(entry, `${id} must be budgeted`);
    assert.ok(
      entry.maxMedianMs <= shipped.maxMedianMs,
      `${id} maxMedianMs ${entry.maxMedianMs} exceeds shipped ${shipped.maxMedianMs}: threshold changes need their own reviewed PR, never relax a ceiling to make CI green`,
    );
    assert.ok(
      entry.maxSingleMs <= shipped.maxSingleMs,
      `${id} maxSingleMs ${entry.maxSingleMs} exceeds shipped ${shipped.maxSingleMs}: threshold changes need their own reviewed PR, never relax a ceiling to make CI green`,
    );
  }
});

test("threshold-change policy stays documented, not weakened", () => {
  const doc = readFileSync(new URL("../docs/performance-budgets.md", import.meta.url), "utf8");
  assert.match(doc, /Never relax these ceilings to turn a build green/);
  assert.match(doc, /threshold changes need\s+their own reviewed PR/i);
});

test("live run without an origin fails closed, never green", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, AUTH_PERF_URL: "" },
  });
  assert.equal(
    result.status,
    2,
    `expected exit 2, got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
});

// Isolate the writer's relative test-results paths without changing the test
// runner's cwd. The child imports helpers only, with no live credentials or env.
function runLedger(t, journeys) {
  const dir = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "auth-perf-ledger-"),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const moduleUrl = new URL("./check-auth-perf.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { readFileSync } from "node:fs";
       import { summarize, writeLedger } from ${JSON.stringify(moduleUrl)};
       const summary = summarize(JSON.parse(readFileSync(0, "utf8")));
       let output = "";
       const code = writeLedger(summary, { stdout: { write(text) { output += text; } } });
       console.log(JSON.stringify({ summary, code, output }));`,
    ],
    { cwd: dir, env: {}, input: JSON.stringify(journeys), encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  const ledgerDir = join(dir, "test-results");
  return {
    ...JSON.parse(result.stdout),
    files: existsSync(ledgerDir) ? readdirSync(ledgerDir).sort() : [],
    read: (name) => readFileSync(join(ledgerDir, name), "utf8"),
  };
}

const passedJourneys = [
  { name: "member-rsvp", status: "passed", reason: null, samples: [100, 120, 140], medianMs: 120 },
  {
    name: "moderator-admin",
    status: "passed",
    reason: null,
    samples: [120, 140, 160],
    medianMs: 140,
  },
];

for (const reason of ["__Host-two_session=abc", "X-TWO-QA-Auth: synthetic", "Bearer synthetic"]) {
  test(`ledger refuses a secret-shaped reason (${reason.split(/[=: ]/)[0]}) before writing files`, (t) => {
    // Keep the verdict passing so only the secret guard can return 1.
    const result = runLedger(t, [{ ...passedJourneys[0], reason }, passedJourneys[1]]);
    assert.equal(result.summary.verdict, "pass");
    assert.equal(result.code, 1);
    assert.deepEqual(result.files, []);
    assert.equal(result.output, "auth perf gate: secret-shaped content in ledger — failing.\n");
    assert.ok(!result.output.includes(reason));
  });
}

test("a failed journey's secret-shaped reason is not written either", (t) => {
  const result = runLedger(t, [
    { ...passedJourneys[0], status: "failed", reason: "__Host-two_session=abc" },
    passedJourneys[1],
  ]);
  assert.equal(result.summary.verdict, "fail");
  assert.equal(result.code, 1);
  assert.deepEqual(result.files, []);
  assert.equal(result.output, "auth perf gate: secret-shaped content in ledger — failing.\n");
});

for (const failed of [false, true]) {
  test(`ledger writes both summaries and returns ${failed ? 1 : 0} with ${failed ? "one failed journey" : "all journeys passed"}`, (t) => {
    const journeys = passedJourneys.map((journey, index) =>
      failed && index === 1
        ? { ...journey, status: "failed", reason: "status 403 !== 200" }
        : journey,
    );
    const result = runLedger(t, journeys);
    const verdict = failed ? "fail" : "pass";
    const counts = { total: 2, passed: failed ? 1 : 2, failed: failed ? 1 : 0 };
    assert.deepEqual(result.summary, { version: 1, counts, journeys, verdict });
    assert.equal(result.code, failed ? 1 : 0);
    assert.deepEqual(result.files, ["auth-perf-ledger.json", "auth-perf-ledger.md"]);
    assert.deepEqual(JSON.parse(result.read("auth-perf-ledger.json")), result.summary);
    const markdown = result.read("auth-perf-ledger.md");
    assert.ok(
      markdown.includes(
        `Verdict: **${verdict}** — ${counts.passed} passed, ${counts.failed} failed, 2 total.`,
      ),
    );
    for (const journey of journeys) {
      assert.ok(
        markdown.includes(
          `| ${journey.name} | ${journey.status} | ${journey.medianMs} | ${journey.samples.join(", ")} | ${journey.reason ?? "—"} |`,
        ),
      );
    }
    assert.equal(
      result.output,
      `auth perf gate: ${counts.passed} passed, ${counts.failed} failed, 2 total (verdict: ${verdict}).\n`,
    );
  });
}

test("browser smoke executes the live authenticated gate", () => {
  const workflow = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
  assert.match(workflow, /auth-perf/);
});
