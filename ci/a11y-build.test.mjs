import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildAuditWorker } from "./a11y-build.mjs";

test("audit bundle substitutes only the count reader and retains real routes/stats", async () => {
  const scratch = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "a11y-build-test-"),
  );
  try {
    const result = await buildAuditWorker(join(scratch, "worker.mjs"));
    const inputs = Object.keys(result.metafile.inputs);
    assert(inputs.includes("ci/a11y-read-models.ts"));
    assert(
      !inputs.includes("src/counts.ts"),
      "production reader must never connect to shared live_counts/rank_counts",
    );
    for (const path of [
      "src/index.tsx",
      "src/profiles/routes.tsx",
      "src/profiles/stats.ts",
      "src/profiles/pages.tsx",
    ])
      assert(inputs.includes(path), `Real application module retained: ${path}`);
    const runner = await readFile(new URL("./a11y.mjs", import.meta.url), "utf8");
    assert.match(runner, /main: bundled,/);
    const content = runner.indexOf("await assertAuditContent(page, scenario)");
    assert(
      content >= 0 && content < runner.indexOf("new AxeBuilder({ page })"),
      "content validation precedes axe rather than only asserting HTTP 200",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
