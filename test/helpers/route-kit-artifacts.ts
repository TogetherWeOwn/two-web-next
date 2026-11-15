import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";

// Structural prerequisites only: passing this check does not certify migration parity.
export function assertTargetArtifacts(root: string, target: unknown) {
  if (
    typeof target !== "string" ||
    !/^web\/src\/(?:hooks\.server\.ts|routes\/(?:[^\r\n]+\/)?\+(?:page\.svelte|server\.ts))$/.test(
      target,
    ) ||
    target.split("/").some((part) => part === "." || part === ".." || part === "")
  ) {
    throw new Error("Unresolved or invalid target");
  }

  const requireFile = (path: string) => {
    try {
      if (lstatSync(join(root, path)).isFile()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    throw new Error(`Missing regular file: ${path}`);
  };

  requireFile(target);
  if (target.endsWith("/+page.svelte")) {
    requireFile(`${dirname(target)}/+page.server.ts`);
  }
  for (const match of target.matchAll(/\[(?:\.\.\.)?[^\]/=]+=([a-zA-Z_][a-zA-Z0-9_]*)\]/g)) {
    requireFile(`web/src/params/${match[1]}.ts`);
  }
}
