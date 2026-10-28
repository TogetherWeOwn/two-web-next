// Pins what the acceptance suite leaves open: paraphrased wrong claims about
// the measured boundary are refused, and the JSON receipt stays within 32 KiB
// however many assertions fail. Executes the real offline checker.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
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
const guide = readFileSync(join(repo, "docs/machine-interface.md"), "utf8");
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.includes("DATABASE_URL") || name.startsWith("PG")) delete env[name];
}

describe("machine contract: paraphrases and receipt bound (offline)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "receipt-bound-contract-"),
    );
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

  function run(text: string) {
    writeFileSync(join(root, "docs/machine-interface.md"), text);
    return spawnSync(
      process.execPath,
      ["--import", "tsx", "ci/check-machine-contract.mjs", "--format", "json"],
      { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    );
  }

  const claims = [
    "The check measures the DTO only.",
    "Estimate the result as twice DTO length.",
    "The entire HTTP response is capped at 32 KiB.",
    "Every response is limited to 32768 bytes.",
    "Every JSON body fits 32 KB.",
    "Responses are capped at 32 kB, including the HTTP framing.",
    "The JSON-RPC reply fits the budget.",
    "Estimate the result as 2x the text length.",
    "Event results are unbounded.",
    "Responses occupy 33 KB.",
    "Responses occupy 33 bytes.",
    "The result occupies 32768.",
    "The result is 2x the text.",
    "The result is 2× the text.",
    "Events are unbounded.",
    "The event is unlimited.",
  ];

  it.each(claims)("refuses the paraphrase %j appended after the Limits", (claim) => {
    const result = run(`${guide}\n${claim}\n`);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.failures).toContain(
      `guide states a size or measurement claim outside the canonical Limits: "${claim}"`,
    );
  });

  it.each(claims)("refuses the paraphrase %j added inside the Limits", (claim) => {
    const result = run(guide.replace("## Limits\n", `## Limits\n\n- ${claim}\n`));
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).verdict).toBe("fail");
  });

  it.each(
    [
      "Event results",
      "HTTP responses",
      "JSON-RPC replies",
      "DTOs",
      "Payloads",
      "JSON bodies",
    ].flatMap((subject) =>
      ["are unbounded", "are unlimited", "have no size bound", "have twice the length"].map(
        (predicate) => `${subject} ${predicate}.`,
      ),
    ),
  )("refuses a subject/measurement claim %j", (claim) => {
    const result = run(`${guide}\n${claim}\n`);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).verdict).toBe("fail");
  });

  it.each([
    "Wait and try again within a minute.",
    "The structuredContent object matches the advertised schema.",
    "Successful reads are counted in operational dashboards.",
    "DTO fields are documented by the schema.",
    "The response arrives within a minute.",
    "See the KB article for details.",
    "The response fits the advertised schema.",
    "The text fits the schema.",
    "DTO bytes are documented.",
  ])("allows unrelated prose %j", (prose) => {
    const result = run(`${guide}\n${prose}\n`);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("pass");
  });

  it.each([
    ["CRLF line endings", guide.replace(/\n/g, "\r\n")],
    ["trailing heading space", guide.replace("## Limits\n", "## Limits \n")],
    ["trailing heading tab", guide.replace("## Limits\n", "## Limits\t\n")],
  ])("accepts unchanged Markdown with %s", (_name, text) => {
    const result = run(text);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).verdict).toBe("pass");
  });

  it.each([
    ["the result boundary bullet", /- Every event result fits[\s\S]*?answers `unavailable`\.\n/],
    ["the JSON-RPC envelope bullet", /- The JSON-RPC envelope[\s\S]*?not bounded by it\.\n/],
  ])("refuses a guide missing %s", (_name, pattern) => {
    expect(guide).toMatch(pattern);
    const result = run(guide.replace(pattern, ""));
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).verdict).toBe("fail");
  });

  it("caps the failure list and keeps the receipt within 32768 bytes", () => {
    const flood = Array.from({ length: 3000 }, (_, i) => `Item ${i} is twice DTO length.`).join(
      "\n",
    );
    const result = run(`${guide}\n${flood}\n`);
    expect(result.status).toBe(1);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.failure_count).toBeGreaterThanOrEqual(3000);
    expect(receipt.failures.length).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(32_768);
  });
});
