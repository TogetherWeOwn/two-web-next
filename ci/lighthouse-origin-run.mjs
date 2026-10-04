#!/usr/bin/env node
// Lighthouse against a deployed origin (the cutover 48h watch, runbook and
// watch-run-record section 6). GET only: discovery issues two GETs and
// Lighthouse navigates. Usage: npm run lighthouse:origin -- <origin>
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const lib = require("./lighthouse-origin-lib.cjs");

const OUTPUT_DIR = ".lighthouseci";
const CONFIG = "ci/lighthouse-origin.cjs";

function runLhci(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [require.resolve("@lhci/cli/src/cli.js"), "autorun", `--config=${CONFIG}`],
      { env, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readResults(dir) {
  const names = await readdir(dir).catch(() => []);
  const lhrs = [];
  for (const name of names.filter((entry) => /^lhr-.*\.json$/.test(entry))) {
    lhrs.push(await readJson(join(dir, name)));
  }
  const assertions = names.includes("assertion-results.json")
    ? await readJson(join(dir, "assertion-results.json"))
    : [];
  return { lhrs, assertions };
}

export async function main(
  argv,
  {
    env = process.env,
    fetchImpl = fetch,
    lhci = runLhci,
    dir = OUTPUT_DIR,
    log = console.log,
  } = {},
) {
  if (argv.length !== 1) {
    log("usage: npm run lighthouse:origin -- <origin>");
    log(`origin is one of: ${lib.ALLOWED_ORIGINS.join(", ")}`);
    return 2;
  }
  let origin;
  try {
    origin = lib.requireAllowedOrigin(argv[0]);
  } catch (error) {
    log(error.message);
    return 2;
  }

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  let found;
  try {
    found = await lib.discoverEventPath(origin, fetchImpl);
  } catch (error) {
    // An origin that does not answer GET /events.rss is itself the finding.
    const failure = `Event discovery failed, origin not healthy: ${error.message}`;
    await writeFile(
      join(dir, "watch-summary.md"),
      `## Lighthouse watch run\n\nOrigin: ${origin}\n\n${failure}\n`,
    );
    log(failure);
    return 1;
  }
  const eventPath = found.path ?? undefined;
  log(
    eventPath
      ? `Event route: ${eventPath} (from ${found.source})`
      : `Event route skipped: ${found.reason}`,
  );

  // The config is validated here once more, before anything is launched.
  const { collect } = lib.buildConfig({ origin, eventPath }).ci;
  log(
    `Measuring ${collect.url.length} routes, ${collect.numberOfRuns} runs each:\n${collect.url.map((url) => `  ${url}`).join("\n")}`,
  );

  const code = await lhci({
    ...env,
    LIGHTHOUSE_ORIGIN: origin,
    LIGHTHOUSE_EVENT_PATH: eventPath ?? "",
  });

  const { lhrs, assertions } = await readResults(dir);
  const rows = lib.summarizeRoutes({
    origin,
    eventPath,
    skipReason: found.reason,
    lhrs,
    assertions,
  });
  const summary = lib.renderSummary({ origin, eventPath, eventSource: found.source, rows });
  await writeFile(join(dir, "watch-summary.md"), summary);
  await writeFile(
    join(dir, "watch-summary.json"),
    `${JSON.stringify({ origin, eventPath: eventPath ?? null, skipReason: found.reason ?? null, exitCode: code, rows }, null, 2)}\n`,
  );
  log(summary);

  // lhci exits non-zero on an error-level assertion or a crashed run. Also fail
  // when a measured route has no result, so a harness crash can never read as a pass.
  const unmeasured = rows.some((row) => row.verdict === "fail");
  return code !== 0 || unmeasured ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
