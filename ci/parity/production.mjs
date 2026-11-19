// Hosted, source-only replay at the production origin. The transport and DB
// stay on loopback; neither production config is given to Wrangler directly.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPANION_NAME, ENTRY_NAME } from "../../web/scripts/kit-facade-transaction.mjs";
import { prepareInstalledKitWorker } from "../kit-worker-installed-output.mjs";
import { readWranglerConfig } from "../wrangler-config.mjs";
import {
  compareRecordings,
  EXCEPTIONS_DOC,
  loadRecording,
  parseExceptions,
  report,
} from "./compare.mjs";
import { listPublicFiles, slug } from "./vectors.mjs";

const repo = resolve(import.meta.dirname, "../..");
const build = ".svelte-kit/cloudflare";
const flags = ["ARCHIVE", "STATIC", "EVENTS", "HOME", "JOIN"].map((name) => `KIT_ROUTE_${name}`);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function productionTargets(root, kit) {
  const production = root.env?.production;
  assert.equal(root.main, "src/worker.ts", "expected the pure Hono entry");
  assert.equal(production?.name, "two-web-next-production");
  assert.equal(kit.name, production.name, "candidate script must match production");
  const origin = new URL(production.vars.APP_URL);
  assert.equal(origin.protocol, "https:");
  assert.equal(kit.vars?.APP_URL, origin.origin, "candidate must use the production origin");
  assert.equal(production.vars.APP_URL, origin.origin);
  for (const flag of new Set([
    ...flags,
    ...Object.keys(kit.vars).filter((key) => key.startsWith("KIT_ROUTE_")),
  ])) {
    assert.equal(kit.vars[flag], "false", `production parity requires ${flag}=false`);
  }
  assert.equal(kit.main, `${build}/${ENTRY_NAME}`);
  assert.equal(kit.assets?.directory, build);
  for (const assets of [root.assets, kit.assets]) {
    assert.equal(assets?.binding, "ASSETS");
    assert.equal(assets.run_worker_first, true);
  }
  // Select only runtime inputs consumed by the local recording harness.
  const local = (config, main, directory) => ({
    main,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    assets: { ...config.assets, directory },
    queues: config.queues,
    vars: config.vars,
  });
  return {
    hono: local(
      { ...root, ...production },
      join(repo, root.main),
      join(repo, root.assets.directory),
    ),
    kit: (worker, assets) => local(kit, worker, assets),
  };
}

async function outputIdentity({ assets, worker }) {
  assert.equal(worker, join(assets, ENTRY_NAME));
  const root = dirname(assets);
  const files = {};
  for (const name of [basename(assets), "cloudflare-tmp", "output"]) {
    const entries = await readdir(join(root, name), { recursive: true, withFileTypes: true });
    assert.ok(
      entries.some((entry) => entry.isFile()),
      `missing built output in ${name}`,
    );
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      assert.ok(entry.isFile(), "expected regular built output");
      const path = join(entry.parentPath, entry.name);
      files[relative(root, path)] = hash(await readFile(path));
    }
  }
  for (const name of [ENTRY_NAME, COMPANION_NAME, "_headers"])
    assert.ok(files[join(basename(assets), name)], `missing installed ${name}`);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

async function preHookAssets(assets) {
  const generated = new Set((await readFile(join(assets, "_headers"), "utf8")).split("\n"));
  const reviewed = (await readFile(join(repo, "web/_headers"), "utf8"))
    .split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  assert.ok(
    reviewed.includes("/_app/*") && reviewed.every((line) => generated.has(line)),
    "built _headers must retain every reviewed /_app rule",
  );
  const paths = listPublicFiles(join(assets, "_app")).map((path) => `/_app${path}`);
  const version = "/_app/version.json";
  const immutable = paths.filter((path) => path.startsWith("/_app/immutable/"));
  assert.ok(paths.includes(version) && immutable.length, "missing pre-hook adapter assets");
  return [version, ...immutable];
}

// Kit-only assets lack a Hono body counterpart. Keep both full recordings,
// but assert their security envelopes separately from shared route parity.
export function comparePreHookAssets(hono, kit, paths, headerNames) {
  assert.ok(paths.length && headerNames.includes("content-security-policy"));
  const rows = [];
  const failures = [];
  for (const path of paths) {
    const file = `static/${slug(path)}`;
    const a = hono.get(file) ?? {};
    const b = kit.get(file) ?? {};
    for (const id of new Set(["GET", "HEAD", ...Object.keys(a), ...Object.keys(b)])) {
      const key = `${file}#${id}`;
      if (!a[id] || !b[id]) {
        failures.push({
          key,
          field: "missing",
          baseline: Boolean(a[id]),
          candidate: Boolean(b[id]),
        });
        continue;
      }
      if (["GET", "HEAD"].includes(id) && b[id].response.status !== 200)
        failures.push({ key, field: "status", baseline: 200, candidate: b[id].response.status });
      rows.push({ key, path, hono: a[id].response.status, kit: b[id].response.status });
      for (const name of headerNames) {
        const before = a[id].response.headers[name];
        const after = b[id].response.headers[name];
        if (typeof before !== "string" || before !== after)
          failures.push({ key, field: `headers.${name}`, baseline: before, candidate: after });
      }
    }
  }
  return { rows, failures };
}

async function main() {
  const { record } = await import("./record.mjs");
  const { securityHeadersFor } = await import("../../src/headers.ts");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(head, process.env.EXPECTED_HEAD_SHA, "production parity requires the exact head");
  const out = join(repo, "artifacts/production-kit-parity");
  await mkdir(out, { recursive: true });
  const save = (name, data) => writeFile(join(out, name), `${JSON.stringify(data, null, 2)}\n`);
  const rootBytes = readFileSync(join(repo, "wrangler.jsonc"));
  const kitBytes = readFileSync(join(repo, "web/wrangler.production.jsonc"));
  const { hono, kit } = productionTargets(
    readWranglerConfig(rootBytes.toString()),
    readWranglerConfig(kitBytes.toString()),
  );
  const installed = await prepareInstalledKitWorker(repo);
  const files = await outputIdentity(installed);
  const candidate = kit(installed.worker, installed.assets);
  const identity = {
    sourceSha: head,
    productionOrigin: hono.vars.APP_URL,
    flags: Object.fromEntries(flags.map((flag) => [flag, candidate.vars[flag]])),
    honoConfigSha256: hash(rootBytes),
    kitConfigSha256: hash(kitBytes),
    installedOutputSha256: hash(JSON.stringify(files)),
    files,
  };
  await save("identity.json", identity);
  const paths = await preHookAssets(installed.assets);
  const names = securityHeadersFor(
    { path: paths[0], method: "GET" },
    hono.vars.FEATURED_IMAGE_HOSTS,
  ).map(([name]) => name.toLowerCase());
  const scratch = await mkdtemp(join(process.env.RUNNER_TEMP, "production-parity-"));
  try {
    const capture = async (name, config) => {
      const targetConfig = join(scratch, `${name}.jsonc`);
      const dir = join(out, name);
      await writeFile(targetConfig, JSON.stringify(config));
      const { meta } = await record({
        out: dir,
        targetConfig,
        databaseUrl: process.env.PARITY_DATABASE_URL,
        extraPublicFiles: paths,
      });
      const recording = loadRecording(dir);
      assert.ok(meta.vectorCount > 0 && meta.coverage.length > 0, "empty route inventory");
      for (const row of meta.coverage) assert.ok(recording.get(row.file)?.[row.vector], row.entry);
      assert.equal(
        [...recording.values()].reduce((n, row) => n + Object.keys(row).length, 0),
        meta.vectorCount,
      );
      return { meta, recording };
    };
    const baseline = await capture("hono", hono);
    const built = await capture("kit", candidate);
    assert.deepEqual(built.meta.coverage, baseline.meta.coverage);
    assert.equal(built.meta.vectorCount, baseline.meta.vectorCount);
    assert.deepEqual(
      await outputIdentity(installed),
      files,
      "installed output changed during replay",
    );
    const assetFiles = new Set(paths.map((path) => `static/${slug(path)}`));
    const shared = (recording) => new Map([...recording].filter(([file]) => !assetFiles.has(file)));
    const exceptions = parseExceptions(readFileSync(join(repo, EXCEPTIONS_DOC), "utf8"));
    const diff = compareRecordings(shared(baseline.recording), shared(built.recording), exceptions);
    const assets = comparePreHookAssets(baseline.recording, built.recording, paths, names);
    await save("comparison.json", {
      sourceSha: head,
      installedOutputSha256: identity.installedOutputSha256,
      honoRuntimePin: baseline.meta.pinnedSha,
      vectorCount: built.meta.vectorCount,
      ...diff,
      assets,
    });
    const summary = [
      report(diff, "Hono vs installed Kit (production origin, all families off)"),
      report({ ...assets, approved: [], unused: [] }, "pre-hook asset security headers"),
    ].join("\n");
    await writeFile(join(out, "summary.txt"), `${summary}\n`);
    console.log(summary);
    if (diff.failures.length || assets.failures.length) process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
