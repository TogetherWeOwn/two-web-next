#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";

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
  // Keep quoted strings intact (including URLs and commas) while removing JSONC
  // comments and trailing commas. JSON.parse still rejects malformed input.
  const stringsOrComments = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  const stringsOrTrailingCommas = /"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g;
  const json = text.replace(stringsOrComments, (match) => match.startsWith('"') ? match : " ")
    .replace(stringsOrTrailingCommas, (match) => match === "," ? "" : match);
  const config = JSON.parse(json);
  const keys = new Set();
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.binding === "string") keys.add(value.binding);
    if (value.vars && typeof value.vars === "object") {
      for (const key of Object.keys(value.vars)) keys.add(key);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(config);
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
  const wrangler = readWranglerKeys(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"));
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
