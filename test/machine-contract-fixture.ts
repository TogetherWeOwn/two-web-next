import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "@babel/parser";
import { buildSync } from "esbuild";

// Bundle only repository modules; package imports remain the real installed dependencies.
// Every caller still starts a fresh checker process for every fixture.
export function compileMachineContractFixture(root: string): void {
  if (!isAbsolute(root)) throw new Error("Machine contract fixture root must be absolute");
  const entry = join(root, "ci/check-machine-contract.mjs");
  const result = buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: entry,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    target: "node22",
    logLevel: "silent",
  });

  // Bundling relocates every module to ci/. Fail closed if a source module starts
  // depending on its own location or cwd. The checker has exactly one intentional
  // location reference: its fixture root is the parent of the output's ci/ dir.
  let rootReferences = 0;
  for (const input of Object.keys(result.metafile.inputs)) {
    const path = resolve(root, input);
    const text = readFileSync(path, "utf8");
    if (
      path === entry &&
      !text.includes('const repoRoot = fileURLToPath(new URL("../", import.meta.url));')
    ) {
      throw new Error("Unsupported machine contract fixture root declaration");
    }
    const plugins = path.endsWith(".tsx")
      ? (["typescript", "jsx"] as const)
      : path.endsWith(".ts")
        ? (["typescript"] as const)
        : path.endsWith(".jsx")
          ? (["jsx"] as const)
          : ([] as const);
    const source = parse(text, { sourceType: "unambiguous", plugins: [...plugins] });
    type Node = {
      type?: string;
      name?: string;
      value?: unknown;
      start?: number | null;
      end?: number | null;
      object?: Node;
      property?: Node;
      [key: string]: unknown;
    };
    function visit(value: unknown, parent?: Node, grandparent?: Node): void {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, parent, grandparent);
        return;
      }
      const node = value as Node;
      if (node.type === "MetaProperty") {
        const expression = grandparent && text.slice(grandparent.start ?? 0, grandparent.end ?? 0);
        if (path !== entry || expression !== 'new URL("../", import.meta.url)') {
          throw new Error(`Unsupported import.meta in bundled checker input: ${input}`);
        }
        rootReferences++;
      }
      if (
        (node.type === "Identifier" && (node.name === "__dirname" || node.name === "__filename")) ||
        (node.type === "MemberExpression" &&
          node.object?.name === "process" &&
          (node.property?.name === "cwd" || node.property?.value === "cwd"))
      ) {
        throw new Error(`Unsupported location-dependent bundled checker input: ${input}`);
      }
      for (const child of Object.values(node)) visit(child, node, parent);
    }
    visit(source);
  }
  const output = result.outputFiles[0];
  if (rootReferences !== 1 || result.outputFiles.length !== 1 || !output) {
    throw new Error("Machine contract bundle has an unexpected root reference or output count");
  }
  writeFileSync(entry, output.contents);
}
