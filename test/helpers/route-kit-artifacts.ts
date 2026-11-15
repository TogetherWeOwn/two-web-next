import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";

// Structural prerequisites only: passing this check does not certify migration parity.
export function assertTargetArtifacts(root: string, target: unknown) {
  if (
    typeof target !== "string" ||
    !/^web\/src\/(?:hooks\.server\.ts|routes\/(?:[^\r\n]+\/)?\+(?:page\.svelte|server\.ts))(?![\s\S])/.test(
      target,
    ) ||
    target.split("/").some((part) => part === "." || part === ".." || part === "")
  ) {
    throw new Error("Unresolved or invalid target");
  }

  const isFile = (path: string) => {
    try {
      return lstatSync(join(root, path)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return false;
    }
  };
  const requireFile = (path: string) => {
    if (!isFile(path)) throw new Error(`Missing regular file: ${path}`);
  };

  requireFile(target);
  if (target.endsWith("/+page.svelte")) {
    requireFile(`${dirname(target)}/+page.server.ts`);
  }
  const routeSegments = target.split("/").filter((segment) => !/^\(.*\)$/.test(segment));
  if (routeSegments.some((segment) => /\[(?:\.\.\.)?[\w-]+=[\w-]+\]/.test(segment))) {
    // Matcher registry resolution is outside this structural check's supported subset.
    throw new Error("Named matcher targets are unsupported");
  }
}
