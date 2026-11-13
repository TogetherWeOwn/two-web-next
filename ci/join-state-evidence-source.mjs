// Resolve evidence inputs from the application checkout, never the controller.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function appGit(appRoot, ...args) {
  const root = realpathSync(appRoot);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const options = { cwd: root, encoding: "utf8", env };
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], options).trim();
  if (realpathSync(gitRoot) !== root) throw new Error(`git root does not match target: ${appRoot}`);
  return execFileSync("git", args, options).trim();
}

// The parent argument to import.meta.resolve requires this Node flag. Resolve in
// a separate process so package exports use import conditions before containment.
function resolveImport(base, specifier) {
  const script = `
    try {
      console.log(JSON.stringify({ url: import.meta.resolve(process.argv[1], process.argv[2]) }));
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, message: error.message }));
    }
  `;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--experimental-import-meta-resolve",
        "--input-type=module",
        "-e",
        script,
        specifier,
        pathToFileURL(join(base, "noop.mjs")).href,
      ],
      { encoding: "utf8" },
    ),
  );
  if (result.code) throw Object.assign(new Error(result.message), { code: result.code });
  return result.url;
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
      const url = resolveImport(base, specifier);
      if (!url.startsWith("file:")) continue;
      const file = fileURLToPath(url);
      if (!existsSync(file) || !withinRoot(root, realpathSync(file))) continue;
      return import(pathToFileURL(file).href);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") {
        if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
        const parts = specifier.split("/");
        const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
        let scope = base;
        while (true) {
          const manifest = join(scope, "package.json");
          if (existsSync(manifest)) {
            const pkg = JSON.parse(readFileSync(manifest, "utf8"));
            if (pkg.name === name && pkg.exports != null) {
              if (withinRoot(root, realpathSync(manifest))) throw error;
              break;
            }
            scope = "";
            break;
          }
          const parent = dirname(scope);
          if (parent === scope || scope.endsWith(`${sep}node_modules`)) {
            scope = "";
            break;
          }
          scope = parent;
        }
        if (scope) continue;
        for (const directory of base === root ? [root] : [base, root]) {
          const candidate = join(directory, "node_modules", name);
          if (existsSync(candidate)) {
            if (withinRoot(root, realpathSync(candidate))) throw error;
            break;
          }
        }
      }
    }
  }
  throw new Error(`cannot resolve ${specifier} from ${appRoot}`);
}

export function srcImport(appRoot, file) {
  return import(pathToFileURL(targetFile(appRoot, file)).href);
}
