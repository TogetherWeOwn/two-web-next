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
const tailStart = "<!-- tail-config-docs:start -->";
const tailEnd = "<!-- tail-config-docs:end -->";

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
        const alias = source.statements.find(
          (node) => node.kind === SyntaxKind.TypeAliasDeclaration && node.name.text === name,
        );
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
    "kv_namespaces",
    "r2_buckets",
    "d1_databases",
    "vectorize",
    "hyperdrive",
    "services",
    "analytics_engine_datasets",
    "mtls_certificates",
    "dispatch_namespaces",
    "pipelines",
    "secrets_store_secrets",
    "workflows",
    "ai_search_namespaces",
    "ai_search",
    "agent_memory",
    "artifacts",
    "unsafe_hello_world",
    "flagship",
    "worker_loaders",
    "vpc_services",
    "vpc_networks",
  ];
  const singleBindings = [
    "assets",
    "browser",
    "ai",
    "images",
    "media",
    "stream",
    "version_metadata",
  ];
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
    const cells = line
      .trim()
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
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

// Tail pager inventory: the Tail Worker returns silently when its optional
// pager configuration is absent (tail/worker.ts tail/scheduled early
// returns), so an undocumented name silently disables paging. This separate
// inventory covers TailEnv keys, Tail Wrangler vars, Tail worker service
// names, app tail_consumers services and accepted app script names. Key names
// only: no secret values are read and no provider call is made. Named
// environments are inventoried explicitly because Wrangler never inherits
// top-level vars (or tail_consumers) into a named environment.
export function readTailEnvKeys(tailWorkerFile, configFile) {
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [resolve(configFile)] });
    try {
      const project = snapshot.getProject(resolve(configFile));
      const source = project?.program.getSourceFile(resolve(tailWorkerFile));
      if (!source) throw new Error("TailEnv source is not included in tsconfig");
      if (project.program.getSyntacticDiagnostics(resolve(tailWorkerFile)).length) {
        throw new Error("TailEnv source has syntax errors");
      }
      const alias = source.statements.find(
        (node) => node.kind === SyntaxKind.TypeAliasDeclaration && node.name.text === "TailEnv",
      );
      if (!alias) throw new Error("Missing TailEnv type alias (tail/worker.ts)");
      const type = project.checker.getTypeAtLocation(alias);
      const properties = type && project.checker.getPropertiesOfType(type);
      if (!properties?.length) throw new Error("Cannot resolve TailEnv keys (tail/worker.ts)");
      return new Set(properties.map((property) => property.name));
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

export function readTailWranglerVars(text) {
  const config = readWranglerConfig(text);
  const keys = new Set();
  function visitEnvironment(value) {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value.vars ?? {})) keys.add(key);
    // Secret names only (never values), at the root and per named
    // environment (not inherited between them).
    for (const name of value.secrets?.required ?? []) {
      if (typeof name === "string") keys.add(name);
    }
  }
  visitEnvironment(config);
  for (const environment of Object.values(config.env ?? {})) visitEnvironment(environment);
  return keys;
}

export function readTailWorkerNames(text) {
  const config = readWranglerConfig(text);
  const names = new Set();
  if (typeof config.name === "string") names.add(config.name);
  for (const environment of Object.values(config.env ?? {})) {
    if (environment && typeof environment.name === "string") names.add(environment.name);
  }
  return names;
}

export function readAppTailConsumers(text) {
  const config = readWranglerConfig(text);
  const services = new Set();
  function visitEnvironment(value) {
    if (!value || typeof value !== "object") return;
    for (const entry of value.tail_consumers ?? []) {
      if (typeof entry?.service === "string") services.add(entry.service);
    }
  }
  visitEnvironment(config);
  for (const environment of Object.values(config.env ?? {})) visitEnvironment(environment);
  return services;
}

export function readAppScriptNames(text) {
  const config = readWranglerConfig(text);
  const names = new Set();
  if (Array.isArray(config.tail_consumers) && config.tail_consumers.length) {
    if (typeof config.name !== "string")
      throw new Error("Missing app Worker name (wrangler.jsonc)");
    names.add(config.name);
  }
  for (const [environmentName, environment] of Object.entries(config.env ?? {})) {
    if (!Array.isArray(environment?.tail_consumers) || !environment.tail_consumers.length) continue;
    const name =
      typeof environment.name === "string"
        ? environment.name
        : typeof config.name === "string"
          ? `${config.name}-${environmentName}`
          : null;
    if (!name)
      throw new Error(`Missing app Worker name for env.${environmentName} (wrangler.jsonc)`);
    names.add(name);
  }
  return names;
}

export function readTailScriptNames(text) {
  const block = /APP_SCRIPT_NAMES[^=]*=\s*new\s+Set\(\[([\s\S]*?)\]\)/.exec(text);
  if (!block) {
    if (/APP_SCRIPT_NAMES/.test(text))
      throw new Error("Empty APP_SCRIPT_NAMES set (tail/worker.ts)");
    throw new Error("Missing APP_SCRIPT_NAMES set (tail/worker.ts)");
  }
  const names = new Set();
  for (const match of block[1].matchAll(/["'`]([^"'`]+)["'`]/g)) {
    if (match[1]) names.add(match[1]);
  }
  if (!names.size) throw new Error("Empty APP_SCRIPT_NAMES set (tail/worker.ts)");
  return names;
}

export function readTailDocKeys(text) {
  if (text.split(tailStart).length !== 2 || text.split(tailEnd).length !== 2) {
    throw new Error("Expected exactly one tail-config-docs inventory block (docs/config.md)");
  }
  const block = text.slice(text.indexOf(tailStart) + tailStart.length, text.indexOf(tailEnd));
  if (text.indexOf(tailEnd) < text.indexOf(tailStart)) {
    throw new Error("Reversed tail inventory markers (docs/config.md)");
  }
  const keys = new Set();
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .trim()
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells[0] === "Name" || /^:?-+:?$/.test(cells[0])) continue;
    if (cells.length !== 5 || cells.some((cell) => !cell)) {
      throw new Error(
        "Tail config rows need name, kind, environments, default and failure behaviour",
      );
    }
    // Uppercase Env-style keys and lowercase service/script aliases share one
    // table so a misspelled alias cannot hide behind the app inventory.
    const match = /^`([A-Za-z][A-Za-z0-9_-]*)`$/.exec(cells[0]);
    if (!match) throw new Error(`Invalid tail config row name: ${cells[0]} (docs/config.md)`);
    if (keys.has(match[1]))
      throw new Error(`Duplicate tail config row: ${match[1]} (docs/config.md)`);
    keys.add(match[1]);
  }
  if (!keys.size) throw new Error("Empty tail config inventory (docs/config.md)");
  return keys;
}

export function checkTailKeys(
  tailEnv,
  tailWranglerVars,
  tailWorkerNames,
  appConsumers,
  tailScripts,
  docs,
  appScripts = new Set(),
) {
  const errors = [];
  const union = new Set([
    ...tailEnv,
    ...tailWranglerVars,
    ...tailWorkerNames,
    ...appConsumers,
    ...tailScripts,
  ]);
  for (const key of [...tailEnv].sort()) {
    if (!docs.has(key))
      errors.push(`Undocumented TailEnv key: ${key} (tail/worker.ts -> docs/config.md)`);
  }
  for (const key of [...tailWranglerVars].sort()) {
    if (!tailEnv.has(key)) {
      errors.push(
        `Tail Wrangler key missing from TailEnv: ${key} (tail/wrangler.jsonc -> tail/worker.ts)`,
      );
    }
    if (!docs.has(key)) {
      errors.push(`Undocumented Tail Wrangler key: ${key} (tail/wrangler.jsonc -> docs/config.md)`);
    }
  }
  for (const key of [...tailWorkerNames].sort()) {
    if (!docs.has(key)) {
      errors.push(`Undocumented Tail worker name: ${key} (tail/wrangler.jsonc -> docs/config.md)`);
    }
  }
  for (const key of [...appConsumers].sort()) {
    if (!docs.has(key)) {
      errors.push(
        `Undocumented Tail consumer service: ${key} (wrangler.jsonc/web/wrangler.staging.jsonc/wrangler.jobs.jsonc -> docs/config.md)`,
      );
    }
    if (!tailWorkerNames.has(key)) {
      errors.push(
        `App tail_consumer without Tail worker: ${key} (wrangler.jsonc/web/wrangler.staging.jsonc/wrangler.jobs.jsonc vs tail/wrangler.jsonc)`,
      );
    }
  }
  for (const key of [...tailScripts].sort()) {
    if (!docs.has(key)) {
      errors.push(`Undocumented Tail app script name: ${key} (tail/worker.ts -> docs/config.md)`);
    }
  }
  for (const name of [...appScripts].sort()) {
    if (!tailScripts.has(name)) {
      errors.push(
        `App script not accepted by Tail: ${name} (wrangler.jsonc/web/wrangler.staging.jsonc/wrangler.jobs.jsonc vs tail/worker.ts APP_SCRIPT_NAMES)`,
      );
    }
  }
  for (const key of [...docs].sort()) {
    if (!union.has(key)) errors.push(`Obsolete Tail doc key: ${key} (docs/config.md)`);
  }
  return errors;
}

export function checkConfigDocs() {
  const env = readEnvKeys(resolve(root, "src/env.ts"), resolve(root, "tsconfig.json"));
  const wrangler = new Set(
    [
      "wrangler.jsonc",
      "wrangler.local.jsonc",
      "wrangler.jobs.jsonc",
      "web/wrangler.staging.jsonc",
    ].flatMap((file) => [...readWranglerKeys(readFileSync(resolve(root, file), "utf8"))]),
  );
  const docText = readFileSync(resolve(root, "docs/config.md"), "utf8");
  const docs = readDocKeys(docText);
  const errors = checkKeys(env, wrangler, docs);
  const tailEnv = readTailEnvKeys(resolve(root, "tail/worker.ts"), resolve(root, "tsconfig.json"));
  const tailWranglerVars = readTailWranglerVars(
    readFileSync(resolve(root, "tail/wrangler.jsonc"), "utf8"),
  );
  const tailWorkerNames = readTailWorkerNames(
    readFileSync(resolve(root, "tail/wrangler.jsonc"), "utf8"),
  );
  // Staging runs the Kit web front and jobs consumer; the root config retains
  // the production environment and legacy Hono bindings. Include all three
  // declarations so the Tail contract covers staging and production scripts.
  const appConfigs = ["wrangler.jsonc", "web/wrangler.staging.jsonc", "wrangler.jobs.jsonc"].map(
    (file) => readFileSync(resolve(root, file), "utf8"),
  );
  const appConsumers = new Set(appConfigs.flatMap((text) => [...readAppTailConsumers(text)]));
  const appScripts = new Set(appConfigs.flatMap((text) => [...readAppScriptNames(text)]));
  const tailScripts = readTailScriptNames(readFileSync(resolve(root, "tail/worker.ts"), "utf8"));
  const tailDocs = readTailDocKeys(docText);
  errors.push(
    ...checkTailKeys(
      tailEnv,
      tailWranglerVars,
      tailWorkerNames,
      appConsumers,
      tailScripts,
      tailDocs,
      appScripts,
    ),
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    `config-docs: ok (${env.size} Env/JobsEnv keys; ${wrangler.size} Wrangler keys; ` +
      `${tailEnv.size} TailEnv keys; ${tailWranglerVars.size} Tail Wrangler vars; ` +
      `${tailWorkerNames.size} Tail worker names; ${appConsumers.size} Tail consumers; ` +
      `${tailScripts.size} Tail script names)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkConfigDocs();
  } catch (error) {
    console.error(`config-docs: ${error.message}`);
    process.exitCode = 1;
  }
}
