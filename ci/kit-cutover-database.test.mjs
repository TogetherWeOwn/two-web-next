import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureNames } from "./kit-cutover-database.mjs";
import { PROFILES, STAGING_WORKER, sourceInputs, writeManifest } from "./kit-cutover-evidence.mjs";

const root = new URL("../", import.meta.url);
const entry = fileURLToPath(new URL("kit-cutover-staging.mjs", import.meta.url));
const preload = new URL("fixtures/kit-cutover-partial-database.mjs", import.meta.url);

test("partial database allocation fails without proof and normal cleanup removes the claim", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "kit-cutover-partial-database-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const packet = join(temp, "packet");
  const proof = join(temp, "proof.json");
  const statePath = join(temp, "database-fixture.json");
  const claim = join(temp, "kit-cutover-claimed.json");
  const { db, login, suffix } = fixtureNames("21", "3");
  const other = fixtureNames("21", "2");
  const worker = `${STAGING_WORKER}-${suffix}`;
  const databases = ["two_web_cutover", other.db];
  const logins = ["two_web_cutover_owner", other.login];
  await writeFile(statePath, JSON.stringify({ worker, databases, logins, events: [] }));

  for (const profile of PROFILES) {
    await mkdir(join(packet, profile, "modules"), { recursive: true });
    await mkdir(join(packet, profile, "assets"));
    await writeFile(join(packet, profile, "assets", ".assetsignore"), "fixture");
  }
  await writeFile(join(packet, "hono/modules/worker.js"), "pure Hono");
  await writeFile(join(packet, "kit/modules/_worker.js"), "facade");
  await writeFile(join(packet, "kit/modules/kit-adapter.js"), "Kit adapter");
  const pin = { sourceSha: "a".repeat(40), runId: "21", runAttempt: "3" };
  const digest = await writeManifest(packet, pin, await sourceInputs(fileURLToPath(root)));

  const host = "ep-offline-fixture.example.neon.tech";
  const url = new URL(`postgresql://two_web_cutover_owner@${host}/two_web_cutover`);
  url.password = "synthetic";
  const run = (...args) => {
    const result = spawnSync(process.execPath, ["--import", preload.href, entry, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_RUN_ID: pin.runId,
        GITHUB_RUN_ATTEMPT: pin.runAttempt,
        GITHUB_SHA: pin.sourceSha,
        RUNNER_TEMP: temp,
        CUTOVER_PACKET_DIGEST: digest,
        KIT_CUTOVER_TEST_DATABASE_HOST: host,
        KIT_CUTOVER_TEST_DATABASE_URL: url.href,
        CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
        CLOUDFLARE_API_TOKEN: "synthetic",
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    return result;
  };

  const qualification = run(packet, proof);
  assert.equal(qualification.status, 1);
  assert.match(
    qualification.stderr,
    /Error: Cutover staging failed during synthetic database setup/,
  );
  assert.doesNotMatch(qualification.stderr, /synthetic role setup failure/);
  assert.equal(await readFile(claim, "utf8"), worker);
  const beforeCleanup = [
    "check-worker-settings",
    ["inspect", db, login],
    ["create-database", db],
    ["refuse-login", login],
    "close-control-connection",
  ];
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
    worker,
    databases: [...databases, db],
    logins,
    events: beforeCleanup,
  });
  assert.deepEqual((await readdir(temp)).sort(), [
    "database-fixture.json",
    "kit-cutover-claimed.json",
    "packet",
  ]);

  const cleanup = run("--cleanup");
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(cleanup.stderr, "");
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
    worker,
    databases,
    logins,
    events: [
      ...beforeCleanup,
      "check-worker-settings",
      ["drop-database", db],
      ["drop-login", login],
      ["inspect", db, login],
      "close-control-connection",
    ],
  });
  assert.deepEqual((await readdir(temp)).sort(), ["database-fixture.json", "packet"]);
});
