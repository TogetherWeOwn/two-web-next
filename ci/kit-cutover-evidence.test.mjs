import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { calendarFixtures, joinAction, smokeFixtures } from "../test/fixtures/smoke-routes.mjs";
import { startSmokeFixture } from "../test/helpers/smoke-http.mjs";
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
import { cloudflare, exercise, verifyServed } from "./kit-cutover-staging.mjs";
import { KIT_ROUTE_FLAGS } from "./production-deploy-gate.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

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
