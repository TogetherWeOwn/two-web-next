import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Workers runtime throws on fetch(..., { redirect: "error" }) ("won't be implemented"), so a
// Worker-side call written that way fails on every request while unit tests with stubbed fetch pass.
// Node-run scripts (bin/, ci/) may keep "error"; code that ships in a Worker must use "manual".
const WORKER_ROOTS = ["src", "tail"];
const ERROR_MODE = /redirect\s*:\s*["']error["']/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe("Worker fetch redirect mode", () => {
  it('never uses redirect: "error" in code that runs on Workers', () => {
    const offenders = WORKER_ROOTS.flatMap(files).filter((f) =>
      ERROR_MODE.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
