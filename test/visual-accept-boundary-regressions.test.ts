// Executor-owned regression probes; the independent acceptance suites stay unchanged.
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const suites = [
  {
    name: "Hono",
    script: "visual-accept",
    actuals: "test-results-visual",
    snapshots: "__screenshots__",
  },
  {
    name: "Kit",
    script: "kit-visual-accept",
    actuals: "test-results-kit-visual",
    snapshots: "__screenshots-kit__",
  },
];
const roots: string[] = [];
const hostile = "bad-\u001b[31m\n\t\r\u007f";
const invocations = [["--dry-run", "--format", "json"], ["--dry-run"], ["--format", "json"], []];

function write(path: string, bytes: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
}

function fixture(suite: (typeof suites)[number]) {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "visual-boundary-regression-"),
  );
  roots.push(root);
  const artifact = join(root, "artifact");
  const dest = join(root, "e2e/visual", suite.snapshots);
  const actuals = join(artifact, suite.actuals);
  const copies = join(artifact, "e2e/visual", suite.snapshots);
  write(join(actuals, "a-page-actual.png"), "reviewed-source-bytes");
  write(join(dest, "a-page.png"), "checkout-canary");
  write(join(root, "outside-canary"), "outside-bytes");
  return { root, artifact, actuals, copies, dest };
}

function tree(root: string): unknown {
  const st = lstatSync(root);
  if (st.isDirectory()) {
    return Object.fromEntries(
      readdirSync(root)
        .sort()
        .map((name) => [name, tree(join(root, name))]),
    );
  }
  return {
    mode: st.mode,
    mtime: st.mtimeMs,
    bytes: st.isFile() ? readFileSync(root).toString("hex") : null,
  };
}

function run(suite: (typeof suites)[number], f: ReturnType<typeof fixture>, flags: string[]) {
  const result = spawnSync(
    process.execPath,
    [resolve(`ci/${suite.script}.mjs`), f.artifact, ...flags],
    {
      cwd: f.root,
      encoding: "utf8",
      timeout: 3_000,
    },
  );
  expect(result.error, "CLI must settle without a FIFO reader/writer").toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function safeStrings(value: unknown) {
  if (typeof value === "string") {
    expect(value).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(value).not.toMatch(/^(?:\/|[a-z]:)|(?:^|\/)\.\.(?:\/|$)/i);
  } else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) safeStrings(child);
  }
}

function safeOutput(result: ReturnType<typeof run>, root: string, json: boolean) {
  const output = result.stdout + result.stderr;
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16_384);
  expect(output).not.toContain(root);
  expect(output).not.toContain("reviewed-source-bytes");
  expect(output).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
  // Only formatter-owned line breaks may remain in human output.
  expect(output).not.toContain("[31m\n");
  if (json) {
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    safeStrings(report);
    expect(report.next_action.length).toBeGreaterThan(0);
    return report;
  }
  if (result.status !== 0 || output.includes("dry run: nothing written")) {
    expect(output).toMatch(/code=\w+\nnext_action=.+\n$/);
  }
  return null;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const suite of suites) {
  describe(`${suite.name} boundary review regressions`, () => {
    for (const scenario of ["writes", "skipped", "collision", "stale copy"]) {
      for (const flags of invocations) {
        it(`${scenario}: sanitizes regular filenames in ${flags.join(" ") || "human apply"}`, () => {
          const f = fixture(suite);
          const name = `${hostile}.png`;
          const actualName = `${hostile}-actual.png`;
          if (scenario === "stale copy") {
            write(join(f.copies, name), "old-copy");
            write(join(f.dest, name), "new-checkout");
          } else {
            write(join(f.actuals, "one", actualName), "actual");
            if (scenario === "collision") write(join(f.actuals, "two", actualName), "different");
            if (scenario === "skipped") {
              write(join(f.actuals, "two", actualName), "actual");
              write(join(f.copies, name), "stale");
              write(join(f.dest, name), "actual");
            }
          }
          const before = tree(f.root);
          const result = run(suite, f, flags);
          const refusal = scenario === "collision" || scenario === "stale copy";
          expect(result.status, result.stderr).toBe(refusal ? 1 : 0);
          const report = safeOutput(result, f.root, flags.includes("json"));
          if (report) {
            expect(report.code).toBe(
              scenario === "collision"
                ? "COLLISION"
                : scenario === "stale copy"
                  ? "STALE_COPY_CONFLICT"
                  : "OK",
            );
          }
          if (refusal || flags.includes("--dry-run")) expect(tree(f.root)).toEqual(before);
          else if (scenario === "writes")
            expect(readFileSync(join(f.dest, name), "utf8")).toBe("actual");
        });
      }
    }

    for (const flags of invocations) {
      it(`bounds the assembled UTF-8 report in ${flags.join(" ") || "human apply"}`, () => {
        const f = fixture(suite);
        // Multiple dry-run lists share one byte budget. Multibyte names and
        // JSON escaping exercise bytes, not just a character-count approximation.
        const longDir = Array(5).fill("é".repeat(100));
        for (let i = 0; i < 25; i++) {
          const name = `${i.toString().padStart(2, "0")}-${'"'.repeat(70)}${"é".repeat(70)}`;
          write(join(f.actuals, ...longDir, `${name}-actual.png`), "actual");
          write(join(f.copies, `${name}.png`), "stale");
        }
        const before = tree(f.root);
        const result = run(suite, f, flags);
        expect(result.status, result.stderr).toBe(0);
        const report = safeOutput(result, f.root, flags.includes("json"));
        if (flags.includes("--dry-run")) {
          expect(tree(f.root)).toEqual(before);
          if (report) {
            expect(report.plan.destinations.length + report.plan.truncated.destinations).toBe(26);
            expect(report.plan.sources.length + report.plan.truncated.sources).toBe(26);
            expect(report.plan.skipped.length + report.plan.truncated.skipped).toBe(25);
          }
        } else if (report) {
          expect(report.accepted.length + report.truncated).toBe(26);
        }
      });
    }

    it("bounds collision diagnostics while retaining distinguishable relative sources", () => {
      const f = fixture(suite);
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          write(
            join(f.actuals, `${j}-${"é".repeat(100)}`, `${i}-${"é".repeat(100)}-actual.png`),
            `content-${j}`,
          );
        }
      }
      const before = tree(f.root);
      for (const flags of invocations) {
        const result = run(suite, f, flags);
        expect(result.status).toBe(1);
        safeOutput(result, f.root, flags.includes("json"));
        expect(tree(f.root)).toEqual(before);
        if (suite.name === "Hono" && !flags.includes("json")) {
          expect(result.stdout + result.stderr).toContain(`${suite.actuals}/0-`);
          expect(result.stdout + result.stderr).toContain(`${suite.actuals}/1-`);
        }
      }
    });

    for (const kind of [
      "source FIFO",
      "foreign FIFO",
      "destination FIFO",
      "destination directory",
    ]) {
      it(`refuses ${kind} before reads or writes`, () => {
        const f = fixture(suite);
        const target =
          kind === "source FIFO"
            ? join(f.actuals, "z-bad-actual.png")
            : kind === "foreign FIFO"
              ? join(f.artifact, "ignored.txt")
              : join(f.dest, "z-bad.png");
        if (kind.startsWith("destination")) write(join(f.actuals, "z-bad-actual.png"), "new");
        if (kind === "destination directory") mkdirSync(target);
        else expect(spawnSync("mkfifo", [target], { encoding: "utf8" }).status).toBe(0);
        const before = tree(f.root);
        for (const flags of invocations) {
          const result = run(suite, f, flags);
          expect(result.status).toBe(1);
          const report = safeOutput(result, f.root, flags.includes("json"));
          if (report) expect(report.code).toBe("IO_ERROR");
          else expect(result.stderr).toContain("code=IO_ERROR");
          expect(tree(f.root)).toEqual(before);
        }
      });
    }

    for (const over of [false, true]) {
      it(`pins depth ${over ? 65 : 64} including the root directory`, () => {
        const f = fixture(suite);
        // Root depth 1 + suite directory + 62 nested directories = depth 64.
        write(join(f.actuals, ...Array(over ? 63 : 62).fill("d"), "z-deep-actual.png"), "deep");
        const before = tree(f.root);
        for (const flags of [
          ["--dry-run", "--format", "json"],
          ["--format", "json"],
        ]) {
          const result = run(suite, f, flags);
          const report = safeOutput(result, f.root, true);
          expect(result.status).toBe(over ? 1 : 0);
          expect(report.code).toBe(over ? "ARTIFACT_LIMIT" : "OK");
          if (over || flags.includes("--dry-run")) expect(tree(f.root)).toEqual(before);
          else expect(readFileSync(join(f.dest, "z-deep.png"), "utf8")).toBe("deep");
        }
      });

      it(`pins exactly ${over ? 4097 : 4096} visited entries including ignored files`, () => {
        const f = fixture(suite);
        // One suite directory + one candidate file + these unrelated files.
        for (let i = 0; i < (over ? 4095 : 4094); i++) write(join(f.artifact, `${i}.txt`), "entry");
        expect(readdirSync(f.artifact).length + readdirSync(f.actuals).length).toBe(
          over ? 4097 : 4096,
        );
        const before = tree(f.root);
        for (const flags of [
          ["--dry-run", "--format", "json"],
          ["--format", "json"],
        ]) {
          const result = run(suite, f, flags);
          const report = safeOutput(result, f.root, true);
          expect(result.status).toBe(over ? 1 : 0);
          expect(report.code).toBe(over ? "ARTIFACT_LIMIT" : "OK");
          if (over || flags.includes("--dry-run")) expect(tree(f.root)).toEqual(before);
          else
            expect(readFileSync(join(f.dest, "a-page.png"), "utf8")).toBe("reviewed-source-bytes");
        }
      });
    }
  });
}
