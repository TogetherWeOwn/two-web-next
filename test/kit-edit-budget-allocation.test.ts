import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL as NodeURL, fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
// Standalone CI tooling has no declaration file; require() keeps the root
// typecheck clean without a suppression comment.
const { loadKitBudget } = require("../ci/budget-fragments.mjs");

const scriptPath = fileURLToPath(new NodeURL("../ci/check-kit-perf.mjs", import.meta.url));
// The shipping plan is the aggregation of ci/budgets/kit/*.json (one unit
// per fragment); serialize it here so fixtures can copy it into a scratch
// root as a legacy single file, exactly as ci/check-kit-perf.test.mjs does.
const committedBudget = Buffer.from(
  JSON.stringify(loadKitBudget(fileURLToPath(new NodeURL("../", import.meta.url)))),
);
const budget = JSON.parse(committedBudget.toString("utf8"));

function allocationResult(clientRawBytes: number) {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-edit-allocation-"),
  );
  try {
    const files = [
      ["ci/kit-perf-budget.json", committedBudget],
      ["web/.svelte-kit/cloudflare/_worker.js", "export default {};\n"],
      ["web/.svelte-kit/output/server/index.js", "export {};\n"],
      // ASCII spaces are valid, deterministic, compressible JS: this proves raw
      // allocation only, not the real feature's gzip size or hashed chunk layout.
      ["web/.svelte-kit/output/client/_app/immutable/client.js", " ".repeat(clientRawBytes)],
      ["web/.svelte-kit/output/client/_app/immutable/client.css", "a{}\n"],
    ] as const;
    for (const [relative, bytes] of files) {
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    const result = spawnSync(process.execPath, [scriptPath, "--root", root], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return {
      code: result.status,
      logs: result.stdout.split(/\r?\n/).filter(Boolean),
      errors: result.stderr.split(/\r?\n/).filter(Boolean),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("committed Kit allocation admits the edit feature's fixed 257165 raw client JS bytes", () => {
  // Independently measured feature composition, deliberately NOT ceiling-derived.
  // Both original-main 254464 and one 512B step below (257024) must reject it.
  const result = allocationResult(257_165);
  expect(result.code, result.errors.join("\n")).toBe(0);
  expect(result.errors).toEqual([]);
  expect(result.logs).toContainEqual(
    expect.stringMatching(/^ok client js: 1\/\d+ files, raw 257165\//),
  );
  expect(result.logs).toContain("kit perf budget: every Kit asset fits.");
});

it("committed Kit allocation rejects raw client JS at max + 1 with a byte-only breach", () => {
  const maximum = budget.client.js.maxRawBytes;
  const result = allocationResult(maximum + 1);
  expect(result.code, result.errors.join("\n")).toBe(1);
  expect(result.errors).toEqual([
    `kit perf budget: client js: raw ${maximum + 1}B over ${maximum}B`,
  ]);
  // Every other required group was present, nonempty and within its unchanged
  // committed limits; neither missing evidence, gzip nor file count supplies red.
  for (const group of ["_worker.js", "server js", "client css"]) {
    expect(
      result.logs.some((line) => line.startsWith(`ok ${group}:`)),
      group,
    ).toBe(true);
  }
  expect(result.logs).not.toContain("kit perf budget: every Kit asset fits.");
});
