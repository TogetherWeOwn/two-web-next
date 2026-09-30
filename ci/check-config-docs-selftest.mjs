import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkKeys, readDocKeys, readEnvKeys, readWranglerKeys } from "./check-config-docs.mjs";

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
