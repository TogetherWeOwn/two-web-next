#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";
import { readWranglerConfig } from "./wrangler-config.mjs";

export { readWranglerConfig } from "./wrangler-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const start = "<!-- config-docs:start -->";
const end = "<!-- config-docs:end -->";

// TypeScript 7's native API resolves intersections and inherited keys, not nested
// connectionString fields. API contract: typescript/dist/api/sync/api.d.ts.
// https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
export function readEnvKeys(envFile, configFile) {
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [resolve(configFile)] });
    try {
      const project = snapshot.getProject(resolve(configFile));
      const source = project?.program.getSourceFile(resolve(envFile));
      if (!source) throw new Error("Env source is not included in tsconfig");
      if (project.program.getSyntacticDiagnostics(resolve(envFile)).length) {
        throw new Error("Env source has syntax errors");
      }
      const keys = new Set();
      for (const name of ["Env", "JobsEnv"]) {
        const alias = source.statements.find((node) =>
          node.kind === SyntaxKind.TypeAliasDeclaration && node.name.text === name);
        if (!alias) throw new Error(`Missing ${name} type alias`);
        const type = project.checker.getTypeAtLocation(alias);
        const properties = type && project.checker.getPropertiesOfType(type);
        if (!properties?.length) throw new Error(`Cannot resolve ${name} keys`);
        for (const property of properties) keys.add(property.name);
      }
      return keys;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

export function readWranglerKeys(text) {
  const config = readWranglerConfig(text);
  const keys = new Set();
  // Inspect declaration paths, not arbitrary JSON (vars can contain objects).
  // Durable Objects/email/rate limits use `name`, unlike most bindings:
  // https://developers.cloudflare.com/workers/wrangler/configuration/#bindings
  const arrayBindings = [
    "kv_namespaces", "r2_buckets", "d1_databases", "vectorize", "hyperdrive",
    "services", "analytics_engine_datasets", "mtls_certificates",
    "dispatch_namespaces", "pipelines", "secrets_store_secrets", "workflows",
    "ai_search_namespaces", "ai_search", "agent_memory", "artifacts",
    "unsafe_hello_world", "flagship", "worker_loaders", "vpc_services", "vpc_networks",
  ];
  const singleBindings = ["assets", "browser", "ai", "images", "media", "stream", "version_metadata"];
  function add(entries, field) {
    for (const entry of entries ?? []) {
      if (typeof entry?.[field] === "string") keys.add(entry[field]);
    }
  }
  function visitEnvironment(value) {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value.vars ?? {})) keys.add(key);
    // Secret names only (never values): `secrets.required` declares names at
    // the root and per named environment (not inherited between them).
    for (const name of value.secrets?.required ?? []) {
      if (typeof name === "string") keys.add(name);
    }
    for (const section of arrayBindings) add(value[section], "binding");
    for (const section of singleBindings) add([value[section]], "binding");
    add(value.queues?.producers, "binding");
    add(value.durable_objects?.bindings, "name");
    add(value.send_email, "name");
    add(value.ratelimits, "name");
    add(value.logfwdr?.bindings, "name");
    add(value.unsafe?.bindings, "name");
  }
  visitEnvironment(config);
  for (const environment of Object.values(config.env ?? {})) visitEnvironment(environment);
  return keys;
}

export function readDocKeys(text) {
  if (text.split(start).length !== 2 || text.split(end).length !== 2) {
    throw new Error("Expected exactly one config-docs inventory block");
  }
  const block = text.slice(text.indexOf(start) + start.length, text.indexOf(end));
  if (text.indexOf(end) < text.indexOf(start)) throw new Error("Reversed inventory markers");
  const keys = new Set();
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells[0] === "Name" || /^:?-+:?$/.test(cells[0])) continue;
    if (cells.length !== 5 || cells.some((cell) => !cell)) {
      throw new Error("Config rows need name, kind, environments, default and failure behaviour");
    }
    const match = /^`([A-Z][A-Z0-9_]*)`$/.exec(cells[0]);
    if (!match) throw new Error(`Invalid config row name: ${cells[0]}`);
    if (keys.has(match[1])) throw new Error(`Duplicate config row: ${match[1]}`);
    keys.add(match[1]);
  }
  if (!keys.size) throw new Error("Empty config inventory");
  return keys;
}

export function checkKeys(env, wrangler, docs) {
  const errors = [];
  for (const key of [...env].sort()) {
    if (!docs.has(key)) errors.push(`Undocumented Env/JobsEnv key: ${key}`);
  }
  for (const key of [...docs].sort()) {
    if (!env.has(key)) errors.push(`Obsolete doc key (not in Env/JobsEnv): ${key}`);
  }
  for (const key of [...wrangler].sort()) {
    if (!env.has(key)) errors.push(`Wrangler key missing from Env/JobsEnv: ${key}`);
    if (!docs.has(key)) errors.push(`Undocumented Wrangler key: ${key}`);
  }
  return errors;
}

export function checkConfigDocs() {
  const env = readEnvKeys(resolve(root, "src/env.ts"), resolve(root, "tsconfig.json"));
  const wrangler = new Set(["wrangler.jsonc", "wrangler.local.jsonc"].flatMap((file) =>
    [...readWranglerKeys(readFileSync(resolve(root, file), "utf8"))]));
  const docs = readDocKeys(readFileSync(resolve(root, "docs/config.md"), "utf8"));
  const errors = checkKeys(env, wrangler, docs);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`config-docs: ok (${env.size} Env/JobsEnv keys; ${wrangler.size} Wrangler keys)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkConfigDocs();
  } catch (error) {
    console.error(`config-docs: ${error.message}`);
    process.exitCode = 1;
  }
}
