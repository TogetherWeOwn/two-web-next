import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

test("budget covers at least the member-RSVP and moderator-admin journeys", () => {
  const budget = JSON.parse(
    readFileSync(new URL("./auth-perf-budget.json", import.meta.url), "utf8"),
  );
  for (const id of ["member-rsvp", "moderator-admin"]) {
    const entry = budget.journeys[id];
    assert.ok(entry, `${id} must be budgeted`);
    assert.ok(entry.path.startsWith("/"), `${id} path must be absolute`);
    assert.ok(entry.maxMedianMs > 0 && entry.maxSingleMs >= entry.maxMedianMs);
  }
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

test("browser smoke executes the live authenticated gate", () => {
  const workflow = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
  assert.match(workflow, /auth-perf/);
});
