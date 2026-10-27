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
// matched file (excluded and opt-in ones too), each literal test.setupFiles
// and test.globalSetup module, and every module those files import through a
// relative path, transitively, since setup files can set limits and helpers
// can define tests.
// Config scope must stay statically enumerable: only imported defineConfig and
// Node path/URL helpers are callable, and test-block mutation/deletion, dir,
// includeSource, project-file paths and scope-changing CLI flags fail closed.
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
import { builtinModules } from "node:module";
import { join, resolve, dirname, normalize, relative, isAbsolute, sep } from "node:path";
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
const GLOBAL_OBJECTS = new Set(["global", "globalThis"]);
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

function visitWithParent(node, callback, parent = null) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") callback(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visitWithParent(child, callback, node);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      visitWithParent(value, callback, node);
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

function isImportMetaUrl(node) {
  return (
    node?.type === "MemberExpression" &&
    node.object?.type === "MetaProperty" &&
    node.object.meta?.name === "import" &&
    node.object.property?.name === "meta" &&
    keyName(node.property, node.computed) === "url"
  );
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

// Permit the repository's VM wrapper to call createRequire only with a
// literal-allowlisted Node builtin; all other computed module loads fail closed.
function isGuardedBuiltinRequire(scope, call) {
  const argument = call.arguments[0];
  if (argument?.type !== "Identifier") return false;
  const parents = new Map();
  visitWithParent(scope.ast, (node, parent) => parents.set(node, parent));
  // The call must sit directly in the wrapper: stopping at every function
  // form (not just arrows) keeps a nested `function run(name)` from
  // attributing its shadowed call to the wrapper.
  let fn = parents.get(call);
  while (
    fn &&
    ![
      "ArrowFunctionExpression",
      "FunctionExpression",
      "FunctionDeclaration",
      "ObjectMethod",
      "ClassMethod",
      "ClassPrivateMethod",
      "StaticBlock",
    ].includes(fn.type)
  )
    fn = parents.get(fn);
  const property = fn && parents.get(fn);
  // Optional params: a StaticBlock stop has none, and must reject cleanly.
  if (
    fn?.params?.length !== 1 ||
    fn.params[0]?.type !== "Identifier" ||
    fn.params[0].name !== argument.name ||
    property?.type !== "ObjectProperty" ||
    keyName(property.key, property.computed) !== "__require" ||
    fn.body.type !== "BlockStatement"
  )
    return false;
  // Any rebinding of the guarded parameter, in any syntactic form, voids the
  // allowlist: destructuring and loop targets assign it, while a shadowing
  // declaration or catch parameter swaps the binding the call resolves.
  let parameterReassigned = false;
  const bindsParameter = (pattern) => patternNames(pattern).includes(argument.name);
  visit(fn.body, (node) => {
    if (
      (node.type === "AssignmentExpression" && bindsParameter(node.left)) ||
      (node.type === "UpdateExpression" && bindsParameter(node.argument)) ||
      (node.type === "VariableDeclarator" && bindsParameter(node.id)) ||
      (["ForInStatement", "ForOfStatement"].includes(node.type) &&
        (node.left.type === "VariableDeclaration"
          ? node.left.declarations.some((declaration) => bindsParameter(declaration.id))
          : bindsParameter(node.left))) ||
      (node.type === "CatchClause" && node.param && bindsParameter(node.param)) ||
      (["FunctionDeclaration", "ClassDeclaration"].includes(node.type) &&
        node.id &&
        bindsParameter(node.id))
    )
      parameterReassigned = true;
  });
  if (parameterReassigned) return false;
  const callIndex = fn.body.body.findIndex((statement) => {
    let containsCall = false;
    visit(statement, (node) => {
      if (node === call) containsCall = true;
    });
    return containsCall;
  });
  if (callIndex < 0) return false;
  return fn.body.body.some((statement, index) => {
    const test = statement.type === "IfStatement" ? unwrap(statement.test) : undefined;
    if (index >= callIndex || test?.type !== "UnaryExpression" || test.operator !== "!")
      return false;
    const predicate = test.argument;
    const callee = predicate?.type === "CallExpression" ? predicate.callee : undefined;
    const list =
      ["MemberExpression", "OptionalMemberExpression"].includes(callee?.type) &&
      keyName(callee.property, callee.computed) === "includes"
        ? callee.object
        : undefined;
    return (
      statement.type === "IfStatement" &&
      statement.consequent.type === "ThrowStatement" &&
      list?.type === "ArrayExpression" &&
      list.elements.every(
        (item) => item?.type === "StringLiteral" && BUILTIN_IMPORTS.has(item.value),
      ) &&
      predicate.arguments?.length === 1 &&
      predicate.arguments[0].type === "Identifier" &&
      predicate.arguments[0].name === argument.name
    );
  });
}

// Runtime bundles built in a temporary directory may be loaded from a file URL
// or a data URL. Source files addressed through file URLs stay in the import walk.
function fileUrlPathArgument(scope, expression) {
  const node = unwrap(expression);
  if (
    node?.type !== "MemberExpression" ||
    keyName(node.property, node.computed) !== "href" ||
    node.object.type !== "CallExpression" ||
    node.object.callee.type !== "Identifier" ||
    !scope.ast.program.body.some(
      (statement) =>
        statement.type === "ImportDeclaration" &&
        ["node:url", "url"].includes(statement.source.value) &&
        statement.specifiers.some(
          (specifier) =>
            specifier.local.name === node.object.callee.name &&
            keyName(specifier.imported) === "pathToFileURL",
        ),
    ) ||
    keyName(node.object.callee) !== node.object.callee.name
  )
    return undefined;
  return node.object.arguments[0];
}

function importedName(scope, local, source) {
  for (const statement of scope.ast.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      ![source, source.replace(/^node:/, "")].includes(statement.source.value)
    )
      continue;
    for (const specifier of statement.specifiers)
      if (specifier.local.name === local)
        return specifier.type === "ImportSpecifier" ? keyName(specifier.imported) : "*";
  }
  return undefined;
}

function isScratchRoot(scope, expression, seen = new Set(), at = expression?.start ?? Infinity) {
  const node = unwrap(expression);
  if (node?.type === "Identifier") {
    if (seen.has(node.name)) return false;
    seen.add(node.name);
    const bindings = bindingsAt(scope, node.name, at);
    return (
      bindings.length > 0 && bindings.every((init) => isScratchRoot(scope, init, new Set(seen), at))
    );
  }
  if (node?.type === "LogicalExpression" && ["??", "||"].includes(node.operator))
    return (
      isScratchRoot(scope, node.left, new Set(seen), at) &&
      isScratchRoot(scope, node.right, new Set(seen), at)
    );
  // These variables are the harness-owned temporary roots, not arbitrary env paths.
  if (
    node?.type === "MemberExpression" &&
    ["PAPERCLIP_RUN_SCRATCH_DIR", "PAPERCLIP_SCRATCH_DIR"].includes(
      keyName(node.property, node.computed),
    ) &&
    node.object.type === "MemberExpression" &&
    keyName(node.object.property, node.object.computed) === "env" &&
    node.object.object.type === "Identifier" &&
    node.object.object.name === "process"
  )
    return true;
  if (node?.type !== "CallExpression" || node.arguments.length !== 0) return false;
  if (
    node.callee.type === "Identifier" &&
    importedName(scope, node.callee.name, "node:os") === "tmpdir"
  )
    return true;
  return (
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    importedName(scope, node.callee.object.name, "node:os") === "*" &&
    keyName(node.callee.property, node.callee.computed) === "tmpdir"
  );
}

function isSafePathSegment(expression) {
  const node = unwrap(expression);
  const value =
    node?.type === "StringLiteral"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0]?.value.cooked
        : undefined;
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

function bindingsAt(scope, name, at) {
  const bindings = (scope.bindings.get(name) ?? []).filter((init) => init.start <= at);
  if (!bindings.length) return [];
  const lastStart = Math.max(...bindings.map((init) => init.start));
  return bindings.filter((init) => init.start === lastStart);
}

function isTemporaryOutput(
  scope,
  expression,
  seen = new Set(),
  at = expression?.start ?? Infinity,
) {
  let node = unwrap(expression);
  if (node?.type === "AwaitExpression") node = unwrap(node.argument);
  if (node?.type === "Identifier") {
    if (seen.has(node.name)) return false;
    seen.add(node.name);
    const bindings = bindingsAt(scope, node.name, at);
    return (
      bindings.length > 0 &&
      bindings.every((init) => isTemporaryOutput(scope, init, new Set(seen), at))
    );
  }
  if (node?.type !== "CallExpression" || node.callee.type !== "Identifier") return false;
  const callee = node.callee.name;
  const mkdtempCall =
    importedName(scope, callee, "node:fs") === "mkdtempSync" ||
    importedName(scope, callee, "node:fs/promises") === "mkdtemp";
  if (
    mkdtempCall &&
    node.arguments.length === 1 &&
    node.arguments[0].type === "CallExpression" &&
    node.arguments[0].callee.type === "Identifier" &&
    importedName(scope, node.arguments[0].callee.name, "node:path") === "join" &&
    isScratchRoot(scope, node.arguments[0].arguments[0]) &&
    node.arguments[0].arguments.slice(1).every(isSafePathSegment)
  )
    return true;
  return (
    importedName(scope, callee, "node:path") === "join" &&
    node.arguments.length > 1 &&
    isTemporaryOutput(scope, node.arguments[0], seen) &&
    node.arguments.slice(1).every(isSafePathSegment)
  );
}

function sourceFileURLSpecifier(scope, expression) {
  const argument = fileUrlPathArgument(scope, expression);
  const candidates =
    argument?.type === "Identifier"
      ? bindingsAt(scope, argument.name, expression?.start ?? Infinity)
      : [argument];
  if (candidates.length !== 1) return undefined;
  for (const candidate of candidates) {
    const init = unwrap(candidate);
    if (init?.type !== "CallExpression" || init.callee.type !== "Identifier") continue;
    if (
      !scope.ast.program.body.some(
        (statement) =>
          statement.type === "ImportDeclaration" &&
          ["node:url", "url"].includes(statement.source.value) &&
          statement.specifiers.some(
            (specifier) =>
              specifier.local.name === init.callee.name &&
              keyName(specifier.imported) === "fileURLToPath",
          ),
      )
    )
      continue;
    const url = unwrap(init.arguments[0]);
    const href =
      url?.type === "MemberExpression" && keyName(url.property, url.computed) === "href"
        ? url.object
        : url;
    if (
      href?.type === "NewExpression" &&
      href.callee.type === "Identifier" &&
      href.callee.name === "URL" &&
      href.arguments[0]?.type === "StringLiteral" &&
      isImportMetaUrl(href.arguments[1])
    )
      return href.arguments[0].value;
  }
  return undefined;
}

function isGeneratedBundleImport(scope, expression) {
  const argument = fileUrlPathArgument(scope, expression);
  if (argument && isTemporaryOutput(scope, argument)) return true;
  const node = unwrap(expression);
  const isDataBundle = (value) =>
    value?.type === "TemplateLiteral" &&
    value.quasis[0]?.value.cooked?.startsWith("data:text/javascript;base64,");
  if (isDataBundle(node)) return true;
  if (node?.type !== "Identifier") return false;
  const bindings = scope.bindings.get(node.name) ?? [];
  return bindings.length > 0 && bindings.every(isDataBundle);
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
  const createRequireNames = new Set();
  const createRequireNamespaces = new Set();
  for (const statement of ast.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      !["node:module", "module"].includes(statement.source.value)
    )
      continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && keyName(specifier.imported) === "createRequire")
        createRequireNames.add(specifier.local.name);
      else if (["ImportNamespaceSpecifier", "ImportDefaultSpecifier"].includes(specifier.type))
        createRequireNamespaces.add(specifier.local.name);
    }
  }
  const createRequireBindings = new Set();
  scope.createRequireBindings = createRequireBindings;
  visit(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      const init = node.init.type === "AwaitExpression" ? node.init.argument : node.init;
      if (
        init.type === "CallExpression" &&
        init.callee.type === "Import" &&
        ["node:module", "module"].includes(keyName(init.arguments[0], true))
      )
        createRequireNamespaces.add(node.id.name);
    }
  });
  const isCreateRequireReference = (expression) => {
    if (expression?.type === "Identifier") return createRequireNames.has(expression.name);
    if (
      !["MemberExpression", "OptionalMemberExpression"].includes(expression?.type) ||
      keyName(expression.property, expression.computed) !== "createRequire"
    )
      return false;
    if (
      expression.object.type === "Identifier" &&
      createRequireNamespaces.has(expression.object.name)
    )
      return true;
    return (
      expression.object.type === "CallExpression" &&
      expression.object.callee.type === "Identifier" &&
      expression.object.callee.name === "require" &&
      ["node:module", "module"].includes(keyName(expression.object.arguments[0], true))
    );
  };
  const isCreateRequireFactory = (callee) => isCreateRequireReference(callee);
  const looksLikeCreateRequireFactory = (callee) =>
    callee?.type === "Identifier"
      ? callee.name === "createRequire"
      : ["MemberExpression", "OptionalMemberExpression"].includes(callee?.type) &&
        keyName(callee.property, callee.computed) === "createRequire";
  const markCreateRequireBinding = (target, init) => {
    if (!init) return;
    if (target?.type !== "Identifier") {
      let hasFactory = false;
      visit(init, (node) => {
        if (
          isCreateRequireReference(node) ||
          (["CallExpression", "OptionalCallExpression"].includes(node.type) &&
            looksLikeCreateRequireFactory(node.callee))
        )
          hasFactory = true;
      });
      if (hasFactory) throw new Error(`${file}: createRequire source is not statically verifiable`);
      const moduleObject =
        (init.type === "CallExpression" &&
          init.callee.type === "Identifier" &&
          init.callee.name === "require" &&
          ["node:module", "module"].includes(keyName(init.arguments[0], true))) ||
        (init.type === "Identifier" && createRequireNamespaces.has(init.name));
      if (moduleObject) {
        for (const property of target.properties ?? []) {
          if (
            property.type === "ObjectProperty" &&
            keyName(property.key, property.computed) === "createRequire"
          )
            for (const name of patternNames(property.value)) createRequireNames.add(name);
        }
      }
      return;
    }
    if (isCreateRequireReference(init)) {
      createRequireNames.add(target.name);
      return;
    }
    if (init.type === "Identifier" && init.name === "createRequire")
      throw new Error(`${file}: createRequire source is not statically verifiable`);
    if (looksLikeCreateRequireFactory(init))
      throw new Error(`${file}: createRequire source is not statically verifiable`);
    if (!["CallExpression", "OptionalCallExpression"].includes(init.type)) return;
    if (isCreateRequireFactory(init.callee)) createRequireBindings.add(target.name);
    else if (looksLikeCreateRequireFactory(init.callee))
      throw new Error(`${file}: createRequire source is not statically verifiable`);
  };
  visit(ast, (node) => {
    if (node.type === "VariableDeclarator") markCreateRequireBinding(node.id, node.init);
    else if (node.type === "AssignmentExpression" && node.operator === "=")
      markCreateRequireBinding(node.left, node.right);
  });
  const parents = new Map();
  visitWithParent(ast, (node, parent) => parents.set(node, parent));
  visitWithParent(ast, (node, parent) => {
    if (node.type !== "Identifier" || node.name !== "require") return;
    const enclosingFunction = (functionNode) =>
      functionNode &&
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
        "ObjectMethod",
        "ClassMethod",
        "ClassPrivateMethod",
      ].includes(functionNode.type);
    let owner = parent;
    while (owner && !enclosingFunction(owner)) owner = parents.get(owner);
    const shadowedByParameter = owner?.params?.some(
      (parameter) => parameter.type === "Identifier" && parameter.name === "require",
    );
    const methodKey =
      ["ObjectMethod", "ClassMethod", "ClassPrivateMethod"].includes(parent?.type) &&
      parent.key === node;
    const functionName =
      ["FunctionDeclaration", "FunctionExpression"].includes(parent?.type) && parent.id === node;
    const importBinding =
      ["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(
        parent?.type,
      ) && parent.local === node;
    if (shadowedByParameter || methodKey || functionName || importBinding) return;
    const directCall =
      ["CallExpression", "OptionalCallExpression"].includes(parent?.type) && parent.callee === node;
    const createRequireBinding =
      parent?.type === "VariableDeclarator" &&
      parent.id === node &&
      createRequireBindings.has(node.name);
    const memberReference =
      parent?.type === "MemberExpression" && (parent.object === node || parent.property === node);
    const propertyKey = parent?.type === "ObjectProperty" && parent.key === node;
    const mainReference =
      parent?.type === "MemberExpression" &&
      parent.object === node &&
      keyName(parent.property, parent.computed) === "main";
    if (!directCall && !createRequireBinding && !mainReference && !memberReference && !propertyKey)
      throw new Error(`${file}: require() calls are not statically verifiable`);
  });
  visit(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.init) bindPattern(node.id, node.init);
    else if (node.type === "AssignmentExpression" && node.operator === "=")
      bindPattern(node.left, node.right);
  });
  visit(ast, (node) => {
    if (
      ["CallExpression", "OptionalCallExpression"].includes(node.type) &&
      node.callee.type === "Import"
    ) {
      const specifier = keyName(node.arguments[0], true);
      if (specifier !== undefined) scope.loads.push(specifier);
      else if (isGeneratedBundleImport(scope, node.arguments[0])) return;
      else {
        const source = sourceFileURLSpecifier(scope, node.arguments[0]);
        if (source) scope.loads.push(source);
        else throw new Error(`${file}: dynamic module specifier is not statically verifiable`);
      }
    } else if (
      ["CallExpression", "OptionalCallExpression"].includes(node.type) &&
      ((node.callee.type === "Identifier" &&
        (node.callee.name === "require" || createRequireBindings.has(node.callee.name))) ||
        (["MemberExpression", "OptionalMemberExpression"].includes(node.callee.type) &&
          keyName(node.callee.property, node.callee.computed) === "require"))
    ) {
      const specifier = keyName(node.arguments[0], true);
      if (specifier === undefined) {
        if (createRequireBindings.has(node.callee.name) && isGuardedBuiltinRequire(scope, node))
          return;
        throw new Error(`${file}: dynamic module specifier is not statically verifiable`);
      }
      scope.loads.push(specifier);
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
    root,
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
        if (value.global) return API_GLOBALS.has(key) ? [{ vitest: key }] : [];
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
      if (
        node.callee.type === "Import" ||
        node.callee.name === "require" ||
        scope.createRequireBindings?.has(node.callee.name)
      ) {
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
  // Global Vitest API names count even when a same-named binding exists.
  const found = API_GLOBALS.has(name) ? [{ vitest: name }] : [];
  if (GLOBAL_OBJECTS.has(name)) found.push({ global: true });
  const imported = scope.imports.get(name);
  if (imported?.name === "*") found.push({ scope, source: imported.source });
  else if (imported) found.push(...exportValues(ctx, scope, imported.source, imported.name, stack));
  for (const init of scope.bindings.get(name) ?? []) found.push(...values(ctx, scope, init, stack));
  stack.delete(key);
  return found;
}

function exportValues(ctx, scope, source, name, stack) {
  if (source === "vitest") return [{ vitest: name }];
  if (!/^\.\.?\//.test(source))
    return BUILTIN_IMPORTS.has(source) ? [] : [{ external: source, name }];
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
  const constNames = new Set();
  const functionNames = new Set();
  const mutatedNames = new Set();
  const rootName = (node) => {
    while (node?.type === "MemberExpression" || node?.type === "OptionalMemberExpression")
      node = node.object;
    return node?.type === "Identifier" ? node.name : undefined;
  };
  visit(scope.ast, (node) => {
    if (node.type === "VariableDeclaration" && node.kind === "const")
      for (const declaration of node.declarations)
        if (declaration.id.type === "Identifier") constNames.add(declaration.id.name);
    if (node.type === "FunctionDeclaration" && node.id?.name) functionNames.add(node.id.name);
    if (
      (node.type === "AssignmentExpression" && node.operator === "=") ||
      node.type === "UpdateExpression"
    ) {
      const name = rootName(node.left ?? node.argument);
      if (name) mutatedNames.add(name);
    }
  });
  const staticObject = (node, seen = new Set()) => {
    node = unwrap(node);
    if (node?.type === "ObjectExpression") return node;
    if (node?.type !== "Identifier" || !constNames.has(node.name) || seen.has(node.name))
      return undefined;
    const bindings = scope.bindings.get(node.name);
    if (bindings?.length !== 1) return undefined;
    seen.add(node.name);
    const object = staticObject(bindings[0], seen);
    seen.delete(node.name);
    return object;
  };
  const containsObject = (node) => {
    node = unwrap(node);
    if (node?.type === "ObjectExpression") return true;
    if (node?.type === "ConditionalExpression")
      return containsObject(node.consequent) || containsObject(node.alternate);
    if (node?.type === "LogicalExpression" || node?.type === "SequenceExpression")
      return node.type === "SequenceExpression"
        ? node.expressions.some(containsObject)
        : containsObject(node.left) || containsObject(node.right);
    return false;
  };
  const options = (node, key, strict = false) => {
    const value = unwrap(node);
    const bindings = value?.type === "Identifier" ? (scope.bindings.get(value.name) ?? []) : [];
    const object = staticObject(node);
    const staticallyCallable =
      value?.type === "Identifier" &&
      (functionNames.has(value.name) ||
        (bindings.length > 0 &&
          bindings.every((init) =>
            ["ArrowFunctionExpression", "FunctionExpression"].includes(unwrap(init)?.type),
          )));
    const importedNamespace =
      value?.type === "MemberExpression" && scope.imports.has(rootName(value));
    const unsupportedExpression =
      value !== undefined &&
      !object &&
      !staticallyCallable &&
      ![
        "ArrowFunctionExpression",
        "FunctionExpression",
        "NumericLiteral",
        "StringLiteral",
        "BooleanLiteral",
        "NullLiteral",
      ].includes(value?.type);
    if (
      strict &&
      (scope.imports.has(value?.name) ||
        importedNamespace ||
        unsupportedExpression ||
        [
          "AssignmentExpression",
          "CallExpression",
          "MemberExpression",
          "NewExpression",
          "OptionalCallExpression",
          "OptionalMemberExpression",
          "AwaitExpression",
          "ConditionalExpression",
          "LogicalExpression",
          "SequenceExpression",
        ].includes(value?.type) ||
        (value?.type === "Identifier" &&
          (!object ||
            object.type !== "ObjectExpression" ||
            !constNames.has(value.name) ||
            mutatedNames.has(value.name)) &&
          !staticallyCallable) ||
        (value?.type !== "ObjectExpression" && containsObject(value)))
    )
      throw new Error(`${scope.file}: non-static test options object reference`);
    if (!object || object.type !== "ObjectExpression") return [];
    if (strict && object.properties.some((prop) => prop.type === "SpreadElement"))
      throw new Error(`${scope.file}: test options object must not use spreads`);
    if (strict) {
      for (const prop of object.properties) {
        if (prop.computed && keyName(prop.key, true) === undefined)
          throw new Error(`${scope.file}: dynamic computed test options key`);
        if (keyName(prop.key, prop.computed) !== key) continue;
        if (prop.type !== "ObjectProperty")
          throw new Error(`${scope.file}: non-static test timeout property`);
        if (unwrap(prop.value)?.type !== "NumericLiteral")
          throw new Error(`${scope.file}: non-static test timeout value`);
      }
    }
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
    if (
      ["MemberExpression", "OptionalMemberExpression"].includes(node.callee.type) &&
      node.callee.computed &&
      keyName(node.callee.property, true) === undefined &&
      values(ctx, scope, node.callee.object).some(
        (value) =>
          value.global ||
          value.source !== undefined ||
          value.external ||
          TEST_API.has(value.vitest) ||
          VI_API.has(value.vitest),
      )
    )
      throw new Error(
        `${scope.file}:${node.loc.start.line}: dynamic computed test API access is not statically verifiable`,
      );
    const callee = values(ctx, scope, node.callee);
    const testApi = callee.some((value) => TEST_API.has(value.vitest));
    const setConfig = callee.some((value) => value.vitest === SET_CONFIG);
    const configInvocation =
      setConfig &&
      !(node.callee.type === "MemberExpression" && keyName(node.callee.property) === "bind");
    const testLimits = subDefault(
      third?.type === "NumericLiteral"
        ? [third]
        : [second, third].flatMap((arg) => options(arg, "timeout", testApi)),
    );
    const configLimits = subDefault(options(first, "testTimeout", configInvocation));
    if (testLimits.length + configLimits.length === 0) return;
    if (
      callee.some(
        (value) =>
          value.external && /^(?:it|test|describe|suite|setConfig)$/i.test(value.name ?? ""),
      )
    )
      throw new Error(
        `${scope.file}:${node.loc.start.line}: declared external test-like API is not statically verifiable`,
      );
    const limits = [...(testApi ? testLimits : []), ...(setConfig ? configLimits : [])];
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
// package.json scripts. Scope-changing CLI flags are rejected.
function configFiles(root) {
  const explicit = new Set();
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
  for (const script of scripts) {
    const commands = String(script).matchAll(/\bvitest\b[^;&|]*/g);
    for (const [command] of commands) {
      if (
        /\s(?:--(?:root|dir|project|workspace|include|testTimeout|test-timeout)|-[rp])(?:=|\s|$)/.test(
          command,
        )
      )
        throw new Error(
          `package.json Vitest flags can override scanned scope or testTimeout: ${command}`,
        );
      for (const match of command.matchAll(/\s(?:--config|-c)(?:=|\s+)["']?([^\s"';&|]+)/g)) {
        const target = normalize(match[1]);
        files.add(target);
        explicit.add(target);
      }
    }
  }
  return { files: [...files].sort(), explicit };
}

// npm runs Vitest from the package root, so include globs resolve there.
function packageRoot(root, dir) {
  for (let current = dir; current !== "."; current = dirname(current))
    if (existsSync(join(root, current, "package.json"))) return current;
  return ".";
}

const BUILTIN_IMPORTS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function isDeclaredExternalImport(root, file, specifier) {
  if (BUILTIN_IMPORTS.has(specifier)) return true;
  if (specifier.startsWith("#")) return false;
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  if (!packageName || packageName === "." || packageName === "..") return false;
  const base = packageRoot(root, dirname(file));
  const manifests = new Set([
    join(root, base, "package.json"),
    join(root, "package.json"),
    join(root, "web/package.json"),
  ]);
  return [...manifests].some((manifest) => {
    if (!existsSync(manifest)) return false;
    const packageJson = JSON.parse(readFileSync(manifest, "utf8"));
    const declared = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ].some((field) => Object.hasOwn(packageJson[field] ?? {}, packageName));
    if (declared) return true;
    const lockfile = manifest.replace(/package\.json$/, "package-lock.json");
    if (!existsSync(lockfile)) return false;
    const lock = JSON.parse(readFileSync(lockfile, "utf8"));
    return Object.hasOwn(lock.packages ?? {}, `node_modules/${packageName}`);
  });
}

function configRootMatchesPackage(root, config, base, ast, expression) {
  const imports = new Map();
  const namespaces = new Map();
  const defaults = new Map();
  const bindings = new Map();
  for (const statement of ast.program.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier")
          imports.set(specifier.local.name, {
            module: statement.source.value,
            name: keyName(specifier.imported),
          });
        if (specifier.type === "ImportNamespaceSpecifier")
          namespaces.set(specifier.local.name, statement.source.value);
        if (specifier.type === "ImportDefaultSpecifier")
          defaults.set(specifier.local.name, statement.source.value);
      }
    } else if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations)
        if (declaration.id.type === "Identifier" && declaration.init)
          bindings.set(declaration.id.name, [
            ...(bindings.get(declaration.id.name) ?? []),
            { kind: statement.kind, init: declaration.init },
          ]);
    }
  }

  const cwd = resolve(root, base);
  const evaluate = (node, seen = new Set()) => {
    node = unwrap(node);
    if (node?.type === "StringLiteral") return node.value;
    if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
      return node.quasis[0].value.cooked;
    if (node?.type === "Identifier") {
      if (seen.has(node.name)) return undefined;
      const declarations = bindings.get(node.name);
      if (declarations?.length !== 1 || declarations[0].kind !== "const") return undefined;
      seen.add(node.name);
      const value = evaluate(declarations[0].init, seen);
      seen.delete(node.name);
      return value;
    }
    if (node?.type !== "CallExpression") return undefined;
    let imported;
    if (node.callee.type === "Identifier") imported = imports.get(node.callee.name);
    else if (node.callee.type === "MemberExpression" && !node.callee.computed) {
      const object =
        node.callee.object?.type === "Identifier" ? node.callee.object.name : undefined;
      imported = {
        module: namespaces.get(object) ?? defaults.get(object),
        name: keyName(node.callee.property, false),
      };
    } else return undefined;
    if (imported?.module === "node:url" && imported.name === "fileURLToPath") {
      const argument = node.arguments[0];
      if (node.arguments.length === 1 && isImportMetaUrl(argument)) return resolve(root, config);
      return undefined;
    }
    const args = node.arguments.map((argument) => evaluate(argument, seen));
    if (args.some((value) => typeof value !== "string")) return undefined;
    if (
      (imported?.module === "node:path" || imported?.module === "path") &&
      imported.name === "resolve"
    )
      return resolve(cwd, ...args);
    if (
      (imported?.module === "node:path" || imported?.module === "path") &&
      imported.name === "dirname" &&
      args.length === 1
    )
      return dirname(args[0]);
    return undefined;
  };

  const value = evaluate(expression);
  if (typeof value !== "string") return false;
  const configured = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  return configured === cwd;
}

// Config composition and mutation can change scope without a literal root
// beside `test`. Reject arbitrary config execution rather than pretending to
// resolve it; plain Vite configs without a test block are not test scopes.
function verifyConfigRoots(root, config, base, ast, hasTestBlock) {
  const importedNames = new Map();
  const importedNamespaces = new Map();
  const importedDefaults = new Map();
  for (const statement of ast.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier")
        importedNames.set(specifier.local.name, {
          module: statement.source.value,
          name: keyName(specifier.imported),
        });
      if (specifier.type === "ImportNamespaceSpecifier")
        importedNamespaces.set(specifier.local.name, statement.source.value);
      if (specifier.type === "ImportDefaultSpecifier")
        importedDefaults.set(specifier.local.name, statement.source.value);
    }
  }
  const safeConfigCall = (callee) => {
    if (
      ["MemberExpression", "OptionalMemberExpression"].includes(callee?.type) &&
      !callee.computed
    ) {
      const object = callee.object?.type === "Identifier" ? callee.object.name : undefined;
      const module = importedNamespaces.get(object) ?? importedDefaults.get(object);
      const name = keyName(callee.property, false);
      if (name === "defineConfig" && ["vite", "vitest/config"].includes(module)) return true;
      if (["resolve", "dirname"].includes(name) && ["node:path", "path"].includes(module))
        return true;
      if (name === "fileURLToPath" && module === "node:url") return true;
    }
    if (callee?.type !== "Identifier") return false;
    const imported = importedNames.get(callee.name);
    if (!imported) return false;
    return (
      (imported.name === "defineConfig" && ["vite", "vitest/config"].includes(imported.module)) ||
      (imported.name === "resolve" && ["node:path", "path"].includes(imported.module)) ||
      (imported.name === "dirname" && ["node:path", "path"].includes(imported.module)) ||
      (imported.name === "fileURLToPath" && imported.module === "node:url")
    );
  };
  visit(ast, (node) => {
    // Babel 8 represents dynamic import as an expression, not a call.
    if (hasTestBlock && node.type === "ImportExpression")
      throw new Error(`${config}: config calls are not statically verifiable`);
    if (hasTestBlock && ["CallExpression", "OptionalCallExpression"].includes(node.type)) {
      const callee = node.callee;
      const property = ["MemberExpression", "OptionalMemberExpression"].includes(callee?.type)
        ? keyName(callee.property, callee.computed)
        : undefined;
      if (callee?.type === "Identifier" && callee.name === "mergeConfig")
        throw new Error(
          `${config}: config composition with mergeConfig is not statically verifiable`,
        );
      if (property === "mergeConfig")
        throw new Error(
          `${config}: config composition with mergeConfig is not statically verifiable`,
        );
      if (property === "assign")
        throw new Error(
          `${config}: config composition with Object.assign is not statically verifiable`,
        );
      if (
        property &&
        ["defineProperty", "defineProperties", "set", "setPrototypeOf", "create"].includes(property)
      )
        throw new Error(`${config}: config root mutation is not statically verifiable`);
      if (
        ["MemberExpression", "OptionalMemberExpression"].includes(callee?.type) &&
        callee.computed &&
        property === undefined
      )
        throw new Error(`${config}: dynamic computed config access is not statically verifiable`);
      if (!safeConfigCall(callee))
        throw new Error(`${config}: config calls are not statically verifiable`);
    }
    if (hasTestBlock && node.type === "NewExpression")
      throw new Error(`${config}: config construction is not statically verifiable`);
    if (hasTestBlock && ["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
      const property = keyName(node.property, node.computed);
      if (node.computed && property === undefined)
        throw new Error(`${config}: dynamic computed config access is not statically verifiable`);
      if (property === "mergeConfig")
        throw new Error(
          `${config}: config composition with mergeConfig is not statically verifiable`,
        );
      if (property === "assign")
        throw new Error(
          `${config}: config composition with Object.assign is not statically verifiable`,
        );
      if (
        ["defineProperty", "defineProperties", "set", "setPrototypeOf", "create"].includes(property)
      )
        throw new Error(`${config}: config root mutation is not statically verifiable`);
    }
    if (
      hasTestBlock &&
      node.type === "VariableDeclarator" &&
      node.id?.type === "ObjectPattern" &&
      node.id.properties.some((prop) =>
        ["assign", "defineProperty", "defineProperties", "set", "setPrototypeOf"].includes(
          prop.type === "ObjectProperty" ? keyName(prop.key, prop.computed) : undefined,
        ),
      )
    )
      throw new Error(`${config}: config root mutation is not statically verifiable`);
    if (hasTestBlock && node.type === "AssignmentExpression")
      throw new Error(`${config}: config assignments are not statically verifiable`);
    if (hasTestBlock && node.type === "UpdateExpression")
      throw new Error(`${config}: config updates are not statically verifiable`);
    if (hasTestBlock && node.type === "UnaryExpression" && node.operator === "delete")
      throw new Error(`${config}: deleting config properties is not statically verifiable`);
    if (
      hasTestBlock &&
      node.type === "ObjectProperty" &&
      node.computed &&
      keyName(node.key, true) === undefined
    )
      throw new Error(`${config}: computed config option keys must be static`);
    if (
      hasTestBlock &&
      node.type === "ObjectProperty" &&
      keyName(node.key, node.computed) === "alias"
    )
      throw new Error(`${config}: resolve aliases are not statically supported`);
    if (
      hasTestBlock &&
      node.type === "ObjectProperty" &&
      keyName(node.key, node.computed) === "__proto__"
    )
      throw new Error(`${config}: config prototype changes are not statically verifiable`);
    // Ungated: a root in any config file, including a skipped plain Vite
    // config another config could merge, must match the package root.
    if (
      node.type === "ObjectProperty" &&
      keyName(node.key, node.computed) === "root" &&
      !configRootMatchesPackage(root, config, base, ast, node.value)
    )
      throw new Error(`${config}: configured Vitest root must match the config package root`);
  });
}

// Every literal test.include array and test.setupFiles value of every config,
// inline projects too. Ambiguous scope or root options fail closed.
function listTestFiles(root) {
  const files = new Set();
  const setupFileRoots = new Set();
  const globalSetupRoots = new Set();
  const discovered = configFiles(root);
  for (const config of discovered.files) {
    const ast = syntax(readFileSync(join(root, config), "utf8"), config);
    const base = packageRoot(root, dirname(config));
    const blocks = [];
    visitWithParent(ast, (node, parent) => {
      if (
        node.type === "ObjectProperty" &&
        keyName(node.key, node.computed) === "test" &&
        unwrap(node.value).type === "ObjectExpression"
      )
        blocks.push({ block: unwrap(node.value), parent });
    });
    // An auto-discovered plain Vite config (the Kit app's) carries no test
    // block; an explicitly selected config must describe its Vitest scope.
    if (blocks.length === 0 && /(^|\/)vite\.config\./.test(config)) {
      if (discovered.explicit.has(config))
        throw new Error(`${config}: explicit Vitest config has no literal test block`);
      verifyConfigRoots(root, config, base, ast, false);
      continue;
    }
    if (blocks.length === 0) throw new Error(`${config} has no literal test block`);
    verifyConfigRoots(root, config, base, ast, true);
    const packagePath = resolve(root, base);
    for (const { block, parent } of blocks) {
      if (parent?.type === "ObjectExpression") {
        if (parent.properties.some((prop) => prop.type === "SpreadElement"))
          throw new Error(`${config}: config options must not use object spreads`);
        if (
          parent.properties.some(
            (prop) =>
              (prop.type === "ObjectProperty" || prop.type === "ObjectMethod") &&
              prop.computed &&
              keyName(prop.key, prop.computed) === undefined,
          )
        )
          throw new Error(`${config}: computed config option keys must be static`);
        const roots = parent.properties.filter(
          (prop) => keyName(prop.key, prop.computed) === "root",
        );
        if (roots.length > 1) throw new Error(`${config}: root must be specified only once`);
        if (roots.length === 1) {
          if (
            roots[0].type !== "ObjectProperty" ||
            !configRootMatchesPackage(root, config, base, ast, roots[0].value)
          )
            throw new Error(`${config}: configured Vitest root must match the config package root`);
        }
      }
      if (block.properties.some((prop) => prop.type === "SpreadElement"))
        throw new Error(`${config}: test options must not use object spreads`);
      if (
        block.properties.some(
          (prop) =>
            (prop.type === "ObjectProperty" || prop.type === "ObjectMethod") &&
            prop.computed &&
            keyName(prop.key, prop.computed) === undefined,
        )
      )
        throw new Error(`${config}: computed test option keys must be static`);
      const option = (name) => {
        const properties = block.properties.filter(
          (prop) => keyName(prop.key, prop.computed) === name,
        );
        if (properties.length > 1)
          throw new Error(`${config}: test.${name} must be specified only once`);
        const property = properties[0];
        if (property && property.type !== "ObjectProperty") {
          const detail = ["setupFiles", "globalSetup"].includes(name)
            ? "must be a literal string or string array"
            : "must be a static property";
          throw new Error(`${config}: test.${name} ${detail}`);
        }
        return unwrap(property?.value);
      };
      for (const name of ["dir", "includeSource"])
        if (option(name) !== undefined)
          throw new Error(`${config}: test.${name} scope is not statically supported`);
      const testRoot = option("root");
      if (testRoot && !configRootMatchesPackage(root, config, base, ast, testRoot))
        throw new Error(`${config}: configured Vitest root must match the config package root`);
      const setup = option("setupFiles");
      if (setup !== undefined) {
        const setupFiles =
          setup.type === "StringLiteral"
            ? [setup.value]
            : setup.type === "ArrayExpression" &&
                setup.elements.every((item) => item?.type === "StringLiteral")
              ? setup.elements.map((item) => item.value)
              : undefined;
        if (!setupFiles)
          throw new Error(`${config}: test.setupFiles must be a literal string or string array`);
        for (const setupFile of setupFiles) {
          const file = normalize(relative(root, resolve(packagePath, setupFile)));
          if (isAbsolute(file) || file === ".." || file.startsWith(`..${sep}`))
            throw new Error(`${config}: test.setupFiles must stay inside the repository`);
          files.add(file);
          setupFileRoots.add(file);
        }
      }
      const globalSetupOption = option("globalSetup");
      if (globalSetupOption !== undefined) {
        const globalSetup =
          globalSetupOption.type === "StringLiteral"
            ? [globalSetupOption.value]
            : globalSetupOption.type === "ArrayExpression" &&
                globalSetupOption.elements.every((item) => item?.type === "StringLiteral")
              ? globalSetupOption.elements.map((item) => item.value)
              : undefined;
        if (!globalSetup)
          throw new Error(`${config}: test.globalSetup must be a literal string or string array`);
        for (const setupModule of globalSetup) {
          const file = normalize(relative(root, resolve(packagePath, setupModule)));
          if (isAbsolute(file) || file === ".." || file.startsWith(`..${sep}`))
            throw new Error(`${config}: test.globalSetup must stay inside the repository`);
          files.add(file);
          globalSetupRoots.add(file);
        }
      }
      const include = option("include");
      const projects = option("projects");
      if (
        projects !== undefined &&
        (projects.type !== "ArrayExpression" ||
          !projects.elements.every((item) => {
            const project = unwrap(item);
            return (
              project?.type === "ObjectExpression" &&
              project.properties.some(
                (property) =>
                  keyName(property.key, property.computed) === "test" &&
                  unwrap(property.value)?.type === "ObjectExpression",
              )
            );
          }))
      )
        throw new Error(`${config}: test.projects must be inline objects with literal test blocks`);
      // A projects block runs each project's own test block instead.
      if (!include && projects !== undefined) continue;
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
  return { files: [...files].sort(), setupFiles: setupFileRoots, globalSetup: globalSetupRoots };
}

// Configured test files, setupFiles and globalSetup modules, plus every
// module they import through a relative path, transitively. Also returns the
// globalSetup-reachable set, computed as a fixpoint over the loaded graph so
// modules first reached through a test path are still marked.
function scanScope(ctx, files, setupFiles, globalSetupFiles = []) {
  const queue = [...files];
  const seen = new Set(queue);
  const setupReachable = new Set(setupFiles);
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index];
    const module = ctx.load(file);
    for (const specifier of module.loads) {
      const target = ctx.resolve(file, specifier);
      const resource = /^\.\.?\//.test(specifier)
        ? resolve(ctx.root, dirname(file), specifier.replace(/\?.*$/, ""))
        : undefined;
      if (
        !target &&
        !(resource && existsSync(resource) && !CODE.test(resource)) &&
        specifier !== "vitest" &&
        !isDeclaredExternalImport(ctx.root, file, specifier)
      )
        throw new Error(
          `${file}: ${setupReachable.has(file) ? "setupFiles module has " : ""}unresolved non-relative import ${specifier}`,
        );
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
    if (setupReachable.has(file))
      for (const specifier of module.loads) {
        const target = ctx.resolve(file, specifier);
        if (target) setupReachable.add(target);
      }
  }
  const globalSetupReachable = new Set();
  const pending = [...globalSetupFiles];
  while (pending.length > 0) {
    const file = pending.pop();
    if (globalSetupReachable.has(file)) continue;
    globalSetupReachable.add(file);
    for (const specifier of ctx.load(file).loads) {
      const target = ctx.resolve(file, specifier);
      if (target && seen.has(target)) pending.push(target);
    }
  }
  return { scanned: [...seen].sort(), globalSetupReachable };
}

// A string the checker can see through: literals and `"a" + "b"` folds.
// Anything else (an identifier, a call, a template with expressions) is an
// opaque key that could name any property.
function staticString(node) {
  node = unwrap(node);
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "NumericLiteral") return String(node.value);
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked;
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticString(node.left);
    const right = staticString(node.right);
    if (typeof left === "string" && typeof right === "string") return left + right;
  }
  return undefined;
}

// A globalSetup module runs before the suite with the resolved config, so
// `ctx.config.testTimeout = N` (vi.setConfig throws there) would lower every
// test's limit with no literal in any test file. Any testTimeout reference in
// those modules or their relative imports fails closed, as does any member
// write, delete, or object/class key through a computed name the checker
// cannot see through: `config[key] = N` could bind any property. Reads
// through opaque names cannot mutate the config and stay allowed.
function verifyGlobalSetupTimeouts(ctx, files) {
  for (const file of [...files].sort()) {
    const ast = ctx.load(file).ast;
    let hit = false;
    visit(ast, (node) => {
      if (
        (node.type === "Identifier" && node.name === "testTimeout") ||
        (node.type === "StringLiteral" && node.value === "testTimeout") ||
        (node.type === "TemplateLiteral" &&
          node.expressions.length === 0 &&
          node.quasis[0]?.value.cooked === "testTimeout") ||
        (node.type === "BinaryExpression" &&
          node.operator === "+" &&
          staticString(node) === "testTimeout")
      )
        hit = true;
    });
    if (hit) throw new Error(`${file}: globalSetup module must not reference testTimeout`);
    const writeTargets = [];
    visit(ast, (node) => {
      if (node.type === "AssignmentExpression") writeTargets.push(node.left);
      else if (["ForInStatement", "ForOfStatement"].includes(node.type))
        writeTargets.push(node.left);
      else if (node.type === "VariableDeclarator" && node.init) writeTargets.push(node.id);
      else if (node.type === "UpdateExpression") writeTargets.push(node.argument);
      else if (node.type === "UnaryExpression" && node.operator === "delete")
        writeTargets.push(node.argument);
    });
    for (const target of writeTargets)
      visit(target, (node) => {
        if (
          ["MemberExpression", "OptionalMemberExpression"].includes(node?.type) &&
          node.computed &&
          staticString(node.property) === undefined
        )
          throw new Error(
            `${file}: globalSetup module must not write through a computed member name`,
          );
      });
    visit(ast, (node) => {
      if (
        [
          "ObjectProperty",
          "ObjectMethod",
          "ClassMethod",
          "ClassPrivateMethod",
          "ClassProperty",
          "PropertyDefinition",
        ].includes(node?.type) &&
        node.computed &&
        staticString(node.key) === undefined
      )
        throw new Error(
          `${file}: globalSetup module must not use a computed key the checker cannot see through`,
        );
    });
  }
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
  let scope;
  try {
    scope = listTestFiles(root);
  } catch (error) {
    output.error(`timeout ledger: cannot enumerate Vitest scope: ${error.message}`);
    return 2;
  }
  const ctx = project(root);
  const scanned = new Map();
  try {
    const { scanned: files, globalSetupReachable } = scanScope(
      ctx,
      scope.files,
      scope.setupFiles,
      scope.globalSetup,
    );
    for (const file of files) scanned.set(file, scanModule(ctx, ctx.load(file)));
    verifyGlobalSetupTimeouts(ctx, globalSetupReachable);
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
      ["cannot enumerate Vitest scope"],
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
      "mutable options object reference fails closed",
      {
        "test/a.test.ts": [
          "let opts = { timeout: 5000 };",
          'it("mutable options", opts, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "mutated const options object reference fails closed",
      {
        "test/a.test.ts": [
          "const opts = {};",
          "opts.timeout = 5000;",
          'it("mutated options", opts, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "spread-supplied test options fail closed",
      {
        "test/a.test.ts": [
          "const base = { timeout: 5000 };",
          "const opts = { ...base };",
          'it("spread options", opts, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["test options object must not use spreads"],
    );
    check(
      "conditionally built test options fail closed",
      {
        "test/a.test.ts": [
          "const opts = cond ? { timeout: 5000 } : {};",
          'it("conditional options", opts, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "mutable alias options fail closed",
      {
        "test/a.test.ts": [
          "const opts = { timeout: 5000 };",
          "let alias = opts;",
          'it("mutable alias", alias, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "conditional identifier aliases fail closed",
      {
        "test/a.test.ts": [
          "const opts = { timeout: 5000 };",
          "const other = {};",
          "const selected = cond ? opts : other;",
          'it("conditional alias", selected, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "sequence option aliases fail closed",
      {
        "test/a.test.ts": [
          "const opts = { timeout: 5000 };",
          "const selected = (setup(), opts);",
          'it("sequence alias", selected, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "parameter option references fail closed",
      { "test/a.test.ts": 'function f(q) { it("parameter options", q, () => {}); }' },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "namespace options imports fail closed",
      {
        "test/options.ts": "export const opts = { timeout: 5000 };",
        "test/a.test.ts": [
          'import * as helper from "./options";',
          'it("namespace options", helper.opts, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "imported options object reference fails closed",
      {
        "test/options.ts": "export const opts = { timeout: 5000 };",
        "test/a.test.ts": [
          'import { opts } from "./options";',
          'it("imported options", opts, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "globalThis and global Vitest APIs are scanned",
      {
        "test/a.test.ts": [
          'globalThis.it("globalThis", () => {}, 5000);',
          'global.it("global", () => {}, 4000);',
          "globalThis.vi.setConfig({ testTimeout: 3000 });",
        ].join("\n"),
      },
      ["| `test/a.test.ts` (1× 5 s, 1× 4 s, 1× 3 s) | 3 limits | Bounds them |"],
      0,
    );
    check(
      "dynamic computed global Vitest APIs fail closed",
      { "test/a.test.ts": 'globalThis["i" + "t"]("hidden", () => {}, 5000);' },
      [],
      2,
      ["dynamic computed test API access is not statically verifiable"],
    );
    check(
      "dynamic computed vi APIs fail closed",
      { "test/a.test.ts": 'vi["set" + "Config"]({ testTimeout: 5000 });' },
      [],
      2,
      ["dynamic computed test API access is not statically verifiable"],
    );
    check(
      "assignment and construction options fail closed",
      {
        "test/a.test.ts": [
          'it("assignment", opts = { timeout: 5000 }, () => {});',
          'it("construction", new Options({ timeout: 4000 }), () => {});',
          'it("computed timeout", () => {}, 2000 + 3000);',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "local member options references fail closed",
      {
        "test/a.test.ts": [
          "const holder = { opts: { timeout: 5000 } };",
          'it("member", holder.opts, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "optional and computed member options references fail closed",
      {
        "test/a.test.ts": [
          "const holder = { opts: { timeout: 5000 } };",
          'it("optional", holder?.opts, () => {});',
          'it("computed", holder["opts"], () => {});',
          'it("third slot", () => {}, holder.opts);',
          "vi.setConfig(holder.opts);",
        ].join("\n"),
      },
      [],
      2,
      ["non-static test options object reference"],
    );
    check(
      "non-literal timeout values fail closed",
      {
        "test/a.test.ts": [
          "const limit = 5000;",
          "const opts = { timeout: limit };",
          'it("variable timeout", opts, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test timeout value"],
    );
    check(
      "getter timeout options fail closed",
      {
        "test/a.test.ts": [
          "const opts = { get timeout() { return 5000; } };",
          'it("getter timeout", opts, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["non-static test timeout property"],
    );
    check(
      "dynamic computed timeout keys fail closed",
      {
        "test/a.test.ts": [
          'const key = "timeout";',
          "const opts = { [key]: 5000 };",
          'it("computed timeout", opts, () => {});',
        ].join("\n"),
      },
      [],
      2,
      ["dynamic computed test options key"],
    );
    check(
      "CommonJS require Vitest APIs are scanned",
      {
        "test/a.test.ts": [
          'const { it: test } = require("vitest");',
          'test("required API", () => {}, 5000);',
        ].join("\n"),
      },
      ["| `test/a.test.ts` (1× 5 s) | 5 s per test | Covers require |"],
      0,
    );
    check(
      "CommonJS required helper modules are scanned",
      {
        "test/a.test.ts": 'require("./helper.cjs");',
        "test/helper.cjs": 'it("required helper", () => {}, 4000);',
      },
      ["| `test/helper.cjs` (1× 4 s) | 4 s per test | Covers helper |"],
      0,
    );
    check(
      "bare module createRequire follows relative helpers",
      {
        "test/a.test.ts": [
          'import { createRequire } from "module";',
          "const req = createRequire(import.meta.url);",
          'req("./helper.cjs");',
        ].join("\n"),
        "test/helper.cjs": 'it("bare module helper", () => {}, 5000);',
      },
      [],
      1,
      ["test/helper.cjs:1 (5000 ms)"],
    );
    check(
      "namespace createRequire follows relative helpers",
      {
        "test/a.test.ts": [
          'import * as module from "node:module";',
          "const req = module.createRequire(import.meta.url);",
          'req("./helper.cjs");',
        ].join("\n"),
        "test/helper.cjs": 'it("namespace helper", () => {}, 5000);',
      },
      [],
      1,
      ["test/helper.cjs:1 (5000 ms)"],
    );
    check(
      "destructured createRequire bindings fail closed",
      {
        "test/a.test.ts": [
          'import { createRequire } from "node:module";',
          "const [req] = [createRequire(import.meta.url)];",
          'req("./helper.cjs");',
        ].join("\n"),
        "test/helper.cjs": 'it("hidden", () => {}, 5000);',
      },
      [],
      2,
      ["createRequire source is not statically verifiable"],
    );
    check(
      "createRequire factory aliases follow relative helpers",
      {
        "test/a.test.ts": [
          'import { createRequire } from "node:module";',
          "const factory = createRequire;",
          "const req = factory(import.meta.url);",
          'req("./helper.cjs");',
        ].join("\n"),
        "test/helper.cjs": 'it("factory alias", () => {}, 5000);',
      },
      [],
      1,
      ["test/helper.cjs:1 (5000 ms)"],
    );
    check(
      "unverified extracted createRequire factory members fail closed",
      {
        "test/a.test.ts": [
          'const module = require("module");',
          "const factory = module.createRequire;",
          "const req = factory(import.meta.url);",
          'req("./helper.cjs");',
        ].join("\n"),
        "test/helper.cjs": 'it("factory member", () => {}, 5000);',
      },
      [],
      2,
      ["createRequire source is not statically verifiable"],
    );
    check(
      "destructured createRequire from require module is tracked",
      {
        "test/a.test.ts": [
          'const { createRequire: cr } = require("module");',
          "const req = cr(import.meta.url);",
          'req("./helper.cjs");',
        ].join("\n"),
        "test/helper.cjs": 'it("destructured factory", () => {}, 5000);',
      },
      [],
      1,
      ["test/helper.cjs:1 (5000 ms)"],
    );
    check(
      "optional createRequire factory calls are tracked",
      {
        "test/a.test.ts": [
          'import { createRequire as factory } from "node:module";',
          "const req = factory?.(import.meta.url);",
          'req("./helper.cjs");',
        ].join("\n"),
        "test/helper.cjs": 'it("optional factory", () => {}, 5000);',
      },
      [],
      1,
      ["test/helper.cjs:1 (5000 ms)"],
    );
    check(
      "createRequire-loaded Vitest aliases are tracked",
      {
        "test/a.test.ts": [
          'import { createRequire } from "node:module";',
          "const req = createRequire(import.meta.url);",
          'const { it: myTest } = req("vitest");',
          'myTest("hidden", () => {}, 5000);',
        ].join("\n"),
      },
      [],
      1,
      ["test/a.test.ts:4 (5000 ms)"],
    );
    check(
      "member require calls scan literal helpers",
      {
        "test/a.test.ts": ['globalThis.require("./helper.cjs");'].join("\n"),
        "test/helper.cjs": 'it("member require", () => {}, 5000);',
      },
      [],
      1,
      ["test/helper.cjs:1 (5000 ms)"],
    );
    check(
      "literal data URL imports fail closed",
      {
        "test/a.test.ts": 'await import("data:text/javascript;base64,Y29uc29sZS5sb2coMSk=");',
      },
      [],
      2,
      ["unresolved non-relative import data:text/javascript;base64"],
    );
    check(
      "reassigned temporary and data URL bindings fail closed",
      {
        "test/a.test.ts": [
          'import { mkdtempSync } from "node:fs";',
          'import { tmpdir } from "node:os";',
          'import { join } from "node:path";',
          'import { pathToFileURL } from "node:url";',
          'let scratch = mkdtempSync(join(tmpdir(), "bundle-"));',
          'scratch = "test";',
          'await import(pathToFileURL(join(scratch, "helper.ts")).href);',
          'let url = "./helper.ts";',
          "url = `data:text/javascript;base64,Y29uc29sZS5sb2coMSk=`;",
          "await import(url);",
        ].join("\n"),
      },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    check(
      "ordinary require property names and resolve calls are allowed",
      {
        "test/a.test.ts": [
          "const options = { require: true };",
          "console.log(options.require);",
          'require.resolve("./helper.cjs");',
        ].join("\n"),
      },
      [],
      0,
    );
    check(
      "require method names and shadowing parameters are allowed",
      {
        "test/a.test.ts": [
          "const object = { require() { return 1; } };",
          "class Example { require() {} }",
          "function helper(require) { return require; }",
        ].join("\n"),
      },
      [],
      0,
    );
    check(
      "aliased CommonJS require references fail closed",
      { "test/a.test.ts": ["const load = require;", "load(moduleName);"].join("\n") },
      [],
      2,
      ["require() calls are not statically verifiable"],
    );
    check(
      "assignment-bound createRequire follows relative helpers",
      {
        "test/a.test.ts": [
          'import { createRequire } from "node:module";',
          "let req;",
          "req = createRequire(import.meta.url);",
          'req("./helper.cjs");',
        ].join("\n"),
        "test/helper.cjs": 'it("assignment helper", () => {}, 5000);',
      },
      [],
      1,
      ["test/helper.cjs:1 (5000 ms)"],
    );
    check(
      "dynamic-import module namespace createRequire follows helpers",
      {
        "test/a.test.ts": [
          'const module = await import("node:module");',
          "const req = module.createRequire(import.meta.url);",
          'req("./helper.cjs");',
        ].join("\n"),
        "test/helper.cjs": 'it("dynamic namespace helper", () => {}, 5000);',
      },
      [],
      1,
      ["test/helper.cjs:1 (5000 ms)"],
    );
    check(
      "require module createRequire follows relative helpers",
      {
        "test/a.test.ts": [
          'const req = require("module").createRequire(import.meta.url);',
          'req("./helper.cjs");',
        ].join("\n"),
        "test/helper.cjs": 'it("required module helper", () => {}, 5000);',
      },
      [],
      1,
      ["test/helper.cjs:1 (5000 ms)"],
    );
    check(
      "unknown createRequire factories fail closed",
      {
        "test/a.test.ts":
          'const req = helpers.createRequire(import.meta.url); req("./helper.cjs");',
      },
      [],
      2,
      ["createRequire source is not statically verifiable"],
    );
    check(
      "dynamic CommonJS module specifiers fail closed",
      { "test/a.test.ts": "require(moduleName);" },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    check(
      "non-literal dynamic imports fail closed",
      { "test/a.test.ts": "await import(`./helper-${name}.ts`);" },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    check(
      "temporary generated file URL bundle imports are not traversed",
      {
        "test/a.test.ts": [
          'import { mkdtempSync } from "node:fs";',
          'import { tmpdir } from "node:os";',
          'import { join } from "node:path";',
          'import { pathToFileURL } from "node:url";',
          'const scratch = mkdtempSync(join(tmpdir(), "bundle-"));',
          'const outfile = join(scratch, "bundle.mjs");',
          "await import(pathToFileURL(outfile).href);",
        ].join("\n"),
      },
      [],
      0,
    );
    check(
      "async mkdtemp bundle imports are not traversed",
      {
        "test/a.test.ts": [
          'import { mkdtemp } from "node:fs/promises";',
          'import { tmpdir } from "node:os";',
          'import { join } from "node:path";',
          'import { pathToFileURL } from "node:url";',
          "let scratch;",
          'scratch = await mkdtemp(join(tmpdir(), "kit-members-binding-"));',
          'const outfile = join(scratch, "members-load.mjs");',
          "await import(pathToFileURL(outfile).href);",
        ].join("\n"),
      },
      [],
      0,
    );
    check(
      "async mkdtemp outside scratch roots fails closed",
      {
        "test/a.test.ts": [
          'import { mkdtemp } from "node:fs/promises";',
          'import { join } from "node:path";',
          'import { pathToFileURL } from "node:url";',
          'const scratch = await mkdtemp(join("test", "bundle-"));',
          'const outfile = join(scratch, "bundle.mjs");',
          "await import(pathToFileURL(outfile).href);",
        ].join("\n"),
      },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    for (const [name, root, expected] of [
      [
        "Paperclip scratch root fallback aliases are accepted",
        "const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();",
        0,
      ],
      [
        "Paperclip scratch root inline fallbacks are accepted",
        "const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir();",
        0,
      ],
      [
        "Paperclip shared scratch root is accepted",
        "const scratchRoot = process.env.PAPERCLIP_SCRATCH_DIR;",
        0,
      ],
      [
        "unrelated environment roots fail closed",
        "const scratchRoot = process.env.TEST_SOURCE_DIR ?? tmpdir();",
        2,
      ],
      [
        "source directory fallback fails closed",
        'const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? "test";',
        2,
      ],
      [
        "reassigned scratch root fails closed",
        'let scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(); scratchRoot = "test";',
        2,
      ],
      [
        "cyclic scratch root aliases fail closed",
        "const scratchRoot = other; const other = scratchRoot;",
        2,
      ],
    ]) {
      check(
        name,
        {
          "test/a.test.ts": [
            'import { mkdtempSync } from "node:fs";',
            'import { tmpdir } from "node:os";',
            'import { join } from "node:path";',
            'import { pathToFileURL } from "node:url";',
            root,
            'const scratch = mkdtempSync(join(scratchRoot, "bundle-"));',
            'const outfile = join(scratch, "bundle.mjs");',
            "await import(pathToFileURL(outfile).href);",
          ].join("\n"),
        },
        [],
        expected,
        expected === 2 ? ["dynamic module specifier is not statically verifiable"] : [],
      );
    }
    check(
      "Paperclip scratch root alone is not a generated bundle path",
      {
        "test/a.test.ts": [
          'import { join } from "node:path";',
          'import { pathToFileURL } from "node:url";',
          'const outfile = join(process.env.PAPERCLIP_RUN_SCRATCH_DIR, "helper.ts");',
          "await import(pathToFileURL(outfile).href);",
        ].join("\n"),
      },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    check(
      "temporary path joins that escape the temp directory fail closed",
      {
        "test/a.test.ts": [
          'import { mkdtempSync } from "node:fs";',
          'import { tmpdir } from "node:os";',
          'import { join } from "node:path";',
          'import { pathToFileURL } from "node:url";',
          'const scratch = mkdtempSync(join(tmpdir(), "bundle-"));',
          'const outfile = join(scratch, "..", "helper.ts");',
          "await import(pathToFileURL(outfile).href);",
        ].join("\n"),
      },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    check(
      "absolute path resolution from temp directories fails closed",
      {
        "test/a.test.ts": [
          'import { mkdtempSync } from "node:fs";',
          'import { tmpdir } from "node:os";',
          'import { join, resolve } from "node:path";',
          'import { pathToFileURL } from "node:url";',
          'const scratch = mkdtempSync(join(tmpdir(), "bundle-"));',
          'const outfile = resolve(scratch, "/repo/helper.ts");',
          "await import(pathToFileURL(outfile).href);",
        ].join("\n"),
      },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    check(
      "source file URL imports remain in the helper walk",
      {
        "test/a.test.ts": [
          'import { fileURLToPath, pathToFileURL } from "node:url";',
          'const helper = fileURLToPath(new URL("./helper.ts", import.meta.url).href);',
          "await import(pathToFileURL(helper).href);",
        ].join("\n"),
        "test/helper.ts": 'it("hidden source helper", () => {}, 5000);',
      },
      [],
      1,
      ["test/helper.ts:1 (5000 ms)"],
    );
    check(
      "arbitrary file URL imports fail closed",
      {
        "test/a.test.ts": [
          'import { pathToFileURL } from "node:url";',
          'await import(pathToFileURL("./helper.ts").href);',
        ].join("\n"),
      },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    check(
      "generated data URL bundle imports are not traversed",
      {
        "test/a.test.ts": [
          'const bundled = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;',
          "await import(bundled);",
        ].join("\n"),
      },
      [],
      0,
    );
    check(
      "inline generated data URL bundle imports are not traversed",
      {
        "test/a.test.ts":
          'await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);',
      },
      [],
      0,
    );
    check(
      "createRequire calls behind a literal builtin allowlist are accepted",
      {
        "test/a.test.ts": [
          'import { createRequire } from "node:module";',
          "const require = createRequire(import.meta.url);",
          'const helpers = { __require: (name) => { if (!["fs", "path"].includes(name)) throw new Error("blocked"); return require(name); } };',
        ].join("\n"),
      },
      [],
      0,
    );
    check(
      "inverted createRequire builtin guard fails closed",
      {
        "test/a.test.ts": [
          'import { createRequire } from "node:module";',
          "const require = createRequire(import.meta.url);",
          'const helpers = { __require: (name) => { if (["fs", "path"].includes(name)) throw new Error("blocked"); return require(name); } };',
        ].join("\n"),
      },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    check(
      "createRequire builtin guard parameter reassignment fails closed",
      {
        "test/a.test.ts": [
          'import { createRequire } from "node:module";',
          "const require = createRequire(import.meta.url);",
          'const helpers = { __require: (name) => { if (!["fs"].includes(name)) throw new Error("blocked"); name = "./helper.cjs"; return require(name); } };',
        ].join("\n"),
      },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    for (const [name, reassign] of [
      ["destructuring reassignment", '({ v: name } = { v: "./helper.cjs" });'],
      ["array reassignment", "[name] = ['./helper.cjs'];"],
      ["for-of reassignment", 'for (name of ["./helper.cjs"]) { /* once */ }'],
      ["for-in reassignment", 'for (name in { "./helper.cjs": 1 }) { /* once */ }'],
      ["shadowing declaration", '{ let name = "./helper.cjs"; return require(name); }'],
      ["catch parameter shadowing", "try { void name; } catch (name) { return require(name); }"],
      ["nested function shadowing", "function run(name) { return require(name); }"],
      ["nested arrow shadowing", "const run = (name) => require(name);"],
      ["function declaration shadowing", "{ function name() {} return require(name); }"],
      ["static block scope", "class C { static { require(name); } }"],
    ]) {
      check(
        `createRequire builtin guard ${name} fails closed`,
        {
          "test/a.test.ts": [
            'import { createRequire } from "node:module";',
            "const require = createRequire(import.meta.url);",
            `const helpers = { __require: (name) => { if (!["fs"].includes(name)) throw new Error("blocked"); ${reassign} return require(name); } };`,
          ].join("\n"),
        },
        [],
        2,
        ["dynamic module specifier is not statically verifiable"],
      );
    }
    check(
      "unreachable createRequire builtin guard fails closed",
      {
        "test/a.test.ts": [
          'import { createRequire } from "node:module";',
          "const require = createRequire(import.meta.url);",
          'const helpers = { __require: (name) => { return require(name); if (!["fs"].includes(name)) throw new Error("blocked"); } };',
        ].join("\n"),
      },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    check(
      "non-literal createRequire calls fail closed",
      {
        "test/a.test.ts": [
          'import { createRequire } from "node:module";',
          "const require = createRequire(import.meta.url);",
          "require(helperPath);",
        ].join("\n"),
      },
      [],
      2,
      ["dynamic module specifier is not statically verifiable"],
    );
    check(
      "referenced options object timeout remains pinned",
      {
        "test/a.test.ts": [
          "const opts = { timeout: 5000 };",
          'it("referenced options", opts, () => {});',
        ].join("\n"),
      },
      [],
      1,
      ["a.test.ts:1 (5000 ms)"],
    );
    check(
      "referenced vi.setConfig object timeout remains pinned",
      {
        "test/a.test.ts": ["const config = { testTimeout: 5000 };", "vi.setConfig(config);"].join(
          "\n",
        ),
      },
      [],
      1,
      ["a.test.ts:1 (5000 ms)"],
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
      "declared package test APIs with timeout literals fail closed",
      {
        "package.json": '{"devDependencies":{"test-tools":"1.0.0"}}',
        "test/a.test.ts": [
          'import { test as customTest } from "test-tools";',
          'customTest("hidden API", () => {}, 5000);',
        ].join("\n"),
      },
      [],
      2,
      ["declared external test-like API is not statically verifiable"],
    );
    check(
      "locked transitive package imports are recognized",
      {
        "web/package.json": "{}",
        "web/package-lock.json": JSON.stringify({
          packages: { "node_modules/@tailwindcss/node": { version: "4.3.3" } },
        }),
        "test/a.test.ts": [
          'import { createRequire } from "node:module";',
          'const webRequire = createRequire("web/package.json");',
          'webRequire("@tailwindcss/node");',
        ].join("\n"),
      },
      [],
      0,
    );
    check(
      "external names containing test are not inferred as test APIs",
      {
        "package.json": '{"dependencies":{"latest-test-utils":"1.0.0"}}',
        "test/a.test.ts": [
          'import * as utils from "latest-test-utils";',
          'utils.latest("ordinary helper", () => {}, 5000);',
        ].join("\n"),
      },
      [],
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

    check(
      "unlisted timeout in a setupFiles module fails",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, setupFiles: "./test/setup.ts" } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "test/setup.ts": 'import { vi } from "vitest"; vi.setConfig({ testTimeout: 5000 });',
      },
      [],
      1,
      ["test/setup.ts:1 (5000 ms)"],
    );
    check(
      "unresolved non-relative setup import fails closed",
      {
        "package.json": '{"dependencies":{"@h/slow":"1.0.0"}}',
        "vitest.config.ts": [
          'export default { resolve: { alias: { "@h": "./helpers" } }, test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, setupFiles: "./test/setup.ts" } };',
        ].join("\n"),
        "test/a.test.ts": 'it("test", () => {});',
        "test/setup.ts": 'import "@h/slow";',
        "helpers/slow.ts": 'import { vi } from "vitest"; vi.setConfig({ testTimeout: 5000 });',
      },
      [],
      2,
      ["resolve aliases are not statically supported"],
    );
    check(
      "computed resolve aliases fail closed",
      {
        "package.json": '{"dependencies":{"@h/slow":"1.0.0"}}',
        "vitest.config.ts": [
          'export default { resolve: { ["ali" + "as"]: { "@h": "./helpers" } }, test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, setupFiles: "./test/setup.ts" } };',
        ].join("\n"),
        "test/a.test.ts": 'it("test", () => {});',
        "test/setup.ts": 'import "@h/slow";',
        "helpers/slow.ts": 'import { vi } from "vitest"; vi.setConfig({ testTimeout: 5000 });',
      },
      [],
      2,
      ["computed config option keys must be static"],
    );
    check(
      "a setupFiles timeout passes with an exact pin from its package root",
      {
        "test/ok.test.ts": 'it("ok", () => {});',
        "web/package.json": "{}",
        "web/vite.config.ts":
          'export default { test: { include: ["src/**/*.test.ts"], testTimeout: 30_000, setupFiles: ["./test/setup.ts"] } };',
        "web/src/a.test.ts": 'it("uses setup config", () => {});',
        "web/test/setup.ts": 'import { vi } from "vitest"; vi.setConfig({ testTimeout: 5000 });',
      },
      ["| `web/test/setup.ts` (1× 5 s) | 5 s | Sets the per-test limit |"],
      0,
    );
    check(
      "imports from a setupFiles module are scanned",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, setupFiles: ["./test/setup.ts"] } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "test/setup.ts": 'import { configure } from "./setup-helper"; configure();',
        "test/setup-helper.ts": 'import { vi } from "vitest"; vi.setConfig({ testTimeout: 5000 });',
      },
      [],
      1,
      ["test/setup-helper.ts:1 (5000 ms)"],
    );
    check(
      "non-literal setupFiles scope fails closed",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, setupFiles } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
      },
      [],
      2,
      ["test.setupFiles must be a literal string or string array"],
    );
    check(
      "spread-provided setupFiles scope fails closed",
      {
        "vitest.config.ts": [
          'const shared = { setupFiles: ["./test/setup.ts"] };',
          'export default { test: { ...shared, include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
        ].join("\n"),
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "test/setup.ts": 'import { vi } from "vitest"; vi.setConfig({ testTimeout: 5000 });',
      },
      [],
      2,
      ["test options must not use object spreads"],
    );
    check(
      "duplicate setupFiles properties fail closed",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, setupFiles: "./test/first.ts", setupFiles: "./test/last.ts" } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "test/first.ts": "// no timeout",
        "test/last.ts": 'import { vi } from "vitest"; vi.setConfig({ testTimeout: 5000 });',
      },
      [],
      2,
      ["test.setupFiles must be specified only once"],
    );
    check(
      "computed setupFiles keys fail closed",
      {
        "vitest.config.ts": [
          'const key = "setupFiles";',
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, [key]: ["./test/setup.ts"] } };',
        ].join("\n"),
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "test/setup.ts": 'import { vi } from "vitest"; vi.setConfig({ testTimeout: 5000 });',
      },
      [],
      2,
      ["computed config option keys must be static"],
    );
    check(
      "clean globalSetup modules pass",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, globalSetup: ["./test/guard.ts"] } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "test/guard.ts": [
          'import { helper } from "./helper";',
          "export default function guard() { helper(); }",
        ].join("\n"),
        "test/helper.ts": "export function helper() {}",
      },
      [],
      0,
    );
    check(
      "globalSetup config mutation fails closed",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, globalSetup: "./test/guard.ts" } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "test/guard.ts": [
          "export default function guard(context) {",
          "  context.config.testTimeout = 5000;",
          "}",
        ].join("\n"),
      },
      [],
      2,
      ["globalSetup module must not reference testTimeout"],
    );
    check(
      "globalSetup transitive testTimeout fails closed",
      {
        // The shared module sorts before the guard, so it is visited before
        // the guard marks it: reachability must be a fixpoint, not visit order.
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, setupFiles: ["./test/aaa-shared.ts"], globalSetup: ["./test/zzz-guard.ts"] } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "test/aaa-shared.ts": 'import "./leaf"; export const shared = 1;',
        "test/zzz-guard.ts": 'import "./aaa-shared"; export default function guard() {}',
        "test/leaf.ts": "export function tweak(context) { context.config.testTimeout = 5000; }",
      },
      [],
      2,
      ["globalSetup module must not reference testTimeout"],
    );
    check(
      "non-literal globalSetup scope fails closed",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, globalSetup } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
      },
      [],
      2,
      ["test.globalSetup must be a literal string or string array"],
    );
    check(
      "globalSetup outside the repository fails closed",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, globalSetup: ["../guard.ts"] } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
      },
      [],
      2,
      ["test.globalSetup must stay inside the repository"],
    );
    check(
      "globalSetup folded testTimeout key fails closed",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, globalSetup: "./test/guard.ts" } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "test/guard.ts": [
          "export default function guard(context) {",
          '  const key = "test" + "Timeout";',
          "  context.config[key] = 5000;",
          "}",
        ].join("\n"),
      },
      [],
      2,
      ["globalSetup module must not reference testTimeout"],
    );
    check(
      "globalSetup opaque computed member write fails closed",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, globalSetup: "./test/guard.ts" } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "test/guard.ts": [
          "export default function guard(context) {",
          "  context.config[process.env.CONFIG_KEY] = 5000;",
          "}",
        ].join("\n"),
      },
      [],
      2,
      ["must not write through a computed member name"],
    );
    check(
      "globalSetup static computed member writes pass",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, globalSetup: "./test/guard.ts" } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "test/guard.ts": [
          "const seen = {};",
          'seen["done"] = true;',
          "const counts = [];",
          "counts[0] = 1;",
          "export default function guard() { return seen.done && counts[0]; }",
        ].join("\n"),
      },
      [],
      0,
    );
    check(
      "duplicate include properties fail closed",
      {
        "vitest.config.ts":
          'export default { test: { include: ["clean/**/*.test.ts"], ["include"]: ["dirty/**/*.test.ts"], testTimeout: 30_000 } };',
        "clean/a.test.ts": 'it("clean", () => {});',
        "dirty/b.test.ts": 'it("slow", () => {}, 5000);',
      },
      [],
      2,
      ["test.include must be specified only once"],
    );
    check(
      "duplicate testTimeout properties fail closed",
      {
        "vitest.config.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, testTimeout: 60_000 } };',
        "test/a.test.ts": 'it("medium", () => {}, 40_000);',
      },
      [],
      2,
      ["test.testTimeout must be specified only once"],
    );
    check(
      "top-level root override fails closed",
      {
        "vitest.config.ts":
          'export default { root: "sub", test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, setupFiles: "./setup.ts" } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "setup.ts": "// no timeout",
        "sub/test/a.test.ts": 'it("uses setup config", () => {});',
        "sub/setup.ts": 'import { vi } from "vitest"; vi.setConfig({ testTimeout: 5000 });',
      },
      [],
      2,
      ["configured Vitest root must match the config package root"],
    );
    check(
      "root composed through mergeConfig fails closed",
      {
        "vitest.config.ts": [
          'import { mergeConfig, defineConfig } from "vitest/config";',
          'export default mergeConfig({ root: "sub" }, defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, setupFiles: ["./setup.ts"] } }));',
        ].join("\n"),
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "setup.ts": "// no timeout",
        "sub/test/a.test.ts": 'it("uses setup config", () => {});',
        "sub/setup.ts": 'import { vi } from "vitest"; vi.setConfig({ testTimeout: 5000 });',
      },
      [],
      2,
      ["config composition with mergeConfig is not statically verifiable"],
    );
    check(
      "namespace mergeConfig cannot import an unscanned root config",
      {
        "vitest.config.ts": [
          'import * as vite from "vite";',
          'import base from "./base.config";',
          'export default vite.mergeConfig(base, { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });',
        ].join("\n"),
        "base.config.ts": 'export default { root: "sub" };',
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["config composition with mergeConfig is not statically verifiable"],
    );
    check(
      "root composed through Object.assign fails closed",
      {
        "vitest.config.ts": [
          'import { defineConfig } from "vitest/config";',
          'export default Object.assign({ root: "sub" }, defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } }));',
        ].join("\n"),
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("root", () => {});',
      },
      [],
      2,
      ["config composition with Object.assign is not statically verifiable"],
    );
    check(
      "computed root assignment fails closed",
      {
        "vitest.config.ts": [
          'const cfg = { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
          'const key = "root";',
          'cfg[key] = "sub";',
          "export default cfg;",
        ].join("\n"),
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["config assignments are not statically verifiable"],
    );
    check(
      "config mutation helpers fail closed",
      {
        "vitest.config.ts": [
          'const cfg = { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
          'Object.defineProperty(cfg, "root", { value: "sub" });',
          'Reflect.set(cfg, "root", "sub");',
          "export default cfg;",
        ].join("\n"),
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["config root mutation is not statically verifiable"],
    );
    check(
      "indirect mergeConfig invocation fails closed",
      {
        "vitest.config.ts": [
          'import { mergeConfig } from "vite";',
          'import base from "./base.config";',
          'export default (0, mergeConfig)(base, { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });',
        ].join("\n"),
        "base.config.ts": 'export default { root: "sub" };',
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["config calls are not statically verifiable"],
    );
    check(
      "dynamic import beside a literal test config fails closed",
      {
        "vitest.config.ts": [
          'await import("./helper.mjs");',
          rootConfig(["test/**/*.test.ts"]),
        ].join("\n"),
        "helper.mjs": "export const ready = true;",
        "test/a.test.ts": 'it("clean", () => {});',
      },
      [],
      2,
      ["config calls are not statically verifiable"],
    );
    check(
      "dynamically imported config with a decoy test block fails closed",
      {
        "vitest.config.ts": [
          'const actual = await import("./actual-config.mjs");',
          'const decoy = { test: { include: ["clean/**/*.test.ts"], testTimeout: 30_000 } };',
          "export default actual.default;",
        ].join("\n"),
        "actual-config.mjs": rootConfig(["hidden/**/*.test.ts"]),
        "clean/a.test.ts": 'it("clean", () => {});',
        "hidden/unpinned.test.ts": 'it("unpinned", () => {}, 5000);',
      },
      [],
      2,
      ["config calls are not statically verifiable"],
    );
    check(
      "aliased Object.assign invocation fails closed",
      {
        "vitest.config.ts": [
          'import base from "./base.config";',
          "const assign = Object.assign;",
          'export default assign({}, base, { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });',
        ].join("\n"),
        "base.config.ts": 'export default { root: "sub" };',
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["config composition with Object.assign is not statically verifiable"],
    );
    check(
      "destructured composition helpers through aliases fail closed",
      {
        "vitest.config.ts": [
          'import base from "./base.config";',
          "const O = Object;",
          "const { assign: combine } = O;",
          'export default combine({}, base, { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });',
        ].join("\n"),
        "base.config.ts": 'export default { root: "sub" };',
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["config root mutation is not statically verifiable"],
    );
    check(
      "destructured mutation helpers through aliases fail closed",
      {
        "vitest.config.ts": [
          "const R = Reflect;",
          "const { set } = R;",
          'const cfg = { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
          'set(cfg, "root", "sub");',
          "export default cfg;",
        ].join("\n"),
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["config root mutation is not statically verifiable"],
    );
    check(
      "third-party config composition fails closed",
      {
        "vitest.config.ts": [
          'import merge from "lodash/merge";',
          'import base from "./base.config";',
          'export default merge({}, base, { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });',
        ].join("\n"),
        "base.config.ts": 'export default { root: "sub" };',
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["config calls are not statically verifiable"],
    );
    check(
      "prototype mutations fail closed",
      {
        "vitest.config.ts": [
          'import base from "./base.config";',
          'const cfg = { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
          "cfg.__proto__ = base;",
          "export default cfg;",
        ].join("\n"),
        "base.config.ts": 'export default { root: "sub" };',
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["config assignments are not statically verifiable"],
    );
    check(
      "prototype object properties fail closed",
      {
        "vitest.config.ts": [
          'import base from "./base.config";',
          'export default { __proto__: base, test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
        ].join("\n"),
        "base.config.ts": 'export default { root: "sub" };',
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["config prototype changes are not statically verifiable"],
    );
    check(
      "computed merge and mutation access plus aliased receivers fail closed",
      {
        "vitest.config.ts": [
          'import * as vite from "vite";',
          'import base from "./base.config";',
          "const O = Object;",
          "const R = Reflect;",
          "const d = O.defineProperty;",
          'const cfg = vite["merge" + "Config"](base, { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });',
          'O["assi" + "gn"](cfg, {});',
          'd(cfg, "root", { value: "sub" });',
          'R.set(cfg, "root", "sub");',
          'Reflect.defineProperty(cfg, "root", { value: "sub" });',
          'Object.defineProperties(cfg, { ["ro" + "ot"]: { value: "sub" } });',
          "export default cfg;",
        ].join("\n"),
        "base.config.ts": 'export default { root: "sub" };',
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["config root mutation is not statically verifiable"],
    );
    check(
      "computed config method names fail closed",
      {
        "vitest.config.ts": [
          'import * as vite from "vite";',
          'import base from "./base.config";',
          'export default vite["merge" + "Config"](base, { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });',
        ].join("\n"),
        "base.config.ts": 'export default { root: "sub" };',
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("unlisted", () => {}, 5000);',
      },
      [],
      2,
      ["dynamic computed config access is not statically verifiable"],
    );
    check(
      "dynamic computed config access fails closed",
      {
        "vitest.config.ts": [
          'const name = "mergeConfig";',
          'export default vite[name]({}, { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });',
        ].join("\n"),
        "test/a.test.ts": 'it("root", () => {});',
      },
      [],
      2,
      ["dynamic computed config access is not statically verifiable"],
    );
    check(
      "later root assignment fails closed",
      {
        "vitest.config.ts": [
          'const cfg = { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
          'cfg.root = "sub";',
          "export default cfg;",
        ].join("\n"),
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/a.test.ts": 'it("root", () => {});',
      },
      [],
      2,
      ["config assignments are not statically verifiable"],
    );
    check(
      "testTimeout update fails closed",
      {
        "vitest.config.ts": [
          'const cfg = { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
          "cfg.test.testTimeout--;",
          "export default cfg;",
        ].join("\n"),
        "test/a.test.ts": 'it("update", () => {});',
      },
      [],
      2,
      ["config updates are not statically verifiable"],
    );
    check(
      "merged Vite config is rejected even without a test block",
      {
        "vitest.config.ts": [
          'import { mergeConfig } from "vite";',
          'import viteConfig from "./vite.config";',
          'export default mergeConfig(viteConfig, { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });',
        ].join("\n"),
        "vite.config.ts": "export default {};",
        "test/a.test.ts": 'it("root", () => {});',
      },
      [],
      2,
      ["config composition with mergeConfig is not statically verifiable"],
    );
    check(
      "test.root override fails closed",
      {
        "vitest.config.ts":
          'export default { test: { root: "sub", include: ["test/**/*.test.ts"], testTimeout: 30_000, setupFiles: "./setup.ts" } };',
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "setup.ts": "// no timeout",
        "sub/test/a.test.ts": 'it("uses setup config", () => {});',
        "sub/setup.ts": 'import { vi } from "vitest"; vi.setConfig({ testTimeout: 5000 });',
      },
      [],
      2,
      ["configured Vitest root must match the config package root"],
    );
    check(
      "config-level root spread fails closed",
      {
        "vitest.config.ts": [
          'const shared = { root: "sub" };',
          'export default { ...shared, test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
        ].join("\n"),
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "sub/test/a.test.ts": 'it("uses setup config", () => {});',
      },
      [],
      2,
      ["configured Vitest root must match the config package root"],
    );
    check(
      "computed config root keys fail closed",
      {
        "vitest.config.ts": [
          'const key = "root";',
          'export default { [key]: "sub", test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
        ].join("\n"),
        "test/a.test.ts": 'it("uses setup config", () => {});',
        "sub/test/a.test.ts": 'it("uses setup config", () => {});',
      },
      [],
      2,
      ["computed config option keys must be static"],
    );

    // Scope: every Vitest config, include array and setupFiles path.
    check(
      "a second Vitest config's includes are scanned",
      {
        "tier0/vitest.config.ts": [
          'import { fileURLToPath } from "node:url";',
          'import { dirname, resolve } from "node:path";',
          'const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");',
          'export default { root: repoRoot, test: { include: ["tier0/**/*.test.ts"], setupFiles: ["./test/setup.ts"], testTimeout: 30_000 } };',
        ].join("\n"),
        "tier0/a.test.ts": 'it("tier0", () => {}, 5000);',
        "test/setup.ts": "// no timeout",
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
      "post-hoc test config assignment fails closed",
      {
        "vitest.config.ts": [
          'const cfg = { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
          'cfg.test.include = ["sub/**/*.test.ts"];',
          "export default cfg;",
        ].join("\n"),
        "test/ok.test.ts": 'it("ok", () => {});',
        "sub/b.test.ts": 'it("hidden", () => {}, 5000);',
      },
      [],
      2,
      ["config assignments are not statically verifiable"],
    );
    check(
      "deleting test config properties fails closed",
      {
        "vitest.config.ts": [
          'const cfg = { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
          "delete cfg.test.include;",
          "export default cfg;",
        ].join("\n"),
      },
      [],
      2,
      ["deleting config properties is not statically verifiable"],
    );
    for (const name of ["dir", "includeSource"]) {
      check(
        `test.${name} scope option fails closed`,
        {
          "vitest.config.ts": rootConfig(["test/**/*.test.ts"]).replace(
            "testTimeout: 30_000",
            `testTimeout: 30_000, ${name}: ["sub/**/*.ts"]`,
          ),
        },
        [],
        2,
        [`test.${name} scope is not statically supported`],
      );
    }
    check(
      "project config paths fail closed",
      {
        "vitest.config.ts": 'export default { test: { projects: ["./sub/project.ts"] } };',
        "sub/project.ts":
          'export default { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } };',
        "sub/test/b.test.ts": 'it("hidden", () => {}, 5000);',
      },
      [],
      2,
      ["test.projects must be inline objects with literal test blocks"],
    );
    for (const flag of [
      "--dir sub",
      "-r sub",
      "--workspace ./custom.workspace.ts",
      "--include sub/**/*.test.ts",
    ]) {
      check(
        `scope-changing Vitest CLI flag ${flag} fails closed`,
        {
          "package.json": JSON.stringify({ scripts: { test: `vitest run ${flag}` } }),
          "vitest.config.ts": rootConfig(["test/**/*.test.ts"]),
          "test/ok.test.ts": 'it("ok", () => {});',
        },
        [],
        2,
        ["package.json Vitest flags can override scanned scope or testTimeout"],
      );
    }
    check(
      "explicit Vite config without test block fails closed",
      {
        "package.json": JSON.stringify({
          scripts: { test: "vitest run --config web/vite.config.ts" },
        }),
        "vitest.config.ts": rootConfig(["test/**/*.test.ts"]),
        "test/ok.test.ts": 'it("ok", () => {});',
        "web/vite.config.ts": "export default { build: {} };",
      },
      [],
      2,
      ["explicit Vitest config has no literal test block"],
    );
    check(
      "optional mergeConfig invocation fails closed",
      {
        "vitest.config.ts": [
          'import * as vite from "vite";',
          'import base from "./base.config";',
          'export default vite?.mergeConfig(base, { test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });',
        ].join("\n"),
        "base.config.ts": 'export default { root: "sub" };',
        "test/a.test.ts": 'it("root", () => {});',
        "sub/test/hidden.test.ts": 'it("hidden", () => {}, 5000);',
      },
      [],
      2,
      ["config composition with mergeConfig is not statically verifiable"],
    );
    check(
      "namespaced defineConfig is statically accepted",
      {
        "vitest.config.ts": [
          'import * as v from "vitest/config";',
          'export default v.defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });',
        ].join("\n"),
        "test/ok.test.ts": 'it("ok", () => {});',
      },
      [],
      0,
    );
    check(
      "plain Vite config composition remains outside Vitest scope",
      {
        "web/vite.config.ts": [
          'import { mergeConfig } from "vite";',
          "export default mergeConfig({ build: {} }, { build: { minify: true } });",
        ].join("\n"),
        "test/ok.test.ts": 'it("ok", () => {});',
      },
      [],
      0,
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
    check(
      "a skipped Vite config with a foreign root fails closed",
      {
        "vite.config.ts": 'export default { root: "sub" };',
        "test/ok.test.ts": 'it("ok", () => {});',
      },
      [],
      2,
      ["configured Vitest root must match the config package root"],
    );
    check(
      "a skipped Vite config with a package root passes",
      {
        "vite.config.ts": 'export default { root: "." };',
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
