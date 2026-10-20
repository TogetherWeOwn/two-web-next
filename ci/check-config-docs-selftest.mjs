import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getPlatformProxy } from "wrangler";
import {
  checkKeys,
  checkTailKeys,
  readAppScriptNames,
  readAppTailConsumers,
  readDocKeys,
  readEnvKeys,
  readTailDocKeys,
  readTailEnvKeys,
  readTailScriptNames,
  readTailWorkerNames,
  readTailWranglerVars,
  readWranglerConfig,
  readWranglerKeys,
} from "./check-config-docs.mjs";

const inventory = (rows) => `<!-- config-docs:start -->
| Name | Kind | Environments | Default | Failure behaviour |
| --- | --- | --- | --- | --- |
${rows}
<!-- config-docs:end -->`;
const row = (key) => `| \`${key}\` | var | dev/staging/prod | none | refuses |`;
const set = (...keys) => new Set(keys);

test("resolves inherited, optional and job keys without comments or nested fields", () => {
  const dir = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "config-selftest-"),
  );
  try {
    const file = join(dir, "env.ts");
    const config = join(dir, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ files: ["env.ts"], compilerOptions: { noLib: true } }));
    writeFileSync(
      file,
      `
      interface Ingress { readonly INGRESS?: string }
      export type Env = Ingress & {
        APP_URL: string; // PHANTOM?: string;
        DB?: { connectionString: string; nested: { NESTED: string } };
        /* NOT_A_KEY: string; */ "QUOTED"?: string;
      };
      export type JobsEnv = Env & { QUEUE: { send(): void }; };
      export type Session = { username: string };
    `,
    );
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
  assert.deepEqual(
    readWranglerKeys(`{
    // ignore { "binding": "COMMENT" }
    "vars": { "APP_URL": "https://example.test/a//b", "TEXT": "literal,}/*kept*/" },
    "hyperdrive": [{ "binding": "DB", "id": "placeholder", }],
    "queues": { "producers": [{ "binding": "QUEUE", "queue": "queue-name" }],
      "consumers": [{ "queue": "queue-name" }] },
    "env": { "staging": { "vars": { "STAGING_ONLY": "" },
      "assets": { "binding": "ASSETS" } } },
    /* comment */ "assets": { "directory": "./public" },
  }`),
    set("APP_URL", "TEXT", "DB", "QUEUE", "STAGING_ONLY", "ASSETS"),
  );
  assert.throws(() => readWranglerKeys("{broken}"), SyntaxError);
});

test("finds name-based bindings at the root and in named environments", () => {
  const keys = readWranglerKeys(
    JSON.stringify({
      name: "worker-metadata",
      durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
      send_email: [{ name: "MAIL", destination_address: "test@example.invalid" }],
      ratelimits: [{ name: "LIMIT", namespace_id: "1", simple: { limit: 1, period: 60 } }],
      workflows: [{ binding: "FLOW", name: "workflow-metadata", class_name: "Flow" }],
      env: {
        staging: {
          durable_objects: { bindings: [{ name: "STAGING_COUNTER", class_name: "Counter" }] },
          send_email: [{ name: "STAGING_MAIL" }],
          logfwdr: { bindings: [{ name: "LOGS" }] },
          unsafe: {
            bindings: [
              { name: "UNSAFE", type: "some_type", dev: { plugin: { name: "metadata" } } },
            ],
          },
        },
      },
    }),
  );
  assert.deepEqual(
    keys,
    set("COUNTER", "MAIL", "LIMIT", "FLOW", "STAGING_COUNTER", "STAGING_MAIL", "LOGS", "UNSAFE"),
  );
  for (const key of keys) {
    assert.deepEqual(checkKeys(set(), set(key), set()), [
      `Wrangler key missing from Env/JobsEnv: ${key}`,
      `Undocumented Wrangler key: ${key}`,
    ]);
  }
});

test("collects required secret names at root and in named environments", () => {
  const keys = readWranglerKeys(
    JSON.stringify({
      vars: { APP_URL: "https://example.test" },
      secrets: { required: ["NEW_SECRET"] },
      env: { staging: { secrets: { required: ["STAGING_SECRET"] } } },
    }),
  );
  assert.deepEqual(keys, set("APP_URL", "NEW_SECRET", "STAGING_SECRET"));
  // Secret names (never values) are enforced like any other Wrangler key.
  assert.deepEqual(checkKeys(set("APP_URL"), set("NEW_SECRET", "STAGING_SECRET"), set("APP_URL")), [
    "Wrangler key missing from Env/JobsEnv: NEW_SECRET",
    "Undocumented Wrangler key: NEW_SECRET",
    "Wrangler key missing from Env/JobsEnv: STAGING_SECRET",
    "Undocumented Wrangler key: STAGING_SECRET",
  ]);
  // Declared, typed and documented secrets pass.
  assert.deepEqual(
    checkKeys(
      set("APP_URL", "NEW_SECRET", "STAGING_SECRET"),
      set("NEW_SECRET", "STAGING_SECRET"),
      set("APP_URL", "NEW_SECRET", "STAGING_SECRET"),
    ),
    [],
  );
});

test("does not interpret JSON var data or deployment metadata as declarations", () => {
  assert.deepEqual(
    readWranglerKeys(
      JSON.stringify({
        vars: {
          DATA: {
            binding: "PHANTOM",
            name: "NOT_A_BINDING",
            vars: { NESTED: "value" },
            durable_objects: { bindings: [{ name: "FAKE_DO" }] },
            env: { staging: { vars: { FAKE_ENV: "value" } } },
          },
        },
        queues: { consumers: [{ queue: "queue-metadata" }] },
        migrations: [{ tag: "v1", new_classes: ["CLASS_METADATA"] }],
        env: { staging: { vars: { OTHER_DATA: [{ binding: "ALSO_PHANTOM" }] } } },
      }),
    ),
    set("DATA", "OTHER_DATA"),
  );
});

async function withLocalProxy(create, use, remove = rmSync) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "config-local-"));
  const errors = [];
  let proxy;
  try {
    proxy = await create(dir);
    await use(proxy);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await proxy?.dispose();
    } catch (error) {
      errors.push(error);
    }
    try {
      remove(dir, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 1) throw new AggregateError(errors, "Local config test teardown failed");
  if (errors.length) throw errors[0];
}

test("local proxy scratch is removed on success after disposal", async () => {
  let owned;
  let disposed = false;
  await withLocalProxy(
    (dir) => {
      owned = dir;
      writeFileSync(join(dir, "fixture"), "offline");
      return {
        dispose: async () => {
          assert.ok(existsSync(dir));
          disposed = true;
        },
      };
    },
    () => {},
  );
  assert.equal(disposed, true);
  assert.equal(existsSync(owned), false);
});

test("local proxy scratch is removed after fixture or startup failure", async () => {
  const failure = new Error("fixture/startup failed");
  let owned;
  await assert.rejects(
    withLocalProxy(
      (dir) => {
        owned = dir;
        writeFileSync(join(dir, "fixture"), "offline");
        throw failure;
      },
      () => assert.fail("must not use a missing proxy"),
    ),
    (error) => error === failure,
  );
  assert.equal(existsSync(owned), false);
});

test("local proxy scratch is removed and proxy disposed after assertion failure", async () => {
  let owned;
  let disposed = false;
  await assert.rejects(
    withLocalProxy(
      (dir) => {
        owned = dir;
        return {
          dispose: async () => {
            disposed = true;
          },
        };
      },
      () => assert.fail("original assertion"),
    ),
    /original assertion/,
  );
  assert.equal(disposed, true);
  assert.equal(existsSync(owned), false);
});

test("local proxy scratch is removed even when disposal rejects", async () => {
  const failure = new Error("dispose rejected");
  let owned;
  await assert.rejects(
    withLocalProxy(
      (dir) => {
        owned = dir;
        writeFileSync(join(dir, "fixture"), "offline");
        return {
          dispose: async () => {
            throw failure;
          },
        };
      },
      () => {},
    ),
    (error) => error === failure,
  );
  assert.equal(existsSync(owned), false);
});

test("local proxy teardown preserves assertion, disposal and removal failures", async () => {
  const assertionFailure = new Error("original assertion");
  const disposeFailure = new Error("dispose rejected");
  const removeFailure = new Error("remove failed");
  let owned;
  await assert.rejects(
    withLocalProxy(
      (dir) => {
        owned = dir;
        return {
          dispose: async () => {
            throw disposeFailure;
          },
        };
      },
      () => {
        throw assertionFailure;
      },
      (dir, options) => {
        rmSync(dir, options);
        throw removeFailure;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [assertionFailure, disposeFailure, removeFailure]);
      return true;
    },
  );
  assert.equal(existsSync(owned), false);
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
  const url = "postgres://agent_test@agent-testdb:5432/two_web_next";
  await withLocalProxy(
    async (dir) => {
      // Scratch .dev.vars is test-only; never load the workspace's auth secrets.
      config.main = resolve(root, config.main);
      config.assets.directory = resolve(root, config.assets.directory);
      writeFileSync(join(dir, "wrangler.json"), JSON.stringify(config));
      writeFileSync(join(dir, ".dev.vars"), `DATABASE_URL=${url}\n`);
      // https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy
      return getPlatformProxy({ configPath: join(dir, "wrangler.json"), persist: false });
    },
    (proxy) => {
      assert.equal(proxy.env.DATABASE_URL, url);
      assert.equal(proxy.env.DB, undefined);
      assert.equal(proxy.env.HYPERDRIVE, undefined);
      assert.equal(typeof proxy.env.SYNC_EVENT_QUEUE.send, "function");
      assert.equal(typeof proxy.env.INTERNAL_ACTION_QUEUE.send, "function");
    },
  );
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
  assert.throws(
    () => readDocKeys(inventory(row("DB")) + "<!-- config-docs:end -->"),
    /exactly one/,
  );
  assert.throws(
    () => readDocKeys("<!-- config-docs:end -->\n<!-- config-docs:start -->"),
    /Reversed/,
  );
});

test("accepts complete documentation", () => {
  assert.deepEqual(checkKeys(set("APP_URL", "DB"), set("DB"), set("APP_URL", "DB")), []);
});

test("fails when an optional or inherited Env key is missing", () => {
  assert.deepEqual(checkKeys(set("APP_URL", "INGRESS"), set(), set("APP_URL")), [
    "Undocumented Env/JobsEnv key: INGRESS",
  ]);
});

test("fails when a removed Env key remains documented", () => {
  assert.deepEqual(checkKeys(set("APP_URL"), set(), set("APP_URL", "OLD_SECRET")), [
    "Obsolete doc key (not in Env/JobsEnv): OLD_SECRET",
  ]);
});

test("fails when Wrangler gains an undeclared or undocumented binding", () => {
  assert.deepEqual(checkKeys(set("APP_URL"), set("NEW_QUEUE"), set("APP_URL")), [
    "Wrangler key missing from Env/JobsEnv: NEW_QUEUE",
    "Undocumented Wrangler key: NEW_QUEUE",
  ]);
});

test("tail inventory covers vars, secrets, services and script names without inheritance", () => {
  const tailVars = readTailWranglerVars(
    JSON.stringify({
      vars: { UPTIME_URL: "https://staging.example/up" },
      secrets: { required: ["OPS_ALERT_WEBHOOK_URL"] },
      env: { production: { vars: { UPTIME_URL: "https://apex.example/up" } } },
    }),
  );
  assert.deepEqual(tailVars, set("UPTIME_URL", "OPS_ALERT_WEBHOOK_URL"));
  const workerNames = readTailWorkerNames(
    JSON.stringify({
      name: "two-web-next-alerts",
      env: { production: { name: "two-web-next-alerts-production" } },
    }),
  );
  assert.deepEqual(workerNames, set("two-web-next-alerts", "two-web-next-alerts-production"));
  const appConfig = JSON.stringify({
    name: "two-web-next",
    tail_consumers: [{ service: "two-web-next-alerts" }],
    env: {
      production: {
        name: "two-web-next-production",
        tail_consumers: [{ service: "two-web-next-alerts-production" }],
      },
    },
  });
  const consumers = readAppTailConsumers(appConfig);
  assert.deepEqual(consumers, set("two-web-next-alerts", "two-web-next-alerts-production"));
  assert.deepEqual(readAppScriptNames(appConfig), set("two-web-next", "two-web-next-production"));
  const renamedProduction = JSON.stringify({
    name: "two-web-next",
    tail_consumers: [{ service: "two-web-next-alerts" }],
    env: {
      production: {
        name: "two-web-next-prod",
        tail_consumers: [{ service: "two-web-next-alerts-production" }],
      },
    },
  });
  const appScripts = readAppScriptNames(renamedProduction);
  assert.deepEqual(appScripts, set("two-web-next", "two-web-next-prod"));
  assert.deepEqual(
    checkTailKeys(
      set(),
      set(),
      set("two-web-next-alerts-production"),
      set("two-web-next-alerts-production"),
      set("two-web-next", "two-web-next-production"),
      set("two-web-next", "two-web-next-production", "two-web-next-alerts-production"),
      appScripts,
    ),
    [
      "App script not accepted by Tail: two-web-next-prod (wrangler.jsonc/web/wrangler.staging.jsonc/wrangler.jobs.jsonc vs tail/worker.ts APP_SCRIPT_NAMES)",
    ],
  );
  assert.deepEqual(
    readAppScriptNames(
      JSON.stringify({
        name: "two-web-next",
        env: { production: { tail_consumers: [{ service: "alerts" }] } },
      }),
    ),
    set("two-web-next-production"),
  );
  const scripts = readTailScriptNames(
    `export const APP_SCRIPT_NAMES = new Set(["two-web-next", "two-web-next-production"]);`,
  );
  assert.deepEqual(scripts, set("two-web-next", "two-web-next-production"));
  assert.throws(() => readTailScriptNames("export const APP_SCRIPT_NAMES = new Set([]);"), /Empty/);
});

const tailInventory = (rows) => `<!-- tail-config-docs:start -->
| Name | Kind | Environments | Default | Failure behaviour |
| --- | --- | --- | --- | --- |
${rows}
<!-- tail-config-docs:end -->`;
const tailRow = (key) =>
  `| \`${key}\` | test kind | tail staging/prod | none | silently disables paging |`;

test("tail doc table accepts service aliases and rejects malformed rows", () => {
  const doc = tailInventory(
    [tailRow("UPTIME_URL"), tailRow("two-web-next-alerts"), tailRow("two-web-next")].join("\n"),
  );
  assert.deepEqual(
    doc && readTailDocKeys(doc),
    set("UPTIME_URL", "two-web-next-alerts", "two-web-next"),
  );
  assert.throws(
    () => readTailDocKeys(tailInventory(tailRow("UPTIME_URL") + "\n" + tailRow("UPTIME_URL"))),
    /Duplicate/,
  );
  assert.throws(
    () => readTailDocKeys(tailInventory("| `DB` | binding | dev | | fails |")),
    /Tail config rows/,
  );
  assert.throws(
    () => readTailDocKeys(tailInventory("| DB | binding | dev | none | fails |")),
    /Invalid tail/,
  );
  assert.throws(() => readTailDocKeys("UPTIME_URL in prose only"), /tail-config-docs/);
});

test("tail check passes when every declaration is documented", () => {
  const tailEnv = set("UPTIME_URL", "OPS_ALERT_WEBHOOK_URL");
  const tailVars = set("UPTIME_URL");
  const workerNames = set("two-web-next-alerts", "two-web-next-alerts-production");
  const consumers = set("two-web-next-alerts", "two-web-next-alerts-production");
  const scripts = set("two-web-next", "two-web-next-production");
  const docs = set(
    "UPTIME_URL",
    "OPS_ALERT_WEBHOOK_URL",
    "two-web-next-alerts",
    "two-web-next-alerts-production",
    "two-web-next",
    "two-web-next-production",
  );
  assert.deepEqual(checkTailKeys(tailEnv, tailVars, workerNames, consumers, scripts, docs), []);
});

test("tail check fails when a declaration is omitted from the docs", () => {
  const tailEnv = set("UPTIME_URL", "OPS_ALERT_WEBHOOK_URL");
  const tailVars = set("UPTIME_URL");
  const workerNames = set("two-web-next-alerts");
  const consumers = set("two-web-next-alerts");
  const scripts = set("two-web-next");
  const docs = set("UPTIME_URL", "two-web-next-alerts", "two-web-next");
  assert.deepEqual(checkTailKeys(tailEnv, tailVars, workerNames, consumers, scripts, docs), [
    "Undocumented TailEnv key: OPS_ALERT_WEBHOOK_URL (tail/worker.ts -> docs/config.md)",
  ]);
  assert.deepEqual(
    checkTailKeys(
      tailEnv,
      tailVars,
      set("two-web-next-alerts"),
      set("two-web-next-alerts", "missing-service"),
      scripts,
      set("UPTIME_URL", "OPS_ALERT_WEBHOOK_URL", "two-web-next-alerts", "two-web-next"),
    ),
    [
      "Undocumented Tail consumer service: missing-service (wrangler.jsonc/web/wrangler.staging.jsonc/wrangler.jobs.jsonc -> docs/config.md)",
      "App tail_consumer without Tail worker: missing-service (wrangler.jsonc/web/wrangler.staging.jsonc/wrangler.jobs.jsonc vs tail/wrangler.jsonc)",
    ],
  );
});

test("tail check fails on obsolete or misspelled documented keys", () => {
  const tailEnv = set("UPTIME_URL");
  const docs = set("UPTIME_URL", "OBSOLETE_TAIL_KEY");
  assert.deepEqual(
    checkTailKeys(
      tailEnv,
      set("UPTIME_URL"),
      set(),
      set(),
      set("two-web-next"),
      set("UPTIME_URL", "two-web-next"),
    ),
    [],
  );
  assert.deepEqual(checkTailKeys(tailEnv, set("UPTIME_URL"), set(), set(), set(), docs), [
    "Obsolete Tail doc key: OBSOLETE_TAIL_KEY (docs/config.md)",
  ]);
  assert.deepEqual(
    checkTailKeys(
      tailEnv,
      set("UPTIME_URL"),
      set(),
      set(),
      set("two-web-next"),
      set("UPTIME_URL", "two-web-next-typo"),
    ),
    [
      "Undocumented Tail app script name: two-web-next (tail/worker.ts -> docs/config.md)",
      "Obsolete Tail doc key: two-web-next-typo (docs/config.md)",
    ],
  );
});

test("tail check covers environment-only declarations without inheritance", () => {
  const tailVars = readTailWranglerVars(
    JSON.stringify({ vars: {}, env: { production: { vars: { ENV_ONLY_VAR: "x" } } } }),
  );
  assert.deepEqual(tailVars, set("ENV_ONLY_VAR"));
  const tailEnv = set("ENV_ONLY_VAR");
  assert.deepEqual(checkTailKeys(tailEnv, tailVars, set(), set(), set(), set("ENV_ONLY_VAR")), []);
  assert.deepEqual(checkTailKeys(tailEnv, tailVars, set(), set(), set(), set()), [
    "Undocumented TailEnv key: ENV_ONLY_VAR (tail/worker.ts -> docs/config.md)",
    "Undocumented Tail Wrangler key: ENV_ONLY_VAR (tail/wrangler.jsonc -> docs/config.md)",
  ]);
});

test("tail env keys resolve from the TailEnv alias without secret values", () => {
  const dir = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "tail-selftest-"),
  );
  try {
    const file = join(dir, "worker.ts");
    const config = join(dir, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({ files: ["worker.ts"], compilerOptions: { noLib: true } }),
    );
    writeFileSync(
      file,
      `export type TailEnv = { OPS_ALERT_WEBHOOK_URL?: string; UPTIME_URL?: string };`,
    );
    assert.deepEqual(readTailEnvKeys(file, config), set("OPS_ALERT_WEBHOOK_URL", "UPTIME_URL"));
    writeFileSync(file, `export type TailEnv = { UPTIME_URL?: string };`);
    assert.deepEqual(readTailEnvKeys(file, config), set("UPTIME_URL"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Composition acceptance: the composed check (checkConfigDocs via the CLI)
// must include wrangler.jobs.jsonc root and named-environment declarations in
// the same Env/JobsEnv/documented-key union as the app configs. Parser-only
// coverage above cannot prove composition, so these tests copy the checker
// into a synthetic tree (it resolves its root from its own location) and run
// the real CLI against fixture configs. Removing wrangler.jobs.jsonc from the
// composed scan is the omission mutant every jobs-only case below must catch.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function runComposedCheck({
  appVars = {},
  stagingVars = {},
  jobsRootVars = {},
  jobsRootBindings = [],
  jobsRootSecrets = [],
  jobsPreviewVars = {},
  jobsPreviewBindings = [],
  jobsPreviewSecrets = [],
  extraJobsEnvKeys = [],
} = {}) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "jobs-comp-"));
  try {
    for (const entry of ["ci", "src", "docs", "tail", "web"]) mkdirSync(join(dir, entry));
    copyFileSync(join(repoRoot, "ci/check-config-docs.mjs"), join(dir, "ci/check-config-docs.mjs"));
    copyFileSync(join(repoRoot, "ci/wrangler-config.mjs"), join(dir, "ci/wrangler-config.mjs"));
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
    const write = (path, content) => writeFileSync(join(dir, path), content);
    write(
      "tsconfig.json",
      JSON.stringify({
        files: ["src/env.ts", "tail/worker.ts"],
        compilerOptions: { noLib: true },
      }),
    );
    const jobsEnvKeys = [
      "JOBS_ROOT_VAR?: string",
      "JOBS_QUEUE: { send(): void }",
      "JOBS_SECRET?: string",
      "JOBS_PREVIEW_VAR?: string",
      "JOBS_PREVIEW_QUEUE: { send(): void }",
      "JOBS_PREVIEW_SECRET?: string",
      ...extraJobsEnvKeys,
    ];
    write(
      "src/env.ts",
      `export type Env = { APP_URL: string; DB: { connectionString: string } };\n` +
        `export type JobsEnv = Env & { ${jobsEnvKeys.join("; ")} };\n`,
    );
    const documented = [
      "APP_URL",
      "DB",
      "JOBS_ROOT_VAR",
      "JOBS_QUEUE",
      "JOBS_SECRET",
      "JOBS_PREVIEW_VAR",
      "JOBS_PREVIEW_QUEUE",
      "JOBS_PREVIEW_SECRET",
    ];
    write(
      "docs/config.md",
      `${inventory(documented.map(row).join("\n"))}\n` +
        `${tailInventory(["UPTIME_URL", "tail-fixture", "app-fixture"].map(tailRow).join("\n"))}\n`,
    );
    write(
      "wrangler.jsonc",
      JSON.stringify({
        name: "app-fixture",
        vars: { APP_URL: "https://example.test", ...appVars },
        hyperdrive: [{ binding: "DB", id: "fixture" }],
      }),
    );
    write("wrangler.local.jsonc", JSON.stringify({ vars: { APP_URL: "http://localhost:8787" } }));
    write(
      "web/wrangler.staging.jsonc",
      JSON.stringify({
        name: "app-fixture",
        vars: { APP_URL: "https://example.test", ...stagingVars },
        hyperdrive: [{ binding: "DB", id: "fixture" }],
      }),
    );
    write(
      "wrangler.jobs.jsonc",
      JSON.stringify({
        name: "jobs-fixture",
        vars: { JOBS_ROOT_VAR: "fixture", ...jobsRootVars },
        queues: {
          producers: [
            { binding: "JOBS_QUEUE", queue: "fixture-queue" },
            ...jobsRootBindings.map((binding) => ({ binding, queue: "fixture-queue" })),
          ],
        },
        secrets: { required: ["JOBS_SECRET", ...jobsRootSecrets] },
        env: {
          preview: {
            name: "jobs-fixture-preview",
            vars: { JOBS_PREVIEW_VAR: "fixture", ...jobsPreviewVars },
            queues: {
              producers: [
                { binding: "JOBS_PREVIEW_QUEUE", queue: "fixture-preview-queue" },
                ...jobsPreviewBindings.map((binding) => ({
                  binding,
                  queue: "fixture-preview-queue",
                })),
              ],
            },
            secrets: { required: ["JOBS_PREVIEW_SECRET", ...jobsPreviewSecrets] },
          },
        },
      }),
    );
    write(
      "tail/worker.ts",
      `export type TailEnv = { UPTIME_URL?: string };\n` +
        `export const APP_SCRIPT_NAMES = new Set(["app-fixture"]);\n`,
    );
    write(
      "tail/wrangler.jsonc",
      JSON.stringify({ name: "tail-fixture", vars: { UPTIME_URL: "https://example.test/up" } }),
    );
    return spawnSync(process.execPath, [join(dir, "ci/check-config-docs.mjs")], {
      cwd: dir,
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertJobsKeyRejected(result, key) {
  assert.equal(result.status, 1, `expected composed check to reject ${key}:\n${result.stdout}`);
  assert.match(result.stderr, new RegExp(`Wrangler key missing from Env/JobsEnv: ${key}`));
  assert.match(result.stderr, new RegExp(`Undocumented Wrangler key: ${key}`));
}

test("composed check accepts typed and documented jobs root and preview keys", () => {
  const result = runComposedCheck();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /config-docs: ok/);
});

test("composed check rejects an undeclared Kit staging-only var", () => {
  const result = runComposedCheck({ stagingVars: { KIT_STAGING_UNDECLARED_VAR: "fixture" } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Wrangler key missing from Env\/JobsEnv: KIT_STAGING_UNDECLARED_VAR/);
  assert.match(result.stderr, /Undocumented Wrangler key: KIT_STAGING_UNDECLARED_VAR/);
});

test("composed check rejects a jobs-only undeclared root var", () => {
  assertJobsKeyRejected(
    runComposedCheck({ jobsRootVars: { JOBS_UNDECLARED_VAR: "fixture" } }),
    "JOBS_UNDECLARED_VAR",
  );
});

test("composed check rejects a jobs-only undeclared root binding", () => {
  assertJobsKeyRejected(
    runComposedCheck({ jobsRootBindings: ["JOBS_UNDECLARED_QUEUE"] }),
    "JOBS_UNDECLARED_QUEUE",
  );
});

test("composed check rejects a jobs-only undeclared root required secret", () => {
  assertJobsKeyRejected(
    runComposedCheck({ jobsRootSecrets: ["JOBS_UNDECLARED_SECRET"] }),
    "JOBS_UNDECLARED_SECRET",
  );
});

test("composed check rejects a jobs-only undeclared env.preview var", () => {
  assertJobsKeyRejected(
    runComposedCheck({ jobsPreviewVars: { JOBS_PREVIEW_UNDECLARED_VAR: "fixture" } }),
    "JOBS_PREVIEW_UNDECLARED_VAR",
  );
});

test("composed check rejects a jobs-only undeclared env.preview binding", () => {
  assertJobsKeyRejected(
    runComposedCheck({ jobsPreviewBindings: ["JOBS_PREVIEW_UNDECLARED_QUEUE"] }),
    "JOBS_PREVIEW_UNDECLARED_QUEUE",
  );
});

test("composed check rejects a jobs-only undeclared env.preview required secret", () => {
  assertJobsKeyRejected(
    runComposedCheck({ jobsPreviewSecrets: ["JOBS_PREVIEW_UNDECLARED_SECRET"] }),
    "JOBS_PREVIEW_UNDECLARED_SECRET",
  );
});

test("composed check rejects a typed but undocumented jobs-only var as a Wrangler key", () => {
  const result = runComposedCheck({
    jobsRootVars: { JOBS_UNDOCUMENTED_VAR: "fixture" },
    extraJobsEnvKeys: ["JOBS_UNDOCUMENTED_VAR?: string"],
  });
  assert.equal(result.status, 1, result.stdout);
  // The Env-vs-docs error alone does not prove the jobs file was scanned; the
  // Wrangler-key error only appears when wrangler.jobs.jsonc is composed in.
  assert.match(result.stderr, /Undocumented Wrangler key: JOBS_UNDOCUMENTED_VAR/);
});

test("composed check still rejects an undeclared app var (composition control)", () => {
  assertJobsKeyRejected(
    runComposedCheck({ appVars: { APP_UNDECLARED_VAR: "fixture" } }),
    "APP_UNDECLARED_VAR",
  );
});
