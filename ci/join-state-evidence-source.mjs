// Resolve evidence inputs from the application checkout, never the controller.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export function appGit(appRoot, ...args) {
  const root = realpathSync(appRoot);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const options = { cwd: root, encoding: "utf8", env };
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], options).replace(/\n$/, "");
  if (realpathSync(gitRoot) !== root) throw new Error(`git root does not match target: ${appRoot}`);
  return execFileSync("git", args, options).trim();
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

export function srcImport(appRoot, file) {
  return import(pathToFileURL(targetFile(appRoot, file)).href);
}
