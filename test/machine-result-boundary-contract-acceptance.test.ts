// Test Author owned. Execute the existing offline contract CLI with real
// schemas/SDK and controlled guides. No implementation inspection or writes.
// Detect a checker that certifies the old ambiguous body limit, omits typed
// duplication/escaping, or claims arbitrary JSON-RPC IDs fit a fixed envelope.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../", import.meta.url));
const checkedInGuide = readFileSync(join(repo, "docs/machine-interface.md"), "utf8");
// Replace the whole limits section with the original insufficient promise.
// This is a consuming-checker test, not a grep for preferred prose in the guide.
const legacyClaim =
  "Every JSON body fits 32 KiB: long descriptions trim with a `…` marker, rows are never dropped.";
const legacyGuide = checkedInGuide.replace(
  /## Limits[\s\S]*?(?=\n## )/,
  `## Limits\n\n- Collections cap at 20 rows per response (per_page clamps to 20); past-the-end pages clamp to the last page.\n- ${legacyClaim}\n- Events are published-only: drafts and cancelled rows read as not found.\n- Unknown counts read as null, never 0 (going_count, going_occupancy, member_count, online_count).\n`,
);
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (
    name.includes("DATABASE_URL") ||
    name.startsWith("PG") ||
    name.startsWith("CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_")
  )
    delete env[name];
}

type Receipt = {
  version: number;
  verdict: string;
  error_code: string | null;
  next_action: string | null;
};

describe("machine contract: precise result boundary and JSON receipt (offline)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "result-boundary-contract-"),
    );
    // Copy dependencies without inspecting production source. Future helper
    // extraction remains possible; the test owns only the observable contract.
    cpSync(join(repo, "ci"), join(root, "ci"), { recursive: true });
    cpSync(join(repo, "src"), join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs"));
    for (const file of ["package.json", "tsconfig.json"])
      copyFileSync(join(repo, file), join(root, file));
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function run(guide: string, json = false) {
    writeFileSync(join(root, "docs/machine-interface.md"), guide);
    const args = [
      "--import",
      "tsx",
      "ci/check-machine-contract.mjs",
      ...(json ? ["--format", "json"] : []),
    ];
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error, "real checker executes without DB/network credentials").toBeUndefined();
    expect(result.signal).toBeNull();
    return result;
  }

  function receipt(stdout: string): Receipt {
    expect(
      () => JSON.parse(stdout),
      "JSON mode emits one JSON document, not prose or mixed logs",
    ).not.toThrow();
    const parsed = JSON.parse(stdout) as Receipt;
    expect(parsed.version).toBe(1);
    expect(Object.hasOwn(parsed, "error_code")).toBe(true);
    expect(Object.hasOwn(parsed, "next_action")).toBe(true);
    return parsed;
  }

  it("CONTROL: retains the existing no-argument contract check with real schemas", () => {
    const result = run(checkedInGuide);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("machine-contract check passed:");
  });

  it("the checked-in canonical guide passes the same precise-boundary check", () => {
    // The checked-in guide is consumed by the CLI, not tested with a source
    // grep. Adversarial controls below prove the CLI actually enforces it.
    const result = run(checkedInGuide, true);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(receipt(result.stdout)).toMatchObject({
      version: 1,
      verdict: "pass",
      error_code: null,
      next_action: null,
    });
  });

  it.each([
    ["legacy unqualified body promise", legacyGuide],
    [
      "DTO-only measurement",
      `${checkedInGuide}\nFor event responses, the 32 KiB budget measures only the DTO before the MCP wrapper; structuredContent duplication and text escaping are not counted.\n`,
    ],
    [
      "twice-DTO estimate",
      `${checkedInGuide}\nFor event responses, estimate the result size as exactly twice the DTO JSON length; do not serialize the text string wrapper.\n`,
    ],
    [
      "unbounded transport promise",
      `${checkedInGuide}\nThe entire JSON-RPC HTTP response, including arbitrary client request IDs, always fits the same fixed 32 KiB cap.\n`,
    ],
  ])("refuses a contradictory %s instead of certifying the wrong boundary", (_name, guide) => {
    const result = run(guide);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("machine-contract check FAILED:");
    expect(result.stdout).not.toContain("machine-contract check passed:");
  });

  it("JSON receipt is deterministic across independent successful runs", () => {
    const first = run(checkedInGuide, true);
    const second = run(checkedInGuide, true);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    const parsed = receipt(first.stdout);
    expect(parsed).toMatchObject({
      version: 1,
      verdict: "pass",
      error_code: null,
      next_action: null,
    });
    expect(JSON.parse(second.stdout)).toEqual(parsed);
    expect(Buffer.byteLength(first.stdout, "utf8")).toBeLessThanOrEqual(32_768);
  });

  it("JSON refusal is explicit and actionable, with nonzero exit and no false success", () => {
    const result = run("\n", true);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const parsed = receipt(result.stdout);
    expect(parsed.verdict).toBe("fail");
    expect(typeof parsed.error_code).toBe("string");
    expect(parsed.error_code!.length).toBeGreaterThan(0);
    expect(typeof parsed.next_action).toBe("string");
    expect(parsed.next_action!.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(32_768);
  });
});
