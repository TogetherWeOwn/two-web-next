import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  advanceFixture,
  createFixture,
  fixtureDatabase,
  fixtureNames,
  removeFixture,
  stagingConfig,
} from "./kit-cutover-database.mjs";
import { smoke } from "../bin/smoke.mjs";
import { REQUIRED_PRODUCTION_SECRETS } from "./check-production-secrets.mjs";
import {
  LEDGER_STATES,
  STAGING_WORKER,
  WranglerOperationError,
  ledgerPrefixes,
  readReady,
  sourceInputs,
  uploadVersion,
  verifyPackage,
  verifyStagingProof,
  wrangler,
} from "./kit-cutover-evidence.mjs";
import { KIT_ROUTE_FLAGS } from "./production-deploy-gate.mjs";
import { liveVersion, rollbackAction } from "./rollback-target.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

function cloudflare() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert.ok(
    /^[a-f0-9]{32}$/.test(account ?? "") && token,
    "missing staging Cloudflare credentials",
  );
  return async (path, method = "GET") => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 404) return null;
    assert.ok(response.ok, "staging Workers API refused the request");
    const body = await response.json();
    assert.equal(body.success, true, "staging Workers API returned an error");
    return body.result;
  };
}

async function verifyServed(origin, prefixes, identity, version, state) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await readReady(origin, prefixes, { version, commit: identity.sourceSha, state });
      break;
    } catch {
      if (attempt === 5) throw new Error("staging failed exact version and ledger verification");
      await delay(10_000);
    }
  }
  let routes = 0;
  assert.ok(
    await smoke(origin, {
      expectedVersionId: version,
      expectedJoinRenderer: "hono",
      onRoute: () => {
        routes += 1;
      },
    }),
    "isolated public-route smoke failed",
  );
  assert.ok(routes > 0, "isolated route smoke ran no checks");
  return routes;
}

function verifyStagedBindings(version, id, config) {
  assert.ok(
    version?.id === id && Array.isArray(version.resources?.bindings),
    "staged bindings unavailable",
  );
  const bindings = new Map(version.resources.bindings.map((binding) => [binding.name, binding]));
  for (const name of ["DB", "BOT_DB", "SYNC_EVENT_QUEUE", "INTERNAL_ACTION_QUEUE"]) {
    assert.ok(!bindings.has(name), "isolated staging has an external binding");
  }
  for (const name of ["DATABASE_URL", ...REQUIRED_PRODUCTION_SECRETS]) {
    assert.equal(bindings.get(name)?.type, "secret_text", "missing synthetic secret binding");
  }
  assert.ok(bindings.has("CF_VERSION_METADATA"), "staged version metadata binding missing");
  for (const flag of KIT_ROUTE_FLAGS) {
    assert.ok(
      config.vars[flag] === undefined ? !bindings.has(flag) : bindings.get(flag)?.text === "false",
      "staged Kit flag is not off",
    );
  }
}

function context() {
  assert.ok(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.GITHUB_REF === "refs/heads/main" &&
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "isolated staging requires the protected main dispatch",
  );
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const names = fixtureNames(runId, runAttempt);
  return {
    identity: {
      sourceSha: process.env.GITHUB_SHA,
      runId,
      runAttempt,
      digest: process.env.CUTOVER_PACKET_DIGEST,
    },
    names,
    worker: `${STAGING_WORKER}-${names.suffix}`,
    claim: join(process.env.RUNNER_TEMP, "kit-cutover-claimed.json"),
  };
}

function databaseUrl() {
  return fixtureDatabase(
    process.env.KIT_CUTOVER_TEST_DATABASE_URL,
    process.env.KIT_CUTOVER_TEST_DATABASE_HOST,
  );
}

async function cleanup({ claim, worker, names }, api, database) {
  const marker = await readFile(claim, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (marker === null) return;
  assert.equal(marker, worker, "isolated cleanup claim mismatch");
  const target = `scripts/${worker}`;
  try {
    if ((await api(`${target}/settings`)) !== null) {
      await api(target, "DELETE");
      assert.equal(await api(`${target}/settings`), null, "isolated Worker cleanup failed");
    }
  } finally {
    await removeFixture(database, names);
  }
  await rm(claim);
}

async function deployPacket(dir, scratch, proof, origin, inputs, api, runtimeUrl) {
  const { worker, identity, configs } = proof;
  const tag = `${identity.sourceSha}-${identity.runId}-${identity.runAttempt}`;
  const secretsFile = join(scratch, "synthetic-bindings.json");
  await writeFile(
    secretsFile,
    JSON.stringify({
      DATABASE_URL: runtimeUrl.href,
      SESSION_SECRET: randomUUID(),
      DISCORD_CLIENT_SECRET: "synthetic",
      DISCORD_BOT_TOKEN: "synthetic",
    }),
    { flag: "wx", mode: 0o600 },
  );
  delete process.env.KIT_CUTOVER_TEST_DATABASE_URL;
  for (const profile of ["hono", "kit"]) {
    const directory = join(dir, profile);
    const config = stagingConfig(profile, inputs, worker, origin);
    const configPath = join(directory, "wrangler.json");
    const configText = JSON.stringify(config);
    configs[profile] = sha256(configText);
    await writeFile(configPath, configText, { flag: "wx" });
    console.info(`Uploading isolated ${profile} version`);
    if (profile === "hono") {
      wrangler(profile, [
        "deploy",
        "--config",
        configPath,
        "--no-bundle",
        "--upload-source-maps=false",
        "--tag",
        tag,
        "--secrets-file",
        secretsFile,
      ]);
      proof.hono = liveVersion(
        JSON.parse(wrangler("hono", ["deployments", "list", "--config", configPath, "--json"])),
      );
    } else {
      proof.kit = uploadVersion(profile, directory, config, tag, {
        secretsFile,
        output: join(scratch, "kit.jsonl"),
      });
    }
    console.info(`Checking isolated ${profile} bindings for version ${proof[profile]}`);
    verifyStagedBindings(
      await api(`scripts/${worker}/versions/${proof[profile]}`),
      proof[profile],
      config,
    );
  }
}

async function exercise(proof, prefixes, owner, names, origin, config) {
  const { identity, hono, kit, checks } = proof;
  const run = (...args) => wrangler("hono", [...args, "--config", config]);
  const deployments = () => JSON.parse(run("deployments", "list", "--json"));
  const capture = async (state, step, version) => {
    assert.equal(liveVersion(deployments()), version);
    const routes = await verifyServed(origin, prefixes, identity, version, state);
    proof.routeCount ??= routes;
    assert.equal(routes, proof.routeCount, "staged smoke route coverage changed");
    checks.push({ state, step, version, status: 200, pending: 0, smoke: "passed" });
    console.info(`Isolated ${state} ${step}: ${version} passed ${routes} routes and readiness`);
  };
  for (const state of LEDGER_STATES) {
    if (state === "1037") await advanceFixture(owner, prefixes[state], names.login);
    await capture(state, "hono", hono);
    assert.equal(liveVersion(deployments()), hono);
    run("versions", "deploy", `${kit}@100%`, "--yes");
    try {
      await capture(state, "kit", kit);
      for (let i = 0; i < 3; i++) {
        await delay(20_000);
        await readReady(origin, prefixes, { version: kit, commit: identity.sourceSha, state });
        proof.kitReadinessSamples += 1;
      }
    } finally {
      assert.equal(rollbackAction(deployments(), { expected: kit, target: hono }), "rollback");
      run("rollback", hono, "--yes");
    }
    await capture(state, "undo", hono);
  }
}

async function qualify(dir, proofPath, ctx) {
  const { identity, worker, names, claim } = ctx;
  const inputs = await sourceInputs();
  await verifyPackage(dir, identity, inputs);
  const prefixes = ledgerPrefixes(inputs.journal);
  const database = databaseUrl();
  const api = cloudflare();
  const subdomain = (await api("subdomain"))?.subdomain;
  assert.match(subdomain ?? "", /^[a-z0-9][a-z0-9-]{0,62}$/);
  const origin = `https://${worker}.${subdomain}.workers.dev`;
  assert.equal(await api(`scripts/${worker}/settings`), null, "isolated script already exists");
  const scratch = await mkdtemp(join(process.env.RUNNER_TEMP, "kit-cutover-staging-"));
  const proof = {
    schema: 1,
    identity,
    worker,
    configs: {},
    checks: [],
    kitReadinessSamples: 0,
    bindingCheck: "isolated-and-all-off",
  };
  let owner;
  let phase = "synthetic database setup";
  try {
    const fixture = await createFixture(database, names, () =>
      writeFile(claim, worker, { flag: "wx", mode: 0o600 }),
    );
    owner = fixture.owner;
    await advanceFixture(owner, prefixes["1033"], names.login);
    phase = "same-script staged uploads";
    await deployPacket(dir, scratch, proof, origin, inputs, api, fixture.runtimeUrl);
    phase = "exact readiness, public smoke and guarded Hono undo";
    await exercise(proof, prefixes, owner, names, origin, join(dir, "hono/wrangler.json"));
  } catch (error) {
    // Report only the operation and numeric provider code from Wrangler.
    const detail = error instanceof WranglerOperationError ? ` (${error.message})` : "";
    throw new Error(`Cutover staging failed during ${phase}${detail}`);
  } finally {
    await owner?.end({ timeout: 0 });
    await rm(scratch, { recursive: true, force: true });
  }
  verifyStagingProof(proof, identity);
  await writeFile(proofPath, JSON.stringify(proof), { flag: "wx" });
  console.info(
    `Isolated pin ${identity.runId}:${identity.runAttempt}:${identity.digest}, Hono ${proof.hono}, Kit ${proof.kit}`,
  );
}

if (import.meta.main) {
  const ctx = context();
  if (process.argv[2] === "--cleanup") {
    try {
      await cleanup(ctx, cloudflare(), databaseUrl());
    } catch {
      throw new Error("Could not verify isolated Worker, database and login cleanup");
    }
  } else {
    await qualify(process.argv[2], process.argv[3], ctx);
  }
}
