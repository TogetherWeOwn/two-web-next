import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { KIT_CLIENT_DIR, KIT_SERVER_DIR, KIT_WORKER_PATH } from "./bundle-inventory.mjs";
import { collectInventory, exitStatus } from "./kit-budget-diagnostic.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    [KIT_WORKER_PATH]: "export default {};",
    [`${KIT_SERVER_DIR}/chunks/events.js`]: "export const title = '夜';",
    [`${KIT_CLIENT_DIR}/immutable/nodes/0.js`]: "export const value = 1;",
    [`${KIT_CLIENT_DIR}/immutable/nodes/0.js.map`]: JSON.stringify({
      sources: ["EventDetail.svelte"],
      sourcesContent: ["private map content"],
    }),
    "web/.svelte-kit/output/client/.vite/manifest.json": "{}",
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  return { root, files };
}

test("inventory retains exact per-file bytes, gzip, hash and module/manifest identity", (t) => {
  const { root, files } = fixture(t);
  const rows = collectInventory(root);
  assert.equal(rows.length, Object.keys(files).length);
  for (const row of rows) {
    const bytes = Buffer.from(files[row.path]);
    assert.equal(row.raw, bytes.length);
    assert.equal(row.sha256, createHash("sha256").update(bytes).digest("hex"));
    if (row.path.endsWith(".js")) assert.equal(row.gzip, gzipSync(bytes).length);
  }
  assert.deepEqual(rows.find((row) => row.path.endsWith(".map")).sources, ["EventDetail.svelte"]);
  assert(!JSON.stringify(rows).includes("private map content"));
});

test("missing and symlinked inventories fail rather than omit evidence", (t) => {
  const { root } = fixture(t);
  fs.unlinkSync(path.join(root, KIT_WORKER_PATH));
  assert.throws(() => collectInventory(root), /ENOENT/);
  fs.symlinkSync(
    path.join(root, KIT_SERVER_DIR, "chunks/events.js"),
    path.join(root, KIT_WORKER_PATH),
  );
  assert.throws(() => collectInventory(root), /unexpected output symlink/);
});

test("only opt-in dispatch selects diagnosis and ordinary CI retains its own gates", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const block = (id) => workflow.split(`\n  ${id}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
  assert.match(
    block("kit-budget-diagnostic"),
    /if: github.event_name == 'workflow_dispatch' && inputs.kit_budget_diagnostic/,
  );
  assert.match(block("scope"), /if: \$\{\{ !inputs.kit_budget_diagnostic \}\}/);
  for (const id of ["check", "node22-compat", "ci-ok"]) {
    assert.match(block(id), /if: \$\{\{ !cancelled\(\) && !inputs.kit_budget_diagnostic \}\}/);
  }
  for (const sha of [
    "10099ce45e7f6a4f1ade945bbbca85278982109e",
    "97fdc74e2fd8053420c0420d6db15c8c2d12b7cc",
  ]) {
    assert(block("kit-budget-diagnostic").includes(`ref: ${sha}`));
  }
  assert.match(workflow, /inputs.kit_budget_diagnostic && '-kit-budget-diagnostic' \|\| ''/);
  assert.match(block("kit-budget-diagnostic"), /if-no-files-found: error/);
});

test("canonical failure is preserved and signal/spawn failure cannot look green", () => {
  assert.equal(exitStatus({ status: 0 }), 0);
  assert.equal(exitStatus({ status: 1 }), 1);
  assert.equal(exitStatus({ status: 2 }), 2);
  assert.equal(exitStatus({ status: null, signal: "SIGTERM" }), 2);
  assert.equal(exitStatus({ status: null, error: new Error("spawn failed") }), 2);
});
