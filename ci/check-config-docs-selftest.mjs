import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getPlatformProxy } from "wrangler";
import { checkKeys, readDocKeys, readEnvKeys, readWranglerConfig, readWranglerKeys } from "./check-config-docs.mjs";

const inventory = (rows) => `<!-- config-docs:start -->
| Name | Kind | Environments | Default | Failure behaviour |
| --- | --- | --- | --- | --- |
${rows}
<!-- config-docs:end -->`;
const row = (key) => `| \`${key}\` | var | dev/staging/prod | none | refuses |`;
const set = (...keys) => new Set(keys);

test("resolves inherited, optional and job keys without comments or nested fields", () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "config-selftest-"));
  try {
    const file = join(dir, "env.ts");
    const config = join(dir, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ files: ["env.ts"], compilerOptions: { noLib: true } }));
    writeFileSync(file, `
      interface Ingress { readonly INGRESS?: string }
      export type Env = Ingress & {
        APP_URL: string; // PHANTOM?: string;
        DB?: { connectionString: string; nested: { NESTED: string } };
        /* NOT_A_KEY: string; */ "QUOTED"?: string;
      };
      export type JobsEnv = Env & { QUEUE: { send(): void }; };
      export type Session = { username: string };
    `);
    assert.deepEqual(readEnvKeys(file, config), set("INGRESS", "APP_URL", "DB", "QUOTED", "QUEUE"));
    writeFileSync(file, "export type JobsEnv = { QUEUE: string };");
    assert.throws(() => readEnvKeys(file, config), /Missing Env/);
    writeFileSync(file, "export type Env = { APP_URL: string }; export type JobsEnv = Env & {");
    assert.throws(() => readEnvKeys(file, config), /syntax errors/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parses JSONC, environment-specific vars and nested binding declarations", () => {
  assert.deepEqual(readWranglerKeys(`{
    // ignore { "binding": "COMMENT" }
    "vars": { "APP_URL": "https://example.test/a//b", "TEXT": "literal,}/*kept*/" },
    "hyperdrive": [{ "binding": "DB", "id": "placeholder", }],
    "queues": { "producers": [{ "binding": "QUEUE", "queue": "queue-name" }],
      "consumers": [{ "queue": "queue-name" }] },
    "env": { "staging": { "vars": { "STAGING_ONLY": "" },
      "assets": { "binding": "ASSETS" } } },
    /* comment */ "assets": { "directory": "./public" },
  }`), set("APP_URL", "TEXT", "DB", "QUEUE", "STAGING_ONLY", "ASSETS"));
  assert.throws(() => readWranglerKeys("{broken}"), SyntaxError);
});

test("finds name-based bindings at the root and in named environments", () => {
  const keys = readWranglerKeys(JSON.stringify({
    name: "worker-metadata",
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
    send_email: [{ name: "MAIL", destination_address: "test@example.invalid" }],
    ratelimits: [{ name: "LIMIT", namespace_id: "1", simple: { limit: 1, period: 60 } }],
    workflows: [{ binding: "FLOW", name: "workflow-metadata", class_name: "Flow" }],
    env: { staging: {
      durable_objects: { bindings: [{ name: "STAGING_COUNTER", class_name: "Counter" }] },
      send_email: [{ name: "STAGING_MAIL" }],
      logfwdr: { bindings: [{ name: "LOGS" }] },
      unsafe: { bindings: [{ name: "UNSAFE", type: "some_type", dev: { plugin: { name: "metadata" } } }] },
    } },
  }));
  assert.deepEqual(keys, set("COUNTER", "MAIL", "LIMIT", "FLOW", "STAGING_COUNTER", "STAGING_MAIL", "LOGS", "UNSAFE"));
  for (const key of keys) {
    assert.deepEqual(checkKeys(set(), set(key), set()), [
      `Wrangler key missing from Env/JobsEnv: ${key}`,
      `Undocumented Wrangler key: ${key}`,
    ]);
  }
});

test("does not interpret JSON var data or deployment metadata as declarations", () => {
  assert.deepEqual(readWranglerKeys(JSON.stringify({
    vars: {
      DATA: { binding: "PHANTOM", name: "NOT_A_BINDING", vars: { NESTED: "value" },
        durable_objects: { bindings: [{ name: "FAKE_DO" }] },
        env: { staging: { vars: { FAKE_ENV: "value" } } } },
    },
    queues: { consumers: [{ queue: "queue-metadata" }] },
    migrations: [{ tag: "v1", new_classes: ["CLASS_METADATA"] }],
    env: { staging: { vars: { OTHER_DATA: [{ binding: "ALSO_PHANTOM" }] } } },
  })), set("DATA", "OTHER_DATA"));
});

test("local config starts with the passwordless test URL and no Hyperdrive", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const config = readWranglerConfig(readFileSync(join(root, "wrangler.local.jsonc"), "utf8"));
  assert.equal(config.hyperdrive, undefined);
  assert.equal(config.env, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.workers_dev, false);
  assert.equal(config.vars.APP_URL, "http://localhost:8787");
  for (const entry of [...config.queues.producers, ...config.queues.consumers]) {
    assert.ok(entry.queue.endsWith("-local"));
    assert.notEqual(entry.remote, true);
  }
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "config-local-"));
  let proxy;
  try {
    // Scratch .dev.vars is test-only; never load the workspace's auth secrets.
    config.main = resolve(root, config.main);
    config.assets.directory = resolve(root, config.assets.directory);
    writeFileSync(join(dir, "wrangler.json"), JSON.stringify(config));
    const url = "postgres://agent_test@agent-testdb:5432/two_web_next";
    writeFileSync(join(dir, ".dev.vars"), `DATABASE_URL=${url}\n`);
    // https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy
    proxy = await getPlatformProxy({ configPath: join(dir, "wrangler.json"), persist: false });
    assert.equal(proxy.env.DATABASE_URL, url);
    assert.equal(proxy.env.DB, undefined);
    assert.equal(proxy.env.HYPERDRIVE, undefined);
    assert.equal(typeof proxy.env.SYNC_EVENT_QUEUE.send, "function");
    assert.equal(typeof proxy.env.INTERNAL_ACTION_QUEUE.send, "function");
  } finally {
    await proxy?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requires inventory rows, not incidental mentions in prose", () => {
  const doc = `Extra \`OBSOLETE\` outside the inventory\n${inventory(row("APP_URL") + "\n" + row("DB"))}`;
  assert.deepEqual(readDocKeys(doc), set("APP_URL", "DB"));
  assert.throws(() => readDocKeys("APP_URL in prose only"), /inventory block/);
  assert.throws(() => readDocKeys(inventory("APP_URL in prose only")), /Empty/);
});

test("rejects duplicate rows, blank metadata and malformed inventory markers", () => {
  assert.throws(() => readDocKeys(inventory(row("DB") + "\n" + row("DB"))), /Duplicate/);
  assert.throws(() => readDocKeys(inventory("| `DB` | binding | dev | | fails |")), /Config rows/);
  assert.throws(() => readDocKeys(inventory("| DB | binding | dev | none | fails |")), /Invalid/);
  assert.throws(() => readDocKeys(inventory(row("DB")) + "<!-- config-docs:end -->"), /exactly one/);
  assert.throws(() => readDocKeys("<!-- config-docs:end -->\n<!-- config-docs:start -->"), /Reversed/);
});

test("accepts complete documentation", () => {
  assert.deepEqual(checkKeys(set("APP_URL", "DB"), set("DB"), set("APP_URL", "DB")), []);
});

test("fails when an optional or inherited Env key is missing", () => {
  assert.deepEqual(checkKeys(set("APP_URL", "INGRESS"), set(), set("APP_URL")),
    ["Undocumented Env/JobsEnv key: INGRESS"]);
});

test("fails when a removed Env key remains documented", () => {
  assert.deepEqual(checkKeys(set("APP_URL"), set(), set("APP_URL", "OLD_SECRET")),
    ["Obsolete doc key (not in Env/JobsEnv): OLD_SECRET"]);
});

test("fails when Wrangler gains an undeclared or undocumented binding", () => {
  assert.deepEqual(checkKeys(set("APP_URL"), set("NEW_QUEUE"), set("APP_URL")), [
    "Wrangler key missing from Env/JobsEnv: NEW_QUEUE",
    "Undocumented Wrangler key: NEW_QUEUE",
  ]);
});
