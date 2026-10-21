// Theme colour guard acceptance: a CI guard fails the build when a raw
// colour literal appears outside the theme files, with an explicit allowlist
// for SVG brand assets. Test-Author-owned: the Builder implements against
// this file and never edits it.
//
// Guard contract for the build:
// - Location: a node-runnable ci script whose name joins "theme" with
//   "colour"/"color" or "guard", or a test/*guard*.test.ts vitest suite. Both
//   spellings count; these acceptance files never count as the guard.
// - Interface: exit 0 on a clean tree; non-zero when a stray exists, printing
//   one finding per offending line with the repo-relative path and line.
// - Roots: at minimum src/**, web/src/**, assets/**, the authored
//   public/*.css, and public/site.webmanifest. Generated bundles and binary
//   assets are skipped.
// - Syntax: 3/4/6/8-digit hex in either case outside comments and HTML
//   entities, plus rgb()/rgba()/hsl()/hsla()/oklch().
// - Allowlist: the theme files (public/theme-tokens.css, web/src/app.css),
//   the throwaway alternate theme, SVG brand assets by pattern (a probe SVG
//   next to shipped brand art must pass), the legacy styles sheets, and the
//   generated leaf bundle.
// - Wiring: a ci script is reachable from `npm run check` (transitively) or
//   a workflow step; a vitest guard rides `npm test`.
//
// These tests fail while the guard is missing and pass only when the guard
// exists, is wired in, passes clean, and catches planted literals. Hermetic:
// local subprocess runs only. No database, no network.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

type Guard = { kind: "ci"; path: string } | { kind: "vitest"; path: string };

const OWN_FILES = new Set([
  "test/theme-colour-guard-acceptance.test.ts",
  "test/theme-one-file-swap-acceptance.test.ts",
]);

function discoverGuard(): Guard | null {
  const ciEntries = readdirSync(join(repoRoot, "ci")).map(String).sort();
  for (const entry of ciEntries) {
    if (!entry.endsWith(".mjs")) {
      continue;
    }
    if (/theme/i.test(entry) && (/colo(u)?r/i.test(entry) || /guard/i.test(entry))) {
      return { kind: "ci", path: join(repoRoot, "ci", entry) };
    }
  }
  const testEntries = readdirSync(join(repoRoot, "test")).map(String).sort();
  for (const entry of testEntries) {
    if (!entry.endsWith(".test.ts")) {
      continue;
    }
    if (OWN_FILES.has(`test/${entry}`)) {
      continue;
    }
    if (/theme/i.test(entry) && (/colo(u)?r/i.test(entry) || /guard/i.test(entry))) {
      return { kind: "vitest", path: `test/${entry}` };
    }
  }
  return null;
}

/** Every package.json script body reachable from `npm run check`. */
function checkChainBlob(): string {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const seen = new Set<string>();
  const queue = ["check"];
  let blob = "";
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const body = pkg.scripts[name];
    if (body === undefined) {
      continue;
    }
    blob += `\n${body}`;
    for (const match of body.matchAll(/npm run ([\w:.-]+)/g)) {
      const next = match[1];
      if (next !== undefined) {
        queue.push(next);
      }
    }
  }
  return blob;
}

function workflowMentions(text: string): boolean {
  const entries = readdirSync(join(repoRoot, ".github/workflows")).map(String);
  return entries.some(
    (entry) => entry.endsWith(".yml") && read(`.github/workflows/${entry}`).includes(text),
  );
}

function runGuard(guard: Guard): { status: number | null; output: string } {
  if (guard.kind === "ci") {
    const result = spawnSync(process.execPath, [guard.path], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  }
  const vitestBin = join(repoRoot, "node_modules", ".bin", "vitest");
  if (!existsSync(vitestBin)) {
    throw new Error(`vitest binary missing at ${vitestBin}; cannot run the guard`);
  }
  const result = spawnSync(vitestBin, ["run", guard.path], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 110_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function writeProbe(rel: string, content: string): void {
  const full = join(repoRoot, rel);
  rmSync(full, { force: true });
  writeFileSync(full, content);
}

function removeProbe(rel: string): void {
  rmSync(join(repoRoot, rel), { force: true });
}

const HEX_PROBE = "src/__theme_guard_probe__.tsx";
const HEX_PROBE_BODY = `// Guard probe: planted stray colours. Removed by the test in a finally.
export const probeSolid = "#DEAD00";
export const probeOverlay = "#DEAD00CC";
export const probeText = "#abc";
export const probeShadow = "rgb(255, 0, 0)";
export const probeTint = "rgba(0, 255, 0, 0.5)";
export const probeTone = "hsl(120, 100%, 50%)";
export const probeWash = "hsla(240, 100%, 50%, 0.3)";
export const probeGlow = "oklch(0.7 0.2 30)";
`;
const PLANTED_LINES = 8;

const FP_PROBE = "src/__theme_guard_probe_fp__.ts";
const FP_PROBE_BODY = `// Guard probe: PR references and entities are not colours. See #1452 and #808.
export const entity = "&#039;";
export const anchor = "#main-content";
`;

function brandArtDir(): string {
  const publicFiles = readdirSync(join(repoRoot, "public"), { recursive: true }).map(String);
  const art = publicFiles.find(
    (entry) => entry.endsWith("lockup-horizontal.svg") || entry.endsWith("logo.svg"),
  );
  if (art === undefined) {
    return "public";
  }
  const slash = art.lastIndexOf("/");
  return slash < 0 ? "public" : `public/${art.slice(0, slash)}`;
}

const SVG_PROBE_BODY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#DEAD00"/></svg>
`;

describe("guard presence", () => {
  it("exists at a conventional path", () => {
    expect(
      discoverGuard(),
      "expected a ci theme colour script or a theme guard suite (see the contract header)",
    ).not.toBeNull();
  });

  it("is wired into the required gates", () => {
    const guard = discoverGuard();
    expect(guard).not.toBeNull();
    if (guard === null) {
      return;
    }
    if (guard.kind === "vitest") {
      expect(checkChainBlob()).toContain("vitest");
      return;
    }
    const base = guard.path.slice(guard.path.lastIndexOf("/") + 1).replace(/\.mjs$/, "");
    const wired = checkChainBlob().includes(base) || workflowMentions(base);
    expect(wired, `expected ${base} to be reachable from npm run check or a workflow`).toBe(true);
  });
});

describe("guard behavior", () => {
  it("passes on the clean tree", { timeout: 120_000 }, () => {
    const guard = discoverGuard();
    expect(guard).not.toBeNull();
    if (guard === null) {
      return;
    }
    const result = runGuard(guard);
    expect(result.status, result.output).toBe(0);
  });

  it("fails on planted literals with one finding per line", { timeout: 120_000 }, () => {
    const guard = discoverGuard();
    expect(guard).not.toBeNull();
    if (guard === null) {
      return;
    }
    writeProbe(HEX_PROBE, HEX_PROBE_BODY);
    try {
      const result = runGuard(guard);
      expect(result.status, result.output).not.toBe(0);
      expect(result.status, result.output).not.toBeNull();
      expect(result.output).toContain("__theme_guard_probe__");
      const mentions = result.output.split("__theme_guard_probe__").length - 1;
      expect(mentions, result.output).toBeGreaterThanOrEqual(PLANTED_LINES);
    } finally {
      removeProbe(HEX_PROBE);
    }
  });

  it("allows SVG brand assets by pattern", { timeout: 120_000 }, () => {
    const guard = discoverGuard();
    expect(guard).not.toBeNull();
    if (guard === null) {
      return;
    }
    const probe = `${brandArtDir()}/__theme_guard_probe__.svg`;
    writeProbe(probe, SVG_PROBE_BODY);
    try {
      const result = runGuard(guard);
      expect(result.status, result.output).toBe(0);
    } finally {
      removeProbe(probe);
    }
  });

  it("ignores PR references and entities", { timeout: 120_000 }, () => {
    const guard = discoverGuard();
    expect(guard).not.toBeNull();
    if (guard === null) {
      return;
    }
    writeProbe(FP_PROBE, FP_PROBE_BODY);
    try {
      const result = runGuard(guard);
      expect(result.status, result.output).toBe(0);
    } finally {
      removeProbe(FP_PROBE);
    }
  });
});

describe("guard wiring controls", () => {
  it("keeps the unit suite inside npm run check", () => {
    expect(checkChainBlob()).toContain("vitest");
  });
});
