#!/usr/bin/env node
// Foreground dev server for the adapter-built Kit Worker, for the kit-parity
// Playwright project's webServer slot. Same fixture shape as
// ci/kit-worker-e2e.mjs (disposable loopback Postgres, fake Discord secrets,
// never the preview Hyperdrive binding): that script asserts and exits, this
// one serves until killed. Runs only in CI; refuses non-loopback databases.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(repo, "web");
const worker = join(web, ".svelte-kit/cloudflare/_worker.js");
const assets = join(web, ".svelte-kit/cloudflare");
const databaseUrl = process.env.KIT_WORKER_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const port = Number(process.env.KIT_WORKER_PORT ?? "8788");

let db;
try {
  db = new URL(databaseUrl ?? "");
} catch {
  throw new Error(
    "kit-worker-dev: KIT_WORKER_TEST_DATABASE_URL/DATABASE_URL must be a valid Postgres URL",
  );
}
if (
  !["postgres:", "postgresql:"].includes(db.protocol) ||
  !["localhost", "127.0.0.1", "::1"].includes(db.hostname)
) {
  throw new Error("kit-worker-dev: Kit Worker fixture accepts only a disposable loopback Postgres");
}
try {
  const { statSync } = await import("node:fs");
  if (!statSync(worker).isFile()) throw new Error("not a file");
} catch {
  throw new Error(
    `kit-worker-dev: built worker missing at ${worker} (run npm run build --prefix web)`,
  );
}

const scratch = mkdtempSync(
  join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-worker-dev-"),
);
const config = join(scratch, "wrangler.jsonc");
writeFileSync(
  config,
  JSON.stringify({
    name: "two-web-kit-parity-fixture",
    main: worker,
    compatibility_date: "2026-09-29",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: assets, binding: "ASSETS", run_worker_first: true },
    vars: {
      APP_URL: `http://127.0.0.1:${port}`,
      DATABASE_URL: databaseUrl,
      FEATURED_IMAGE_HOSTS: "",
      DISCORD_CLIENT_ID: "ci-fixture-client",
      DISCORD_CLIENT_SECRET: "ci-fixture-secret",
      DISCORD_BOT_TOKEN: "ci-fixture-token",
      DISCORD_GUILD_ID: "ci-fixture-guild",
      DISCORD_MODERATOR_ROLE_IDS: "",
      DISCORD_INVITE_URL: "https://example.invalid/invite",
      AGENT_EVENTS_ENABLED: "false",
    },
  }),
);

const child = spawn(
  join(web, "node_modules/.bin/wrangler"),
  [
    "dev",
    "--config",
    config,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--log-level",
    "error",
  ],
  {
    cwd: repo,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill("SIGTERM"));
}
child.once("exit", (code) => process.exit(code ?? 1));

void fileURLToPath;
