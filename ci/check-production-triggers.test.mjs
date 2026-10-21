import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Executed CLI contract for the production trigger drift probe: the header
// and both runbooks define the probe entirely by its exit codes (0 clean,
// 1 drift, 2 unreadable), so the suite must execute the module as a script,
// not just import main/fetchLiveState/detectTriggerDrift. Deleting the
// process.exitCode assignments must turn every test below red.
//
// No network, no secrets: fetch is stubbed in the child via --import, and
// the credential env vars carry fixture values the stub never sends anywhere.

const SYNC = "two-web-next-production-sync-event";
const INTERNAL = "two-web-next-production-internal-action";
const WEB_SCRIPT = "two-web-next-production";
const JOBS_SCRIPT = "two-web-jobs-production";

const schedules = (key) => `/workers/scripts/${key}/schedules`;
const crons = (...entries) => ({
  success: true,
  result: { schedules: entries.map((cron) => ({ cron })) },
});
const consumers = (script) => ({
  success: true,
  result: [
    {
      script,
      settings: { batch_size: 10, max_retries: 10, max_wait_time_ms: 5000 },
    },
  ],
});
const queueList = () => ({
  success: true,
  result: [
    { queue_name: SYNC, queue_id: "fixture-queue-sync" },
    { queue_name: INTERNAL, queue_id: "fixture-queue-internal" },
  ],
});

const CLEAN = {
  [schedules(WEB_SCRIPT)]: { body: crons() },
  [schedules(JOBS_SCRIPT)]: { body: crons("*/10 * * * *", "0 0 * * *") },
  "/queues": { body: queueList() },
  "/queues/fixture-queue-sync/consumers": { body: consumers(JOBS_SCRIPT) },
  "/queues/fixture-queue-internal/consumers": { body: consumers(JOBS_SCRIPT) },
};

// Pre-transfer transitional state: web still owns both crons and both
// consumers, the jobs script is not deployed yet.
const DRIFTED = {
  [schedules(WEB_SCRIPT)]: { body: crons("*/10 * * * *", "0 0 * * *") },
  [schedules(JOBS_SCRIPT)]: {
    status: 404,
    body: { success: false, errors: [{ code: 10090, message: "fixture script not found" }] },
  },
  "/queues": { body: queueList() },
  "/queues/fixture-queue-sync/consumers": { body: consumers(WEB_SCRIPT) },
  "/queues/fixture-queue-internal/consumers": { body: consumers(WEB_SCRIPT) },
};

function cliWithStubbedFetch(responses, { env = {} } = {}) {
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "fetch-stub-",
    ),
  );
  try {
    const stub = join(scratch, "fetch-stub.mjs");
    writeFileSync(
      stub,
      `const responses = JSON.parse(process.env.STUB_RESPONSES);
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const key = url.pathname.replace(/^\\/client\\/v4\\/accounts\\/[^/]+/, "");
  const hit = responses[key];
  if (!hit) throw new Error("unexpected fetch: " + url.pathname);
  return { status: hit.status ?? 200, text: async () => JSON.stringify(hit.body) };
};
`,
      { mode: 0o600 },
    );
    const result = spawnSync(
      process.execPath,
      ["--import", stub, "ci/check-production-triggers.mjs"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          CF_ACCOUNT_ID: "fixture-account-id",
          CLOUDFLARE_API_TOKEN: "fixture-token-never-real",
          STUB_RESPONSES: JSON.stringify(responses),
          ...env,
        },
      },
    );
    assert.equal(result.error, undefined);
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("CLI exits 0 with a clean report when live triggers match the reviewed configs", () => {
  const result = cliWithStubbedFetch(CLEAN);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no drift/);
  assert.equal(result.stderr, "");
});

test("CLI exits 1 naming the drift on the pre-transfer web-owned topology", () => {
  const result = cliWithStubbedFetch(DRIFTED);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /production trigger drift/);
  assert.ok(
    result.stderr.includes(WEB_SCRIPT),
    "drift report must name the web script that still owns triggers",
  );
});

test("CLI exits 2 without credentials and performs no live read", () => {
  const { CF_ACCOUNT_ID: _account, CLOUDFLARE_API_TOKEN: _token, ...rest } = process.env;
  const result = spawnSync(process.execPath, ["ci/check-production-triggers.mjs"], {
    encoding: "utf8",
    timeout: 30_000,
    env: rest,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /CF_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required/);
});

test("CLI exits 2 when the live schedules read is unreadable", () => {
  const result = cliWithStubbedFetch({
    [schedules(WEB_SCRIPT)]: {
      status: 500,
      body: { success: false, errors: [{ code: 7000, message: "fixture schedules outage" }] },
    },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`schedules unreadable for ${WEB_SCRIPT}`));
});
