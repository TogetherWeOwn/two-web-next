import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptBaselines, HONO_SCREENSHOT_DIR, KIT_SCREENSHOT_DIR } from "./kit-visual-accept.mjs";

function scratch() {
  return mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-visual-accept-"));
}

function writeBytes(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("Kit baselines land in the Kit directory, never the Hono one", () => {
  const workspace = scratch();
  const artifact = scratch();
  writeBytes(
    join(artifact, "test-results-kit-parity", "past-desktop-actual.png"),
    "kit-past-bytes",
  );
  const written = [];
  const result = acceptBaselines(artifact, {
    cwd: workspace,
    mkdir: (dir, opts) => {
      written.push(`mkdir:${dir}`);
      return mkdirSync(dir, opts);
    },
    copy: (src, dest) => {
      written.push(`copy:${dest}`);
      return writeBytes(dest, readFileSync(src, "utf8"));
    },
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.accepted, ["past-desktop.png"]);
  assert.ok(
    written.some((line) => line.includes(KIT_SCREENSHOT_DIR)),
    written.join("\n"),
  );
  assert.ok(!written.some((line) => line.includes(HONO_SCREENSHOT_DIR)), written.join("\n"));
  assert.equal(
    readFileSync(join(workspace, KIT_SCREENSHOT_DIR, "past-desktop.png"), "utf8"),
    "kit-past-bytes",
  );
});

test("empty artifact refuses with nothing written", () => {
  const workspace = scratch();
  const artifact = scratch();
  let writes = 0;
  const result = acceptBaselines(artifact, {
    cwd: workspace,
    copy: () => {
      writes += 1;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(writes, 0);
});

test("colliding sources refuse with nothing written", () => {
  const workspace = scratch();
  const artifact = scratch();
  writeBytes(
    join(artifact, "test-results-kit-parity", "a", "past-desktop-actual.png"),
    "bytes-one",
  );
  writeBytes(
    join(artifact, "test-results-kit-parity", "b", "past-desktop-actual.png"),
    "bytes-two",
  );
  let writes = 0;
  const result = acceptBaselines(artifact, {
    cwd: workspace,
    copy: () => {
      writes += 1;
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /refusing/);
  assert.equal(writes, 0);
});

test("Hono suite actuals in the shared artifact are ignored", () => {
  const workspace = scratch();
  const artifact = scratch();
  // Shared e2e-failure artifact layout: the Hono actual must not land in the
  // Kit baselines, even when it flattens to the same destination name.
  writeBytes(
    join(artifact, "test-results-visual", "past", "past-desktop-actual.png"),
    "hono-bytes",
  );
  writeBytes(
    join(artifact, "test-results-kit-parity", "past", "past-desktop-actual.png"),
    "kit-bytes",
  );
  const result = acceptBaselines(artifact, {
    cwd: workspace,
    mkdir: mkdirSync,
    copy: (src, dest) => writeBytes(dest, readFileSync(src, "utf8")),
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.accepted, ["past-desktop.png"]);
  assert.equal(
    readFileSync(join(workspace, KIT_SCREENSHOT_DIR, "past-desktop.png"), "utf8"),
    "kit-bytes",
  );
});

test("Hono baseline names stay attributable to the Hono suite", async () => {
  const visualSpec = readFileSync(
    new URL("../e2e/visual/public-pages.visual.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(visualSpec, /__screenshots-kit__/);
  const visualConfig = readFileSync(
    new URL("../playwright.visual.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(visualConfig, /updateSnapshots: "missing"/);
  assert.match(visualConfig, /__screenshots__/);
});
