import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  LEDGER_STATES,
  STAGING_WORKER,
  WranglerOperationError,
  inventory,
  ledgerPrefixes,
  productionUploadConfig,
  sourceInputs,
  verifyPackage,
  verifyReady,
  verifyStagingProof,
  writeManifest,
} from "./kit-cutover-evidence.mjs";
import { packageCutover } from "./kit-cutover-package.mjs";
import { cloudflare, exercise, verifyServed } from "./kit-cutover-staging.mjs";
import { KIT_ROUTE_FLAGS } from "./production-deploy-gate.mjs";

const sourceSha = "a".repeat(40);
const digest = "b".repeat(64);
const hono = "11111111-1111-1111-1111-111111111111";
const kit = "22222222-2222-2222-2222-222222222222";
const identity = { sourceSha, runId: "21", runAttempt: "3", digest };
const ledgerJournal = [
  "1032_event-public-join-details",
  "1033_session-roles-checked-at",
  "1034_event-echoes",
  "1035_bot-reconciliation-intents",
  "1036_event-sync-claim-started",
  "1037_waitlist-offers",
  "1038_announcement-send-claims",
].map((tag, i) => ({ tag, when: 1700000000000 + i }));

const inputs = await sourceInputs();

test("packaging refuses installed Kit asset drift after parity", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "cutover-packaging-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repo = join(scratch, "repo");
  const assets = join(scratch, "installed/cloudflare");
  const asset = join(assets, "_app/immutable/fixture.js");
  const name = "two-web-next-production";
  const wrangler = { version: "1.2.3" };
  const sourceFiles = {
    "wrangler.jsonc": { env: { production: { name, main: "src/worker.ts" } } },
    "web/wrangler.production.jsonc": {
      name,
      main: ".svelte-kit/cloudflare/_worker.js",
      vars: Object.fromEntries(KIT_ROUTE_FLAGS.map((flag) => [flag, "false"])),
      triggers: { crons: [] },
      workers_dev: false,
      preview_urls: false,
      assets: { directory: ".svelte-kit/cloudflare" },
    },
    "drizzle/meta/_journal.json": { entries: [] },
    "package-lock.json": { packages: { "node_modules/wrangler": wrangler } },
    "node_modules/wrangler/package.json": wrangler,
  };
  for (const [file, data] of Object.entries(sourceFiles)) {
    const path = join(repo, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data));
  }
  await mkdir(join(repo, "public"));
  await writeFile(join(repo, "public/fixture.txt"), "synthetic Hono asset");
  await mkdir(join(repo, "node_modules/.bin"));
  await writeFile(
    join(repo, "node_modules/.bin/wrangler"),
    "#!/bin/sh\nprintf 'invoked\\n' > wrangler-invoked\nexit 1\n",
    { mode: 0o755 },
  );

  await mkdir(dirname(asset), { recursive: true });
  await writeFile(join(assets, "_worker.js"), "synthetic Kit facade");
  await writeFile(join(assets, "kit-adapter.js"), "synthetic Kit adapter");
  await writeFile(asset, "parity-approved asset bytes");
  const files = Object.fromEntries(
    Object.entries(await inventory(assets)).map(([path, hash]) => [`cloudflare/${path}`, hash]),
  );
  const context = { sourceSha, runId: identity.runId, runAttempt: identity.runAttempt };
  const output = join(scratch, "github-output");
  const summary = join(scratch, "github-summary");
  await writeFile(output, "");
  await writeFile(summary, "");
  for (const [key, value] of Object.entries({
    RUNNER_TEMP: scratch,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
  })) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }

  for (const [change, mutate] of [
    ["changed", () => writeFile(asset, "changed after parity")],
    ["missing", () => rm(asset)],
  ]) {
    await t.test(`${change} asset`, async () => {
      await mutate();
      const packet = join(scratch, `packet-${change}`);
      await assert.rejects(packageCutover(packet, repo, { assets }, { files }, context), {
        code: "ERR_ASSERTION",
        message: /^installed Kit assets drifted after parity\b/,
      });
      await assert.rejects(lstat(join(packet, "manifest.json")), { code: "ENOENT" });
      await assert.rejects(lstat(join(repo, "wrangler-invoked")), { code: "ENOENT" });
      assert.equal(await readFile(output, "utf8"), "");
      assert.equal(await readFile(summary, "utf8"), "");
    });
  }
});

async function writePacketFixture(dir) {
  for (const profile of ["hono", "kit"]) {
    await mkdir(join(dir, profile, "modules"), { recursive: true });
    await mkdir(join(dir, profile, "assets"));
    await writeFile(join(dir, profile, "assets", ".assetsignore"), "fixture");
  }
  await writeFile(join(dir, "hono/modules/worker.js"), "pure Hono");
  await writeFile(join(dir, "kit/modules/_worker.js"), "facade");
  await writeFile(join(dir, "kit/modules/kit-adapter.js"), "Kit adapter");
  const context = { sourceSha, runId: identity.runId, runAttempt: identity.runAttempt };
  return { ...context, digest: await writeManifest(dir, context, inputs) };
}

test("cutover packet refuses wrong bytes, package identity, or source config", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "cutover-packet-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const pin = await writePacketFixture(scratch);
  await verifyPackage(scratch, pin, inputs);
  await assert.rejects(verifyPackage(scratch, { ...pin, digest }, inputs), /manifest digest/);
  for (const [field, value] of [
    ["sourceSha", "d".repeat(40)],
    ["runId", "22"],
    ["runAttempt", "4"],
  ]) {
    await assert.rejects(
      verifyPackage(scratch, { ...pin, [field]: value }, inputs),
      new RegExp(field),
    );
  }
  await assert.rejects(
    verifyPackage(scratch, pin, {
      digests: { ...inputs.digests, honoConfig: digest },
    }),
    /config or journal digest/,
  );
  await assert.rejects(
    verifyPackage(scratch, pin, {
      ...inputs,
      honoBuild: { ...inputs.honoBuild, define: "__TWO_WEB_1033_COMPAT__:false" },
    }),
    /Hono build profile/,
  );
  await writeFile(join(scratch, "kit/modules/kit-adapter.js"), "changed");
  await assert.rejects(verifyPackage(scratch, pin, inputs), /kit bytes mismatch/);
  await writeFile(join(scratch, "kit/modules/kit-adapter.js"), "Kit adapter");
  await writeFile(join(scratch, "hono/assets/.assetsignore"), "changed Hono asset control file");
  await assert.rejects(verifyPackage(scratch, pin, inputs), /hono bytes mismatch/);
});

test("isolated qualification refuses changed packet bytes and preserves earlier proof", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "cutover-handoff-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const packet = join(scratch, "kit-cutover-packet");
  const proofPath = join(scratch, "proof.json");
  const earlierProof = Buffer.from('{"fixture":"earlier isolated proof"}\n');
  const pin = await writePacketFixture(packet);
  await verifyPackage(packet, pin, inputs);
  await writeFile(proofPath, earlierProof);
  await writeFile(join(packet, "kit/modules/kit-adapter.js"), "Kit ADAPTER");

  const result = spawnSync(process.execPath, ["ci/kit-cutover-staging.mjs", packet, proofPath], {
    // Pass only the dispatch identity. The subprocess receives no service credentials.
    env: {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_SHA: pin.sourceSha,
      GITHUB_RUN_ID: pin.runId,
      GITHUB_RUN_ATTEMPT: pin.runAttempt,
      RUNNER_TEMP: scratch,
      CUTOVER_PACKET_DIGEST: pin.digest,
      CUTOVER_PROFILE: "ember",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /AssertionError \[ERR_ASSERTION\]: cutover kit bytes mismatch/);
  assert.equal(result.stdout, "");
  assert.deepEqual(await readFile(proofPath), earlierProof);
  assert.deepEqual((await readdir(scratch)).sort(), ["kit-cutover-packet", "proof.json"]);
});

test("cutover ledger admits exactly 1033 or 1037 and exact version readiness", () => {
  const prefixes = ledgerPrefixes(ledgerJournal);
  assert.throws(
    () => ledgerPrefixes([...ledgerJournal, { tag: "1039_later", when: 1700000000007 }]),
    /approved cutover window/,
  );
  const body = {
    db: "ok",
    pending_migrations: 0,
    migration_ledger: prefixes["1033"],
    revision: { version_id: hono, commit: sourceSha },
  };
  const expected = { version: hono, commit: sourceSha };
  for (const [state, rows] of Object.entries(prefixes)) {
    assert.equal(verifyReady(200, { ...body, migration_ledger: rows }, prefixes, expected), state);
  }
  assert.throws(() => verifyReady(503, body, prefixes, expected), /readiness/);
  assert.throws(() => verifyReady(200, { ...body, pending_migrations: 1 }, prefixes), /readiness/);
  assert.throws(() => verifyReady(200, body, prefixes, { version: kit }), /version or commit/);
  assert.throws(
    () => verifyReady(200, body, prefixes, { ...expected, commit: "c".repeat(40) }),
    /version or commit/,
  );
  assert.throws(() => verifyReady(200, body, prefixes, { ...expected, state: "1037" }), /state/);
  for (const rows of [
    prefixes["1037"].slice(0, -1),
    [...prefixes["1033"], prefixes["1037"].at(-1)],
    [...prefixes["1037"], ledgerJournal.at(-1).when],
    [...prefixes["1033"], prefixes["1033"].at(-1)],
    prefixes["1033"].map(String),
  ]) {
    assert.throws(
      () => verifyReady(200, { ...body, migration_ledger: rows }, prefixes),
      /canonical/,
    );
  }
});

test("isolated Workers API GET bounds and disposes provider responses", async (t) => {
  const account = "a".repeat(32);
  const token = "synthetic-token";
  const settingsPath = "scripts/synthetic-worker/settings";
  const versionPath = `scripts/synthetic-worker/versions/${kit}`;
  const mockApi = (respond) =>
    cloudflare({
      account,
      token,
      fetchImpl: async (url, options) => {
        assert.equal(options.method, "GET");
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        assert.equal(options.redirect, "error");
        assert.ok(options.signal instanceof AbortSignal);
        const prefix = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/`;
        assert.ok(url.startsWith(prefix));
        return respond(url.slice(prefix.length));
      },
    });

  await t.test("cancels an oversized stream before reading to EOF", async () => {
    const halfMiB = new Uint8Array(512 * 1024).fill(32);
    const json = new TextEncoder().encode(JSON.stringify({ success: true, result: { id: kit } }));
    const chunks = [halfMiB, halfMiB, json];
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream(
      {
        pull(controller) {
          const chunk = chunks[pulls++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const api = mockApi(() => new Response(stream));

    await assert.rejects(api(versionPath), { message: "staging Workers API response too large" });
    assert.equal(pulls, 3);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  });

  await t.test("returns null for missing settings and cancels without pulling", async () => {
    let cancelled = false;
    const stream = new ReadableStream(
      {
        pull() {
          assert.fail("missing-resource body was read");
        },
        cancel() {
          cancelled = true;
          throw new Error("synthetic cancellation failure");
        },
      },
      { highWaterMark: 0 },
    );
    const api = mockApi(() => new Response(stream, { status: 404 }));

    assert.equal(await api(settingsPath), null);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  });

  await t.test("returns synthetic version and settings evidence", async () => {
    const version = {
      id: kit,
      resources: { bindings: [{ name: "DATABASE_URL", type: "secret_text" }] },
    };
    const settings = { bindings: [{ name: "FIXTURE_NAME", type: "plain_text", text: "Épreuve" }] };
    const api = mockApi((path) => {
      if (path === versionPath) return Response.json({ success: true, result: version });
      assert.equal(path, settingsPath);
      const bytes = new TextEncoder().encode(JSON.stringify({ success: true, result: settings }));
      const split = bytes.indexOf(0xc3) + 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(0, split));
            controller.enqueue(bytes.subarray(split));
            controller.close();
          },
        }),
      );
    });

    assert.deepEqual(await api(versionPath), version);
    assert.deepEqual(await api(settingsPath), settings);
  });

  await t.test("reports malformed JSON and provider errors without response data", async () => {
    const invalid = mockApi(() => new Response("synthetic private response"));
    const refused = mockApi(() => Response.json({ success: "synthetic private response" }));

    await assert.rejects(invalid(settingsPath), {
      message: "staging Workers API response was not valid JSON",
    });
    await assert.rejects(refused(settingsPath), {
      message: "staging Workers API returned an error",
    });
  });
});

test("isolated cutover repeats readiness and smoke when rollback is still propagating", async () => {
  const origin = "https://cutover.example.invalid";
  const prefixes = ledgerPrefixes(ledgerJournal);
  const calls = [];
  let attempt = 0;
  const routeCount = await verifyServed(origin, prefixes, identity, hono, "1033", "hono", {
    probeReady: async (url, ledger, expected) => {
      assert.equal(url, origin);
      assert.equal(ledger, prefixes);
      assert.deepEqual(expected, { version: hono, commit: sourceSha, state: "1033" });
      calls.push("readiness");
      attempt += 1;
      if (attempt === 2) throw new Error("Worker readiness version or commit mismatch");
    },
    probeRoutes: async (url, { expectedVersionId, expectedCutoverRenderer, onRoute }) => {
      assert.equal(url, origin);
      assert.equal(expectedVersionId, hono);
      assert.equal(expectedCutoverRenderer, "hono");
      // Smoke would pass on attempt two even though readiness just regressed.
      const converged = attempt > 1;
      calls.push("smoke");
      onRoute("/up", converged ? 0 : 1);
      onRoute("/", converged ? 0 : 1);
      return converged;
    },
    wait: async (ms) => {
      assert.equal(ms, 10_000);
      calls.push("wait");
    },
  });
  assert.equal(routeCount, 2);
  assert.deepEqual(calls, [
    "readiness",
    "smoke",
    "wait",
    "readiness",
    "wait",
    "readiness",
    "smoke",
  ]);
});

test("isolated cutover refuses six stale readiness observations at the 1037 rollback target", async () => {
  const origin = "https://cutover.example.invalid";
  const prefixes = ledgerPrefixes(ledgerJournal);
  const stale = {
    db: "ok",
    pending_migrations: 0,
    migration_ledger: prefixes["1037"],
    revision: { version_id: kit, commit: sourceSha },
  };
  const calls = [];
  await assert.rejects(
    verifyServed(origin, prefixes, identity, hono, "1037", "hono", {
      probeReady: async (url, ledger, expected) => {
        calls.push(["readiness", url, ledger, expected]);
        return verifyReady(200, stale, ledger, expected);
      },
      probeRoutes: async (_origin, { onRoute }) => {
        calls.push(["smoke"]);
        onRoute("/", 0);
        return true;
      },
      wait: async (ms) => {
        calls.push(["wait", ms]);
      },
    }),
    { message: "staging failed exact version and ledger verification" },
  );
  const expected = { version: hono, commit: sourceSha, state: "1037" };
  const readiness = ["readiness", origin, prefixes, expected];
  assert.deepEqual(calls, [
    ...Array.from({ length: 5 }, () => [readiness, ["wait", 10_000]]).flat(),
    readiness,
  ]);
});

test("isolated cutover refuses persistent smoke failures after six attempts", async () => {
  const calls = [];
  await assert.rejects(
    verifyServed(
      "https://cutover.example.invalid",
      ledgerPrefixes(ledgerJournal),
      identity,
      hono,
      "1033",
      "hono",
      {
        probeReady: async () => {
          calls.push("readiness");
        },
        probeRoutes: async (_origin, { onRoute }) => {
          calls.push("smoke");
          onRoute("/", 1);
          return false;
        },
        wait: async () => {
          calls.push("wait");
        },
      },
    ),
    /isolated public-route smoke failed/,
  );
  assert.deepEqual(calls, [
    ...Array.from({ length: 5 }, () => ["readiness", "smoke", "wait"]).flat(),
    "readiness",
    "smoke",
  ]);
});

test("isolated cutover refuses successful smoke with no route checks", async () => {
  const calls = [];
  await assert.rejects(
    verifyServed(
      "https://cutover.example.invalid",
      ledgerPrefixes(ledgerJournal),
      identity,
      hono,
      "1037",
      "hono",
      {
        probeReady: async () => {
          calls.push("readiness");
        },
        probeRoutes: async () => {
          calls.push("smoke");
          return true;
        },
        wait: async () => {
          calls.push("wait");
        },
      },
    ),
    { message: "isolated route smoke ran no checks" },
  );
  assert.deepEqual(calls, ["readiness", "smoke"]);
});

test("isolated cutover proof requires both exact versions and six healthy transitions", () => {
  const checks = LEDGER_STATES.flatMap((state) =>
    ["hono", "kit", "undo"].map((step) => ({
      state,
      step,
      version: step === "kit" ? kit : hono,
      status: 200,
      pending: 0,
      smoke: "passed",
    })),
  );
  const proof = {
    schema: 1,
    identity,
    worker: `${STAGING_WORKER}-21-3`,
    hono,
    kit,
    checks,
    configs: { kit: digest, hono: digest },
    routeCount: 24,
    kitReadinessSamples: 6,
    bindingCheck: "isolated-and-all-off",
  };
  verifyStagingProof(proof, identity);
  const ember = { ...proof, bindingCheck: "isolated-and-ember" };
  const emberPin = { ...identity, mode: "ember" };
  verifyStagingProof(ember, emberPin);
  assert.throws(
    () => verifyStagingProof({ ...ember, kit: hono }, emberPin),
    /staging requires distinct versions on one Worker/,
  );
  assert.throws(
    () =>
      verifyStagingProof(
        { ...ember, configs: { ...ember.configs, kit: "g".repeat(64) } },
        emberPin,
      ),
    /invalid staged config digests/,
  );
  assert.throws(
    () => verifyStagingProof({ ...ember, routeCount: 0 }, emberPin),
    /empty staged route smoke/,
  );
  verifyStagingProof(ember, { ...identity, mode: "hono" });
  assert.throws(() => verifyStagingProof(ember, { ...identity, mode: "kit" }), /profile/);
  assert.throws(() => verifyStagingProof(proof, emberPin), /profile/);
  assert.throws(() => verifyStagingProof({ ...proof, kitReadinessSamples: 5 }, identity));
  assert.throws(() => verifyStagingProof({ ...proof, bindingCheck: "unobserved" }, identity));
  for (const change of [{ status: 503 }, { pending: 1 }, { version: kit }, { smoke: "failed" }]) {
    assert.throws(
      () =>
        verifyStagingProof(
          {
            ...proof,
            checks: checks.map((row, i) => (i === 2 ? { ...row, ...change } : row)),
          },
          identity,
        ),
      /must prove/,
    );
  }
  assert.throws(() => verifyStagingProof(proof, { ...identity, runAttempt: "2" }), /identity/);
  assert.throws(
    () => verifyStagingProof({ ...proof, checks: checks.slice(0, 3) }, identity),
    /must prove/,
  );
  const adminPin = { ...identity, mode: "admin" };
  const admin = {
    ...proof,
    ember: hono,
    configs: { kit: digest, ember: digest },
    checks: checks
      .slice(3)
      .map((row) => ({ ...row, step: row.step === "hono" ? "ember" : row.step })),
    kitReadinessSamples: 3,
    bindingCheck: "isolated-and-admin",
    adminChecks: ["default-denied", "credential-separation", "ownership-undo"],
  };
  verifyStagingProof(admin, adminPin);
  assert.throws(
    () => verifyStagingProof({ ...admin, bindingCheck: ember.bindingCheck }, adminPin),
    /profile/,
  );
  assert.throws(() => verifyStagingProof({ ...admin, adminChecks: [] }, adminPin));
  assert.throws(() => verifyStagingProof({ ...admin, checks: admin.checks.slice(0, 2) }, adminPin));
});

test("Ember cutover configuration opts in only the Ember documents", () => {
  const allOff = productionUploadConfig("kit", inputs);
  assert.equal(allOff.vars.KIT_ROUTE_EMBER_PAGES, "false");
  const vars = {
    ...allOff.vars,
    KIT_ROUTE_ADMIN: "false",
    KIT_ROUTE_EMBER_PAGES: "true",
    KIT_ROUTE_AUTH: "false",
    KIT_ROUTE_FEEDS: "false",
    KIT_ROUTE_SEO: "false",
    KIT_ROUTE_SECURITY_TXT: "false",
    DISCORD_LIVE_SOCKET_ENABLED: "false",
  };
  assert.deepEqual(productionUploadConfig("kit", inputs, "ember"), { ...allOff, vars });
  assert.throws(() => productionUploadConfig("hono", inputs, "ember"), /requires the Kit artifact/);
  assert.deepEqual(productionUploadConfig("kit", inputs, "admin"), {
    ...allOff,
    vars: { ...vars, KIT_ROUTE_ADMIN: "true" },
  });
});

test("isolated database admission fixes the host, database, owner, and run scope", async () => {
  const { fixtureDatabase, fixtureNames } = await import("./kit-cutover-database.mjs");
  const host = "ep-fixture.us-east-2.aws.neon.tech";
  const fixture = `postgresql://two_web_cutover_owner:synthetic@${host}/two_web_cutover`;
  assert.equal(fixtureDatabase(fixture, host).searchParams.get("sslmode"), "verify-full");
  assert.throws(() => fixtureDatabase(fixture, "ep-different.us-east-2.aws.neon.tech"));
  assert.throws(() => fixtureDatabase(fixture.replace("/two_web_cutover", "/main"), host));
  assert.throws(() => fixtureDatabase(`${fixture}?options=override`, host));
  assert.deepEqual(fixtureNames("21", "3"), {
    suffix: "21-3",
    db: "two_web_cutover_21_3",
    login: "two_web_cutover_21_3_runtime",
  });
  assert.throws(() => fixtureNames("21", "03"));
});

test("Ember fixture requires the exact 1033 starting prefix before recording 1037 proof", async (t) => {
  const prefixes = ledgerPrefixes(inputs.journal);
  const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
  const names = { login: "two_web_cutover_21_3_runtime" };
  const pin = { ...identity, mode: "ember" };

  for (const [name, extraRows] of [
    ["canonical 1034 prefix refuses", 1],
    ["canonical 1033 prefix advances", 0],
  ]) {
    await t.test(name, async (t) => {
      // Supply the ledger at the transition read, after the 1033 observations.
      const rows = migrations
        .slice(0, prefixes[1033].length + extraRows)
        .map(({ folderMillis, hash }) => ({ created_at: String(folderMillis), hash }));
      const owner = ([query]) => {
        assert.match(
          query,
          /^SELECT created_at::text(?:, hash)? FROM drizzle\.__drizzle_migrations/,
        );
        return rows;
      };
      owner.begin = t.mock.fn(async (transaction) => {
        const sql = (query, ...values) => {
          if (typeof query === "string") {
            assert.equal(query, names.login);
            return query;
          }
          if (query[0].startsWith("INSERT INTO drizzle.__drizzle_migrations")) {
            const [hash, createdAt] = values;
            rows.push({ hash, created_at: String(createdAt) });
            return;
          }
          assert.match(query[0], /^GRANT /);
        };
        sql.unsafe = () => {};
        await transaction(sql);
      });

      const proof = {
        schema: 1,
        identity,
        worker: `${STAGING_WORKER}-21-3`,
        hono,
        kit,
        checks: [],
        configs: { kit: digest, hono: digest },
        kitReadinessSamples: 0,
        bindingCheck: "isolated-and-ember",
      };
      let live = hono;
      const traffic = [];
      const run = exercise(
        proof,
        prefixes,
        owner,
        names,
        "https://cutover.example.invalid",
        ".",
        {},
        {
          profile: "ember",
          runWrangler: (profile, [command, subcommand, target]) => {
            assert.equal(profile, "hono");
            if (command === "deployments" && subcommand === "list") {
              return JSON.stringify([{ versions: [{ version_id: live, percentage: 100 }] }]);
            }
            if (command === "versions" && subcommand === "deploy") {
              assert.equal(target, `${kit}@100%`);
              live = kit;
            } else {
              assert.equal(command, "rollback");
              assert.equal(subcommand, hono);
              live = hono;
            }
            traffic.push(live);
          },
          serve: async (_origin, _prefixes, _identity, version, state, renderer) => {
            assert.equal(renderer, version === kit ? "kit" : "hono");
            if (state === "1037") {
              assert.deepEqual(
                rows.map(({ created_at }) => Number(created_at)),
                prefixes[1037],
              );
            }
            return 1;
          },
          ready: async () => {},
          wait: async () => {},
        },
      );

      if (extraRows) {
        await assert.rejects(run, /unexpected starting prefix/);
        assert.equal(owner.begin.mock.callCount(), 0);
        assert.deepEqual(traffic, [kit, hono]);
        assert.deepEqual(
          proof.checks.map(({ state }) => state),
          ["1033", "1033", "1033"],
        );
        assert.equal(proof.kitReadinessSamples, 3);
        assert.throws(() => verifyStagingProof(proof, pin));
      } else {
        await run;
        assert.equal(owner.begin.mock.callCount(), 1);
        assert.deepEqual(traffic, [kit, hono, kit, hono]);
        verifyStagingProof(proof, pin);
      }
    });
  }
});

test("isolated upload diagnostics keep only the operation, exit status and provider code", () => {
  const error = new WranglerOperationError(["versions", "upload", "configured-entry"], {
    status: 1,
    stderr: "untrusted binding details [code: 10007]",
  });
  assert.equal(error.message, "Wrangler versions upload failed (exit 1), provider code 10007");
  for (const stderr of [
    undefined,
    "[code: 123]",
    Buffer.from("[code: 123456789]"),
    "[code: TOKEN]",
  ]) {
    const refusal = new WranglerOperationError(
      ["rollback", "11111111-1111-1111-1111-111111111111"],
      {
        status: null,
        stderr,
      },
    );
    assert.equal(refusal.message, "Wrangler rollback failed");
  }
});
