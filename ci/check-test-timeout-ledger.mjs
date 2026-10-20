#!/usr/bin/env node
// Timeout-ledger ratchet (HARD): every per-test timeout literal below the
// 30 s Vitest default must have a ledger row in docs/ci-load-sensitive-tests.md
// naming its file with an exact (N× <limit>) pin, plus a "why it stays"
// justification. Pins count timeout LOCATIONS per limit, not the tests an
// .each table or a suite expands to.
//
// Scope: every Vitest config (vitest.config.*, vitest.<name>.config.*, a
// vite.config.* with a test block, and any `vitest --config` target in the
// package.json scripts). Each literal test.include array, inline projects
// included, is globbed from the config's package root. The scan covers every
// matched file (excluded and opt-in ones too) plus every module those files
// import through a relative path, transitively, since helpers can define
// tests. Each config test block must keep the 30 s testTimeout assumed here.
//
// A per-test limit is a numeric literal that Vitest reads as a timeout: the
// third argument, or a direct `{ timeout: N }` option in the second, of a
// test or suite API. Those are it, test, describe or suite (a suite limit
// binds every test inside it), their chains (.each, .for, .skipIf, .runIf,
// .skip, .only, .concurrent, ...), and aliases of those. Aliases are followed
// through bindings, destructuring, member reads, object and array literals,
// vitest imports and namespaces including `await import("vitest")`, and
// fixtures and namespaces re-exported by a relative module; not through
// function returns, parameters, classes, `.call`/`.apply` or reflection.
// `vi.setConfig({ testTimeout: N })` under any alias counts too, since it
// binds every later test in a file, as does a literal 0: Vitest reads 0 as
// "no limit", which also overrides the default hang detector.
// Hook limits (beforeEach/afterEach/beforeAll/afterAll) are explicitly OUT of
// scope: per-hook limits are a follow-up, not this gate. Helper timeouts
// (setTimeout, sql.end, expect.poll, vi.waitFor, Playwright options),
// non-literal timeouts, elapsed-time asserts and literals at or above the
// default are ignored.
//
// Exit codes: 0 = every flagged file is pinned with its exact limits,
// 1 = a file without a row or pin, a pin whose counts or limits differ from
// the source, or a pin on a file with no flagged literal,
// 2 = usage, read, parse or config-scope error (fail closed).
import {
  globSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_REL = "docs/ci-load-sensitive-tests.md";
const DEFAULT_TIMEOUT_MS = 30_000;
// Vitest exports that take a per-test limit, and the `vi` utility (also
// exported as `vitest`) whose setConfig() can lower it.
const TEST_API = new Set(["it", "test", "describe", "suite"]);
const VI_API = new Set(["vi", "vitest"]);
const API_GLOBALS = new Set([...TEST_API, ...VI_API]);
// The value of vi.setConfig under any alias.
const SET_CONFIG = "vi.setConfig";
const CALL = new Set(["CallExpression", "OptionalCallExpression"]);
const CODE = /\.[cm]?[jt]sx?$/;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const CONFIG_GLOBS = ["vitest.config", "vitest.*.config", "vite.config"].map(
  (name) => `**/${name}.{ts,mts,cts,js,mjs,cjs}`,
);
const SKIP_DIR = /(^|\/)(node_modules|\.[^/]+)$/;

// Parse syntax rather than approximating JavaScript lexical rules: templates,
// keyword regexes, TypeScript generics and curried test builders all occur in
// this suite. Never evaluate the config or test modules.
function syntax(source, file = "") {
  const plugins = /x$/.test(file) ? ["typescript", "jsx"] : ["typescript"];
  return parse(source, { sourceType: "module", plugins });
}

function visit(node, callback) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, callback);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      visit(value, callback);
    }
  }
}

// Type-only wrappers don't change the value: `5000 as const`, `test!`.
function unwrap(node) {
  while (/^TS(As|Satisfies|NonNull|TypeAssertion|Instantiation)Expression$/.test(node?.type))
    node = node.expression;
  return node;
}

// The static name of an identifier, a string or number key, or an
// `obj["key"]` member.
function keyName(node, computed = false) {
  if (!computed && node?.type === "Identifier") return node.name;
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "NumericLiteral") return String(node.value);
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0].value.cooked;
  return undefined;
}

// A synthetic `object[key]` read, for destructuring and literal lookups.
const member = (object, key) => ({
  type: "MemberExpression",
  object,
  property: { type: "StringLiteral", value: key },
  computed: true,
});

// Every name a declaration pattern binds: `{ it: run }`, `[first]`, defaults.
function patternNames(pattern) {
  switch (pattern?.type) {
    case "Identifier":
      return [pattern.name];
    case "AssignmentPattern":
      return patternNames(pattern.left);
    case "RestElement":
      return patternNames(pattern.argument);
    case "ObjectPattern":
      return pattern.properties.flatMap((prop) =>
        patternNames(prop.type === "RestElement" ? prop : prop.value),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap(patternNames);
    default:
      return [];
  }
}

// What a module binds: its imports, every `x = ...` initializer in any scope
// (a same-named binding elsewhere can only add API names, never hide one),
// its exports, and the modules it loads.
function moduleScope(file, source) {
  const ast = syntax(source, file);
  const scope = {
    file,
    ast,
    imports: new Map(),
    bindings: new Map(),
    exports: new Map(),
    stars: [],
    loads: [],
  };
  const bind = (name, init) =>
    scope.bindings.set(name, [...(scope.bindings.get(name) ?? []), init]);
  // `const { it: run = other } = v` binds run to both `v.it` and `other`;
  // `const [run] = list` binds run to `list[0]`.
  const bindPattern = (pattern, init) => {
    if (pattern.type === "Identifier") bind(pattern.name, init);
    else if (pattern.type === "AssignmentPattern") {
      bindPattern(pattern.left, init);
      bindPattern(pattern.left, pattern.right);
    } else if (pattern.type === "ObjectPattern") {
      for (const prop of pattern.properties) {
        const key = prop.type === "ObjectProperty" ? keyName(prop.key, prop.computed) : undefined;
        if (key !== undefined) bindPattern(prop.value, member(init, key));
      }
    } else if (pattern.type === "ArrayPattern") {
      for (const [index, element] of pattern.elements.entries())
        if (element) bindPattern(element, member(init, String(index)));
    }
  };
  visit(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.init) bindPattern(node.id, node.init);
    else if (node.type === "AssignmentExpression" && node.operator === "=")
      bindPattern(node.left, node.right);
    else if (node.type === "CallExpression" && node.callee.type === "Import") {
      const specifier = keyName(node.arguments[0], true);
      if (specifier !== undefined) scope.loads.push(specifier);
    }
  });
  for (const statement of ast.program.body) {
    const source = statement.source?.value;
    if (source !== undefined) scope.loads.push(source);
    if (statement.type === "ImportDeclaration") {
      for (const spec of statement.specifiers) {
        let name = keyName(spec.imported);
        if (spec.type === "ImportNamespaceSpecifier") name = "*";
        if (spec.type === "ImportDefaultSpecifier") name = "default";
        scope.imports.set(spec.local.name, { source, name });
      }
    } else if (statement.type === "ExportNamedDeclaration") {
      for (const declarator of statement.declaration?.declarations ?? [])
        for (const name of patternNames(declarator.id)) scope.exports.set(name, { local: name });
      for (const spec of statement.specifiers) {
        const local = spec.type === "ExportNamespaceSpecifier" ? "*" : keyName(spec.local);
        scope.exports.set(
          keyName(spec.exported),
          source === undefined ? { local } : { source, name: local },
        );
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      scope.exports.set("default", { node: statement.declaration });
    } else if (statement.type === "ExportAllDeclaration") {
      scope.stars.push(source);
    }
  }
  return scope;
}

// Loads each repo module once, and resolves a relative specifier the way Vite
// does here: the exact file, a .ts source written as .js, an extension-less
// path, or a directory index. Only vitest itself among packages is an API.
function project(root) {
  const modules = new Map();
  return {
    load(file, source) {
      if (!modules.has(file)) {
        try {
          modules.set(file, moduleScope(file, source ?? readFileSync(join(root, file), "utf8")));
        } catch (error) {
          throw new Error(`cannot read/parse ${file}: ${error.message}`);
        }
      }
      return modules.get(file);
    },
    resolve(from, specifier) {
      if (!/^\.\.?\//.test(specifier)) return undefined;
      const base = normalize(join(dirname(from), specifier.replace(/\?.*$/, "")));
      return [
        base,
        base.replace(/\.([cm]?)js(x?)$/, ".$1ts$2"),
        ...EXTENSIONS.map((extension) => base + extension),
        ...EXTENSIONS.map((extension) => join(base, `index${extension}`)),
      ].find(
        (file) =>
          CODE.test(file) &&
          !file.startsWith("..") &&
          statSync(join(root, file), { throwIfNoEntry: false })?.isFile(),
      );
    },
  };
}

// What `expression` can evaluate to in module `scope`: vitest exports
// ({ vitest: name }), module namespaces ({ scope, source }) and object or
// array literals ({ scope, literal }), followed through bindings,
// destructuring, member reads, imports, re-exports, namespaces and
// `await import(...)`; not through function returns, parameters, classes,
// `.call`/`.apply` or reflection. `stack` cuts cycles on the current path
// only.
function values(ctx, scope, expression, stack = new Set()) {
  const node = unwrap(expression);
  switch (node?.type) {
    case "Identifier":
      return nameValues(ctx, scope, node.name, stack);
    case "MemberExpression":
    case "OptionalMemberExpression": {
      const key = keyName(node.property, node.computed);
      if (key === undefined) return [];
      return values(ctx, scope, node.object, stack).flatMap((value) => {
        if (value.literal) return literalMember(ctx, value.scope, value.literal, key, stack);
        if (value.source !== undefined)
          return exportValues(ctx, value.scope, value.source, key, stack);
        // A member of an API (test.skip, test.extend) is still that API;
        // setConfig is the one vi member that sets a limit.
        return [VI_API.has(value.vitest) && key === "setConfig" ? { vitest: SET_CONFIG } : value];
      });
    }
    case "CallExpression":
    case "OptionalCallExpression": {
      if (node.callee.type === "Import") {
        const specifier = keyName(node.arguments[0], true);
        return specifier === undefined ? [] : [{ scope, source: specifier }];
      }
      return values(ctx, scope, node.callee, stack);
    }
    case "ObjectExpression":
    case "ArrayExpression":
      return [{ scope, literal: node }];
    case "AwaitExpression":
      return values(ctx, scope, node.argument, stack);
    case "AssignmentExpression":
      return values(ctx, scope, node.right, stack);
    case "TaggedTemplateExpression":
      return values(ctx, scope, node.tag, stack);
    case "ConditionalExpression":
      return [node.consequent, node.alternate].flatMap((branch) =>
        values(ctx, scope, branch, stack),
      );
    case "LogicalExpression":
      return [node.left, node.right].flatMap((branch) => values(ctx, scope, branch, stack));
    case "SequenceExpression":
      return values(ctx, scope, node.expressions.at(-1), stack);
    default:
      return [];
  }
}

// A property of an object literal or an element of an array literal; a
// spread can supply any key, and shifts every array index after it.
function literalMember(ctx, scope, literal, key, stack) {
  if (literal.type === "ArrayExpression") {
    const spread = literal.elements.some((element) => element?.type === "SpreadElement");
    return (spread ? literal.elements : [literal.elements[Number(key)]]).flatMap((element) =>
      element?.type === "SpreadElement"
        ? values(ctx, scope, member(element.argument, key), stack)
        : values(ctx, scope, element, stack),
    );
  }
  return literal.properties.flatMap((prop) => {
    if (prop.type === "SpreadElement") return values(ctx, scope, member(prop.argument, key), stack);
    if (prop.type === "ObjectProperty" && keyName(prop.key, prop.computed) === key)
      return values(ctx, scope, prop.value, stack);
    return [];
  });
}

function nameValues(ctx, scope, name, stack) {
  const key = `${scope.file}\0${name}`;
  if (stack.has(key)) return [];
  stack.add(key);
  // A global API name counts even when a same-named binding exists.
  const found = API_GLOBALS.has(name) ? [{ vitest: name }] : [];
  const imported = scope.imports.get(name);
  if (imported?.name === "*") found.push({ scope, source: imported.source });
  else if (imported) found.push(...exportValues(ctx, scope, imported.source, imported.name, stack));
  for (const init of scope.bindings.get(name) ?? []) found.push(...values(ctx, scope, init, stack));
  stack.delete(key);
  return found;
}

function exportValues(ctx, scope, source, name, stack) {
  if (source === "vitest") return [{ vitest: name }];
  const file = ctx.resolve(scope.file, source);
  const key = `${file}\0export ${name}`;
  if (!file || stack.has(key)) return [];
  stack.add(key);
  const target = ctx.load(file);
  const entry = target.exports.get(name);
  let found;
  if (!entry)
    found =
      name === "default"
        ? []
        : target.stars.flatMap((star) => exportValues(ctx, target, star, name, stack));
  else if (entry.node) found = values(ctx, target, entry.node, stack);
  else if (entry.source === undefined) found = nameValues(ctx, target, entry.local, stack);
  else if (entry.name === "*") found = [{ scope: target, source: entry.source }];
  else found = exportValues(ctx, target, entry.source, entry.name, stack);
  stack.delete(key);
  return found;
}

// Timeout LOCATIONS in one module, not the tests .each/for or a suite expands to.
function scanModule(ctx, scope) {
  const found = [];
  const options = (node, key) => {
    const object = unwrap(node);
    if (object?.type !== "ObjectExpression") return [];
    return object.properties
      .filter((prop) => prop.type === "ObjectProperty" && keyName(prop.key, prop.computed) === key)
      .map((prop) => prop.value);
  };
  const subDefault = (nodes) =>
    nodes
      .map(unwrap)
      .filter((limit) => limit?.type === "NumericLiteral" && limit.value < DEFAULT_TIMEOUT_MS);
  visit(scope.ast, (node) => {
    if (!CALL.has(node.type)) return;
    // Vitest reads (name, options | fn, timeout | fn): a numeric third
    // argument wins, else the second argument's options, and later
    // arguments are ignored, as are builder inputs (it.each(cases)). A
    // third-slot object (it throws since Vitest 4) still counts.
    // vi.setConfig(config) reads config.testTimeout.
    const [first, second, third] = node.arguments.map(unwrap);
    const testLimits = subDefault(
      third?.type === "NumericLiteral"
        ? [third]
        : [second, third].flatMap((arg) => options(arg, "timeout")),
    );
    const configLimits = subDefault(options(first, "testTimeout"));
    // Resolve the callee only for calls that carry a sub-default literal.
    if (testLimits.length + configLimits.length === 0) return;
    const callee = values(ctx, scope, node.callee);
    const limits = [
      ...(callee.some((value) => TEST_API.has(value.vitest)) ? testLimits : []),
      ...(callee.some((value) => value.vitest === SET_CONFIG) ? configLimits : []),
    ];
    for (const limit of limits) found.push({ line: limit.loc.start.line, value: limit.value });
  });
  return found.sort((a, b) => a.line - b.line);
}

// Timeout locations in one source text; relative imports resolve from `file`.
export function scanTestTimeouts(source, file = "test/inline.test.ts", root = repoRoot) {
  const ctx = project(root);
  return scanModule(ctx, ctx.load(file, source));
}

// Vitest configs the repo runs: the conventional names anywhere outside
// dependencies and dot-directories, plus every `vitest --config <file>` in the
// package.json scripts.
function configFiles(root) {
  const files = new Set(
    globSync(CONFIG_GLOBS, {
      cwd: root,
      exclude: (entry) => SKIP_DIR.test(typeof entry === "string" ? entry : entry.name),
    }),
  );
  const manifest = join(root, "package.json");
  const scripts = existsSync(manifest)
    ? Object.values(JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {})
    : [];
  for (const script of scripts)
    for (const match of String(script).matchAll(
      /\bvitest\b[^;&|]*?\s(?:--config|-c)(?:=|\s+)["']?([^\s"';&|]+)/g,
    ))
      files.add(normalize(match[1]));
  return [...files].sort();
}

// npm runs Vitest from the package root, so include globs resolve there.
function packageRoot(root, dir) {
  for (let current = dir; current !== "."; current = dirname(current))
    if (existsSync(join(root, current, "package.json"))) return current;
  return ".";
}

// Every literal test.include array of every config, inline projects too. A
// non-literal include, one that matches no file, or a test block whose
// default limit isn't the one this ledger assumes fails closed.
function listTestFiles(root) {
  const files = new Set();
  for (const config of configFiles(root)) {
    const blocks = [];
    visit(syntax(readFileSync(join(root, config), "utf8"), config), (node) => {
      if (
        node.type === "ObjectProperty" &&
        keyName(node.key, node.computed) === "test" &&
        unwrap(node.value).type === "ObjectExpression"
      )
        blocks.push(unwrap(node.value));
    });
    // A plain Vite config (the Kit app's) carries no test block.
    if (blocks.length === 0 && /(^|\/)vite\.config\./.test(config)) continue;
    if (blocks.length === 0) throw new Error(`${config} has no literal test block`);
    const base = packageRoot(root, dirname(config));
    for (const block of blocks) {
      const option = (name) =>
        unwrap(
          block.properties.find(
            (prop) => prop.type === "ObjectProperty" && keyName(prop.key, prop.computed) === name,
          )?.value,
        );
      const include = option("include");
      // A projects block runs each project's own test block instead.
      if (!include && option("projects")) continue;
      if (
        include?.type !== "ArrayExpression" ||
        !include.elements.every((item) => item?.type === "StringLiteral")
      )
        throw new Error(`${config}: test.include must be a literal string array`);
      const timeout = option("testTimeout");
      if (timeout?.type !== "NumericLiteral" || timeout.value !== DEFAULT_TIMEOUT_MS)
        throw new Error(`${config}: testTimeout must be ${DEFAULT_TIMEOUT_MS}, the ledger default`);
      const matched = globSync(
        include.elements.map((item) => item.value),
        { cwd: join(root, base) },
      );
      if (matched.length === 0) throw new Error(`${config}: test.include matches no file`);
      for (const file of matched) files.add(normalize(join(base, file)));
    }
  }
  if (files.size === 0) throw new Error("no Vitest config with a test.include scope");
  return [...files].sort();
}

// The configured files plus every module they import through a relative
// path, transitively.
function scanScope(ctx, files) {
  const queue = [...files];
  const seen = new Set(queue);
  for (const file of queue)
    for (const specifier of ctx.load(file).loads) {
      const target = ctx.resolve(file, specifier);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  return [...seen].sort();
}

// "1× 20 s, 2× 2 s": a limit-to-count map in pin form, largest limit first.
function tally(limits) {
  return [...limits]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => b - a)
    .map(([ms, count]) => `${count}× ${ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`}`)
    .join(", ");
}

// Only a complete (N× <limit>[, M× <limit>]) pin immediately after a file in
// the Test cell belongs to that file. Multipliers in prose or another file's
// pin don't count. Pins map each file to its limit (ms) counts.
export function parseLedgerPins(ledgerText) {
  const lines = ledgerText.split(/\r?\n/);
  const section = lines.findIndex((line) => line.startsWith("## Remaining limits"));
  const pins = new Map();
  const mentioned = new Set();
  if (section === -1) return { pins, mentioned };
  const limit = String.raw`(\d+)\s*×\s*(\d+(?:\.\d+)?)\s*(ms|s)`;
  const pinGroup = new RegExp(String.raw`^\s*\((${limit}(?:\s*,\s*${limit})*)\)`);
  for (const line of lines.slice(section + 1)) {
    if (/^##\s/.test(line)) break;
    if (!line.startsWith("|")) continue;
    const cell = line.split("|")[1] ?? "";
    for (const span of cell.matchAll(/`([^`\s:]+\.[cm]?[jt]sx?)(?::\d+(?:[,-]\d+)*)?`/g)) {
      const file = span[1];
      mentioned.add(file);
      const group = pinGroup.exec(cell.slice(span.index + span[0].length));
      if (!group) continue;
      const limits = pins.get(file) ?? new Map();
      for (const [, count, amount, unit] of group[1].matchAll(new RegExp(limit, "g"))) {
        const ms = unit === "s" ? Math.round(Number(amount) * 1000) : Number(amount);
        limits.set(ms, (limits.get(ms) ?? 0) + Number(count));
      }
      pins.set(file, limits);
    }
  }
  return { pins, mentioned };
}

export function checkLedger(root, output = console) {
  const ledgerPath = join(root, LEDGER_REL);
  if (!existsSync(ledgerPath)) {
    output.error(`timeout ledger: missing ${LEDGER_REL}`);
    return 2;
  }
  let ledgerText;
  try {
    ledgerText = readFileSync(ledgerPath, "utf8");
  } catch (error) {
    output.error(`timeout ledger: cannot read ${LEDGER_REL}: ${error.message}`);
    return 2;
  }
  const { pins, mentioned } = parseLedgerPins(ledgerText);
  let files;
  try {
    files = listTestFiles(root);
  } catch (error) {
    output.error(`timeout ledger: cannot enumerate Vitest includes: ${error.message}`);
    return 2;
  }
  const ctx = project(root);
  const scanned = new Map();
  try {
    for (const file of scanScope(ctx, files)) scanned.set(file, scanModule(ctx, ctx.load(file)));
  } catch (error) {
    output.error(`timeout ledger: ${error.message}`);
    return 2;
  }
  const errors = [];
  for (const [rel, flagged] of scanned) {
    const pinned = tally(pins.get(rel) ?? []);
    if (flagged.length === 0) {
      if (pinned)
        errors.push(`${rel}: ledger pins ${pinned} but the file holds no sub-default test timeout`);
      continue;
    }
    const actual = new Map();
    for (const hit of flagged) actual.set(hit.value, (actual.get(hit.value) ?? 0) + 1);
    const at = flagged.map((hit) => `${rel}:${hit.line} (${hit.value} ms)`).join(", ");
    if (!mentioned.has(rel)) {
      errors.push(
        `${rel}: ${flagged.length} sub-default test timeout(s) with no ledger row: ${at}`,
      );
    } else if (!pinned) {
      errors.push(`${rel}: ledger row names the file but carries no (N× <limit>) pin: ${at}`);
    } else if (pinned !== tally(actual)) {
      errors.push(`${rel}: ledger pins ${pinned} but the file holds ${tally(actual)}: ${at}`);
    }
  }
  for (const [rel, limits] of pins)
    if (!scanned.has(rel) && tally(limits))
      errors.push(`${rel}: ledger pins ${tally(limits)} but the file is not in the Vitest scope`);
  const pretty = errors.sort();
  for (const error of pretty) output.error(`timeout ledger: ${error}`);
  if (pretty.length) {
    output.error(`timeout ledger: ${pretty.length} file(s) out of step with the ledger.`);
    return 1;
  }
  output.log("timeout ledger: ok.");
  return 0;
}

function selftest() {
  const suite = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "timeout-ledger-"),
  );
  const failures = [];
  let cases = 0;
  const ledger = (rows) =>
    [
      "# Load-sensitive tests",
      "",
      "## Remaining limits and timing asserts",
      "",
      "| Test | Limit | Why it stays |",
      "| --- | --- | --- |",
      ...rows,
      "",
      "## Other",
      "",
    ].join("\n");
  const rootConfig = (include) =>
    `export default { test: { include: ${JSON.stringify(include)}, testTimeout: 30_000 } };`;
  const defaultConfig = rootConfig([
    "test/**/*.test.ts",
    "test/**/*.test.mjs",
    "ci/audit-lifecycle.test.mjs",
  ]);
  const report = (name, ok, detail) => {
    cases += 1;
    if (ok) {
      console.log(`PASS ${name}`);
      return;
    }
    failures.push(name);
    console.error(`FAIL ${name}: ${detail}`);
  };
  // Each case is a fresh repo: the default root config unless `files`
  // overrides it, the files, and a ledger of `rows`.
  const check = (name, files, rows, expected, diagnostics = []) => {
    const root = mkdtempSync(join(suite, "case-"));
    const tree = { "vitest.config.ts": defaultConfig, [LEDGER_REL]: ledger(rows), ...files };
    for (const [path, content] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const messages = [];
    const code = checkLedger(root, {
      log() {},
      error(text) {
        messages.push(text);
      },
    });
    const missing = diagnostics.filter((want) => !messages.some((text) => text.includes(want)));
    report(
      name,
      code === expected && missing.length === 0,
      `exit ${code} (want ${expected}), missing ${JSON.stringify(missing)}; ${messages.join("; ")}`,
    );
  };

  try {
    check(
      "covered literals pass",
      {
        "test/a.test.ts": 'it("fast", async () => {\n  expect(1).toBe(1);\n}, 10_000);\n',
        "test/b.test.ts": 'it.each([1, 2])(\n  "mode %s",\n  async () => {},\n  3000,\n);\n',
      },
      [
        "| `test/a.test.ts` (1× 10 s) | 10 s per test | Bounds the probe |",
        "| `test/b.test.ts` (1× 3 s) | 3 s per test | Bounds disposal |",
      ],
      0,
    );

    check(
      "uncovered timeout fails with file, line and value",
      { "test/a.test.ts": 'it("fast", async () => {}, 15_000);\n' },
      [],
      1,
      ["test/a.test.ts", "test/a.test.ts:1", "15000"],
    );

    check(
      "count mismatch fails",
      {
        "test/a.test.ts":
          'it("one", async () => {}, 15_000);\nit("two", async () => {}, 15_000);\n',
      },
      ["| `test/a.test.ts` (1× 15 s) | 15 s per test | Bounds both |"],
      1,
      ["ledger pins 1× 15 s but the file holds 2× 15 s"],
    );

    check(
      "named file without a count pin fails",
      { "test/a.test.ts": 'it("fast", async () => {}, 15_000);\n' },
      ["| `test/a.test.ts` | 15 s per test | Bounds the race |"],
      1,
      ["carries no (N× <limit>) pin"],
    );

    check(
      "hooks, helpers and default-scale literals are out of scope",
      {
        "test/a.test.ts": [
          "beforeEach(async () => {}, 15_000);",
          "afterAll(async () => { await sql.end({ timeout: 1 }); });",
          'it("slow", async () => { await new Promise((r) => setTimeout(r, 3000)); }, 30_000);',
          'it("slower", async () => {}, 60_000);',
          'it("polls", async () => { await expect.poll(() => probe(), { timeout: 4000 }); });',
          'it("regex", async () => { expect(s).toMatch(/foo(bar)+/); });',
          'describe("hooks", () => { beforeAll(() => {}, 5000); onTestFinished(() => {}, 5000); });',
          'it("waits", async () => { await vi.waitFor(() => probe(), { timeout: 4000 }); });',
          "",
        ].join("\n"),
      },
      [],
      0,
    );

    check(
      "regex with parens does not swallow the timeout",
      {
        "test/a.test.ts":
          'it("parens", async () => {\n  expect(s).toMatch(/a(b|c)+\\d/);\n}, 10_000);\n',
      },
      [],
      1,
      ["test/a.test.ts:3", "10000"],
    );

    check(
      "options-form timeout is flagged",
      { "test/a.test.ts": 'it("opt", { timeout: 5000 }, async () => {});\n' },
      [],
      1,
      ["test/a.test.ts:1", "5000"],
    );

    check(
      "trailing-comma timeout forms are flagged",
      {
        "test/a.test.ts": 'it.each(modes)(\n  "mode %s",\n  async () => {},\n  3000,\n);\n',
        "test/b.test.ts": 'it("slow",\n  async () => {},\n  20000,\n);\n',
      },
      [],
      1,
      ["test/a.test.ts:4", "3000", "test/b.test.ts:3", "20000"],
    );

    check(
      "line-anchored cites match by file",
      { "test/a.test.ts": 'it("fast", async () => {}, 20_000);\n' },
      ["| `test/a.test.ts:220` (1× 20 s) | 20 s per test | Bounds the replay |"],
      0,
    );

    for (const options of [
      "{ timeout: 5000, retry: 1 }",
      "{ retry: 1, timeout: 5000 }",
      "{ timeout: 5000, }",
      '{ "timeout": 5000, retry: 1 }',
    ]) {
      check(
        `options property ${options}`,
        { "test/a.test.ts": `it("opt", ${options}, () => {});` },
        [],
        1,
        ["5000"],
      );
    }

    for (const callee of [
      "it.each<[string, Array<string>]>(cases)",
      "it.skipIf(cond)",
      "test.runIf(cond)",
      "test.for(cases)",
      "it.each`a | b\n${1} | ${2}`",
      "it.skipIf(cond).each(cases)",
      "test.concurrent",
    ]) {
      check(
        `chained call ${callee}`,
        { "test/a.test.ts": `${callee}("case", () => {}, 5000);` },
        [],
        1,
        ["5000"],
      );
    }

    check(
      "regexes after keywords cannot swallow a timeout",
      {
        "test/a.test.ts": [
          'it("return", () => { return /x\\(y/.test(s); }, 7000);',
          'it("throw", () => { throw /x\\(y/; }, 7000);',
          'it("case", () => { switch (s) { case /x\\(y/: break; } }, 7000);',
        ].join("\n"),
      },
      [],
      1,
      ["3 sub-default", "test/a.test.ts:1", "test/a.test.ts:2", "test/a.test.ts:3"],
    );

    check(
      "nested templates preserve interpolation code and ignore literal text",
      {
        "test/a.test.ts": [
          'it(`case ${"`"}`, () => {}, 5000);',
          'const name = `${it("real", () => {}, 5000)}`;',
          "it(`case ${a ? `x` : `y`}`, () => {}, 5000);",
          'const raw = `it("not code", () => {}, 5000)`;',
        ].join("\n"),
      },
      ["| `test/a.test.ts` (3× 5 s) | 5 s | Bounds probes |"],
      0,
    );

    check(
      "member calls and builder inputs are not test timeouts",
      {
        "test/a.test.ts": [
          'obj.test("not vitest", () => {}, 5000);',
          'obj . it("not vitest", () => {}, 5000);',
          'it.each([5000])("case", () => {});',
          'it.skipIf(5000)("case", () => {});',
          'it("nested option", { retry: { timeout: 5000 } }, () => {});',
        ].join("\n"),
      },
      [],
      0,
    );

    check(
      "prose cannot supply a count pin",
      { "test/a.test.ts": 'it("one", () => {}, 5000);' },
      ["| `test/a.test.ts` | 5 s | Retries 1× under load (1× 5 s) |"],
      1,
      ["carries no (N× <limit>) pin"],
    );

    check(
      "a pin only belongs to its adjacent file",
      {
        "test/a.test.ts": 'it("one", () => {}, 5000);',
        "test/b.test.ts": 'it("two", () => {}, 5000);',
      },
      ["| `test/a.test.ts`, `test/b.test.ts` (1× 5 s) | 5 s | Bounds probes |"],
      1,
      ["test/a.test.ts: ledger row names the file but carries no (N× <limit>) pin"],
    );

    check(
      "separate adjacent pins and mixed limits pass",
      {
        "test/a.test.ts": 'it("one", () => {}, 5000);',
        "test/b.test.ts": 'it("two", () => {}, 2000); it("three", () => {}, 20000);',
      },
      [
        "| `test/a.test.ts` (1× 5 s), `test/b.test.ts` (1× 2 s, 1× 20 s) | 2–20 s | Bounds probes |",
      ],
      0,
    );

    check(
      "Vitest ci include without a ledger row fails",
      { "ci/audit-lifecycle.test.mjs": 'it("child", () => {}, 2000);' },
      [],
      1,
      ["ci/audit-lifecycle.test.mjs:1", "2000"],
    );
    check(
      "Vitest ci include with a ledger row passes",
      { "ci/audit-lifecycle.test.mjs": 'it("child", () => {}, 2000);' },
      ["| `ci/audit-lifecycle.test.mjs` (1× 2 s) | 2 s | Bounds cleanup |"],
      0,
    );

    check("parse errors fail closed", { "test/a.test.ts": 'it("broken", () => {, 5000);' }, [], 2, [
      "cannot read/parse test/a.test.ts",
    ]);
    check(
      "config scope errors fail closed",
      { "vitest.config.ts": "export default { test: { include: dynamicScope } };" },
      [],
      2,
      ["cannot enumerate Vitest includes"],
    );
    check(
      "new configured include is scanned without a directory allowlist edit",
      {
        "vitest.config.ts": rootConfig(["extra/**/*.test.mjs"]),
        "extra/new.test.mjs": 'test("new", () => {}, 5000);',
      },
      [],
      1,
      ["extra/new.test.mjs:1"],
    );
    check(
      "non-pins in the Test cell do not count",
      { "test/a.test.ts": 'it("one", () => {}, 5000);' },
      ["| `test/a.test.ts` retries 1× under load | 5 s | Bounds probe |"],
      1,
      ["carries no (N× <limit>) pin"],
    );

    // Suite limits bind every test inside the suite: one location each.
    check(
      "describe and suite limits are per-test limits",
      {
        "test/a.test.ts": [
          'describe("trailing", () => { it("x", () => {}); }, 5000);',
          'describe("options", { timeout: 6000 }, () => {});',
          'describe.each([1])("table %s", () => {}, 7000);',
          'describe.for([1])("for %s", { timeout: 8000 }, () => {});',
          'suite("alias", () => {}, 9000);',
          'describe.skipIf(cond)("conditional", () => {}, 4000);',
        ].join("\n"),
      },
      [],
      1,
      ["6 sub-default", "a.test.ts:1 (5000 ms)", "a.test.ts:2 (6000 ms)", "a.test.ts:6 (4000 ms)"],
    );
    check(
      "a suite limit is pinned once, not per test",
      {
        "test/a.test.ts":
          'describe("s", { timeout: 5000 }, () => { it("a", () => {}); it("b", () => {}); });',
      },
      ["| `test/a.test.ts` (1× 5 s) | 5 s per test | Bounds the suite |"],
      0,
    );

    check(
      "assigned, chained and inline extend aliases are test APIs",
      {
        "test/a.test.ts": [
          "const mt = test.extend({ db: async ({}, use) => use(1) });",
          "const mt2 = mt.extend({});",
          "let late; late = it.extend({});",
          'mt("assigned", () => {}, 5000);',
          'mt2.skip("chained", () => {}, 5000);',
          'late("assigned later", { timeout: 5000 }, () => {});',
          'test.extend({})("inline", () => {}, 5000);',
        ].join("\n"),
      },
      [],
      1,
      ["4 sub-default", "a.test.ts:4", "a.test.ts:5", "a.test.ts:6", "a.test.ts:7"],
    );
    check(
      "vitest import aliases and namespaces are APIs",
      {
        "test/a.test.ts": [
          'import { it as vit, describe as group, vi as v2 } from "vitest";',
          'import * as V from "vitest";',
          'vit("alias", () => {}, 5000);',
          'group("suite alias", { timeout: 5000 }, () => {});',
          'V.test("namespace", () => {}, 5000);',
          'V.describe.each([1])("namespace table", () => {}, 5000);',
          "v2.setConfig({ testTimeout: 5000 });",
          "V.vi.setConfig({ testTimeout: 5000 });",
        ].join("\n"),
      },
      [],
      1,
      ["6 sub-default", "a.test.ts:3", "a.test.ts:5", "a.test.ts:7", "a.test.ts:8"],
    );
    check(
      "fixtures exported by relative modules are test APIs",
      {
        "test/fixtures/base.ts": [
          'import { test as base } from "vitest";',
          "export const dbTest = base.extend({});",
          "export default base.extend({});",
          "const hidden = base;",
          "export { hidden as renamed };",
        ].join("\n"),
        "test/fixtures/index.ts":
          'export * from "./base.js";\nexport { default as defaultTest } from "./base";\n',
        "test/a.test.ts": [
          'import { dbTest } from "./fixtures/base.js";',
          'import fixtureTest from "./fixtures/base";',
          'import { renamed, defaultTest } from "./fixtures";',
          'import * as fx from "./fixtures/index.ts";',
          'dbTest("named export", () => {}, 5000);',
          'fixtureTest("default export", () => {}, 5000);',
          'renamed("renamed export", () => {}, 5000);',
          'defaultTest("re-exported default", () => {}, 5000);',
          'fx.dbTest.each([1])("star re-export via namespace", () => {}, 5000);',
        ].join("\n"),
      },
      [],
      1,
      ["5 sub-default", "a.test.ts:5", "a.test.ts:6", "a.test.ts:7", "a.test.ts:8", "a.test.ts:9"],
    );
    check(
      "namespace re-exports, dynamic imports and destructuring reach vitest",
      {
        "test/fixtures/base.ts":
          'import { test as base } from "vitest";\nexport const dbTest = base.extend({});\n',
        "test/fixtures/ns.ts":
          'import * as vt from "vitest";\nexport * as fx from "./base";\nexport { vt };\n',
        "test/a.test.ts": [
          'import { fx, vt } from "./fixtures/ns";',
          'const V = await import("vitest");',
          'const { it: dynIt, describe: dynGroup, expect: notApi } = await import("vitest");',
          "const { test: picked = fallback, missing: viaDefault = test } = V;",
          "let late; ({ suite: late } = V);",
          "const ns = V; const pick = flag ? ns.expect : ns.it;",
          'fx.dbTest("namespace re-export", () => {}, 5000);',
          'vt.it("re-exported namespace binding", () => {}, 5000);',
          'V.it("dynamic import namespace", () => {}, 5000);',
          'dynIt("destructured dynamic import", () => {}, 5000);',
          'dynGroup("destructured suite", { timeout: 5000 }, () => {});',
          'picked("destructured with a default", () => {}, 5000);',
          'viaDefault("a default value", () => {}, 5000);',
          'late("destructuring assignment", () => {}, 5000);',
          '(late = V.test)("an assignment used as a value", () => {}, 5000);',
          'pick("an alias read twice in one lookup", () => {}, 5000);',
          'notApi("not a test API", () => {}, 5000);',
        ].join("\n"),
      },
      [],
      1,
      ["10 sub-default", "a.test.ts:7", "a.test.ts:13", "a.test.ts:15", "a.test.ts:16 (5000 ms)"],
    );
    check(
      "vi.setConfig counts under any alias",
      {
        "test/a.test.ts": [
          'import * as V from "vitest";',
          "const { setConfig } = vi;",
          "const sc = vi.setConfig;",
          "const bound = vitest.setConfig.bind(vi);",
          "const { setConfig: viaNamespace } = V.vi;",
          "setConfig({ testTimeout: 5000 });",
          "sc({ testTimeout: 5000 });",
          "bound({ testTimeout: 5000 });",
          "viaNamespace({ testTimeout: 5000 });",
          "vi.fn({ testTimeout: 5000 });",
          "vi.setConfig({ testTimeout: 60_000 });",
        ].join("\n"),
      },
      [],
      1,
      ["4 sub-default", "a.test.ts:6", "a.test.ts:7", "a.test.ts:8", "a.test.ts:9 (5000 ms)"],
    );
    check(
      "object and array literals carry API values",
      {
        "test/a.test.ts": [
          "const [first, , third = it] = [it, null];",
          "const table = { run: test, other: helper, ...{ spread: describe } };",
          "const { run } = table;",
          "const list = [...extra, suite];",
          "const [api, notApi] = [it, helper];",
          'first("array destructuring", () => {}, 5000);',
          'third("array default", () => {}, 5000);',
          'table.run("object literal member", () => {}, 5000);',
          'run("destructured object literal", () => {}, 5000);',
          'table.spread("object spread", () => {}, 5000);',
          'list[0]("array after a spread", () => {}, 5000);',
          'table.other("non-API property", () => {}, 5000);',
          'table.missing("missing property", () => {}, 5000);',
          'notApi("array non-API element", () => {}, 5000);',
        ].join("\n"),
      },
      [],
      1,
      ["6 sub-default", "a.test.ts:6", "a.test.ts:10", "a.test.ts:11 (5000 ms)"],
    );
    check(
      "exports of destructured bindings are followed",
      {
        "test/fixtures/mod.ts": [
          'import * as V from "vitest";',
          "export const { it: exportedIt } = V;",
          "export const [exportedTest] = [V.test];",
        ].join("\n"),
        "test/a.test.ts": [
          'import { exportedIt, exportedTest } from "./fixtures/mod";',
          'exportedIt("object pattern export", () => {}, 5000);',
          'exportedTest("array pattern export", () => {}, 5000);',
        ].join("\n"),
      },
      [],
      1,
      ["2 sub-default", "a.test.ts:2 (5000 ms)", "a.test.ts:3 (5000 ms)"],
    );
    check(
      "Vitest's argument positions decide the limit",
      {
        "test/a.test.ts": [
          'it("options win over an ignored fourth argument", { timeout: 1000 }, () => {}, 60_000);',
          'it("third argument with an extra one", () => {}, 5000, "ignored");',
          'it("a numeric third argument wins over options", { timeout: 1000 }, 60_000);',
          'it("a fourth argument is ignored", () => {}, "x", 5000);',
          'it("third-slot options still count", () => {}, { timeout: 4000 });',
          'it("fourth-slot options are ignored", () => {}, "x", { timeout: 5000 });',
        ].join("\n"),
      },
      [],
      1,
      ["3 sub-default", "a.test.ts:1 (1000 ms)", "a.test.ts:2 (5000 ms)", "a.test.ts:5 (4000 ms)"],
    );
    check(
      "vi.setConfig testTimeout is a per-test limit",
      {
        "test/a.test.ts": [
          "vi.setConfig({ testTimeout: 5000 });",
          "vi.setConfig({ hookTimeout: 5000, testTimeout: 60_000 });",
          'it("after", () => {});',
        ].join("\n"),
      },
      ["| `test/a.test.ts` (1× 5 s) | 5 s per test | Bounds the file |"],
      0,
    );
    check(
      "helpers that define tests are scanned through imports",
      {
        "test/helpers/slow.ts":
          'import { it } from "vitest";\nexport function itSlow(name, fn) {\n  it(name, fn, 5000);\n}\n',
        "test/a.test.ts": 'import { itSlow } from "./helpers/slow";\nitSlow("x", () => {});',
      },
      [],
      1,
      ["test/helpers/slow.ts:3 (5000 ms)"],
    );
    check(
      "a helper with a ledger row passes",
      {
        "test/helpers/slow.ts":
          'import { it } from "vitest";\nexport function itSlow(name, fn) {\n  it(name, fn, 5000);\n}\n',
        "test/a.test.ts": 'import { itSlow } from "./helpers/slow.js";\nitSlow("x", () => {});',
      },
      ["| `test/helpers/slow.ts` (1× 5 s) | 5 s per test | Bounds the helper's tests |"],
      0,
    );
    check(
      "non-API callees stay out, and shadowing cannot hide an API",
      {
        "test/util.ts": "export const notATest = (name, fn, ms) => fn();\n",
        "test/a.test.ts": [
          'import { notATest } from "./util";',
          "const helper = (name, fn, ms) => fn();",
          'helper("plain helper", () => {}, 5000);',
          'notATest("imported helper", () => {}, 5000);',
          "function wrap() { const test = makeThing(); return test; }",
          'test("global test despite a shadowing binding", () => {}, 5000);',
          "const v = { setConfig() {} };",
          "v.setConfig({ testTimeout: 5000 });",
          'import("./util").then(() => {});',
          "let loopA, loopB; loopA = loopB; loopB = loopA;",
          'loopA("a binding cycle", () => {}, 5000);',
        ].join("\n"),
      },
      [],
      1,
      ["1 sub-default", "test/a.test.ts:6 (5000 ms)"],
    );
    check(
      "type wrappers, optional calls and static computed keys are flagged",
      {
        "test/a.test.ts": [
          'it("as const", () => {}, 5000 as const);',
          'it("satisfies", { timeout: 5000 } satisfies TestOptions, () => {});',
          'it?.("optional call", () => {}, 5000);',
          'test["skip"]("computed member", () => {}, 5000);',
          'it("computed key", { ["timeout"]: 5000 }, () => {});',
        ].join("\n"),
      },
      [],
      1,
      ["5 sub-default"],
    );

    // Scope: every Vitest config the repo runs, every include array.
    check(
      "a second Vitest config's includes are scanned",
      {
        "tier0/vitest.config.ts":
          'export default { root: repoRoot, test: { include: ["tier0/**/*.test.ts"], testTimeout: 30_000 } };',
        "tier0/a.test.ts": 'it("tier0", () => {}, 5000);',
        "test/ok.test.ts": 'it("ok", () => {});',
      },
      [],
      1,
      ["tier0/a.test.ts:1 (5000 ms)"],
    );
    check(
      "every inline project's includes are scanned",
      {
        "vitest.config.ts": [
          "export default { test: { projects: [",
          '  { test: { include: ["a/**/*.test.ts"], testTimeout: 30_000 } },',
          '  { test: { include: ["b/**/*.test.ts"], testTimeout: 30_000 } },',
          "] } };",
        ].join("\n"),
        "a/x.test.ts": 'it("a", () => {}, 5000);',
        "b/y.test.ts": 'it("b", () => {}, 6000);',
      },
      [],
      1,
      ["a/x.test.ts:1 (5000 ms)", "b/y.test.ts:1 (6000 ms)"],
    );
    check(
      "a vitest --config script target is scanned",
      {
        "package.json": JSON.stringify({ scripts: { odd: "vitest run --config config/odd.ts" } }),
        "config/odd.ts": rootConfig(["odd/**/*.test.ts"]),
        "odd/x.test.ts": 'it("odd", () => {}, 5000);',
        "test/ok.test.ts": 'it("ok", () => {});',
      },
      [],
      1,
      ["odd/x.test.ts:1 (5000 ms)"],
    );
    check(
      "a nested package's config globs from its own root",
      {
        "web/package.json": "{}",
        "web/vite.config.ts": rootConfig(["src/**/*.test.ts"]),
        "web/src/x.test.ts": 'it("kit", () => {}, 5000);',
        "test/ok.test.ts": 'it("ok", () => {});',
      },
      [],
      1,
      ["web/src/x.test.ts:1 (5000 ms)"],
    );
    check(
      "a plain Vite config without a test block is not a scope",
      {
        "web/vite.config.ts":
          'export default { build: { rollupOptions: { output: { manualChunks: [{ name: "admin", test: /admin/ }] } } } };',
        "test/ok.test.ts": 'it("ok", () => {});',
      },
      [],
      0,
    );
    check("an include that matches no file fails closed", {}, [], 2, ["matches no file"]);
    for (const [name, config] of [
      ["a raised testTimeout", rootConfig(["test/**/*.test.ts"]).replace("30_000", "60_000")],
      ["a missing testTimeout", 'export default { test: { include: ["test/**/*.test.ts"] } };'],
    ]) {
      check(
        `${name} fails closed`,
        { "vitest.config.ts": config, "test/ok.test.ts": 'it("ok", () => {});' },
        [],
        2,
        ["testTimeout must be 30000"],
      );
    }

    // Pins carry exact limits, and a stale pin fails.
    check(
      "a pin with the wrong limit fails",
      { "test/a.test.ts": 'it("x", () => {}, 2000);' },
      ["| `test/a.test.ts` (1× 20 s) | 20 s | Bounds probe |"],
      1,
      ["ledger pins 1× 20 s but the file holds 1× 2 s"],
    );
    check(
      "a mixed pin with the wrong split fails",
      {
        "test/a.test.ts":
          'it("x", () => {}, 2000);\nit("y", () => {}, 2000);\nit("z", () => {}, 2000);',
      },
      ["| `test/a.test.ts` (1× 20 s, 2× 2 s) | 2–20 s | Bounds probes |"],
      1,
      ["ledger pins 1× 20 s, 2× 2 s but the file holds 3× 2 s"],
    );
    check(
      "decimal seconds and milliseconds normalize",
      { "test/a.test.ts": 'it("x", () => {}, 2500);\nit("y", () => {}, 500);' },
      ["| `test/a.test.ts` (1× 2.5 s, 1× 500 ms) | sub-3 s | Bounds probes |"],
      0,
    );
    check(
      "a pin on a file without a sub-default timeout fails",
      { "test/a.test.ts": 'it("x", () => {});' },
      ["| `test/a.test.ts` (1× 5 s) | 5 s | Bounded once |"],
      1,
      ["holds no sub-default test timeout"],
    );
    check(
      "a pin on a file outside the Vitest scope fails",
      { "test/a.test.ts": 'it("x", () => {});' },
      ["| `test/gone.test.ts` (1× 5 s) | 5 s | Renamed away |"],
      1,
      ["test/gone.test.ts: ledger pins 1× 5 s but the file is not in the Vitest scope"],
    );

    // The source-level probe API reports the locations the gate pins.
    const probe = scanTestTimeouts(
      'it("a", () => {}, 5000);\ndescribe("s", { timeout: 6000 }, () => {});\nbeforeAll(() => {}, 7000);\n',
    );
    report(
      "scanTestTimeouts reports test and suite locations, not hooks",
      JSON.stringify(probe) ===
        JSON.stringify([
          { line: 1, value: 5000 },
          { line: 2, value: 6000 },
        ]),
      JSON.stringify(probe),
    );
  } finally {
    rmSync(suite, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`timeout ledger selftest: ${failures.length} of ${cases} cases failed.`);
    return 1;
  }
  console.log(`timeout ledger selftest: ${cases} cases passed.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--selftest")) {
    console.error("Usage: node ci/check-test-timeout-ledger.mjs [--selftest]");
    process.exitCode = 2;
  } else if (process.argv[2] === "--selftest") {
    process.exitCode = selftest();
  } else {
    process.exitCode = checkLedger(repoRoot);
  }
}
