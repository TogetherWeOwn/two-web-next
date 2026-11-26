import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { ENTRY_NAME } from "../web/scripts/kit-facade-transaction.mjs";
import { kitRouteFlagsForFamily } from "./kit-route-flags.mjs";
import { readWranglerConfig } from "./wrangler-config.mjs";

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
const BODY_CEILING = 1_048_576;

const readConfig = (path) =>
  readWranglerConfig(readFileSync(new URL(path, import.meta.url), "utf8"));

test("inert Kit production config mirrors the production web Worker without deploy topology", () => {
  const root = readConfig("../wrangler.jsonc");
  const production = root.env.production;
  const { vars: _vars, ...kit } = readConfig("../web/wrangler.production.jsonc");
  const adapterOutput = ".svelte-kit/cloudflare";

  // Exact shape: no routes, named preview environment, consumers or extra bindings.
  assert.deepEqual(kit, {
    $schema: root.$schema,
    name: production.name,
    main: `${adapterOutput}/${ENTRY_NAME}`,
    compatibility_date: production.compatibility_date ?? root.compatibility_date,
    compatibility_flags: production.compatibility_flags ?? root.compatibility_flags,
    observability: production.observability ?? root.observability,
    workers_dev: false,
    preview_urls: false,
    placement: production.placement,
    tail_consumers: production.tail_consumers,
    version_metadata: production.version_metadata,
    keep_vars: production.keep_vars ?? root.keep_vars,
    triggers: { crons: [] },
    queues: { producers: production.queues.producers },
    assets: { ...(production.assets ?? root.assets), directory: adapterOutput },
    hyperdrive: production.hyperdrive,
  });
  assert.equal(kit.name, WEB_SCRIPT);
});

test("inert Kit production vars allow only reviewed public values and disabled route flags", () => {
  const { vars } = readConfig("../wrangler.jsonc").env.production;
  const publicKeys = [
    "APP_URL",
    "FEATURED_IMAGE_HOSTS",
    "DISCORD_CLIENT_ID",
    "DISCORD_GUILD_ID",
    "DISCORD_MODERATOR_ROLE_IDS",
    "DISCORD_INVITE_URL",
  ];
  const flagKeys = Object.keys(kitRouteFlagsForFamily("hono"));
  assert.deepEqual(readConfig("../web/wrangler.production.jsonc").vars, {
    ...Object.fromEntries(publicKeys.map((key) => [key, vars[key]])),
    ...Object.fromEntries(flagKeys.map((key) => [`KIT_ROUTE_${key.toUpperCase()}`, "false"])),
    KIT_ROUTE_EMBER_PAGES: "false",
    KIT_ROUTE_ADMIN: "false",
  });
});

const schedules = (key) => `/workers/scripts/${key}/schedules`;
const crons = (...entries) => ({
  success: true,
  result: { schedules: entries.map((cron) => ({ cron })) },
});
const paddedSchedules = { ...crons(), padding: "ééé" };
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

function cliWithStubbedFetch(responses) {
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
  const init = { status: hit.status ?? 200 };
  const json = hit.body === null ? null : JSON.stringify(hit.body);
  if (!hit.chunkEnds) return new Response(json, init);

  const padding = hit.bytes === undefined ? "" : " ".repeat(hit.bytes - Buffer.byteLength(json));
  const bytes = new TextEncoder().encode(json + padding);
  const ends = [...hit.chunkEnds, bytes.byteLength];
  let offset = 0;
  let nextChunk = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (nextChunk === ends.length) {
        controller.close();
        return;
      }
      const end = ends[nextChunk++];
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() {
      console.error("fixture stream cancelled after " + nextChunk + " chunks");
    },
  }, { highWaterMark: 0 }), init);
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
          CF_ACCOUNT_ID: "fixture-account-id",
          CLOUDFLARE_API_TOKEN: "fixture-token-never-real",
          STUB_RESPONSES: JSON.stringify(responses),
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

test("CLI accepts valid JSON at the exact 1 MiB byte ceiling", () => {
  const result = cliWithStubbedFetch({
    ...CLEAN,
    [schedules(WEB_SCRIPT)]: {
      body: paddedSchedules,
      bytes: BODY_CEILING,
      chunkEnds: [BODY_CEILING - 1],
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no drift/);
  assert.equal(result.stderr, "");
});

for (const remaining of [0, 1]) {
  const boundary = remaining ? "before the final byte" : "on the final byte";
  test(`CLI refuses and cancels an oversized stream ${boundary}`, () => {
    const result = cliWithStubbedFetch({
      ...CLEAN,
      [schedules(WEB_SCRIPT)]: {
        body: paddedSchedules,
        bytes: BODY_CEILING + 1 + remaining,
        chunkEnds: remaining ? [BODY_CEILING, BODY_CEILING + 1] : [BODY_CEILING],
      },
    });
    assert.equal(result.status, 2, result.stdout || result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `fixture stream cancelled after 2 chunks\n::error::oversized response from ${schedules(WEB_SCRIPT)}\n`,
    );
  });
}

test("CLI exits 2 when a schedules response has no body", () => {
  const result = cliWithStubbedFetch({
    [schedules(WEB_SCRIPT)]: { body: null },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `::error::unreadable response from ${schedules(WEB_SCRIPT)}\n`);
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
  const body = { success: false, errors: [{ code: 7000, message: "fixture café outage" }] };
  const result = cliWithStubbedFetch({
    [schedules(WEB_SCRIPT)]: {
      status: 500,
      body,
      chunkEnds: [Buffer.from(JSON.stringify(body)).indexOf("é") + 1],
    },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`schedules unreadable for ${WEB_SCRIPT}`));
  assert.match(result.stderr, /fixture café outage/);
});
