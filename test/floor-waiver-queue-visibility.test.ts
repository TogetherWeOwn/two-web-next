// Acceptance pins for the floor-waiver queue-visibility findings.
//
// Warning 1: merge-queue squash hard-wraps the PR body at ~72 columns, so a
// verbatim long-path `Floor-waiver:` line loses its ` -- reason` tail and the
// verbatim floor-guard parser stops counting it. Warning 2: a `--first-parent`
// commit scan skips waivers arriving via a merged side branch that floor-guard
// (full `mergeBase..HEAD` range) honours, so pr-lint passes while queue
// floor-guard fails. Base-branch trailers must stay ignored in both scans.
//
// These tests are RED first: they fail against the verbatim parser and the
// first-parent scan, and pass once the parsers unfold continuations and the
// scan covers side-branch history while excluding the base tip.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI helper has no declaration file (single-line import: wrapping would detach this from TS7016).
import { parseFloorWaivers } from "../ci/floor-guard.mjs";

const LONG_PATH = "test/staging-workflow-secret-mapping.test.ts";
const LONG_WAIVER = `Floor-waiver: test-deleted ${LONG_PATH} -- moved to docs`;

function scratchDir(prefix: string) {
  return mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      prefix,
    ),
  );
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("floor-waiver queue visibility", () => {
  describe("72-column queue wrap", () => {
    it("counts a verbatim long-path waiver", () => {
      const waivers = parseFloorWaivers(`Subject\n\n${LONG_WAIVER}\n`);
      expect(waivers.get("test-deleted")?.has(LONG_PATH)).toBe(true);
    });

    it("counts a long-path waiver whose reason tail wrapped to the next line", () => {
      // A 72-column squash wrap leaves the path on the first line and the
      // ` -- reason` tail on a continuation line; the queue parser must join
      // them or a verbatim body copy fails floor-guard in the queue.
      const wrapped = `Floor-waiver: test-deleted ${LONG_PATH}\n-- moved to docs`;
      const waivers = parseFloorWaivers(wrapped);
      expect(waivers.get("test-deleted")?.has(LONG_PATH)).toBe(true);
    });

    it("counts a long-path waiver split mid-path by the wrap", () => {
      // A word-wrap can split inside the long path itself; real paths never
      // contain spaces, so the inserted space must not break the waiver.
      const wrapped =
        "Floor-waiver: test-deleted test/staging-workflow-sec\nret-mapping.test.ts -- moved to docs";
      const waivers = parseFloorWaivers(wrapped);
      expect(waivers.get("test-deleted")?.has(LONG_PATH)).toBe(true);
    });
  });

  describe("merged side-branch versus base-branch waivers", () => {
    it("sees a merged side-branch waiver in the floor-guard range", () => {
      const dir = scratchDir("floor-waiver-side-");
      try {
        git(dir, ["init", "-q"]);
        writeFileSync(join(dir, "base.txt"), "base\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-qm", "base"]);
        const baseSha = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["checkout", "-qb", "upstream", baseSha]);
        writeFileSync(join(dir, "side.txt"), "side\n");
        git(dir, ["add", "."]);
        git(dir, [
          "commit",
          "-m",
          "side work",
          "-m",
          "Floor-waiver: test-deleted test/b.test.ts -- moved to docs",
        ]);
        git(dir, ["checkout", "-qb", "pr", baseSha]);
        writeFileSync(join(dir, "pr.txt"), "pr\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-qm", "pr work"]);
        git(dir, ["merge", "--no-ff", "upstream", "-m", "Merge upstream"]);
        const mergeBase = git(dir, ["merge-base", baseSha, "HEAD"]);
        const messages = git(dir, ["log", "--format=%B", `${mergeBase}..HEAD`]);
        expect(parseFloorWaivers(messages).get("test-deleted")?.has("test/b.test.ts")).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("requires a merged side-branch waiver in the pr-lint scan, not just floor-guard", () => {
      // floor-guard honours every commit in `mergeBase..HEAD`, including the
      // second parent of a side-branch merge. A `--first-parent` pr-lint scan
      // skips that parent, so pr-lint passes while queue floor-guard fails.
      // The helper must therefore validate queue-visible waivers over the
      // side-branch-inclusive range (`HEAD --not <base_sha> <base_tip>`,
      // single `--not`), never `--first-parent`.
      const dir = scratchDir("floor-waiver-scan-");
      try {
        git(dir, ["init", "-q"]);
        writeFileSync(join(dir, "base.txt"), "base\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-qm", "base"]);
        const baseSha = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["checkout", "-qb", "upstream", baseSha]);
        writeFileSync(join(dir, "side.txt"), "side\n");
        git(dir, ["add", "."]);
        git(dir, [
          "commit",
          "-m",
          "side work",
          "-m",
          "Floor-waiver: test-deleted test/b.test.ts -- moved to docs",
        ]);
        git(dir, ["checkout", "-qb", "pr", baseSha]);
        writeFileSync(join(dir, "pr.txt"), "pr\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-qm", "pr work"]);
        git(dir, ["merge", "--no-ff", "upstream", "-m", "Merge upstream"]);
        const mergeBase = git(dir, ["merge-base", baseSha, "HEAD"]);
        const guardMessages = git(dir, ["log", "--format=%B", `${mergeBase}..HEAD`]);
        expect(parseFloorWaivers(guardMessages).get("test-deleted")?.has("test/b.test.ts")).toBe(
          true,
        );
        // A first-parent-only scan misses the merged side parent entirely:
        // this divergence is the queue failure the helper must not have.
        const firstParentMessages = git(dir, [
          "log",
          "--first-parent",
          "--format=%B",
          `${mergeBase}..HEAD`,
        ]);
        expect(
          parseFloorWaivers(firstParentMessages).get("test-deleted")?.has("test/b.test.ts") ??
            false,
        ).toBe(false);
        // The helper must therefore implement queue-visible validation over
        // the side-branch-inclusive range instead of `--first-parent`.
        const helperText = readFileSync("ci/pr-lint-output.py", "utf8");
        expect(helperText).toContain("missing_body_waivers");
        expect(helperText).not.toContain("--first-parent");
        // The replacement range keeps the side-branch waiver visible.
        const inclusiveMessages = git(dir, ["log", "--format=%B", "HEAD", "--not", baseSha]);
        expect(
          parseFloorWaivers(inclusiveMessages).get("test-deleted")?.has("test/b.test.ts"),
        ).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("still ignores a waiver already on the base tip after an update-branch merge", () => {
      // The fixed scan (`HEAD --not <base_sha> <base_tip>`, single `--not`)
      // excludes everything reachable from the base tip, so a trailer that
      // landed on the base branch never requires a body copy. A side branch
      // off the same tip must still be required.
      const dir = scratchDir("floor-waiver-base-");
      try {
        git(dir, ["init", "-q"]);
        writeFileSync(join(dir, "base.txt"), "base\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-qm", "base"]);
        const staleBase = git(dir, ["rev-parse", "HEAD"]);
        writeFileSync(join(dir, "earlier.txt"), "earlier\n");
        git(dir, ["add", "."]);
        git(dir, [
          "commit",
          "-m",
          "earlier",
          "-m",
          "Floor-waiver: test-deleted test/earlier.test.ts -- moved in earlier PR",
        ]);
        const baseTip = git(dir, ["rev-parse", "HEAD"]);
        git(dir, ["checkout", "-qb", "pr", staleBase]);
        writeFileSync(join(dir, "pr.txt"), "pr\n");
        git(dir, ["add", "."]);
        git(dir, ["commit", "-qm", "pr work"]);
        git(dir, ["merge", "--no-ff", baseTip, "-m", "Merge main"]);
        const fixedScan = git(dir, ["log", "--format=%B", "HEAD", "--not", staleBase, baseTip]);
        expect(
          parseFloorWaivers(fixedScan).get("test-deleted")?.has("test/earlier.test.ts") ?? false,
        ).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
