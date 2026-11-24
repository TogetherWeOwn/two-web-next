// The hosted XFS proof and loopback fixture call this installer explicitly.
// Ordinary builds, preview and deployment do not run it.
// Design credit: Rick7C2, draft #2092 at eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3.
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import { compileKitFacade } from "./kit-facade-compiler.mjs";
import {
  COMPANION_NAME,
  ENTRY_NAME,
  FACADE_MARKER,
  installFacadeFiles,
} from "./kit-facade-transaction.mjs";
import { withKitLock } from "./kit-lock.mjs";

export { COMPANION_NAME, ENTRY_NAME, FACADE_MARKER };
export const DEFAULT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.svelte-kit/cloudflare",
);

// Adapter Cloudflare 8 copies a default object literal with a fetch method.
// Reject ambiguous object shapes without evaluating the generated module.
async function prepareFacade(source, productionCutover) {
  const result = await compileKitFacade(source, { productionCutover });
  const program = parse(source, { sourceType: "module" }).program;
  const declaration = program.body.find((node) => node.type === "ExportDefaultDeclaration");
  const object = declaration?.declaration;
  if (object?.type !== "ObjectExpression") throw new Error("unsupported adapter fetch contract");
  let fetch = 0;
  for (const property of object.properties) {
    if (property.type === "SpreadElement" || property.computed) {
      throw new Error("unsupported adapter fetch contract");
    }
    const name = property.key.name ?? property.key.value;
    if (name === "__proto__") throw new Error("unsupported adapter fetch contract");
    if (productionCutover && (name === "queue" || name === "scheduled")) {
      throw new Error("adapter already declares a cutover jobs handler");
    }
    if (name === "fetch") {
      const callable =
        (property.type === "ObjectMethod" && property.kind === "method" && !property.generator) ||
        (property.type === "ObjectProperty" &&
          ["FunctionExpression", "ArrowFunctionExpression"].includes(property.value.type) &&
          !property.value.generator);
      if (!callable || ++fetch !== 1) throw new Error("unsupported adapter fetch contract");
    }
  }
  if (fetch !== 1) throw new Error("unsupported adapter fetch contract");
  return result;
}

// The CLI and API require an existing private, stable XFS output directory,
// including when using DEFAULT_DIR; withKitLock verifies admission before writing.
// Hold the lock through preparation, installation, and rollback.
export async function installWorkerFacade({
  dir = DEFAULT_DIR,
  io = {},
  productionCutover = false,
} = {}) {
  const root = resolve(dir);
  return withKitLock(root, () =>
    installFacadeFiles({
      root,
      prepare: (source) => prepareFacade(source, productionCutover),
      io,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  const { adapterSha256 } = await installWorkerFacade({ dir });
  console.log(`installed Kit Worker facade in ${dir} (adapter sha256 ${adapterSha256})`);
}
