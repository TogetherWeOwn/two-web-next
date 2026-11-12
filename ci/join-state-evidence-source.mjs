// Resolve evidence inputs from the application checkout, never the controller.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export function appGit(appRoot, ...args) {
  return execFileSync("git", args, { cwd: appRoot, encoding: "utf8" }).trim();
}

function withinRoot(root, file) {
  const fromRoot = relative(root, file);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function targetFile(appRoot, file) {
  const root = realpathSync(appRoot);
  const candidate = resolve(root, file);
  if (isAbsolute(file) || !withinRoot(root, candidate))
    throw new Error(`path outside target: ${file}`);
  if (!existsSync(candidate)) return candidate;
  const actual = realpathSync(candidate);
  if (!withinRoot(root, actual)) throw new Error(`path outside target: ${file}`);
  return actual;
}

export function appImport(appRoot, specifier, explicitFile) {
  if (explicitFile) {
    const file = targetFile(appRoot, explicitFile);
    if (existsSync(file)) return import(pathToFileURL(file).href);
  }
  const root = realpathSync(appRoot);
  for (const base of [root, join(root, "web")]) {
    try {
      const file = createRequire(join(base, "noop.js")).resolve(specifier);
      if (!isAbsolute(file) || !withinRoot(root, realpathSync(file))) continue;
      return import(pathToFileURL(file).href);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`cannot resolve ${specifier} from ${appRoot}`);
}

export function srcImport(appRoot, file) {
  return import(pathToFileURL(targetFile(appRoot, file)).href);
}
