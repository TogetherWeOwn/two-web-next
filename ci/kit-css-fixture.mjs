// Real SvelteKit/Vite build regression harness for compiled CSS evidence.
//
// Copies the tracked repo into a disposable directory, applies caller overlays
// (new or replaced files, or deletions) to that copy only, runs the real
// `npm run build --prefix web`, and hands the callback the emitted CSS plus the
// Vite manifest and route evidence needed to attribute CSS to routes. The
// source tree is never written. Use it to pin how a CSS consumer (scoped
// Svelte <style>, a standalone .css import, a transitive or dynamic import, or
// a consumer that is never imported) reaches the compiled output.
//
//   await withKitCssFixture({ overlays: { [`${FIXTURE_ROUTE_ROOT}/+page.svelte`]: "..." } },
//     ({ cssContaining, routeCssContains }) => { ... });
//
// Overlay values: string or Buffer (write), null (delete a tracked file), or a
// function (existing Buffer | null) => string | Buffer | null.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { inside, rejectLinkAncestors, validateLinks } from "./kit-browser-fixture.mjs";
import { createEvidence } from "./kit-css-evidence.mjs";

export { createEvidence, routeCssFiles } from "./kit-css-evidence.mjs";

export const FIXTURE_ROUTE_ROOT = "web/src/routes/__css_fixture__";
export const FIXTURE_ROUTE_ID = "/__css_fixture__";
export const CLIENT_OUTPUT = "web/.svelte-kit/output/client";
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

// The build regenerates or drift-checks these (`build-ember-tokens.mjs --check`
// reads every token consumer and the generated theme), so a CSS overlay on them
// would fail the build or be overwritten, not test a consumer. Add new consumers
// as new files instead. Overlaying generators is a known gap, not supported.
export const GENERATED_INPUTS = new Set([
  "web/src/ember-theme.css",
  "web/src/app.css",
  "web/src/error.html",
  "assets/styles.css",
  "assets/theme.css",
  "assets/admin-rsvp-review.css",
  "public/event-theme.css",
  "public/profile-theme.css",
  "public/schedule-theme.css",
]);

/** Repo-relative, forward-slash, non-escaping path or a thrown error. */
export function overlayPath(root, file) {
  if (typeof file !== "string" || file === "" || file.includes("\0") || isAbsolute(file))
    throw new Error(`Invalid overlay path: ${JSON.stringify(file)}`);
  const dest = resolve(root, normalize(file));
  if (!inside(root, dest)) throw new Error(`Overlay path escapes copy: ${file}`);
  const rel = relative(root, dest).split(sep).join("/");
  if (GENERATED_INPUTS.has(rel))
    throw new Error(`Overlay targets a generated or token-checked input: ${rel}`);
  return dest;
}

export async function applyOverlays(root, overlays) {
  for (const [file, value] of Object.entries(overlays)) {
    const dest = overlayPath(root, file);
    await rejectLinkAncestors(root, dest);
    let existing = null;
    try {
      existing = await readFile(dest);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const next = typeof value === "function" ? value(existing) : value;
    if (next === null) {
      if (existing === null) throw new Error(`Overlay deletes a missing file: ${file}`);
      await rm(dest);
    } else if (typeof next === "string" || Buffer.isBuffer(next)) {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, next);
    } else {
      throw new Error(`Overlay value must be string, Buffer, null or a function: ${file}`);
    }
  }
}

async function cssFiles(dir, base) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".css")) continue;
    const full = join(entry.parentPath, entry.name);
    found.push({
      file: relative(base, full).split(sep).join("/"),
      text: await readFile(full, "utf8"),
    });
  }
  return found.sort((a, b) => a.file.localeCompare(b.file, "en"));
}

async function copySource(source, root) {
  const files = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: source })
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    const dest = resolve(root, file);
    if (!inside(root, dest)) throw new Error(`Invalid tracked path: ${file}`);
    await rejectLinkAncestors(root, dirname(dest));
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(source, file), dest, { verbatimSymlinks: true });
  }
  for (const dir of ["node_modules", "web/node_modules"]) {
    const dest = join(root, dir);
    await rejectLinkAncestors(root, dest);
    await cp(join(source, dir), dest, { recursive: true, verbatimSymlinks: true });
  }
  await validateLinks(root);
}

/**
 * Runs the real Kit build in a disposable copy of `source` with `overlays`
 * applied, then calls `callback(evidence)`. The copy is removed afterwards,
 * including on build or callback failure. `buildArgs` exists so a self-test
 * can substitute a stub; production callers leave it unset.
 */
export async function withKitCssFixture(
  { source = process.cwd(), overlays = {}, buildArgs = ["run", "build", "--prefix", "web"] },
  callback,
) {
  source = await realpath(source);
  const scratch = await realpath(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir());
  if (scratch === source || inside(source, scratch))
    throw new Error("Fixture scratch must be outside source");
  const root = await mkdtemp(join(scratch, "kit-css-"));
  try {
    await copySource(source, root);
    await applyOverlays(root, overlays);
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: root,
      XDG_CACHE_HOME: join(root, ".cache"),
      npm_config_cache: join(root, ".npm-cache"),
    };
    execFileSync("npm", buildArgs, {
      cwd: root,
      env,
      stdio: "inherit",
      timeout: BUILD_TIMEOUT_MS,
    });
    const output = join(root, "web/.svelte-kit/output");
    const client = await cssFiles(join(root, CLIENT_OUTPUT), join(root, CLIENT_OUTPUT));
    const server = await cssFiles(join(output, "server"), join(output, "server"));
    const manifest = JSON.parse(await readFile(join(root, CLIENT_OUTPUT, ".vite/manifest.json")));
    const routeEvidence = JSON.parse(await readFile(join(output, "client-route-evidence.json")));
    return await callback(
      createEvidence({ root, output, client, server, manifest, routeEvidence }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
