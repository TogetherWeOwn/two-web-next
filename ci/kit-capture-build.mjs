import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Startup sanity check, not qualification evidence: the real request must
// still pass every build/runtime/origin guard and carry the response marker.
// The adapter entry is only a wrapper; inspect the generated SSR modules,
// excluding source maps and client assets that can retain dead source text.
export function requireCaptureArtifact(server) {
  const files = statSync(server).isFile()
    ? [server]
    : readdirSync(server, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
        .map((entry) => join(entry.parentPath, entry.name));
  let instant = false;
  let gate = false;
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    instant ||= code.includes("2098-12-31T20:00:00Z");
    gate ||= code.includes("__TWO_LOCAL_CAPTURE__");
    if (instant && gate) return;
  }
  throw new Error(
    "kit-worker-dev: capture code missing; rebuild with SSR_CAPTURE_FIXTURE=true npm run build --prefix web",
  );
}
