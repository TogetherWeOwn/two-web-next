#!/usr/bin/env node
// Compare the complete inventory under the production origin and bindings,
// using disposable loopback DB clones and the built adapter, never vite dev.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "../wrangler-config.mjs";
import { loadRecording, parseExceptions, report, EXCEPTIONS_DOC } from "./compare.mjs";

import { compareProductionRecordings, productionAssetPaths } from "./asset-headers.mjs";

const repo = resolve(import.meta.dirname, "../..");

export function productionHonoTarget(root, kit) {
  const production = root.env?.production;
  if (root.main !== "src/worker.ts" || production?.name !== "two-web-next-production")
    throw new Error("Production parity requires the retained pure-Hono entry and script");
  if (kit.name !== production.name || kit.vars?.APP_URL !== production.vars?.APP_URL)
    throw new Error("Production parity targets must share the script and production origin");
  for (const flag of ["KIT_ROUTE_ARCHIVE", "KIT_ROUTE_STATIC"])
    if (kit.vars?.[flag] !== "false") throw new Error(`Production parity requires ${flag}=false`);
  const target = { ...root, ...production };
  target.main = resolve(repo, root.main);
  target.assets = { ...root.assets, directory: resolve(repo, root.assets.directory) };
  delete target.env;
  // The recording harness already excludes routes, tails and remote DBs.
  // Keep this intermediate target local-only too, even before harnessConfig.
  delete target.routes;
  delete target.hyperdrive;
  delete target.tail_consumers;
  return target;
}

async function main() {
  const { record } = await import("./record.mjs");
  const root = readWranglerConfig(readFileSync(join(repo, "wrangler.jsonc"), "utf8"));
  const kit = readWranglerConfig(readFileSync(join(repo, "web/wrangler.production.jsonc"), "utf8"));
  const target = productionHonoTarget(root, kit);
  const assetPaths = productionAssetPaths(
    resolve(repo, "web", kit.assets.directory),
    readFileSync(join(repo, "web/_headers"), "utf8"),
  );
  const { securityHeadersFor } = await import("../../src/headers.ts");
  const securityHeaderNames = securityHeadersFor(
    { path: "/_app/version.json", method: "GET" },
    target.vars.FEATURED_IMAGE_HOSTS,
  ).map(([name]) => name.toLowerCase());
  const out = resolve(
    process.env.PRODUCTION_PARITY_ARTIFACT_DIR ?? "artifacts/production-kit-parity",
  );
  await mkdir(out, { recursive: true });
  const scratch = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "production-parity-"));
  try {
    const config = join(scratch, "hono-production.jsonc");
    await writeFile(config, JSON.stringify(target));
    const baseline = join(out, "hono");
    const candidate = join(out, "kit");
    const hono = await record({
      out: baseline,
      targetConfig: config,
      databaseUrl: process.env.PARITY_DATABASE_URL,
      extraPublicFiles: assetPaths,
    });
    const built = await record({
      out: candidate,
      targetConfig: "web/wrangler.production.jsonc",
      databaseUrl: process.env.PARITY_DATABASE_URL,
      extraPublicFiles: assetPaths,
    });
    if (hono.meta.vectorCount === 0 || hono.meta.vectorCount !== built.meta.vectorCount)
      throw new Error("Production parity did not record the complete shared inventory");
    const exceptions = parseExceptions(readFileSync(join(repo, EXCEPTIONS_DOC), "utf8"));
    const { comparison, assets } = compareProductionRecordings(
      loadRecording(baseline),
      loadRecording(candidate),
      assetPaths,
      securityHeaderNames,
      exceptions,
    );
    const summary = [
      report(comparison, "pure Hono production vs built Kit production (all families off)"),
      report(
        { failures: assets.failures, approved: [], unused: [] },
        "pre-hook asset security headers",
      ),
    ].join("\n");
    await writeFile(join(out, "asset-headers.json"), JSON.stringify(assets, null, 2) + "\n");
    await writeFile(
      join(out, "comparison.json"),
      JSON.stringify(
        {
          sourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: repo,
            encoding: "utf8",
          }).trim(),
          honoRuntimePin: hono.meta.pinnedSha,
          vectorCount: hono.meta.vectorCount,
          productionOrigin: target.vars.APP_URL,
          ...comparison,
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(join(out, "summary.txt"), summary + "\n");
    console.log(summary);
    process.exitCode = comparison.failures.length || assets.failures.length ? 1 : 0;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
