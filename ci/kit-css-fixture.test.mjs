// Self-test of the Kit CSS fixture harness against a CONTROLLED fixture that
// lives only in this file. A green run proves the harness builds a disposable
// copy, reads compiled CSS and attributes it to routes. It says nothing about
// any production CSS-retention implementation: a source-owner change must add
// its own consumers and assertions through withKitCssFixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FIXTURE_ROUTE_ID,
  FIXTURE_ROUTE_ROOT,
  applyOverlays,
  overlayPath,
  withKitCssFixture,
} from "./kit-css-fixture.mjs";

test("overlays write, replace, transform and delete only inside the copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "kit-css-overlay-"));
  try {
    await writeFile(join(root, "keep.txt"), "old");
    await writeFile(join(root, "gone.txt"), "x");
    await applyOverlays(root, {
      "new/dir/file.css": "a{b:c}",
      "keep.txt": (existing) => `${existing}+new`,
      "gone.txt": null,
    });
    assert.equal(await readFile(join(root, "new/dir/file.css"), "utf8"), "a{b:c}");
    assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "old+new");
    assert.equal(existsSync(join(root, "gone.txt")), false);
    await assert.rejects(applyOverlays(root, { "missing.txt": null }), /missing file/);
    await assert.rejects(applyOverlays(root, { "k.txt": 5 }), /must be string/);
    assert.throws(() => overlayPath(root, "../escape"), /escapes copy/);
    assert.throws(() => overlayPath(root, "/abs"), /Invalid overlay path/);
    assert.throws(() => overlayPath(root, "web/src/app.css"), /generated or token-checked/);
    assert.throws(() => overlayPath(root, "web/../web/src/ember-theme.css"), /generated or token/);
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    await assert.rejects(applyOverlays(root, { "link/f.txt": "x" }), /symlink in destination/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlays reject terminal symlinks before reading or writing outside the copy", async () => {
  const parent = await mkdtemp(join(tmpdir(), "kit-css-terminal-link-"));
  const root = join(parent, "copy");
  try {
    await mkdir(root);
    const outside = join(parent, "outside.txt");
    await writeFile(outside, "unchanged");
    await symlink(outside, join(root, "link.txt"));
    await assert.rejects(applyOverlays(root, { "link.txt": "changed" }), /symlink in destination/);
    assert.equal(await readFile(outside, "utf8"), "unchanged");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

const R = FIXTURE_ROUTE_ROOT;
const marker = (name) => `--fx-${name}:1`;
const css = (cls, name) => `.${cls}{${marker(name)}}`;
const controlled = {
  [`${R}/+page.svelte`]: `<script>
import { onMount } from 'svelte';
import Transitive from './Transitive.svelte';
import './standalone.css';
let Dyn = $state(null);
onMount(async () => { Dyn = (await import('./Dynamic.svelte')).default; });
</script>
<p class="fx-page fx-standalone">control</p>
<Transitive />
{#if Dyn}<Dyn />{/if}
<style>.fx-page{--fx-page:1}</style>`,
  [`${R}/standalone.css`]: css("fx-standalone", "standalone"),
  [`${R}/Transitive.svelte`]: `<script>import Inner from './Inner.svelte';</script><Inner />`,
  [`${R}/Inner.svelte`]: `<p class="fx-inner">inner</p><style>.fx-inner{--fx-inner:1}</style>`,
  [`${R}/Dynamic.svelte`]: `<p class="fx-dynamic">dyn</p><style>.fx-dynamic{--fx-dynamic:1}</style>`,
  [`${R}/Orphan.svelte`]: `<p class="fx-orphan">orphan</p><style>.fx-orphan{--fx-orphan:1}</style>`,
};
const hash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

test("controlled fixture: real Kit build exposes scoped, standalone, transitive, dynamic and absent CSS", {
  timeout: 15 * 60 * 1000,
}, async () => {
  const appCss = join(process.cwd(), "web/src/app.css");
  const before = await hash(appCss);
  let copy;
  await withKitCssFixture({ overlays: controlled }, (e) => {
    copy = e.root;
    const has = (name, options) => e.routeCssContains(FIXTURE_ROUTE_ID, marker(name), options);
    // Scoped Svelte CSS compiles to a hashed selector, so match the declaration.
    assert.equal(has("page"), true, "scoped page style");
    assert.equal(has("standalone"), true, "standalone .css import");
    assert.equal(has("inner"), true, "transitive scoped style");
    // Dynamic consumer: only reachable through a dynamic edge.
    assert.equal(has("dynamic"), false, "dynamic CSS is not in the static closure");
    assert.equal(has("dynamic", { dynamic: true }), true, "dynamic CSS is in the full closure");
    assert.ok(e.cssContaining(marker("dynamic")).length > 0, "dynamic CSS is emitted");
    // Negative control: an unimported consumer emits nothing anywhere.
    assert.deepEqual(e.cssContaining(marker("orphan")), []);
    assert.equal(
      e.serverCss.some((f) => f.text.includes(marker("orphan"))),
      false,
    );
    // Chunk-level evidence is available for a source-owner's own assertions.
    assert.ok(e.clientCss.length > 0);
    assert.ok(existsSync(join(e.output, "client-route-evidence.json")));
  });
  assert.equal(existsSync(copy), false, "copy is removed");
  assert.equal(existsSync(join(process.cwd(), R)), false, "fixture route never touches source");
  assert.equal(await hash(appCss), before, "tracked source is unmodified");
});
