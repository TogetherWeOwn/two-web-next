// Reviewed source semantics only: not Wrangler-normalized config or live settings.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./worker-bundle-evidence.mjs";
import { readWranglerConfig } from "./wrangler-config.mjs";

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} object required`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `unreviewed ${label} fields`);
}

export function verifyKitSourceConfig(root, kit) {
  exactKeys(
    root,
    [
      "$schema",
      "name",
      "main",
      "compatibility_date",
      "compatibility_flags",
      "observability",
      "placement",
      "tail_consumers",
      "workers_dev",
      "keep_vars",
      "routes",
      "triggers",
      "queues",
      "version_metadata",
      "assets",
      "hyperdrive",
      "vars",
      "env",
    ],
    "root config",
  );
  exactKeys(root.env, ["production"], "environments");
  const production = root.env.production;
  exactKeys(
    production,
    [
      "name",
      "workers_dev",
      "placement",
      "preview_urls",
      "tail_consumers",
      "version_metadata",
      "routes",
      "triggers",
      "queues",
      "hyperdrive",
      "vars",
    ],
    "production config",
  );
  exactKeys(root.assets, ["directory", "binding", "run_worker_first"], "root assets");
  assert.equal(root.main, "src/worker.ts", "pure-Hono baseline entry required");
  assert.equal(production.name, "two-web-next-production", "production script required");
  assert.equal(root.assets.binding, "ASSETS", "asset binding required");
  assert.equal(root.assets.run_worker_first, true, "Worker host guard must run first");
  assert.equal(root.keep_vars, true, "existing vars must be retained");
  assert.deepEqual(production.triggers, { crons: [] }, "web Worker must have no cron jobs");
  exactKeys(production.queues, ["producers"], "production queues");
  assert.ok(
    production.vars && typeof production.vars === "object" && !Array.isArray(production.vars),
    "production vars object required",
  );
  for (const [name, value] of Object.entries(production.vars)) {
    assert.equal(typeof value, "string", "source vars must be strings");
    assert.ok(!name.startsWith("KIT_ROUTE_") && name !== "QA_AUTH_TOKEN", "unexpected baseline var");
  }
  const expected = {
    $schema: root.$schema,
    name: production.name,
    main: "worker.js",
    compatibility_date: root.compatibility_date,
    compatibility_flags: root.compatibility_flags,
    observability: root.observability,
    workers_dev: production.workers_dev,
    preview_urls: production.preview_urls,
    placement: production.placement,
    tail_consumers: production.tail_consumers,
    version_metadata: production.version_metadata,
    keep_vars: root.keep_vars,
    triggers: production.triggers,
    queues: production.queues,
    assets: {
      directory: ".svelte-kit/cloudflare",
      binding: root.assets.binding,
      run_worker_first: root.assets.run_worker_first,
    },
    hyperdrive: production.hyperdrive,
    vars: { ...production.vars, KIT_ROUTE_ARCHIVE: "false", KIT_ROUTE_STATIC: "false" },
  };
  assert.deepEqual(kit, expected, "Kit config differs from reviewed source contract");
  return {
    schema: "two.kit-source-config.v1",
    evidence: "reviewed-source-config-only",
    target: kit.name,
    config: kit,
    nonVersioned: {
      routes: production.routes,
      tail_consumers: kit.tail_consumers,
      triggers: kit.triggers,
    },
  };
}

function main() {
  const [output, ...extra] = process.argv.slice(2);
  assert.ok(output && !extra.length, "usage: kit-source-config.mjs <output>");
  const files = ["wrangler.jsonc", "web/wrangler.production.jsonc"];
  const inputs = files.map((path) => ({ path, bytes: readFileSync(path) }));
  const [root, kit] = inputs.map((file) => readWranglerConfig(file.bytes.toString("utf8")));
  const receipt = {
    ...verifyKitSourceConfig(root, kit),
    inputs: inputs.map(({ path, bytes }) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
  };
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
