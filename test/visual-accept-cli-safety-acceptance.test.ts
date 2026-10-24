// Offline acceptance: visual-accept CLI safety for both suites.
//
// Owned by the acceptance card; the builder builds on this branch and never
// edits this file. Corrections return to the acceptance card.
//
// Contract for ci/visual-accept.mjs (tool "visual-accept") and
// ci/kit-visual-accept.mjs (tool "kit-visual-accept"):
// - Valid invocation: node <script> [--dry-run] [--format json] <artifact-dir>
//   Flags may appear before or after the positional, in any order. Only
//   --dry-run and --format json are valid. --format requires the value "json";
//   a missing value or any other value is UNKNOWN_FLAG. Single-dash,
//   misspelled, or unknown --flags are UNKNOWN_FLAG. Zero positionals is
//   MISSING_ARG. More than one positional is EXTRA_ARGS. A missing path or a
//   file where a directory belongs is ARTIFACT_NOT_FOUND. Flag validation runs
//   before positional checks, which run before artifact reads, which run before
//   any baseline write.
// - Human usage errors (exit 2): stdout empty, stderr carries a usage line plus
//   code=<CODE> and next_action=<concrete hint>. Human refusals (exit 1:
//   COLLISION, STALE_COPY_CONFLICT) carry code + next_action on stderr and name
//   the destination. Success (exit 0, code OK) keeps the compatible "accepted"
//   line. Empty artifacts stay exit 1 with code NO_CANDIDATES and write nothing.
// - --dry-run is read-only: it prints the full plan (destinations, sources,
//   skipped-with-reason, collision verdict), writes nothing (directory snapshot
//   identical, destination directory never created), and exits as the real run
//   would (0 accept, 1 refuse/no-op). Two identical dry runs print byte-identical
//   output.
// - --format json replaces human output: stdout is a single versioned JSON
//   verdict { version: 1, tool, mode: "accept" | "dry-run", ok, code,
//   next_action, destinations: number, sources: number } plus a dry-run plan
//   { destinations: string[], skipped: { item: string, reason: string }[],
//   verdict: string } when mode is dry-run. stderr stays empty. Human output is
//   unchanged when --format is absent.
// - Stable codes: UNKNOWN_FLAG, EXTRA_ARGS, MISSING_ARG, ARTIFACT_NOT_FOUND,
//   COLLISION, STALE_COPY_CONFLICT, OK, NO_CANDIDATES. next_action is non-empty
//   prose naming the fix (artifact path, flag spelling, or reviewed actual).
// - No output (human or JSON, stdout or stderr) prints absolute checkout paths,
//   artifact file bytes, or raw stacks. Diagnostics name destinations by
//   filename only.
//
// Offline only: synthetic text "png" bytes in temp dirs, PATH-only env, no
// network, no database, no staging. Every spawn targets a scratch workspace as
// cwd so the relative e2e destination stays inside scratch.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HONO_SCRIPT = join(REPO_ROOT, "ci", "visual-accept.mjs");
const KIT_SCRIPT = join(REPO_ROOT, "ci", "kit-visual-accept.mjs");
const SCRATCH_BASE =
  process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();

const CODE_RE = /code\s*[=:]\s*["']?([A-Za-z0-9_.-]+)["']?/i;
const NEXT_ACTION_RE = /next_action\s*[=:]\s*(.+)/i;
const STACK_RE = /\n\s+at\s+\S+:\d+:\d+/;
const JSON_STACK_KEY_RE = /"stack"\s*:/;

type RunResult = { status: number | null; stdout: string; stderr: string };

type Suite = {
  name: string;
  script: string;
  tool: string;
  destRel: string;
  snapshotsRel: string;
  actualsRel: string;
  otherActualsRel: string;
  otherSnapshotsRel: string;
  parityActualsRel?: string;
};

const SUITES: Suite[] = [
  {
    name: "Hono",
    script: HONO_SCRIPT,
    tool: "visual-accept",
    destRel: join("e2e", "visual", "__screenshots__"),
    snapshotsRel: join("e2e", "visual", "__screenshots__"),
    actualsRel: join("test-results-visual"),
    otherActualsRel: join("test-results-kit-visual"),
    otherSnapshotsRel: join("e2e", "visual", "__screenshots-kit__"),
  },
  {
    name: "Kit",
    script: KIT_SCRIPT,
    tool: "kit-visual-accept",
    destRel: join("e2e", "visual", "__screenshots-kit__"),
    snapshotsRel: join("e2e", "visual", "__screenshots-kit__"),
    actualsRel: join("test-results-kit-visual"),
    otherActualsRel: join("test-results-visual"),
    otherSnapshotsRel: join("e2e", "visual", "__screenshots__"),
    parityActualsRel: join("test-results-kit-parity"),
  },
];

const rootsToClean: string[] = [];
afterEach(() => {
  while (rootsToClean.length > 0) {
    const root = rootsToClean.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(prefix: string) {
  const root = mkdtempSync(join(SCRATCH_BASE, prefix));
  rootsToClean.push(root);
  const workspace = join(root, "checkout");
  const artifact = join(root, "artifact");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(artifact, { recursive: true });
  return { root, workspace, artifact };
}

function writeBytes(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of [...entries].sort()) {
      const full = join(current, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, relPath);
      else out.push(relPath);
    }
  };
  walk(dir, "");
  return out;
}

type Snapshot = { files: { rel: string; bytes: string; mtime: number }[] };

function snapshotWorkspace(workspace: string): Snapshot {
  const files = listFilesRecursive(workspace).map((rel) => {
    const full = join(workspace, ...rel.split("/"));
    return {
      rel,
      bytes: readFileSync(full, "utf8"),
      mtime: statSync(full).mtimeMs,
    };
  });
  return { files };
}

function runCli(script: string, args: string[], cwd: string): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? "" },
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function extractCode(output: string): string | null {
  return output.match(CODE_RE)?.[1] ?? null;
}

function extractNextAction(output: string): string | null {
  const match = output.match(NEXT_ACTION_RE)?.[1]?.trim();
  if (!match) return null;
  return match.replace(/^["']|["']$/g, "").trim();
}

function expectHumanUsageError(
  result: RunResult,
  workspace: string,
  expectedCode: string,
  context: string,
) {
  expect(result.status, `${context}: exit must be 2`).toBe(2);
  expect(result.stdout, `${context}: human usage errors print no stdout`).toBe("");
  expect(result.stderr, `${context}: stderr must show usage`).toMatch(/usage:/i);
  expect(extractCode(result.stderr), `${context}: stderr must carry code=${expectedCode}`).toBe(
    expectedCode,
  );
  const nextAction = extractNextAction(result.stderr);
  expect(nextAction, `${context}: stderr must carry next_action`).toBeTruthy();
  expect(nextAction!.length, `${context}: next_action must be concrete`).toBeGreaterThan(9);
  expect(result.stderr, `${context}: stderr must not leak the workspace path`).not.toContain(
    workspace,
  );
  expect(result.stderr, `${context}: stderr must not print a stack`).not.toMatch(STACK_RE);
}

function expectNoLeaks(
  output: string,
  workspace: string,
  forbiddenBytes: string[],
  context: string,
) {
  expect(output, `${context}: must not leak the workspace path`).not.toContain(workspace);
  for (const bytes of forbiddenBytes) {
    expect(output, `${context}: must not print file bytes`).not.toContain(bytes);
  }
  expect(output, `${context}: must not print a stack`).not.toMatch(STACK_RE);
}

function parseJsonVerdict(stdout: string, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `${context}: stdout must be a single JSON verdict, got: ${stdout.slice(0, 400)}`,
    );
  }
  expect(typeof parsed, `${context}: verdict must be an object`).toBe("object");
  return parsed as Record<string, unknown>;
}

function expectJsonVerdict(
  result: RunResult,
  suite: Suite,
  expected: { mode: string; ok: boolean; code: string },
  context: string,
) {
  expect(result.stderr, `${context}: JSON mode keeps stderr empty`).toBe("");
  const parsed = parseJsonVerdict(result.stdout, context);
  expect(parsed.version, `${context}: JSON verdict is versioned`).toBe(1);
  expect(parsed.tool, `${context}: JSON verdict carries the stable check id`).toBe(suite.tool);
  expect(parsed.mode, `${context}: JSON verdict names the mode`).toBe(expected.mode);
  expect(parsed.ok, `${context}: JSON ok matches the outcome`).toBe(expected.ok);
  expect(parsed.code, `${context}: JSON verdict carries code=${expected.code}`).toBe(expected.code);
  expect(typeof parsed.next_action, `${context}: JSON verdict carries next_action`).toBe("string");
  expect(
    (parsed.next_action as string).length,
    `${context}: next_action must be concrete`,
  ).toBeGreaterThan(9);
  expect(result.stdout, `${context}: JSON must not leak file bytes`).not.toMatch(STACK_RE);
  expect(result.stdout, `${context}: JSON must not embed a stack field`).not.toMatch(
    JSON_STACK_KEY_RE,
  );
  return parsed;
}

function writeValidArtifact(suite: Suite, artifact: string, tag: string): string {
  const bytes = `VALID-${tag}-BYTES-7F3A`;
  writeBytes(join(artifact, suite.actualsRel, "home", "home-actual.png"), bytes);
  return bytes;
}

function writeCollidingArtifact(
  suite: Suite,
  artifact: string,
  tag: string,
): { bytesA: string; bytesB: string } {
  const bytesA = `COLLIDE-A-${tag}-BYTES-1A2B`;
  const bytesB = `COLLIDE-B-${tag}-BYTES-3C4D`;
  if (suite.name === "Kit") {
    writeBytes(join(artifact, suite.actualsRel, "a", "home-actual.png"), bytesA);
    writeBytes(join(artifact, suite.actualsRel, "b", "home-actual.png"), bytesB);
  } else {
    writeBytes(join(artifact, "a", "home-actual.png"), bytesA);
    writeBytes(join(artifact, "b", "home-actual.png"), bytesB);
  }
  return { bytesA, bytesB };
}

for (const suite of SUITES) {
  describe(`${suite.tool} CLI safety`, () => {
    it("rejects unknown flags before reads or writes (exit 2, code + next_action)", () => {
      const unknownFlags = [
        "--bogus",
        "--frobnicate",
        "--unknown-flag",
        "-x",
        "--accept-all",
        "--DRY-RUN",
        "--dryrun",
        "--dri-run",
      ];
      for (const flag of unknownFlags) {
        const { workspace, artifact } = makeRoot("cli-unknown-");
        const validBytes = writeValidArtifact(suite, artifact, `UNKNOWN-${flag}`);
        const before = snapshotWorkspace(workspace);
        const destDir = join(workspace, suite.destRel);

        const result = runCli(suite.script, [artifact, flag], workspace);

        const context = `${suite.tool} ${flag}`;
        expectHumanUsageError(result, workspace, "UNKNOWN_FLAG", context);
        expectNoLeaks(result.stderr, workspace, [validBytes], context);
        expect(snapshotWorkspace(workspace), `${context}: writes nothing`).toEqual(before);
        expect(existsSync(destDir), `${context}: never creates the destination`).toBe(false);
      }
    });

    it("rejects misspelled --format and bad --format values (exit 2, code + next_action)", () => {
      const cases: string[][] = [
        ["--fromat", "json"],
        ["--formt", "json"],
        ["--format", "xml"],
        ["--format", "yaml"],
        ["--format", ""],
        ["--format"],
      ];
      for (const flagArgs of cases) {
        const { workspace, artifact } = makeRoot("cli-format-");
        const validBytes = writeValidArtifact(suite, artifact, `FORMAT-${flagArgs.join("-")}`);
        const before = snapshotWorkspace(workspace);

        const result = runCli(suite.script, [artifact, ...flagArgs], workspace);

        const context = `${suite.tool} ${flagArgs.join(" ")}`;
        expectHumanUsageError(result, workspace, "UNKNOWN_FLAG", context);
        expectNoLeaks(result.stderr, workspace, [validBytes], context);
        expect(snapshotWorkspace(workspace), `${context}: writes nothing`).toEqual(before);
      }
    });

    it("rejects extra positionals and checks flags before positionals, reads, and collisions", () => {
      // Extra positional with otherwise valid flags.
      {
        const { workspace, artifact } = makeRoot("cli-extra-");
        const validBytes = writeValidArtifact(suite, artifact, "EXTRA");
        const before = snapshotWorkspace(workspace);
        const result = runCli(suite.script, [artifact, "extra-positional"], workspace);
        expectHumanUsageError(result, workspace, "EXTRA_ARGS", `${suite.tool} extra positional`);
        expectNoLeaks(result.stderr, workspace, [validBytes], `${suite.tool} extra positional`);
        expect(snapshotWorkspace(workspace), "extra positional writes nothing").toEqual(before);
      }
      // Unknown flag wins over a missing positional.
      {
        const { workspace } = makeRoot("cli-order-missing-");
        const before = snapshotWorkspace(workspace);
        const result = runCli(suite.script, ["--bogus"], workspace);
        expectHumanUsageError(
          result,
          workspace,
          "UNKNOWN_FLAG",
          `${suite.tool} unknown beats missing`,
        );
        expect(snapshotWorkspace(workspace), "unknown beats missing writes nothing").toEqual(
          before,
        );
      }
      // Unknown flag wins over a missing directory read.
      {
        const { workspace } = makeRoot("cli-order-nodir-");
        const missing = join(workspace, "does-not-exist");
        const before = snapshotWorkspace(workspace);
        const result = runCli(suite.script, [missing, "--bogus"], workspace);
        expectHumanUsageError(
          result,
          workspace,
          "UNKNOWN_FLAG",
          `${suite.tool} unknown beats missing dir`,
        );
        expect(snapshotWorkspace(workspace), "unknown beats missing dir writes nothing").toEqual(
          before,
        );
      }
      // Unknown flag wins over a collision verdict.
      {
        const { workspace, artifact } = makeRoot("cli-order-collision-");
        const { bytesA, bytesB } = writeCollidingArtifact(suite, artifact, "ORDER");
        const before = snapshotWorkspace(workspace);
        const result = runCli(suite.script, [artifact, "--bogus"], workspace);
        expectHumanUsageError(
          result,
          workspace,
          "UNKNOWN_FLAG",
          `${suite.tool} unknown beats collision`,
        );
        expectNoLeaks(
          result.stderr,
          workspace,
          [bytesA, bytesB],
          `${suite.tool} unknown beats collision`,
        );
        expect(snapshotWorkspace(workspace), "unknown beats collision writes nothing").toEqual(
          before,
        );
      }
      // Unknown flag wins over extra-positional detection.
      {
        const { workspace, artifact } = makeRoot("cli-order-extra-");
        writeValidArtifact(suite, artifact, "ORDER-EXTRA");
        const before = snapshotWorkspace(workspace);
        const result = runCli(suite.script, [artifact, "extra", "--bogus"], workspace);
        expectHumanUsageError(
          result,
          workspace,
          "UNKNOWN_FLAG",
          `${suite.tool} unknown beats extra`,
        );
        expect(snapshotWorkspace(workspace), "unknown beats extra writes nothing").toEqual(before);
      }
    });

    it("requires the artifact positional (exit 2, MISSING_ARG + next_action)", () => {
      const cases: string[][] = [[], ["--dry-run"], ["--format", "json"]];
      for (const args of cases) {
        const { workspace } = makeRoot("cli-missing-arg-");
        const before = snapshotWorkspace(workspace);
        const result = runCli(suite.script, args, workspace);
        const context = `${suite.tool} missing arg [${args.join(" ")}]`;
        expectHumanUsageError(result, workspace, "MISSING_ARG", context);
        expect(snapshotWorkspace(workspace), `${context}: writes nothing`).toEqual(before);
      }
    });

    it("refuses a missing artifact directory (exit 2, ARTIFACT_NOT_FOUND, no absolute path)", () => {
      const { workspace } = makeRoot("cli-missing-dir-");
      const missing = join(workspace, "does-not-exist");
      const before = snapshotWorkspace(workspace);
      const result = runCli(suite.script, [missing], workspace);
      expectHumanUsageError(result, workspace, "ARTIFACT_NOT_FOUND", `${suite.tool} missing dir`);
      expect(snapshotWorkspace(workspace), "missing dir writes nothing").toEqual(before);

      // A file where a directory belongs is the same refusal.
      const { workspace: workspace2 } = makeRoot("cli-file-as-dir-");
      const filePath = join(workspace2, "not-a-dir.txt");
      writeBytes(filePath, "i-am-a-file");
      const before2 = snapshotWorkspace(workspace2);
      const fileResult = runCli(suite.script, [filePath], workspace2);
      expectHumanUsageError(
        fileResult,
        workspace2,
        "ARTIFACT_NOT_FOUND",
        `${suite.tool} file as dir`,
      );
      expect(snapshotWorkspace(workspace2), "file as dir writes nothing").toEqual(before2);
    });

    it("refuses colliding destinations (exit 1 preserved, COLLISION + next_action, names dest)", () => {
      const { workspace, artifact } = makeRoot("cli-collision-");
      const { bytesA, bytesB } = writeCollidingArtifact(suite, artifact, "REFUSE");
      const destDir = join(workspace, suite.destRel);
      writeBytes(join(destDir, "sentinel.png"), "SENTINEL-BYTES-9E8F");
      const before = snapshotWorkspace(workspace);

      const result = runCli(suite.script, [artifact], workspace);

      expect(result.status, `${suite.tool} collision stays exit 1`).toBe(1);
      expect(result.stdout, `${suite.tool} collision prints no stdout`).toBe("");
      expect(result.stderr, `${suite.tool} collision names home.png`).toMatch(/home\.png/);
      expect(extractCode(result.stderr), `${suite.tool} collision carries code=COLLISION`).toBe(
        "COLLISION",
      );
      const nextAction = extractNextAction(result.stderr);
      expect(nextAction, `${suite.tool} collision carries next_action`).toBeTruthy();
      expect(nextAction!.length).toBeGreaterThan(9);
      expectNoLeaks(result.stderr, workspace, [bytesA, bytesB], `${suite.tool} collision`);
      expect(snapshotWorkspace(workspace), `${suite.tool} collision writes nothing`).toEqual(
        before,
      );
    });

    it("refuses stale-copy conflicts (exit 1, STALE_COPY_CONFLICT, unrelated actual not applied)", () => {
      const { workspace, artifact } = makeRoot("cli-stale-");
      const destDir = join(workspace, suite.destRel);
      const checkoutBytes = "CHECKOUT-PAGE-BYTES-5A6B";
      const staleBytes = "STALE-ARTIFACT-BYTES-7C8D";
      const reviewedBytes = "REVIEWED-OTHER-BYTES-1E2F";
      writeBytes(join(destDir, "page.png"), checkoutBytes);
      writeBytes(join(artifact, suite.snapshotsRel, "page.png"), staleBytes);
      if (suite.name === "Kit") {
        writeBytes(join(artifact, suite.actualsRel, "other-actual.png"), reviewedBytes);
      } else {
        writeBytes(join(artifact, suite.actualsRel, "other-actual.png"), reviewedBytes);
      }
      const before = snapshotWorkspace(workspace);

      const result = runCli(suite.script, [artifact], workspace);

      expect(result.status, `${suite.tool} stale conflict stays exit 1`).toBe(1);
      expect(result.stdout, `${suite.tool} stale conflict prints no stdout`).toBe("");
      expect(result.stderr, `${suite.tool} stale conflict names page.png`).toMatch(/page\.png/);
      expect(
        extractCode(result.stderr),
        `${suite.tool} stale conflict carries code=STALE_COPY_CONFLICT`,
      ).toBe("STALE_COPY_CONFLICT");
      const nextAction = extractNextAction(result.stderr);
      expect(nextAction, `${suite.tool} stale conflict carries next_action`).toBeTruthy();
      expect(nextAction, `${suite.tool} next_action names the fix`).toMatch(
        /actual|artifact|current/i,
      );
      expectNoLeaks(
        result.stderr,
        workspace,
        [checkoutBytes, staleBytes, reviewedBytes],
        `${suite.tool} stale conflict`,
      );
      expect(snapshotWorkspace(workspace), `${suite.tool} stale conflict writes nothing`).toEqual(
        before,
      );
    });

    it("collapses byte-identical duplicates to one write (exit 0 preserved)", () => {
      const { workspace, artifact } = makeRoot("cli-identical-");
      const sameBytes = "SAME-BYTES-COLLAPSE-4D5E";
      if (suite.name === "Kit") {
        writeBytes(join(artifact, suite.actualsRel, "a", "home-actual.png"), sameBytes);
        writeBytes(join(artifact, suite.actualsRel, "b", "home-actual.png"), sameBytes);
      } else {
        writeBytes(join(artifact, "a", "home-actual.png"), sameBytes);
        writeBytes(join(artifact, "b", "home-actual.png"), sameBytes);
      }

      const result = runCli(suite.script, [artifact], workspace);

      expect(result.status, `${suite.tool} identical duplicates stay exit 0`).toBe(0);
      expect(result.stdout, `${suite.tool} identical duplicates report one baseline`).toMatch(
        /accepted 1\b.*baseline/i,
      );
      const destDir = join(workspace, suite.destRel);
      expect(readFileSync(join(destDir, "home.png"), "utf8")).toBe(sameBytes);
      expectNoLeaks(
        result.stdout + result.stderr,
        workspace,
        [sameBytes],
        `${suite.tool} identical`,
      );
    });

    it("ignores the other suite's outputs (cross-suite boundary preserved)", () => {
      const { workspace, artifact } = makeRoot("cli-cross-suite-");
      const ownBytes = "OWN-SUITE-BYTES-6F7A";
      const otherActualBytes = "OTHER-ACTUAL-BYTES-8B9C";
      const otherBaselineBytes = "OTHER-BASELINE-BYTES-0D1E";
      writeBytes(join(artifact, suite.actualsRel, "home", "home-actual.png"), ownBytes);
      writeBytes(
        join(artifact, suite.otherActualsRel, "past", "past-desktop-actual.png"),
        otherActualBytes,
      );
      writeBytes(join(artifact, suite.otherSnapshotsRel, "past-desktop.png"), otherBaselineBytes);
      if (suite.parityActualsRel) {
        // Kit owns both visual and parity actuals; parity is own-suite here.
        writeBytes(
          join(artifact, suite.parityActualsRel, "past", "parity-actual.png"),
          "PARITY-OWN-BYTES-2F3A",
        );
      }
      if (suite.name === "Hono") {
        // Hono must ignore both Kit actual dirs plus the Kit baseline dir.
        writeBytes(
          join(artifact, "test-results-kit-parity", "past", "parity-actual.png"),
          "KIT-PARITY-IGNORED-4B5C",
        );
      }

      const result = runCli(suite.script, [artifact], workspace);

      expect(result.status, `${suite.tool} cross-suite stays exit 0`).toBe(0);
      const destDir = join(workspace, suite.destRel);
      expect(readFileSync(join(destDir, "home.png"), "utf8")).toBe(ownBytes);
      const written = listFilesRecursive(destDir);
      expect(written, `${suite.tool} writes only own-suite destinations`).not.toContain(
        "past-desktop.png",
      );
      expect(written, `${suite.tool} writes only own-suite destinations`).not.toContain("past.png");
      expectNoLeaks(
        result.stdout + result.stderr,
        workspace,
        [ownBytes, otherActualBytes, otherBaselineBytes],
        `${suite.tool} cross-suite`,
      );
    });

    it("keeps the documented accept invocation (exit 0, writes baselines)", () => {
      const { workspace, artifact } = makeRoot("cli-accept-");
      const validBytes = writeValidArtifact(suite, artifact, "ACCEPT");
      const result = runCli(suite.script, [artifact], workspace);
      expect(result.status, `${suite.tool} documented invocation stays exit 0`).toBe(0);
      expect(result.stdout, `${suite.tool} success keeps the accepted line`).toMatch(
        /accepted 1\b.*baseline/i,
      );
      expect(result.stderr, `${suite.tool} success keeps stderr empty`).toBe("");
      const destDir = join(workspace, suite.destRel);
      expect(readFileSync(join(destDir, "home.png"), "utf8")).toBe(validBytes);
      expectNoLeaks(result.stdout + result.stderr, workspace, [validBytes], `${suite.tool} accept`);
    });

    it("keeps the empty-artifact no-op (exit 1, writes nothing)", () => {
      const { workspace, artifact } = makeRoot("cli-empty-");
      const before = snapshotWorkspace(workspace);
      const destDir = join(workspace, suite.destRel);
      const result = runCli(suite.script, [artifact], workspace);
      expect(result.status, `${suite.tool} empty artifact stays exit 1`).toBe(1);
      expect(snapshotWorkspace(workspace), `${suite.tool} empty writes nothing`).toEqual(before);
      expect(existsSync(destDir), `${suite.tool} empty never creates the destination`).toBe(false);
    });

    it("--dry-run prints the plan and writes nothing (exit 0, deterministic)", () => {
      const orders: string[][] = [
        ["--dry-run", "ARTIFACT"],
        ["ARTIFACT", "--dry-run"],
      ];
      for (const order of orders) {
        const { workspace, artifact } = makeRoot("cli-dryrun-");
        const validBytes = writeValidArtifact(suite, artifact, `DRYRUN-${order.join("-")}`);
        // A stale copy superseded by the actual exercises skipped-with-reason.
        writeBytes(join(artifact, suite.snapshotsRel, "home.png"), "STALE-HOME-BYTES-3E4F");
        const before = snapshotWorkspace(workspace);
        const destDir = join(workspace, suite.destRel);
        const args = order.map((token) => (token === "ARTIFACT" ? artifact : token));

        const first = runCli(suite.script, args, workspace);
        const second = runCli(suite.script, args, workspace);

        const context = `${suite.tool} dry-run [${args.join(" ")}]`;
        expect(first.status, `${context}: exits 0 when the plan would accept`).toBe(0);
        expect(first.stdout, `${context}: names the destination`).toMatch(/home\.png/);
        expect(first.stdout, `${context}: marks itself a dry run`).toMatch(/dry.run|would/i);
        expect(first.stdout, `${context}: reports skipped or dropped with a reason`).toMatch(
          /skip|drop/i,
        );
        expect(first.stdout, `${context}: states the verdict`).toMatch(/accept|verdict|plan/i);
        expect(first.stdout, `${context}: two identical plans are byte-identical`).toBe(
          second.stdout,
        );
        expect(first.stderr, `${context}: keeps stderr empty on a clean plan`).toBe("");
        expectNoLeaks(first.stdout + first.stderr, workspace, [validBytes], context);
        expect(snapshotWorkspace(workspace), `${context}: writes nothing`).toEqual(before);
        expect(existsSync(destDir), `${context}: never creates the destination`).toBe(false);
      }
    });

    it("--dry-run reports collisions and empty artifacts without writing (exit 1)", () => {
      // Colliding plan: would-refuse verdict, names the destination.
      {
        const { workspace, artifact } = makeRoot("cli-dryrun-collision-");
        const { bytesA, bytesB } = writeCollidingArtifact(suite, artifact, "DRYRUN");
        const before = snapshotWorkspace(workspace);
        const result = runCli(suite.script, ["--dry-run", artifact], workspace);
        expect(result.status, `${suite.tool} dry-run collision stays exit 1`).toBe(1);
        expect(result.stdout, `${suite.tool} dry-run collision names home.png`).toMatch(
          /home\.png/,
        );
        expect(result.stdout, `${suite.tool} dry-run collision states refuse`).toMatch(
          /refus|collision|verdict/i,
        );
        expectNoLeaks(
          result.stdout + result.stderr,
          workspace,
          [bytesA, bytesB],
          `${suite.tool} dry-run collision`,
        );
        expect(
          snapshotWorkspace(workspace),
          `${suite.tool} dry-run collision writes nothing`,
        ).toEqual(before);
      }
      // Empty plan: no-op verdict, writes nothing.
      {
        const { workspace, artifact } = makeRoot("cli-dryrun-empty-");
        const before = snapshotWorkspace(workspace);
        const destDir = join(workspace, suite.destRel);
        const result = runCli(suite.script, [artifact, "--dry-run"], workspace);
        expect(result.status, `${suite.tool} dry-run empty stays exit 1`).toBe(1);
        expect(result.stdout, `${contextDryRunEmpty(suite)}`).toMatch(/no|candidate|plan|dry.run/i);
        expect(snapshotWorkspace(workspace), `${suite.tool} dry-run empty writes nothing`).toEqual(
          before,
        );
        expect(existsSync(destDir), `${suite.tool} dry-run empty never creates dest`).toBe(false);
      }
    });

    it("--format json pins a versioned success verdict (writes, counts, code OK)", () => {
      const orders: string[][] = [
        ["--format", "json", "ARTIFACT"],
        ["ARTIFACT", "--format", "json"],
      ];
      for (const order of orders) {
        const { workspace, artifact } = makeRoot("cli-json-ok-");
        const validBytes = writeValidArtifact(suite, artifact, `JSON-${order.join("-")}`);
        const args = order.map((token) => (token === "ARTIFACT" ? artifact : token));
        const result = runCli(suite.script, args, workspace);
        const context = `${suite.tool} json success [${args.join(" ")}]`;
        expect(result.status, `${context}: stays exit 0`).toBe(0);
        const parsed = expectJsonVerdict(
          result,
          suite,
          { mode: "accept", ok: true, code: "OK" },
          context,
        );
        expect(typeof parsed.destinations, `${context}: counts destinations`).toBe("number");
        expect(typeof parsed.sources, `${context}: counts sources`).toBe("number");
        expect(parsed.destinations, `${context}: one destination`).toBe(1);
        expect(result.stdout, `${context}: names the destination`).toMatch(/home\.png/);
        expect(result.stdout, `${context}: no workspace leak`).not.toContain(workspace);
        expect(result.stdout, `${context}: no file-bytes leak`).not.toContain(validBytes);
        // --format changes output only: the baseline is still written.
        const destDir = join(workspace, suite.destRel);
        expect(readFileSync(join(destDir, "home.png"), "utf8")).toBe(validBytes);
      }
    });

    it("--format json pins error verdicts (collision exit 1, unknown exit 2, empty exit 1)", () => {
      // Collision as JSON: exit 1, code COLLISION, counts present, writes nothing.
      {
        const { workspace, artifact } = makeRoot("cli-json-collision-");
        const { bytesA, bytesB } = writeCollidingArtifact(suite, artifact, "JSON");
        const before = snapshotWorkspace(workspace);
        const result = runCli(suite.script, [artifact, "--format", "json"], workspace);
        expect(result.status, `${suite.tool} json collision stays exit 1`).toBe(1);
        const parsed = expectJsonVerdict(
          result,
          suite,
          { mode: "accept", ok: false, code: "COLLISION" },
          `${suite.tool} json collision`,
        );
        expect(typeof parsed.destinations, `${suite.tool} json collision counts`).toBe("number");
        expect(typeof parsed.sources, `${suite.tool} json collision counts`).toBe("number");
        expect(result.stdout, `${suite.tool} json collision names home.png`).toMatch(/home\.png/);
        expect(result.stdout, `${suite.tool} json collision hides bytes`).not.toContain(bytesA);
        expect(result.stdout, `${suite.tool} json collision hides bytes`).not.toContain(bytesB);
        expect(result.stdout, `${suite.tool} json collision hides paths`).not.toContain(workspace);
        expect(snapshotWorkspace(workspace), `${suite.tool} json collision writes nothing`).toEqual(
          before,
        );
      }
      // Unknown flag as JSON: exit 2, code UNKNOWN_FLAG, writes nothing.
      {
        const { workspace, artifact } = makeRoot("cli-json-unknown-");
        const validBytes = writeValidArtifact(suite, artifact, "JSON-UNKNOWN");
        const before = snapshotWorkspace(workspace);
        const result = runCli(suite.script, [artifact, "--bogus", "--format", "json"], workspace);
        expect(result.status, `${suite.tool} json unknown stays exit 2`).toBe(2);
        expectJsonVerdict(
          result,
          suite,
          { mode: "accept", ok: false, code: "UNKNOWN_FLAG" },
          `${suite.tool} json unknown`,
        );
        expect(result.stdout, `${suite.tool} json unknown hides bytes`).not.toContain(validBytes);
        expect(result.stdout, `${suite.tool} json unknown hides paths`).not.toContain(workspace);
        expect(snapshotWorkspace(workspace), `${suite.tool} json unknown writes nothing`).toEqual(
          before,
        );
      }
      // Empty artifact as JSON: exit 1, code NO_CANDIDATES, zero counts.
      {
        const { workspace, artifact } = makeRoot("cli-json-empty-");
        const before = snapshotWorkspace(workspace);
        const result = runCli(suite.script, ["--format", "json", artifact], workspace);
        expect(result.status, `${suite.tool} json empty stays exit 1`).toBe(1);
        const parsed = expectJsonVerdict(
          result,
          suite,
          { mode: "accept", ok: false, code: "NO_CANDIDATES" },
          `${suite.tool} json empty`,
        );
        expect(parsed.destinations, `${suite.tool} json empty counts zero`).toBe(0);
        expect(parsed.sources, `${suite.tool} json empty counts zero`).toBe(0);
        expect(snapshotWorkspace(workspace), `${suite.tool} json empty writes nothing`).toEqual(
          before,
        );
      }
      // Missing directory as JSON: exit 2, code ARTIFACT_NOT_FOUND.
      {
        const { workspace } = makeRoot("cli-json-missing-");
        const missing = join(workspace, "does-not-exist");
        const before = snapshotWorkspace(workspace);
        const result = runCli(suite.script, [missing, "--format", "json"], workspace);
        expect(result.status, `${suite.tool} json missing stays exit 2`).toBe(2);
        expectJsonVerdict(
          result,
          suite,
          { mode: "accept", ok: false, code: "ARTIFACT_NOT_FOUND" },
          `${suite.tool} json missing`,
        );
        expect(result.stdout, `${suite.tool} json missing hides paths`).not.toContain(workspace);
        expect(snapshotWorkspace(workspace), `${suite.tool} json missing writes nothing`).toEqual(
          before,
        );
      }
    });

    it("--dry-run --format json pins a versioned plan (writes nothing, deterministic)", () => {
      const orders: string[][] = [
        ["--dry-run", "--format", "json", "ARTIFACT"],
        ["ARTIFACT", "--dry-run", "--format", "json"],
      ];
      for (const order of orders) {
        const { workspace, artifact } = makeRoot("cli-json-dryrun-");
        const validBytes = writeValidArtifact(suite, artifact, `JSON-DRY-${order.join("-")}`);
        writeBytes(join(artifact, suite.snapshotsRel, "home.png"), "STALE-HOME-BYTES-6A7B");
        const before = snapshotWorkspace(workspace);
        const args = order.map((token) => (token === "ARTIFACT" ? artifact : token));
        const first = runCli(suite.script, args, workspace);
        const second = runCli(suite.script, args, workspace);
        const context = `${suite.tool} json dry-run [${args.join(" ")}]`;
        expect(first.status, `${context}: exits 0 when the plan would accept`).toBe(0);
        const parsed = expectJsonVerdict(
          first,
          suite,
          { mode: "dry-run", ok: true, code: "OK" },
          context,
        );
        expect(typeof parsed.destinations, `${context}: counts destinations`).toBe("number");
        expect(typeof parsed.sources, `${context}: counts sources`).toBe("number");
        const plan = parsed.plan as Record<string, unknown> | undefined;
        expect(plan, `${context}: carries a plan object`).toBeTruthy();
        expect(JSON.stringify(plan), `${context}: plan names home.png`).toMatch(/home\.png/);
        const skipped = (plan?.skipped ?? plan?.dropped) as unknown;
        expect(Array.isArray(skipped), `${context}: plan lists skipped-with-reason`).toBe(true);
        expect((skipped as unknown[]).length, `${context}: stale copy is skipped`).toBeGreaterThan(
          0,
        );
        const verdict = String(plan?.verdict ?? plan?.decision ?? plan?.outcome ?? "");
        expect(verdict, `${context}: plan states the verdict`).toMatch(/accept|verdict|plan/i);
        expect(first.stdout, `${context}: deterministic across runs`).toBe(second.stdout);
        expect(first.stdout, `${context}: no bytes leak`).not.toContain(validBytes);
        expect(first.stdout, `${context}: no path leak`).not.toContain(workspace);
        expect(snapshotWorkspace(workspace), `${context}: writes nothing`).toEqual(before);
      }
    });

    it("never prints absolute paths, file bytes, or stacks (success and refusal)", () => {
      // Success output is clean.
      {
        const { workspace, artifact } = makeRoot("cli-leak-ok-");
        const validBytes = writeValidArtifact(suite, artifact, "LEAK-OK");
        const result = runCli(suite.script, [artifact], workspace);
        expect(result.status).toBe(0);
        expectNoLeaks(
          result.stdout + result.stderr,
          workspace,
          [validBytes],
          `${suite.tool} success output`,
        );
      }
      // Collision output names the dest by filename only.
      {
        const { workspace, artifact } = makeRoot("cli-leak-collision-");
        const { bytesA, bytesB } = writeCollidingArtifact(suite, artifact, "LEAK");
        const result = runCli(suite.script, [artifact], workspace);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/home\.png/);
        expectNoLeaks(
          result.stdout + result.stderr,
          workspace,
          [bytesA, bytesB],
          `${suite.tool} collision output`,
        );
      }
    });
  });
}

function contextDryRunEmpty(suite: Suite): string {
  return `${suite.tool} dry-run empty describes the no-op plan`;
}
