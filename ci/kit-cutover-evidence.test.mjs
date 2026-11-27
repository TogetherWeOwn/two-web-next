import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { calendarFixtures, joinAction, smokeFixtures } from "../test/fixtures/smoke-routes.mjs";
import { startSmokeFixture } from "../test/helpers/smoke-http.mjs";
import { stagingConfig } from "./kit-cutover-database.mjs";
import {
  LEDGER_STATES,
  STAGING_WORKER,
  WranglerOperationError,
  inventory,
  ledgerPrefixes,
  productionUploadConfig,
  readReady,
  sourceInputs,
  verifyPackage,
  verifyReady,
  verifyStagingProof,
  writeManifest,
} from "./kit-cutover-evidence.mjs";
import { packageCutover } from "./kit-cutover-package.mjs";
import {
  cloudflare,
  exercise,
  verifyServed,
  verifyStagedBindings,
} from "./kit-cutover-staging.mjs";
import "./fixtures/kit-cutover-cleanup.mjs";
import { KIT_ROUTE_FLAGS } from "./production-deploy-gate.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

const sourceSha = "a".repeat(40);
const digest = "b".repeat(64);
const hono = "11111111-1111-1111-1111-111111111111";
const kit = "22222222-2222-2222-2222-222222222222";
const identity = { sourceSha, runId: "21", runAttempt: "3", digest };
const inputs = await sourceInputs();
// Keep the offline rehearsal usable after the repository adds later migrations.
const cutoverEnd = inputs.journal.findIndex(({ tag }) => tag === "1038_announcement-send-claims");
const ledgerJournal = inputs.journal.slice(0, cutoverEnd + 1);

test("isolated Worker settings and deletion readback uses bounded offline streams", async (t) => {
  const account = "a".repeat(32);
  const token = "synthetic";
  const script = "scripts/synthetic-worker";
  const settings = `${script}/settings`;
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/`;
  const limit = 1024 * 1024;
  const result = { bindings: [{ name: "FIXTURE", type: "plain_text", text: "Épreuve" }] };
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  const envelope = encode({ success: true, result });
  const split = envelope.indexOf(0xc3) + 1;
  const chunks = [envelope.subarray(0, split), envelope.subarray(split)];
  const padding = new Uint8Array(limit - envelope.byteLength).fill(32);
  const fixture = (chunks, status = 200) => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream(
      {
        pull(controller) {
          const chunk = chunks[pulls++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          cancelled = true;
          // A stalled cancellation must never delay a verdict.
          return new Promise(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    return {
      response: new Response(body, { status }),
      state: () => ({ pulls, cancelled, locked: body.locked }),
    };
  };
  const offlineApi = (method, path, respond) =>
    cloudflare({
      account,
      token,
      fetchImpl: async (url, options) => {
        assert.equal(url, `${base}${path}`);
        assert.equal(options.method, method);
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        assert.equal(options.redirect, "error");
        assert.ok(options.signal instanceof AbortSignal);
        return respond(options.signal);
      },
    });

  const timeout = t.mock.method(AbortSignal, "timeout");
  const existing = fixture([...chunks, padding]);
  assert.deepEqual(await offlineApi("GET", settings, () => existing.response)(settings), result);
  const deleted = fixture([encode({ success: true, result: null })]);
  assert.equal(await offlineApi("DELETE", script, () => deleted.response)(script, "DELETE"), null);

  for (const [method, path] of [
    ["DELETE", script],
    ["GET", settings],
  ]) {
    const request = (respond) => offlineApi(method, path, respond)(path, method);
    const oversized = fixture([...chunks, padding, Uint8Array.of(32)]);
    await assert.rejects(
      request(() => oversized.response),
      {
        message: "staging Workers API response too large",
      },
    );
    assert.deepEqual(oversized.state(), { pulls: 4, cancelled: true, locked: false });

    const missing = fixture([], 404);
    assert.equal(await request(() => missing.response), null);
    assert.deepEqual(missing.state(), { pulls: 0, cancelled: true, locked: false });

    const refused = fixture([], 502);
    for (const [response, message] of [
      [fixture([]).response, "staging Workers API response was not valid JSON"],
      [
        fixture([new TextEncoder().encode("synthetic private response")]).response,
        "staging Workers API response was not valid JSON",
      ],
      [fixture([Uint8Array.of(0xff)]).response, "staging Workers API response could not be read"],
      [refused.response, "staging Workers API refused the request"],
      [
        fixture([encode({ success: "synthetic private response" })]).response,
        "staging Workers API returned an error",
      ],
    ]) {
      await assert.rejects(
        request(() => response),
        { message },
      );
    }
    assert.deepEqual(refused.state(), { pulls: 0, cancelled: true, locked: false });
    await assert.rejects(
      request(() => {
        throw new Error("synthetic private transport error");
      }),
      { message: "staging Workers API request failed" },
    );
  }
  assert.deepEqual(existing.state(), { pulls: 4, cancelled: false, locked: false });
  assert.deepEqual(deleted.state(), { pulls: 2, cancelled: false, locked: false });

  const missingResult = fixture([encode({ success: true, result: null })]);
  await assert.rejects(offlineApi("GET", settings, () => missingResult.response)(settings), {
    message: "staging Workers API returned invalid settings",
  });
  assert.ok(timeout.mock.calls.length > 0);
  for (const call of timeout.mock.calls) assert.deepEqual(call.arguments, [10_000]);
});

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

test("isolated cutover cleanup CLI reports each failure and keeps the claim for retry", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "cutover-cleanup-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const worker = `${STAGING_WORKER}-21-3`;
  const dbHost = "ep-cleanup.example.neon.tech";
  const claim = join(scratch, "kit-cutover-claimed.json");
  const preload = `
    import assert from "node:assert/strict";
    import fs from "node:fs/promises";
    import { registerHooks, syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const claimOperation = process.env.FAKE_CLAIM_OPERATION;
    if (claimOperation) {
      const claimPath = join(process.env.RUNNER_TEMP, "kit-cutover-claimed.json");
      const original = fs[claimOperation];
      fs[claimOperation] = async (path, ...args) => {
        if (path === claimPath) throw Object.assign(new Error("raw claim I/O detail"), { code: "EIO" });
        return original(path, ...args);
      };
      syncBuiltinESMExports();
    }
    let deleted = process.env.FAKE_WORKER === "absent";
    globalThis.fetch = async (url, { method }) => {
      const target = "https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/workers/scripts/${worker}";
      if (method === "DELETE") {
        assert.equal(url, target);
        console.log("Worker delete");
        if (process.env.FAKE_WORKER === "fail") throw new Error("raw Worker detail");
        deleted = true;
      } else {
        assert.equal(method, "GET");
        assert.equal(url, target + "/settings");
        console.log("Worker settings");
        if (deleted) return new Response(null, { status: 404 });
      }
      return Response.json({ success: true, result: {} });
    };
    globalThis.fakePostgres = (url) => {
      assert.equal(url, "postgresql://two_web_cutover_owner:fixture@${dbHost}/two_web_cutover?sslmode=verify-full");
      const execute = async (template, name) => {
        if (template[0].startsWith("DROP DATABASE")) {
          assert.equal(name, "two_web_cutover_21_3");
          console.log("Database drop");
          if (process.env.FAKE_DATABASE === "fail") throw new Error("raw database detail");
        } else if (template[0].startsWith("DROP ROLE")) {
          assert.equal(name, "two_web_cutover_21_3_runtime");
          console.log("Login drop");
        } else {
          assert.match(template[0], /^SELECT/);
          console.log("Database and login verification");
          return [{ db: false, login: false }];
        }
      };
      // The client uses the same callable for SQL and synchronous identifiers.
      return Object.assign((query, ...values) => typeof query === "string" ? query : execute(query, ...values), {
        end: async () => {},
      });
    };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "postgres") {
          return { url: "data:text/javascript,export default globalThis.fakePostgres", shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
  `;
  function run(workerMode, databaseMode, claimOperation = "") {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        "ci/kit-cutover-staging.mjs",
        "--cleanup",
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
          GITHUB_REF: "refs/heads/main",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_RUN_ID: "21",
          GITHUB_RUN_ATTEMPT: "3",
          CUTOVER_PROFILE: "ember",
          RUNNER_TEMP: scratch,
          CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
          CLOUDFLARE_API_TOKEN: workerMode === "unconfigured" ? "" : "fixture",
          KIT_CUTOVER_TEST_DATABASE_HOST: dbHost,
          KIT_CUTOVER_TEST_DATABASE_URL:
            databaseMode === "unconfigured"
              ? ""
              : `postgresql://two_web_cutover_owner:fixture@${dbHost}/two_web_cutover`,
          FAKE_WORKER: workerMode,
          FAKE_DATABASE: databaseMode,
          FAKE_CLAIM_OPERATION: claimOperation,
        },
      },
    );
    assert.ifError(result.error);
    assert.doesNotMatch(result.stdout + result.stderr, /raw (Worker|database|claim I\/O) detail/);
    return result;
  }

  const workerCleanup = ["Worker settings", "Worker delete", "Worker settings"];
  const databaseCleanup = ["Database drop", "Login drop", "Database and login verification"];
  for (const [workerMode, databaseMode, failures, operations] of [
    ["fail", "fail", "Worker, database and login", [...workerCleanup.slice(0, 2), "Database drop"]],
    ["fail", "ok", "Worker", [...workerCleanup.slice(0, 2), ...databaseCleanup]],
    ["ok", "fail", "database and login", [...workerCleanup, "Database drop"]],
    ["unconfigured", "ok", "Worker", databaseCleanup],
    ["ok", "unconfigured", "database and login", workerCleanup],
  ]) {
    await t.test(`Worker ${workerMode}, database ${databaseMode}`, async () => {
      await writeFile(claim, worker);
      const result = run(workerMode, databaseMode);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.stdout.trim().split("\n"), operations);
      assert.equal(await readFile(claim, "utf8"), worker);
      assert.equal(
        result.stderr.split("\n").find((line) => line.startsWith("Error: ")),
        `Error: Could not verify isolated cleanup: ${failures}`,
      );
    });
  }
  await t.test("successful retry tolerates a Worker already removed", async () => {
    const result = run("absent", "ok");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), ["Worker settings", ...databaseCleanup]);
    assert.equal(result.stderr, "");
    await assert.rejects(readFile(claim, "utf8"), { code: "ENOENT" });
  });
  await t.test("successful cleanup deletes and verifies the Worker", async () => {
    await writeFile(claim, worker);
    const result = run("ok", "ok");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [...workerCleanup, ...databaseCleanup]);
    assert.equal(result.stderr, "");
    await assert.rejects(readFile(claim, "utf8"), { code: "ENOENT" });
  });
  await t.test("missing claim needs no configuration", () => {
    const result = run("unconfigured", "unconfigured");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
  });
  await t.test("mismatched claim stays private and prevents cleanup", async () => {
    const foreignMarker = "untrusted claim contents";
    await writeFile(claim, foreignMarker);
    const result = run("ok", "ok");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error: Isolated cleanup claim mismatch$/m);
    assert.ok(!result.stderr.includes(foreignMarker));
    assert.equal(await readFile(claim, "utf8"), foreignMarker);
  });
  for (const [operation, diagnostic, calls] of [
    ["readFile", "read", []],
    ["rm", "clear", [...workerCleanup, ...databaseCleanup]],
  ]) {
    await t.test(`claim ${diagnostic} failure preserves the claim`, async () => {
      await writeFile(claim, worker);
      const result = run("ok", "ok", operation);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout.trim(), calls.join("\n"));
      assert.equal(
        result.stderr.split("\n").find((line) => line.startsWith("Error: ")),
        `Error: Could not ${diagnostic} isolated cleanup claim`,
      );
      assert.equal(await readFile(claim, "utf8"), worker);
    });
  }
});

test("cutover inventory bounds entries across directories even for tiny files", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "cutover-inventory-count-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  assert.deepEqual(await inventory(scratch), {});
  const invalidName = join(scratch, "bad name");
  await writeFile(invalidName, "x");
  await assert.rejects(inventory(scratch), /unsafe cutover asset name/);
  await rm(invalidName);

  const fileDigest = sha256("x");
  const expected = {};
  for (const directory of ["assets", "modules"]) {
    await mkdir(join(scratch, directory));
    for (let index = 0; index < 255; index += 1) {
      const name = `${directory}/file-${index}`;
      await writeFile(join(scratch, name), "x");
      expected[name] = fileDigest;
    }
  }
  // Two directories and 510 one-byte files use all 512 entries.
  assert.deepEqual(await inventory(scratch), expected);

  const extra = join(scratch, "assets", "extra");
  await writeFile(extra, "x");
  await assert.rejects(inventory(scratch), /cutover package entry count limit/);
  await rm(extra);
  await mkdir(extra);
  await assert.rejects(inventory(scratch), /cutover package entry count limit/);

  await writeFile(join(scratch, "assets", "one-more"), "x");
  const { default: fs } = await import("node:fs/promises");
  const { syncBuiltinESMExports } = await import("node:module");
  const openDirectory = fs.opendir;
  let entriesRead = 0;
  const probe = t.mock.method(fs, "opendir", async (path) => {
    const directory = await openDirectory(path);
    return (async function* () {
      for await (const entry of directory) {
        entriesRead += 1;
        yield entry;
      }
    })();
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(inventory(scratch), /cutover package entry count limit/);
    assert.equal(entriesRead, 513);
  } finally {
    probe.mock.restore();
    syncBuiltinESMExports();
  }
});

async function writePacketFixture(dir, extraNames = []) {
  for (const profile of ["hono", "kit"]) {
    await mkdir(join(dir, profile, "modules"), { recursive: true });
    await mkdir(join(dir, profile, "assets"));
    await writeFile(join(dir, profile, "assets", ".assetsignore"), "fixture");
    for (const name of extraNames) {
      await writeFile(join(dir, profile, name), `${profile}/${name}`);
    }
  }
  await writeFile(join(dir, "hono/modules/worker.js"), "pure Hono");
  await writeFile(join(dir, "kit/modules/_worker.js"), "facade");
  await writeFile(join(dir, "kit/modules/kit-adapter.js"), "Kit adapter");
  const context = { sourceSha, runId: identity.runId, runAttempt: identity.runAttempt };
  return { ...context, digest: await writeManifest(dir, context, inputs) };
}

test("cutover inventory preserves filenames shared with object properties", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "cutover-inventory-names-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const names = ["__proto__", "constructor", "hasOwnProperty", "toString", "assets/__proto__"];
  const pin = await writePacketFixture(scratch, names);
  const manifest = await verifyPackage(scratch, pin, inputs);
  for (const profile of ["hono", "kit"]) {
    const files = await inventory(join(scratch, profile));
    for (const name of names) {
      const path = `${profile}/${name}`;
      const digest = createHash("sha256").update(path).digest("hex");
      assert.equal(Object.getOwnPropertyDescriptor(files, name)?.value, digest, path);
    }
    assert.deepEqual(manifest.files[profile], files);
  }
});

test("cutover package inventory rejects an external symlink before reading it", async (t) => {
  const { default: fs, symlink } = await import("node:fs/promises");
  const { syncBuiltinESMExports } = await import("node:module");

  const scratch = await mkdtemp(join(tmpdir(), "cutover-package-symlink-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const packet = join(scratch, "packet");
  const asset = join(packet, "assets", "fixture.txt");
  const outside = join(scratch, "outside.txt");
  const bytes = "synthetic packaged asset";
  await mkdir(join(packet, "assets"), { recursive: true });
  await writeFile(asset, bytes);
  await writeFile(outside, bytes);

  const read = t.mock.method(fs, "readFile");
  // Inventory uses the named ESM export, which needs syncing after patch and restore.
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await inventory(packet), { "assets/fixture.txt": sha256(bytes) });
    assert.equal(read.mock.callCount(), 1);
    assert.equal(read.mock.calls[0].arguments[0], asset);
    read.mock.resetCalls();

    // Keep the bytes identical so a digest comparison cannot distinguish the replacement.
    await rm(asset);
    await symlink(outside, asset);
    await assert.rejects(inventory(packet), {
      code: "ERR_ASSERTION",
      message: "cutover package requires regular files",
    });
    assert.equal(read.mock.callCount(), 0);
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
  }
});

test("Ember upload CLI publishes only a valid native Wrangler receipt", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "ember-upload-receipt-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const packet = join(scratch, "packet");
  const { runId, runAttempt, digest: manifest } = await writePacketFixture(packet);
  const preload = join(scratch, "offline.mjs");
  await writeFile(
    preload,
    `import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const { env } = process;
const nativeReceipt = env.WRANGLER_OUTPUT_FILE_PATH;
const { fstatSync, readFileSync, readSync } = fs;
let receiptStat;
let bytesRead = 0;
let receiptGrew = false;
const isReceipt = (stat) => receiptStat && stat.dev === receiptStat.dev && stat.ino === receiptStat.ino;
fs.fstatSync = (fd) => {
  const stat = fstatSync(fd);
  if (!receiptGrew && env.FIXTURE_RECEIPT_GROWS === "true" && isReceipt(stat)) {
    fs.appendFileSync(nativeReceipt, " ".repeat(4096));
    receiptGrew = true;
  }
  return stat;
};
fs.readSync = (fd, ...args) => {
  const count = readSync(fd, ...args);
  if (isReceipt(fstatSync(fd))) bytesRead += count;
  return count;
};
// A readFileSync regression can bypass the exported readSync entirely.
fs.readFileSync = (file, ...args) => {
  const isNative = typeof file === "number" ? isReceipt(fstatSync(file)) : file === nativeReceipt;
  const countedBefore = bytesRead;
  const content = readFileSync(file, ...args);
  if (isNative && bytesRead === countedBefore) bytesRead += Buffer.byteLength(content);
  return content;
};
process.on("exit", () => fs.writeFileSync(env.FIXTURE_BYTES_READ, String(bytesRead)));
globalThis.fetch = async (url) => {
  assert.equal(url.href, "https://togetherweown.com/up");
  return Response.json(JSON.parse(env.FIXTURE_READINESS));
};
childProcess.execFileSync = (tool, args, options) => {
  if (tool === "git") {
    assert.deepEqual(args, ["rev-parse", "HEAD"]);
    return env.DEPLOY_SHA;
  }
  if (tool === "node_modules/.bin/wrangler") {
    assert.deepEqual(args.slice(0, 3), ["versions", "view", env.ROLLBACK_VERSION_ID]);
    return env.FIXTURE_UNDO;
  }
  assert.equal(tool, "web/node_modules/.bin/wrangler");
  assert.deepEqual(args.slice(0, 3), ["versions", "upload", "--config"]);
  const config = JSON.parse(fs.readFileSync(args[3], "utf8"));
  assert.equal(config.vars.KIT_ROUTE_EMBER_PAGES, "true");
  assert.equal(options.env.WRANGLER_OUTPUT_FILE_PATH, nativeReceipt);
  fs.copyFileSync(env.FIXTURE_RECEIPT, nativeReceipt);
  receiptStat = fs.statSync(nativeReceipt);
  return "";
};
syncBuiltinESMExports();
`,
  );
  const worker = inputs.kit.name;
  const upload = (overrides = {}) =>
    JSON.stringify({
      type: "version-upload",
      version: 1,
      worker_name: worker,
      version_id: kit,
      ...overrides,
    });
  const valid = `${JSON.stringify({ type: "version-upload-start" })}\r\n${upload()}\r\n`;
  const limit = 1024 * 1024;
  const atLimit = valid.padEnd(limit);
  const invalidUtf8 = Buffer.concat([
    Buffer.from(`${valid}{"message":"`),
    Buffer.from([0xff]),
    Buffer.from('"}\n'),
  ]);
  const readiness = JSON.stringify({
    db: "ok",
    pending_migrations: 0,
    migration_ledger: ledgerPrefixes(inputs.journal)["1033"],
    revision: { version_id: hono, commit: sourceSha },
  });
  const undo = JSON.stringify({
    id: hono,
    annotations: {
      "workers/tag": `${sourceSha}-1-1`,
      "workers/message": `two-web-cutover-undo:${manifest}`,
    },
  });
  const cases = [
    { name: "normal", raw: valid, bytesRead: Buffer.byteLength(valid) },
    { name: "at the byte limit", raw: atLimit, bytesRead: limit },
    {
      name: "over the byte limit",
      raw: `${atLimit} `,
      bytesRead: 0,
      error: /Wrangler output too large/,
    },
    {
      name: "grows past the byte limit",
      raw: atLimit,
      grows: true,
      bytesRead: limit + 1,
      error: /Wrangler output too large/,
    },
    {
      name: "malformed JSON after upload",
      raw: `${valid}{fixture-receipt-content}\n`,
      error: /invalid JSON/,
    },
    {
      name: "non-object after upload",
      raw: `${valid}42\n`,
      error: /invalid Wrangler output record/,
    },
    { name: "invalid UTF-8 after upload", raw: invalidUtf8, error: /invalid UTF-8/ },
    { name: "no upload", raw: "{}\n", error: /expected one native version upload/ },
    {
      name: "duplicate upload",
      raw: `${valid}${upload()}\n`,
      error: /expected one native version upload/,
    },
    { name: "wrong target", raw: upload({ worker_name: "other-worker" }), error: /wrong target/ },
    { name: "wrong schema", raw: upload({ version: 2 }), error: /wrong target/ },
    {
      name: "invalid version ID",
      raw: upload({ version_id: "invalid" }),
      error: /Worker Version ID/,
    },
  ];
  for (const [index, { name, raw, error, grows, bytesRead }] of cases.entries()) {
    await t.test(name, async () => {
      const directory = join(scratch, `case-${index}`);
      const receipt = join(directory, "fixture.jsonl");
      const output = join(directory, "github-output");
      const readCount = join(directory, "receipt-bytes-read");
      // verifyPackage requires the top-level packet inventory to remain exact.
      const artifact = join(directory, "artifact");
      await cp(packet, artifact, { recursive: true });
      await writeFile(receipt, raw);
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          preload,
          fileURLToPath(new URL("./kit-cutover-deploy.mjs", import.meta.url)),
          "upload",
          artifact,
        ],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          encoding: "utf8",
          timeout: 5_000,
          env: {
            CUTOVER_MODE: "ember",
            CUTOVER_PIN: `${runId}:${runAttempt}:${manifest}`,
            CUTOVER_UNDO_VERSION: hono,
            INPUT_SHA: sourceSha,
            DEPLOY_SHA: sourceSha,
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_REF: "refs/heads/main",
            PRODUCTION_AUTO_PROMOTE_DISABLED: "true",
            ROLLBACK_VERSION_ID: hono,
            GITHUB_RUN_ID: runId,
            GITHUB_RUN_ATTEMPT: runAttempt,
            GITHUB_OUTPUT: output,
            WRANGLER_OUTPUT_FILE_PATH: join(directory, "native.jsonl"),
            FIXTURE_READINESS: readiness,
            FIXTURE_UNDO: undo,
            FIXTURE_RECEIPT: receipt,
            FIXTURE_RECEIPT_GROWS: String(Boolean(grows)),
            FIXTURE_BYTES_READ: readCount,
          },
        },
      );
      assert.ifError(result.error);
      if (error) {
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stderr, error);
        assert.doesNotMatch(result.stderr, /fixture-receipt-content/);
        assert.doesNotMatch(result.stdout, /Uploaded staged/);
        await assert.rejects(readFile(output), { code: "ENOENT" });
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(output, "utf8"), `version_id=${kit}\n`);
      }
      if (bytesRead !== undefined)
        assert.equal(await readFile(readCount, "utf8"), String(bytesRead));
    });
  }
});

const readyOrigin = "https://cutover.example.invalid";
const readyPrefixes = ledgerPrefixes(ledgerJournal);
const readyIdentity = { version: kit, commit: sourceSha, state: "1033" };
const readyBody = {
  db: "ok",
  pending_migrations: 0,
  migration_ledger: readyPrefixes["1033"],
  revision: { version_id: kit, commit: sourceSha },
};

test("readReady admits exact 200 and approved deferred 503 responses", async () => {
  const jsonAtLimit = JSON.stringify(readyBody).padEnd(16 * 1024);
  const response = async (url, { headers, redirect, signal }) => {
    assert.equal(url.href, `${readyOrigin}/up`);
    assert.deepEqual(headers, { "cache-control": "no-cache" });
    assert.equal(redirect, "error");
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    return new Response(jsonAtLimit);
  };
  assert.equal(await readReady(readyOrigin, readyPrefixes, readyIdentity, response), "1033");

  const deferred = async () =>
    Response.json({ ...readyBody, pending_migrations: 1 }, { status: 503 });
  assert.equal(
    await readReady(
      readyOrigin,
      readyPrefixes,
      { ...readyIdentity, allowDeferred: true },
      deferred,
    ),
    "1033",
  );
  await assert.rejects(readReady(readyOrigin, readyPrefixes, readyIdentity, deferred), /readiness/);
});

test("readReady cancels and refuses an oversized stream without Content-Length", {
  timeout: 2_000,
}, async () => {
  const atLimit = new TextEncoder().encode(JSON.stringify(readyBody).padEnd(16 * 1024));
  const chunks = [atLimit, Uint8Array.of(0x20)];
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
        // An unsettled cleanup must leave the refusal prompt.
        return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(stream);
  assert.equal(response.headers.get("content-length"), null);
  await assert.rejects(
    readReady(readyOrigin, readyPrefixes, readyIdentity, async () => response),
    /readiness response exceeds/,
  );
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("readReady refuses empty, invalid or truncated JSON", async () => {
  await assert.rejects(
    readReady(readyOrigin, readyPrefixes, readyIdentity, async () => new Response()),
    /missing readiness response body/i,
  );
  const json = JSON.stringify(readyBody);
  for (const body of ["", `${json} garbage`, json.slice(0, -1)]) {
    await assert.rejects(
      readReady(readyOrigin, readyPrefixes, readyIdentity, async () => new Response(body)),
      /invalid readiness JSON/i,
    );
  }
});

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

test("cutover packet publishes its digest after the summary", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "cutover-publication-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repo = join(scratch, "repo");
  const name = "two-web-next-production";
  const wrangler = "1.2.3";
  const kitModules = { "_worker.js": "// fixture facade", "kit-adapter.js": "// fixture Kit" };
  const kitConfig = {
    name,
    main: ".svelte-kit/cloudflare/_worker.js",
    assets: { directory: ".svelte-kit/cloudflare" },
    workers_dev: false,
    preview_urls: false,
    triggers: { crons: [] },
    vars: Object.fromEntries(KIT_ROUTE_FLAGS.map((flag) => [flag, "false"])),
  };
  for (const [path, body] of Object.entries({
    "wrangler.jsonc": JSON.stringify({ env: { production: { name, main: "src/worker.ts" } } }),
    "web/wrangler.production.jsonc": JSON.stringify(kitConfig),
    "drizzle/meta/_journal.json": JSON.stringify({ entries: [] }),
    "package-lock.json": JSON.stringify({
      packages: { "node_modules/wrangler": { version: wrangler } },
    }),
    "node_modules/wrangler/package.json": JSON.stringify({ version: wrangler }),
    "public/index.html": "<p>Fixture Hono</p>",
    ...Object.fromEntries(
      Object.entries(kitModules).map(([path, body]) => [`installed/${path}`, body]),
    ),
  })) {
    const target = join(repo, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  const stub = join(repo, "node_modules/.bin/wrangler");
  await mkdir(dirname(stub));
  await writeFile(
    stub,
    '#!/bin/sh\n[ "$5" = --outdir ] || exit 2\nprintf "%s\\n" "// fixture Hono" > "$6/worker.js"\n',
    {
      mode: 0o700,
    },
  );

  const context = { sourceSha, runId: identity.runId, runAttempt: identity.runAttempt };
  const installed = { assets: join(repo, "installed") };
  const assetIdentity = {
    files: Object.fromEntries(
      Object.entries(kitModules).map(([path, body]) => [`cloudflare/${path}`, sha256(body)]),
    ),
  };
  const fixtureInputs = await sourceInputs(repo);
  const packager = new URL("./kit-cutover-package.mjs", import.meta.url).href;
  const runPackage = (packet, output, summary) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "const { packageCutover } = await import(process.argv[1]); await packageCutover(...JSON.parse(process.argv[2]));",
        packager,
        JSON.stringify([packet, repo, installed, assetIdentity, context]),
      ],
      {
        encoding: "utf8",
        env: { RUNNER_TEMP: scratch, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
        timeout: 10_000,
      },
    );
  const verifyWrittenPacket = async (packet) => {
    const manifestDigest = sha256(await readFile(join(packet, "manifest.json")));
    await verifyPackage(packet, { ...context, digest: manifestDigest }, fixtureInputs);
    return manifestDigest;
  };

  await t.test(
    "summary write failure leaves the output unchanged and the packet verifiable",
    async () => {
      const packet = join(scratch, "failed-packet");
      const output = join(scratch, "failed-output");
      const summary = join(scratch, "failed-summary");
      await writeFile(output, "existing=value\n");
      await mkdir(summary);

      const result = runPackage(packet, output, summary);
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /EISDIR/);
      assert.ok(result.stderr.includes(summary));
      await verifyWrittenPacket(packet);
      assert.equal(await readFile(output, "utf8"), "existing=value\n");
    },
  );

  await t.test("successful publication appends the exact manifest digest", async () => {
    const packet = join(scratch, "successful-packet");
    const output = join(scratch, "successful-output");
    const summary = join(scratch, "successful-summary");
    await writeFile(output, "existing=value\n");
    await writeFile(summary, "Existing summary\n");

    const result = runPackage(packet, output, summary);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const manifestDigest = await verifyWrittenPacket(packet);
    assert.equal(await readFile(output, "utf8"), `existing=value\ndigest=${manifestDigest}\n`);
    assert.equal(
      await readFile(summary, "utf8"),
      `Existing summary\nCutover packet manifest SHA-256: \`${manifestDigest}\`\n`,
    );
  });
});

test("cutover packaging cleans only its own incomplete packet", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "cutover-packet-cleanup-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repo = join(scratch, "repo");
  const wrangler = { version: "1.2.3" };
  const name = "two-web-next-production";
  const assets = join(scratch, "installed");
  const publicAssets = join(repo, "public");
  const stub = "node_modules/.bin/wrangler";
  const files = {
    "wrangler.jsonc": JSON.stringify({ env: { production: { name, main: "src/worker.ts" } } }),
    "web/wrangler.production.jsonc": JSON.stringify({
      name,
      main: ".svelte-kit/cloudflare/_worker.js",
      assets: { directory: ".svelte-kit/cloudflare" },
      vars: Object.fromEntries(KIT_ROUTE_FLAGS.map((flag) => [flag, "false"])),
      triggers: { crons: [] },
      workers_dev: false,
      preview_urls: false,
    }),
    "drizzle/meta/_journal.json": JSON.stringify({ entries: [] }),
    "package-lock.json": JSON.stringify({ packages: { "node_modules/wrangler": wrangler } }),
    "node_modules/wrangler/package.json": JSON.stringify(wrangler),
    [stub]:
      '#!/bin/sh\n[ "$5" = --outdir ] || exit 2\nprintf "// synthetic Hono\\n" > "$6/worker.js"\n',
  };
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(repo, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: name === stub ? 0o700 : 0o600 });
  }
  await mkdir(assets);
  await writeFile(join(assets, "_worker.js"), "// synthetic facade");
  await writeFile(join(assets, "kit-adapter.js"), "// synthetic Kit adapter");
  const assetIdentity = {
    files: Object.fromEntries(
      Object.entries(await inventory(assets)).map(([name, hash]) => [`cloudflare/${name}`, hash]),
    ),
  };
  const context = { sourceSha, runId: identity.runId, runAttempt: identity.runAttempt };
  for (const [key, value] of Object.entries({
    RUNNER_TEMP: scratch,
    GITHUB_OUTPUT: join(scratch, "output"),
    GITHUB_STEP_SUMMARY: join(scratch, "summary"),
  })) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
  const pack = (packet) => packageCutover(packet, repo, { assets }, assetIdentity, context);

  await t.test("removes the incomplete packet and preserves the original failure", async () => {
    const packet = join(scratch, "incomplete");
    // Hono asset inventory fails after the packet has received its Kit assets and modules.
    await assert.rejects(pack(packet), { code: "ENOENT", path: publicAssets, syscall: "lstat" });
    await assert.rejects(lstat(packet), { code: "ENOENT" });
  });

  await t.test("reports the packaging and cleanup errors when removal fails", async (t) => {
    const { default: fsPromises } = await import("node:fs/promises");
    const { syncBuiltinESMExports } = await import("node:module");
    const packet = join(scratch, "cleanup-failure");
    const cleanupError = Object.assign(new Error("synthetic packet removal refusal"), {
      code: "EACCES",
      path: packet,
    });
    const remove = fsPromises.rm;
    const mockedRemove = t.mock.method(fsPromises, "rm", async (path, options) => {
      if (path === packet) throw cleanupError;
      return remove(path, options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(pack(packet), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        const [original, cleanup] = error.errors;
        assert.equal(original.code, "ENOENT");
        assert.equal(original.path, publicAssets);
        assert.equal(original.syscall, "lstat");
        assert.equal(cleanup, cleanupError);
        return true;
      });
    } finally {
      mockedRemove.mock.restore();
      syncBuiltinESMExports();
    }
  });

  await t.test("removes the packet after manifest verification refuses empty assets", async () => {
    const packet = join(scratch, "manifest-refusal");
    await mkdir(publicAssets);
    await assert.rejects(pack(packet), /missing Worker assets/);
    await assert.rejects(lstat(packet), { code: "ENOENT" });
    await rm(publicAssets, { recursive: true, force: true });
  });

  await t.test("keeps a verified packet and preserves it on admission failure", async () => {
    await mkdir(publicAssets);
    await writeFile(join(publicAssets, "fixture.txt"), "synthetic Hono asset");
    const packet = join(scratch, "complete");
    await pack(packet);
    const manifestDigest = sha256(await readFile(join(packet, "manifest.json")));
    const pin = { ...context, digest: manifestDigest };
    const fixtureInputs = await sourceInputs(repo);
    await verifyPackage(packet, pin, fixtureInputs);

    await assert.rejects(pack(packet), { code: "EEXIST", path: packet, syscall: "mkdir" });
    await verifyPackage(packet, pin, fixtureInputs);
  });
});

test("cutover ledger requires the canonical pre-1033 journal", async (t) => {
  const timestamps = ledgerJournal.map(({ when }) => when);
  assert.deepEqual(ledgerPrefixes(ledgerJournal), {
    1033: timestamps.slice(0, 34),
    1037: timestamps.slice(0, 38),
  });
  const last = ledgerJournal.at(-1);
  assert.throws(
    () => ledgerPrefixes([...ledgerJournal, { ...last, tag: "1039_later", when: last.when + 1 }]),
    /approved cutover window/,
  );
  const unorderedTail = structuredClone(ledgerJournal);
  unorderedTail.at(-1).when = unorderedTail.at(-2).when;
  assert.throws(() => ledgerPrefixes(unorderedTail), /invalid canonical ledger timestamps/);

  const [first, second] = ledgerJournal.slice(2, 4);
  for (const [label, replacement] of [
    ["malformed tag", [first, { ...second, tag: "1001_bad/tag" }]],
    ["missing tag", [first, { ...second, tag: undefined }]],
    ["duplicate tag", [first, { ...second, tag: first.tag }]],
    ["duplicate migration number", [first, { ...second, tag: "1000_other" }]],
    ["unexpected historical tag", [first, { ...second, tag: "1001_other" }]],
    ["missing historical entry", [first]],
    [
      "out-of-order tags",
      [
        { ...first, tag: second.tag },
        { ...second, tag: first.tag },
      ],
    ],
    ["changed historical timestamp in order", [first, { ...second, when: second.when + 1 }]],
  ]) {
    await t.test(label, () => {
      const journal = [...ledgerJournal.slice(0, 2), ...replacement, ...ledgerJournal.slice(4)];
      assert.throws(() => ledgerPrefixes(journal), /noncanonical cutover migration journal/);
    });
  }
  await t.test("changed cutover timestamp in order", () => {
    const journal = structuredClone(ledgerJournal);
    journal.at(-5).when += 1;
    assert.throws(() => ledgerPrefixes(journal), /noncanonical cutover migration journal/);
  });
});

test("cutover ledger admits exactly 1033 or 1037 and exact version readiness", () => {
  const prefixes = ledgerPrefixes(ledgerJournal);
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

test("cutover readiness bounds deferred migrations on the canonical 1033 ledger", () => {
  const prefixes = ledgerPrefixes(ledgerJournal);
  const body = {
    db: "ok",
    pending_migrations: 5,
    migration_ledger: prefixes["1033"],
    revision: { version_id: kit, commit: sourceSha },
  };
  const expected = { version: kit, commit: sourceSha, state: "1033" };
  const deferred = { ...expected, allowDeferred: true };

  assert.equal(verifyReady(503, body, prefixes, deferred), "1033");
  assert.throws(
    () => verifyReady(503, { ...body, pending_migrations: 6 }, prefixes, deferred),
    /unexpected deferred migration count/,
  );
  assert.throws(() => verifyReady(503, body, prefixes, expected), /readiness/);
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

  await t.test("accepts exactly 1 MiB of UTF-8 and cancels one byte over before EOF", async () => {
    const version = { id: kit, annotations: { "workers/tag": "Épreuve" } };
    const json = new TextEncoder().encode(JSON.stringify({ success: true, result: version }));
    const padding = new Uint8Array(1024 * 1024 - json.byteLength).fill(32);
    const readVersion = (...chunks) => {
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
      return {
        result: mockApi(() => new Response(stream))(versionPath),
        state: () => ({ pulls, cancelled, locked: stream.locked }),
      };
    };

    const exact = readVersion(json, padding);
    assert.deepEqual(await exact.result, version);
    assert.deepEqual(exact.state(), { pulls: 3, cancelled: false, locked: false });
    const oversized = readVersion(json, padding, Uint8Array.of(32));
    await assert.rejects(oversized.result, { message: "staging Workers API response too large" });
    assert.deepEqual(oversized.state(), { pulls: 3, cancelled: true, locked: false });
  });

  await t.test("cancels missing and refused settings responses without pulling", async () => {
    for (const status of [404, 502]) {
      let pulls = 0;
      let cancelled = false;
      const stream = new ReadableStream(
        {
          pull(controller) {
            pulls++;
            controller.close();
          },
          cancel() {
            cancelled = true;
            throw new Error("synthetic cancellation failure");
          },
        },
        { highWaterMark: 0 },
      );
      const api = mockApi(() => new Response(stream, { status }));

      if (status === 404) assert.equal(await api(settingsPath), null);
      else
        await assert.rejects(api(settingsPath), {
          message: "staging Workers API refused the request",
        });
      assert.equal(pulls, 0);
      assert.equal(cancelled, true);
      assert.equal(stream.locked, false);
    }
  });

  await t.test("releases the reader and sanitizes a stream read failure", async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(new Error("synthetic private response"));
      },
    });
    const api = mockApi(() => new Response(stream));

    await assert.rejects(api(settingsPath), {
      message: "staging Workers API response could not be read",
    });
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

  await t.test(
    "reports empty or malformed JSON and provider errors without response data",
    async () => {
      for (const payload of ["", "synthetic private response"]) {
        const invalid = mockApi(() => new Response(payload));
        await assert.rejects(invalid(settingsPath), {
          message: "staging Workers API response was not valid JSON",
        });
      }
      const refused = mockApi(() => Response.json({ success: "synthetic private response" }));
      await assert.rejects(refused(settingsPath), {
        message: "staging Workers API returned an error",
      });
    },
  );
});

test("isolated cutover counts routes only from the successful retry", async () => {
  const origin = "https://cutover.example.invalid";
  const prefixes = ledgerPrefixes(ledgerJournal);
  const calls = [];
  let retrying = false;
  const routeCount = await verifyServed(origin, prefixes, identity, kit, "1037", "kit", {
    probeReady: async () => {
      calls.push("readiness");
    },
    probeRoutes: async (_origin, { onRoute }) => {
      calls.push("smoke");
      onRoute("/up", 0);
      onRoute("/", retrying ? 0 : 1);
      if (retrying) onRoute("/events", 0);
      return retrying;
    },
    wait: async () => {
      calls.push("wait");
      retrying = true;
    },
  });
  assert.equal(routeCount, 3);
  assert.deepEqual(calls, ["readiness", "smoke", "wait", "readiness", "smoke"]);
});

test("isolated Ember bindings reject duplicate names without exposing binding contents", () => {
  const config = stagingConfig(
    "kit",
    inputs,
    STAGING_WORKER,
    "https://cutover.example.invalid",
    "ember",
  );
  const bindings = [
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    { name: "DATABASE_URL", type: "secret_text" },
    { name: "SESSION_SECRET", type: "secret_text" },
    { name: "DISCORD_CLIENT_SECRET", type: "secret_text" },
    { name: "DISCORD_BOT_TOKEN", type: "secret_text" },
    { name: "CF_VERSION_METADATA", type: "version_metadata" },
  ];
  verifyStagedBindings({ id: kit, resources: { bindings } }, kit, config);

  const conflictingFlag = { name: "KIT_ROUTE_EMBER_PAGES", type: "plain_text", text: "false" };
  assert.throws(
    () =>
      verifyStagedBindings(
        { id: kit, resources: { bindings: [conflictingFlag, ...bindings] } },
        kit,
        config,
      ),
    { message: "staged bindings contain duplicate names" },
  );
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

test("isolated cutover refuses a healthy smoke response from the wrong Worker version", async (t) => {
  const prefixes = ledgerPrefixes(ledgerJournal);
  let smokeVersion = kit;
  const observations = [];
  const { url, requests } = await startSmokeFixture(
    t,
    (path, response, headers) => {
      if (path === "/join") response.body += joinAction;
      if (path === "/up") {
        // readReady sends no-cache. The ordinary-traffic smoke makes its own request.
        const ready = headers["cache-control"] === "no-cache";
        const version = ready ? hono : smokeVersion;
        observations.push([ready ? "readiness" : "smoke", version]);
        response.body = JSON.stringify({
          ...JSON.parse(response.body),
          migration_ledger: prefixes[1033],
          revision: { version_id: version, commit: sourceSha },
        });
      }
    },
    calendarFixtures,
  );
  const log = t.mock.method(console, "log", () => {});
  const waits = [];
  const verify = () =>
    verifyServed(url, prefixes, identity, hono, "1033", "hono", {
      wait: async (ms) => {
        waits.push(ms);
      },
    });

  await assert.rejects(verify(), /isolated public-route smoke failed/);
  assert.deepEqual(waits, Array(5).fill(10_000));
  assert.deepEqual(
    observations,
    Array.from({ length: 6 }, () => [
      ["readiness", hono],
      ["smoke", kit],
    ]).flat(),
  );
  const failures = log.mock.calls
    .map(({ arguments: [line] }) => line)
    .filter((line) => line.startsWith("FAIL "));
  assert.deepEqual(
    failures,
    Array(6).fill(
      `FAIL /up: expected revision.version_id ${hono}; actual revision.version_id ${kit}`,
    ),
  );

  smokeVersion = hono;
  observations.length = 0;
  assert.equal(
    await verify(),
    Object.keys(smokeFixtures).length + Object.keys(calendarFixtures).length,
  );
  assert.deepEqual(observations, [
    ["readiness", hono],
    ["smoke", hono],
  ]);
  assert.equal(waits.length, 5);
  assert.ok(requests.every(({ override }) => override === undefined));
});

test("isolated cutover propagates a smoke rejection after a route callback", async () => {
  const origin = "https://cutover.example.invalid";
  const prefixes = ledgerPrefixes(ledgerJournal);
  const ready = {
    db: "ok",
    pending_migrations: 0,
    migration_ledger: prefixes["1037"],
    revision: { version_id: kit, commit: sourceSha },
  };
  const failure = new Error("synthetic smoke adapter failure");
  const verify = (complete) =>
    verifyServed(origin, prefixes, identity, kit, "1037", "kit", {
      probeReady: async (_origin, ledger, expected) => verifyReady(200, ready, ledger, expected),
      probeRoutes: async (_origin, { onRoute }) => {
        onRoute("/up", 0);
        if (!complete) throw failure;
        return true;
      },
      wait: async () => assert.fail("unexpected retry after smoke adapter rejection"),
    });

  await assert.rejects(verify(false), (error) => error === failure);
  assert.equal(await verify(true), 1);
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

  // Keep every transition consistent with the claimed version pair.
  const sameVersion = {
    ...ember,
    kit: ember.hono,
    checks: ember.checks.map((row) => ({ ...row, version: ember.hono })),
  };
  assert.throws(() => verifyStagingProof(sameVersion, { ...identity, mode: "ember" }), {
    message: "staging requires distinct versions on one Worker",
  });

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

test("all-off Hono fallback retains session settings and restores Hono route ownership", () => {
  const name = "cutover-fixture-production";
  const appUrl = "https://cutover.example.invalid";
  const databaseId = "1".repeat(32);
  const hyperdrive = [{ binding: "DB", id: databaseId }];
  const assets = { binding: "ASSETS", run_worker_first: true };
  const shared = { name, workers_dev: false, preview_urls: false, hyperdrive };
  const fallbackInputs = {
    root: {
      name: "cutover-fixture-staging",
      vars: { APP_URL: "https://staging.example.invalid" },
      hyperdrive: [{ binding: "DB", id: "2".repeat(32) }],
      assets,
      keep_vars: true,
      env: {
        production: {
          ...shared,
          vars: { APP_URL: appUrl },
          routes: [{ pattern: new URL(appUrl).hostname, custom_domain: true }],
        },
      },
    },
    kit: {
      ...shared,
      assets,
      keep_vars: true,
      vars: {
        APP_URL: appUrl,
        KIT_ROUTE_ARCHIVE: "false",
        KIT_ROUTE_STATIC: "false",
        KIT_ROUTE_EVENTS: "false",
        KIT_ROUTE_HOME: "false",
        KIT_ROUTE_JOIN: "false",
        KIT_ROUTE_EMBER_PAGES: "false",
        KIT_ROUTE_ADMIN: "false",
      },
    },
  };

  const ember = productionUploadConfig("kit", fallbackInputs, "ember");
  const fallback = productionUploadConfig("hono", fallbackInputs, "all-off");

  assert.equal(ember.main, "modules/_worker.js");
  assert.equal(fallback.main, "modules/worker.js");
  assert.deepEqual(
    Object.entries(ember.vars).filter(
      ([key, value]) => key.startsWith("KIT_ROUTE_") && value !== "false",
    ),
    [["KIT_ROUTE_EMBER_PAGES", "true"]],
  );
  assert.equal(
    Object.keys(fallback.vars).some((key) => key.startsWith("KIT_ROUTE_")),
    false,
  );
  for (const config of [ember, fallback]) {
    assert.equal(config.name, name);
    assert.equal(config.vars.APP_URL, appUrl);
    assert.deepEqual(config.hyperdrive, [{ binding: "DB", id: databaseId }]);
    assert.equal(config.keep_vars, true);
    assert.equal(Object.hasOwn(config.vars, "SESSION_SECRET"), false);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(Object.hasOwn(config, "routes"), false);
    assert.equal(Object.hasOwn(config, "route"), false);
    assert.equal(config.assets.binding, "ASSETS");
    assert.equal(config.assets.run_worker_first, true);
  }
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

test("isolated fixture setup preserves the setup error and refuses a failed control close", async (t) => {
  const fixtureModule = new URL("./kit-cutover-database.mjs?close-test", import.meta.url).href;
  const postgresModule = `data:text/javascript,${encodeURIComponent(`
    export const clients = new Map();
    export default function postgres(url) {
      const name = new URL(url).pathname;
      if (!clients.has(name)) throw new Error("Unexpected fixture connection");
      return clients.get(name)();
    }
  `)}`;
  const { clients } = await import(postgresModule);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "postgres" && context.parentURL === fixtureModule) {
        return { url: postgresModule, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  const { createFixture, fixtureDatabase, fixtureNames } = await import(fixtureModule).finally(() =>
    hooks.deregister(),
  );
  const host = "ep-fixture.us-east-2.aws.neon.tech";
  const url = fixtureDatabase(
    `postgresql://two_web_cutover_owner:synthetic@${host}/two_web_cutover`,
    host,
  );
  const names = fixtureNames("21", "3");
  const setupError = new Error("synthetic setup failure");
  const closeError = new Error("synthetic close failure");
  const controlSetup = ["control open", "ownership", "freshness", "claim", "revoke", "create"];
  const allocation = [...controlSetup, "revoke", "login", "grant", "control close"];

  for (const [scenario, stopAt, failedClose, expectedError, expectedCalls] of [
    [
      "control operation and close fail",
      "control",
      "control",
      setupError,
      [...controlSetup, "control close"],
    ],
    [
      "owner operation and close fail",
      "owner",
      "owner",
      setupError,
      [...allocation, "owner open", "owner setup", "owner close"],
    ],
    ["control close alone fails", null, "control", closeError, allocation],
  ]) {
    await t.test(scenario, async () => {
      const calls = [];
      function connect(client) {
        calls.push(`${client} open`);
        async function execute([sql]) {
          if (sql.startsWith("SELECT current_user")) {
            calls.push("ownership");
            return [{ owned: true }];
          }
          if (sql.startsWith("SELECT")) {
            calls.push("freshness");
            return [{ db: false, login: false }];
          }
          const operation = {
            "REVOKE CONNECT ON DATABASE two_web_cutover FROM PUBLIC": "revoke",
            "REVOKE CONNECT ON DATABASE": "revoke",
            "CREATE DATABASE": "create",
            "CREATE ROLE": "login",
            "GRANT CONNECT ON DATABASE": "grant",
          }[sql.trim()];
          assert.ok(operation, "unexpected fixture operation");
          calls.push(operation);
          if (stopAt === "control" && operation === "create") throw setupError;
        }
        return Object.assign((query) => (typeof query === "string" ? query : execute(query)), {
          unsafe: (query) => ({
            async simple() {
              assert.equal(client, "owner");
              assert.ok(query);
              calls.push("owner setup");
              if (stopAt === "owner") throw setupError;
            },
          }),
          async end(options) {
            assert.deepEqual(options, { timeout: 0 });
            calls.push(`${client} close`);
            if (failedClose === client) throw closeError;
          },
        });
      }
      clients.set(url.pathname, () => connect("control"));
      clients.set(`/${names.db}`, () => connect("owner"));
      const claim = async () => {
        calls.push("claim");
      };
      await assert.rejects(createFixture(url, names, claim), (error) => error === expectedError);
      assert.deepEqual(calls, expectedCalls);
    });
  }
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
              return JSON.stringify([
                {
                  created_on: "2026-11-01T06:00:00.123456Z",
                  versions: [{ version_id: live, percentage: 100 }],
                },
              ]);
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

function isolatedDispatch(runAttempt, scratch) {
  return {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ID: "21",
    GITHUB_RUN_ATTEMPT: runAttempt,
    GITHUB_SHA: sourceSha,
    CUTOVER_PACKET_DIGEST: digest,
    RUNNER_TEMP: scratch,
  };
}

test("isolated cleanup removes only the claimed run attempt's resources", async (t) => {
  const { cleanup, runIsolatedCutover } = await import("./kit-cutover-staging.mjs");
  const scratch = await mkdtemp(join(tmpdir(), "cutover-cleanup-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const workers = new Set();
  const allocations = [];
  const calls = [];
  const database = Symbol("synthetic database");
  const api = async (path, method = "GET") => {
    calls.push([method, path]);
    if (method === "DELETE") return workers.delete(path.slice("scripts/".length));
    const worker = path.slice("scripts/".length, -"/settings".length);
    return workers.has(worker) ? {} : null;
  };
  const dropFixture = async (target, names) => {
    assert.equal(target, database);
    calls.push(["drop fixture", names]);
  };
  const operations = {
    qualifyPacket: async (packet, proofPath, { worker, names, claim }) => {
      assert.deepEqual([packet, proofPath], ["packet", "proof.json"]);
      allocations.push({ worker, names });
      await writeFile(claim, worker, { flag: "wx" });
      workers.add(worker);
    },
    cleanupAttempt: (ctx) => cleanup(ctx, api, database, dropFixture),
  };
  const attempts = ["1", "2"].map((attempt) => isolatedDispatch(attempt, join(scratch, attempt)));
  const expected = ["1", "2"].map((attempt) => ({
    worker: `${STAGING_WORKER}-21-${attempt}`,
    names: {
      suffix: `21-${attempt}`,
      db: `two_web_cutover_21_${attempt}`,
      login: `two_web_cutover_21_${attempt}_runtime`,
    },
  }));
  for (const env of attempts) {
    await mkdir(env.RUNNER_TEMP);
    await runIsolatedCutover(["packet", "proof.json"], env, operations);
  }
  assert.deepEqual(allocations, expected);

  const [first, second] = attempts;
  const firstClaim = join(first.RUNNER_TEMP, "kit-cutover-claimed.json");
  await assert.rejects(
    runIsolatedCutover(["--cleanup"], { ...second, RUNNER_TEMP: first.RUNNER_TEMP }, operations),
    { message: "Isolated cleanup claim mismatch" },
  );
  assert.deepEqual(calls, []);
  assert.equal(await readFile(firstClaim, "utf8"), expected[0].worker);

  for (const [index, env] of attempts.entries()) {
    await runIsolatedCutover(["--cleanup"], env, operations);
    const { worker, names } = expected[index];
    const script = `scripts/${worker}`;
    assert.deepEqual(calls.splice(0), [
      ["GET", `${script}/settings`],
      ["DELETE", script],
      ["GET", `${script}/settings`],
      ["drop fixture", names],
    ]);
    assert.deepEqual(
      [...workers],
      expected.slice(index + 1).map(({ worker }) => worker),
    );
    await assert.rejects(readFile(join(env.RUNNER_TEMP, "kit-cutover-claimed.json")), {
      code: "ENOENT",
    });
  }
});

test("isolated orchestration rejects invalid attempts before starting operations", async (t) => {
  const { runIsolatedCutover } = await import("./kit-cutover-staging.mjs");
  const started = t.mock.fn();
  const operations = {
    qualifyPacket: started,
    cleanupAttempt: started,
  };
  for (const attempt of [undefined, "0", "02", "2/../1", "1234567890123456"]) {
    const env = isolatedDispatch(attempt, "unused");
    for (const args of [["packet", "proof.json"], ["--cleanup"]]) {
      await assert.rejects(runIsolatedCutover(args, env, operations), {
        code: "ERR_ASSERTION",
        operator: "match",
      });
    }
  }
  assert.equal(started.mock.callCount(), 0);
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

test("isolated cutover removes scratch and withholds proof when the owner close fails", async (t) => {
  const { finalizeIsolatedCutover } = await import("./kit-cutover-staging.mjs");
  const runnerTemp = await mkdtemp(join(tmpdir(), "kit-cutover-finalization-test-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const scratch = await mkdtemp(join(runnerTemp, "kit-cutover-staging-"));
  await writeFile(join(scratch, "synthetic-bindings.json"), "disposable fixture");
  const owner = {
    end: t.mock.fn(async () => {
      throw new Error("untrusted synthetic connection detail");
    }),
  };
  const publishProof = t.mock.fn(() =>
    writeFile(join(runnerTemp, "proof.json"), "synthetic proof", { flag: "wx" }),
  );

  const failure = await finalizeIsolatedCutover(owner, scratch, publishProof).catch(
    (error) => error,
  );
  assert.deepEqual(await readdir(runnerTemp), []);
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, "Cutover staging failed during local fixture finalization");
  assert.equal(failure.cause, undefined);
  assert.deepEqual(
    owner.end.mock.calls.map(({ arguments: args }) => args),
    [[{ timeout: 0 }]],
  );
  assert.equal(publishProof.mock.callCount(), 0);
});

test("isolated cutover withholds proof when scratch removal fails", async (t) => {
  const { finalizeIsolatedCutover } = await import("./kit-cutover-staging.mjs");
  const runnerTemp = await mkdtemp(join(tmpdir(), "kit-cutover-removal-test-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const blocker = join(runnerTemp, "not-a-directory");
  await writeFile(blocker, "disposable fixture");
  // A file as the parent forces ENOTDIR even with recursive, forced removal.
  const scratch = join(blocker, "scratch");
  const owner = { end: t.mock.fn(async () => {}) };
  const publishProof = t.mock.fn(() =>
    writeFile(join(runnerTemp, "proof.json"), "synthetic proof", { flag: "wx" }),
  );

  await assert.rejects(finalizeIsolatedCutover(owner, scratch, publishProof), (failure) => {
    assert.equal(failure.message, "Cutover staging failed during local fixture finalization");
    assert.equal(failure.cause, undefined);
    return true;
  });
  assert.equal(owner.end.mock.callCount(), 1);
  assert.equal(publishProof.mock.callCount(), 0);
  assert.deepEqual(await readdir(runnerTemp), ["not-a-directory"]);
});
