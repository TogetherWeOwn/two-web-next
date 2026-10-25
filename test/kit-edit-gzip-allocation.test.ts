import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const checker = fileURLToPath(new URL("../ci/check-kit-perf.mjs", import.meta.url).href);
const committedBudget = readFileSync(
  fileURLToPath(new URL("../ci/kit-perf-budget.json", import.meta.url).href),
);

// Fixed independently of the ceilings: valid JS whose gzip needs the edit allowance,
// while its raw size fits even the previous raw budget. Never tune it at test time.
function clientCorpus() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let state = 0x12345678;
  let source = 'const corpus = "';
  for (let index = 0; index < 136_730; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    source += alphabet[state & 63];
  }
  return Buffer.from(`${source}";\n`);
}

function checkBudget(budget: Buffer, corpus: Buffer) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-gzip-"));
  try {
    for (const [path, bytes] of [
      ["ci/kit-perf-budget.json", budget],
      ["web/.svelte-kit/cloudflare/_worker.js", "export default {};\n"],
      ["web/.svelte-kit/output/server/chunks/server.js", "export const server = 1;\n"],
      ["web/.svelte-kit/output/client/_app/immutable/client.js", corpus],
      ["web/.svelte-kit/output/client/_app/immutable/style.css", "body{color:red}\n"],
    ] as const) {
      const target = join(root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, bytes);
    }
    const result = spawnSync(process.execPath, [checker, "--root", root, "--format", "json"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("committed Kit edit gzip allocation", () => {
  it("admits the fixed corpus with the committed budget, including every required asset group", () => {
    const corpus = clientCorpus();
    expect(() => new Script(corpus.toString("utf8"))).not.toThrow();
    expect(corpus.length).toBe(136_749);
    expect(corpus.length).toBeLessThan(254_464);
    expect(gzipSync(corpus).length).toBeGreaterThan(102_912);
    expect(gzipSync(corpus).length).toBeLessThanOrEqual(103_168);

    const result = checkBudget(committedBudget, corpus);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.error).toBeUndefined();
    expect(
      report.groups.map(({ id, status }: { id: string; status: string }) => [id, status]),
    ).toEqual([
      ["kit.worker", "pass"],
      ["kit.server.js", "pass"],
      ["kit.client.js", "pass"],
      ["kit.client.css", "pass"],
    ]);
    expect(result.stderr).toContain("every Kit asset fits");
  });

  it("rejects a gzip-only revert to the previous cap, not raw, count or missing evidence", () => {
    const reverted = JSON.parse(committedBudget.toString("utf8"));
    reverted.client.js.maxGzipBytes = 102_912;
    const corpus = clientCorpus();
    const result = checkBudget(Buffer.from(JSON.stringify(reverted)), corpus);
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.error).toBeUndefined();
    expect(
      report.groups.map(({ id, status }: { id: string; status: string }) => [id, status]),
    ).toEqual([
      ["kit.worker", "pass"],
      ["kit.server.js", "pass"],
      ["kit.client.js", "fail"],
      ["kit.client.css", "pass"],
    ]);
    expect(
      result.stderr.split("\n").filter((line) => line.startsWith("kit perf budget: client")),
    ).toEqual([`kit perf budget: client js: gzip ${gzipSync(corpus).length}B over 102912B`]);
  });
});
