#!/usr/bin/env node
// Foreground dev server for the adapter-built Kit Worker, for the kit-parity
// Playwright project's webServer slot. Like ci/kit-worker-e2e.mjs, it uses a
// disposable loopback Postgres, fake Discord secrets, and never the preview
// Hyperdrive binding. This dev fixture also stubs Discord fetches for callback
// coverage, then serves until killed. Runs only in CI; refuses non-loopback databases.
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
const testWorker = join(scratch, "kit-worker.mjs");
writeFileSync(
  testWorker,
  [
    `import worker from ${JSON.stringify(worker)};`,
    "globalThis.fetch = async (input, init) => {",
    "  const request = new Request(input, init);",
    "  const url = new URL(request.url);",
    '  if (url.origin !== "https://discord.com") {',
    '    throw new Error("E2E blocked unmocked outbound fetch: " + request.method + " " + url.origin + url.pathname);',
    "  }",
    '  if (request.method === "POST" && url.pathname === "/api/v10/oauth2/token") {',
    '    const code = new URLSearchParams(await request.clone().text()).get("code") ?? "";',
    '    if (code === "e2e-blocked-code") return Response.json({ access_token: "e2e-blocked-token" });',
    '    if (code === "e2e-outage-code") return new Response("fixture outage", { status: 500 });',
    '    return Response.json({ access_token: "e2e-member-token" });',
    "  }",
    '  if (request.method === "GET" && url.pathname === "/api/v10/users/@me") {',
    '    return Response.json({ id: "900000000000001398", username: "E2E Discord Member", global_name: "E2E Discord Member", avatar: null });',
    "  }",
    '  if (request.method === "GET" && url.pathname === "/api/v10/guilds/326474832151838730/widget.json") {',
    '    return Response.json({ id: "326474832151838730" });',
    "  }",
    '  if (url.pathname === "/api/v10/guilds/326474832151838730/members/900000000000001398") {',
    '    if (request.method === "PUT") {',
    "      const body = await request.clone().json().catch(() => ({}));",
    '      return body.access_token === "e2e-blocked-token" ? new Response(null, { status: 403 }) : new Response(null, { status: 204 });',
    "    }",
    '    if (request.method === "GET") return Response.json({ roles: [] });',
    "  }",
    '  throw new Error("E2E blocked unmocked Discord fetch: " + request.method + " " + url.pathname);',
    "};",
    "// Mirror the Hono e2e entry's healthy-empty Discord seam (e2e/worker.ts):",
    "// both loopback targets simulate the same Discord state, so cross-target",
    "// renders agree and no run ever attempts a live Discord read.",
    "const entry = { ...worker };",
    "entry.fetch = (request, env, ctx) =>",
    "  worker.fetch(",
    "    request,",
    "    { ...env, DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false } },",
    "    ctx,",
    "  );",
    "export default entry;",
  ].join("\n"),
);
writeFileSync(
  config,
  JSON.stringify({
    name: "two-web-kit-parity-fixture",
    main: testWorker,
    compatibility_date: "2026-09-29",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: assets, binding: "ASSETS", run_worker_first: true },
    vars: {
      APP_URL: `http://127.0.0.1:${port}`,
      DATABASE_URL: databaseUrl,
      FEATURED_IMAGE_HOSTS: "",
      SESSION_SECRET: "ci-fixture-session-secret-at-least-32-bytes",
      DISCORD_CLIENT_ID: "ci-fixture-client",
      DISCORD_CLIENT_SECRET: "ci-fixture-secret",
      DISCORD_BOT_TOKEN: "ci-fixture-token",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_MODERATOR_ROLE_IDS: "",
      DISCORD_INVITE_URL: "https://example.invalid/invite",
      AGENT_EVENTS_ENABLED: "false",
      // Fixture-only parity ownership: this generated config serves
      // only the loopback parity worker (APP_URL is http://127.0.0.1 above),
      // and fixtureManifestFor honours the flags only on loopback, so the
      // executed journeys run the Kit loads. The shipped
      // manifest now owns the board on Kit everywhere deployed too, so
      // that flag is redundant for the entry (rollback is enabled: false);
      // the live detail entry stays disabled in the shipped manifest and the
      // fixture alone enables it for the RSVP companion journey.
      KIT_PARITY_FIXTURE_MEMBER_BOARD: "true",
      KIT_PARITY_FIXTURE_EVENT_DETAIL: "true",
      // Same shared `events-read:anon` bucket as the Hono loopback worker
      // (same disposable Postgres, no forwarded client headers), so the Kit
      // legs need the same raised budget (docs/event-read-admission.md).
      E2E_PUBLIC_READ_BUDGET: "600",
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
