import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { smoke } from "../bin/smoke.mjs";
import {
  LEDGER_STATES,
  STAGING_WORKER,
  ledgerPrefixes,
  productionUploadConfig,
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

export function stagingConfig(profile, inputs, worker, origin) {
  const config = productionUploadConfig(profile, inputs);
  return {
    name: worker,
    main: config.main,
    base_dir: config.base_dir,
    ...(config.rules ? { rules: config.rules } : {}),
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    assets: config.assets,
    version_metadata: config.version_metadata,
    workers_dev: true,
    preview_urls: false,
    vars: {
      ...Object.fromEntries(
        Object.entries(config.vars).filter(([name]) => name.startsWith("KIT_ROUTE_")),
      ),
      APP_URL: origin,
      FEATURED_IMAGE_HOSTS: "",
      DISCORD_CLIENT_ID: "100000000000000001",
      DISCORD_GUILD_ID: "100000000000000002",
      DISCORD_INVITE_URL: "https://discord.gg/cutover-fixture",
    },
  };
}

export function fixtureDatabase(value, host) {
  assert.match(host ?? "", /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/);
  const url = URL.canParse(value) ? new URL(value) : null;
  assert.ok(
    url?.protocol === "postgresql:" &&
      url.hostname === host &&
      !url.hostname.includes("-pooler.") &&
      (url.port === "" || url.port === "5432") &&
      url.pathname === "/two_web_cutover" &&
      url.username === "two_web_cutover_owner" &&
      url.password &&
      !url.search &&
      !url.hash,
    "isolated cutover requires its dedicated synthetic database and owner",
  );
  url.searchParams.set("sslmode", "require");
  return url;
}

function cloudflare() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert.ok(
    /^[a-f0-9]{32}$/.test(account ?? "") && token,
    "missing staging Cloudflare credentials",
  );
  return async (path) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/${path}`,
      {
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

async function advance(owner, migrations, expected, runtimeLogin) {
  const applied =
    await owner`SELECT created_at::text, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id`;
  for (const [index, row] of applied.entries()) {
    assert.equal(Number(row.created_at), migrations[index]?.folderMillis);
    assert.equal(row.hash, migrations[index]?.hash);
  }
  const pending = migrations.slice(applied.length, expected.length);
  assert.ok(pending.length > 0, "synthetic ledger must advance");
  await owner.begin(async (sql) => {
    for (const migration of pending) {
      for (const statement of migration.sql) {
        if (statement.trim()) await sql.unsafe(statement);
      }
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${migration.hash}, ${migration.folderMillis})`;
    }
    // This login can read only synthetic public app data and the readiness
    // projection. It never receives direct ledger access.
    await sql`GRANT USAGE ON SCHEMA public, web_readiness TO ${sql(runtimeLogin)}`;
    await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${sql(runtimeLogin)}`;
    await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${sql(runtimeLogin)}`;
    await sql`GRANT SELECT ON web_readiness.migration_timestamps TO ${sql(runtimeLogin)}`;
  });
  const rows =
    await owner`SELECT created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at, id`;
  assert.deepEqual(
    rows.map(({ created_at }) => Number(created_at)),
    expected,
  );
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
  console.info(`Isolated ${state}: ${version} passed ${routes} routes and exact readiness`);
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
  for (const name of [
    "DATABASE_URL",
    "SESSION_SECRET",
    "DISCORD_CLIENT_SECRET",
    "DISCORD_BOT_TOKEN",
  ]) {
    assert.ok(
      bindings.get(name)?.type === "secret_text",
      "isolated staging is missing a synthetic secret binding",
    );
  }
  assert.ok(bindings.has("CF_VERSION_METADATA"), "staged version metadata binding missing");
  for (const flag of KIT_ROUTE_FLAGS) {
    assert.ok(
      config.vars[flag] === undefined ? !bindings.has(flag) : bindings.get(flag)?.text === "false",
      "staged Kit flag is not off",
    );
  }
}

async function qualify(dir, proofDir) {
  assert.ok(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.GITHUB_REF === "refs/heads/main" &&
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
    "isolated staging requires the protected main dispatch",
  );
  const identity = {
    sourceSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    digest: process.env.CUTOVER_PACKET_DIGEST,
  };
  const suffix = `${identity.runId}-${identity.runAttempt}`;
  assert.match(suffix, /^[1-9]\d{0,14}-[1-9]\d{0,14}$/);
  const inputs = await sourceInputs();
  await verifyPackage(dir, identity, inputs);
  const prefixes = ledgerPrefixes(inputs.journal);
  const database = fixtureDatabase(
    process.env.KIT_CUTOVER_TEST_DATABASE_URL,
    process.env.KIT_CUTOVER_TEST_DATABASE_HOST,
  );
  const api = cloudflare();
  const subdomain = (await api("subdomain"))?.subdomain;
  assert.match(subdomain ?? "", /^[a-z0-9][a-z0-9-]{0,62}$/);
  const worker = `${STAGING_WORKER}-${suffix}`;
  const target = `scripts/${worker}/settings`;
  const origin = `https://${worker}.${subdomain}.workers.dev`;
  assert.equal(await api(target), null, "isolated script already exists");
  const scratch = await mkdtemp(join(process.env.RUNNER_TEMP, "kit-cutover-staging-"));
  const connect = (url) =>
    postgres(url.href, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  const control = connect(database);
  const databaseName = `two_web_cutover_${suffix.replace("-", "_")}`;
  const runtimeLogin = `runtime_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  let createdDb = false;
  let createdLogin = false;
  let mayHaveWorker = false;
  let owner;
  let phase = "synthetic database setup";
  const checks = [];
  const configs = {};
  let routeCount;
  let kitReadinessSamples = 0;
  let hono;
  let kit;
  const cleanupDatabase = async () => {
    try {
      await owner?.end({ timeout: 0 });
      if (createdDb) await control`DROP DATABASE ${control(databaseName)} WITH (FORCE)`;
      if (createdLogin) await control`DROP ROLE ${control(runtimeLogin)}`;
      const [left] = await control`SELECT
        EXISTS (SELECT FROM pg_database WHERE datname = ${databaseName}) AS db,
        EXISTS (SELECT FROM pg_roles WHERE rolname = ${runtimeLogin}) AS login`;
      assert.ok(!left.db && !left.login);
    } catch {
      throw new Error("synthetic database or login cleanup failed");
    } finally {
      await control.end({ timeout: 0 });
      await rm(scratch, { recursive: true, force: true });
    }
  };
  try {
    await control`CREATE DATABASE ${control(databaseName)} TEMPLATE template0`;
    createdDb = true;
    await control`CREATE ROLE ${control(runtimeLogin)} LOGIN PASSWORD ${control.unsafe(`'${password}'`)}`;
    createdLogin = true;
    const runDatabase = new URL(database);
    runDatabase.pathname = `/${databaseName}`;
    owner = connect(runDatabase);
    await owner.unsafe(await readFile("ci/disposable-runtime-role.sql", "utf8")).simple();
    await owner`CREATE SCHEMA drizzle`;
    await owner`CREATE TABLE drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`;
    await owner.unsafe(await readFile("docs/web-readiness-projection.sql", "utf8")).simple();

    const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
    await advance(owner, migrations, prefixes["1033"], runtimeLogin);
    const runtimeDb = new URL(runDatabase);
    runtimeDb.username = runtimeLogin;
    runtimeDb.password = password;
    const secretsFile = join(scratch, "synthetic-bindings.json");
    await writeFile(
      secretsFile,
      JSON.stringify({
        DATABASE_URL: runtimeDb.href,
        SESSION_SECRET: randomUUID(),
        DISCORD_CLIENT_SECRET: "synthetic",
        DISCORD_BOT_TOKEN: "synthetic",
      }),
      { mode: 0o600, flag: "wx" },
    );
    // Do not pass the owner credential to Wrangler or to the Worker.
    delete process.env.KIT_CUTOVER_TEST_DATABASE_URL;

    phase = "same-script staged uploads";
    const tag = `${identity.sourceSha}-${suffix}`;
    const paths = {};
    for (const profile of ["hono", "kit"]) {
      const directory = join(dir, profile);
      const config = stagingConfig(profile, inputs, worker, origin);
      const configPath = join(directory, "wrangler.json");
      paths[profile] = configPath;
      const configText = JSON.stringify(config);
      configs[profile] = sha256(configText);
      await writeFile(configPath, configText, { flag: "wx" });
      if (profile === "hono") {
        mayHaveWorker = true;
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
        hono = liveVersion(
          JSON.parse(wrangler("hono", ["deployments", "list", "--config", configPath, "--json"])),
        );
      } else {
        kit = uploadVersion(profile, directory, config, tag, {
          secretsFile,
          output: join(scratch, "kit.jsonl"),
        });
      }
      const id = profile === "hono" ? hono : kit;
      verifyStagedBindings(await api(`scripts/${worker}/versions/${id}`), id, config);
    }
    const configPath = paths.hono;
    const deployments = () =>
      JSON.parse(wrangler("hono", ["deployments", "list", "--config", configPath, "--json"]));
    const capture = async (state, step, version) => {
      assert.equal(liveVersion(deployments()), version);
      const routes = await verifyServed(origin, prefixes, identity, version, state);
      routeCount ??= routes;
      assert.equal(routes, routeCount, "staged smoke route coverage changed");
      checks.push({ state, step, version, status: 200, pending: 0, smoke: "passed" });
    };
    for (const state of LEDGER_STATES) {
      phase = `isolated Hono, Kit and rollback on ${state}`;
      if (state === "1037") await advance(owner, migrations, prefixes[state], runtimeLogin);
      await capture(state, "hono", hono);
      assert.equal(rollbackAction(deployments(), { expected: hono, target: kit }), "rollback");
      wrangler("hono", ["versions", "deploy", `${kit}@100%`, "--yes", "--config", configPath]);
      try {
        await capture(state, "kit", kit);
        for (let sample = 0; sample < 3; sample++) {
          await delay(20_000);
          await readReady(origin, prefixes, { version: kit, commit: identity.sourceSha, state });
          kitReadinessSamples += 1;
        }
      } finally {
        assert.equal(rollbackAction(deployments(), { expected: kit, target: hono }), "rollback");
        wrangler("hono", ["rollback", hono, "--yes", "--config", configPath]);
      }
      await capture(state, "undo", hono);
    }
  } catch {
    // Driver or provider errors can contain connection and binding values.
    throw new Error(`Cutover staging failed during ${phase}`);
  } finally {
    try {
      if (mayHaveWorker && (await api(target)) !== null) {
        wrangler("hono", ["delete", worker, "--config", join(dir, "hono/wrangler.json")]);
        assert.equal(await api(target), null, "isolated Worker cleanup failed");
      }
    } finally {
      await cleanupDatabase();
    }
  }
  const proof = {
    schema: 1,
    identity,
    worker,
    hono,
    kit,
    checks,
    configs,
    routeCount,
    kitReadinessSamples,
    bindingCheck: "isolated-and-all-off",
  };
  verifyStagingProof(proof, identity);
  await mkdir(proofDir);
  await writeFile(join(proofDir, "proof.json"), JSON.stringify(proof), { flag: "wx" });
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `\nStaged packet: \`${suffix.replace("-", ":")}:${identity.digest}\`\n\nHono: \`${hono}\` · Kit: \`${kit}\`\n`,
  );
}

if (import.meta.main) await qualify(...process.argv.slice(2));
