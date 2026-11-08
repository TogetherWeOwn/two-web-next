import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verifyKitSourceConfig } from "./kit-source-config.mjs";
import { readWranglerConfig } from "./wrangler-config.mjs";

const repo = join(import.meta.dirname, "..");
const load = (path) => readWranglerConfig(readFileSync(join(repo, path), "utf8"));
const baseRoot = load("wrangler.jsonc");
const baseKit = load("web/wrangler.production.jsonc");

function fixtures() {
  return { root: structuredClone(baseRoot), kit: structuredClone(baseKit) };
}

function rejects(mutate) {
  const { root, kit } = fixtures();
  mutate(root, kit);
  assert.throws(() => verifyKitSourceConfig(root, kit));
}

test("repository configs yield the reviewed source-config evidence", () => {
  const { root, kit } = fixtures();
  const result = verifyKitSourceConfig(root, kit);
  assert.equal(result.schema, "two.kit-source-config.v1");
  assert.equal(result.evidence, "reviewed-source-config-only");
  assert.equal(result.target, kit.name);
  assert.equal(result.target, "two-web-next-production");
  assert.deepEqual(result.config, kit);
  assert.deepEqual(result.nonVersioned, {
    routes: root.env.production.routes,
    tail_consumers: kit.tail_consumers,
    triggers: kit.triggers,
  });
});

test("the Kit config is derived from the root and production env", () => {
  const { root, kit } = fixtures();
  const prod = root.env.production;
  assert.equal(kit.$schema, root.$schema);
  assert.equal(kit.name, prod.name);
  assert.equal(kit.main, "worker.js");
  assert.equal(kit.compatibility_date, root.compatibility_date);
  assert.deepEqual(kit.compatibility_flags, root.compatibility_flags);
  assert.deepEqual(kit.observability, root.observability);
  assert.equal(kit.keep_vars, root.keep_vars);
  for (const key of [
    "workers_dev",
    "preview_urls",
    "placement",
    "tail_consumers",
    "version_metadata",
    "triggers",
    "queues",
    "hyperdrive",
  ]) {
    assert.deepEqual(kit[key], prod[key], key);
  }
  assert.deepEqual(kit.assets, {
    directory: ".svelte-kit/cloudflare",
    binding: root.assets.binding,
    run_worker_first: root.assets.run_worker_first,
  });
  assert.deepEqual(kit.vars, {
    ...prod.vars,
    KIT_ROUTE_ARCHIVE: "false",
    KIT_ROUTE_STATIC: "false",
  });
});

test("unknown root and production fields are rejected", () => {
  rejects((root) => {
    root.unexpected = true;
  });
  rejects((root) => {
    root.d1_databases = [];
  });
  rejects((root) => {
    root.env.production.unexpected = 1;
  });
  rejects((root) => {
    root.env.production.compatibility_date = "2030-01-01";
  });
  rejects((root) => {
    root.env.production.assets = { directory: "./public" };
  });
  rejects((root) => {
    root.env.production.keep_vars = false;
  });
});

test("root top-level keys must stay inside the permitted set", () => {
  rejects((root) => {
    delete root.assets;
  });
  rejects((root) => {
    root.assets.not_found_handling = "single-page-application";
  });
  rejects((root) => {
    delete root.assets.run_worker_first;
  });
});

test("environment overrides other than production are rejected", () => {
  rejects((root) => {
    root.env.staging = { name: "two-web-next-staging" };
  });
  rejects((root) => {
    delete root.env.production;
  });
  rejects((root) => {
    root.env = [];
  });
});

test("root main and production target are pinned", () => {
  rejects((root) => {
    root.main = "src/other.ts";
  });
  rejects((root, kit) => {
    root.env.production.name = "two-web-next";
    kit.name = "two-web-next";
  });
  rejects((_root, kit) => {
    kit.name = "two-web-next";
  });
  rejects((_root, kit) => {
    kit.main = "src/worker.ts";
  });
});

test("extra Kit route, config and asset settings are rejected", () => {
  rejects((_root, kit) => {
    kit.routes = structuredClone(baseRoot.env.production.routes);
  });
  rejects((_root, kit) => {
    kit.route = `${baseRoot.env.production.routes[0].pattern}/*`;
  });
  rejects((_root, kit) => {
    kit.account_id = "x";
  });
  rejects((_root, kit) => {
    kit.env = {};
  });
  rejects((_root, kit) => {
    kit.assets.html_handling = "none";
  });
  rejects((_root, kit) => {
    kit.assets.directory = "./public";
  });
  rejects((_root, kit) => {
    kit.assets.run_worker_first = false;
  });
  rejects((_root, kit) => {
    kit.assets.binding = "STATIC";
  });
  rejects((_root, kit) => {
    kit.vars.EXTRA = "1";
  });
  rejects((_root, kit) => {
    delete kit.vars.APP_URL;
  });
});

test("Kit family flags are fixed to false", () => {
  rejects((_root, kit) => {
    kit.vars.KIT_ROUTE_ARCHIVE = "true";
  });
  rejects((_root, kit) => {
    kit.vars.KIT_ROUTE_STATIC = "true";
  });
  rejects((_root, kit) => {
    delete kit.vars.KIT_ROUTE_STATIC;
  });
  rejects((_root, kit) => {
    kit.vars.KIT_ROUTE_EVENTS = "true";
  });
});

test("compatibility, binding, tail and jobs drift is rejected", () => {
  rejects((_root, kit) => {
    kit.compatibility_date = "2026-01-01";
  });
  rejects((_root, kit) => {
    kit.compatibility_flags = [];
  });
  rejects((_root, kit) => {
    kit.observability = { enabled: false };
  });
  rejects((_root, kit) => {
    kit.keep_vars = false;
  });
  rejects((_root, kit) => {
    kit.workers_dev = true;
  });
  rejects((_root, kit) => {
    kit.preview_urls = true;
  });
  rejects((_root, kit) => {
    kit.placement = { region: "aws:us-east-1" };
  });
  rejects((_root, kit) => {
    kit.version_metadata.binding = "OTHER";
  });
  rejects((_root, kit) => {
    kit.tail_consumers = [{ service: "two-web-next-alerts" }];
  });
  rejects((_root, kit) => {
    kit.tail_consumers = [];
  });
  rejects((_root, kit) => {
    kit.hyperdrive[0].id = "0".repeat(32);
  });
  rejects((_root, kit) => {
    kit.hyperdrive.pop();
  });
  rejects((_root, kit) => {
    kit.queues.producers[0].binding = "OTHER_QUEUE";
  });
  rejects((_root, kit) => {
    kit.queues.consumers = [{ queue: "two-web-next-production-sync-event" }];
  });
  rejects((_root, kit) => {
    kit.triggers.crons = ["* * * * *"];
  });
  rejects((root) => {
    root.env.production.triggers.crons = ["* * * * *"];
  });
});

test("malformed baseline shapes are rejected", () => {
  for (const bad of [null, undefined, [], "text", 1]) {
    assert.throws(() => verifyKitSourceConfig(bad, structuredClone(baseKit)));
    assert.throws(() => verifyKitSourceConfig(structuredClone(baseRoot), bad));
  }
  rejects((root) => {
    root.env.production = null;
  });
  rejects((root) => {
    root.env.production.vars = [];
  });
  rejects((root) => {
    root.assets = "./public";
  });
  rejects((root) => {
    root.env.production.queues = null;
  });
  rejects((_root, kit) => {
    kit.assets = null;
  });
  rejects((_root, kit) => {
    kit.vars = null;
  });
});

test("Actions run this test and write the source-config artifact", () => {
  const text = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
  assert.ok(text.includes("node --test ci/kit-source-config.test.mjs"));
  assert.ok(
    text.includes(
      "node ci/kit-source-config.mjs artifacts/kit-upload-rehearsal/source-config.json",
    ),
  );
});
