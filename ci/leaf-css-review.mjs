#!/usr/bin/env node
// Review the derived CSP delta without committing derived bytes or hash pins.
// Usage (offline, no deps): node ci/leaf-css-review.mjs <base-sha> <head-sha>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseLeafModule } from "./leaf-css-parser.mjs";

const inputs = [
  "ci/build-leaf-css.mjs",
  "public/styles.css",
  "public/theme-tokens.css",
  "public/theme.css",
];
// Read by later generators (a revision's generator may or may not need them);
// copied only when that revision has them, so every revision finds its inputs.
const optionalInputs = ["assets/leaf-only.css"];
const options = {
  encoding: "utf8",
  timeout: 10000,
  maxBuffer: 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
};

function snapshot(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("expected an immutable commit SHA");
  const dir = mkdtempSync(join(tmpdir(), "leaf-css-review-"));
  try {
    const blobs = new Map();
    const copyBlob = (input) => {
      const raw = execFileSync("git", ["show", `${sha}:${input}`], {
        ...options,
        encoding: "buffer",
      });
      const contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
      blobs.set(input, contents);
      mkdirSync(dirname(join(dir, input)), { recursive: true });
      writeFileSync(join(dir, input), raw);
    };
    for (const input of inputs) copyBlob(input);
    for (const input of optionalInputs) {
      // A successful tree lookup distinguishes a genuinely absent seam from a Git failure.
      const entry = execFileSync(
        "git",
        ["ls-tree", "--full-tree", "-z", sha, "--", input],
        options,
      );
      if (!entry) continue;
      if (!/^\d+ blob [a-f0-9]+\tassets\/leaf-only\.css\0$/.test(entry)) {
        throw new Error("invalid optional source entry");
      }
      copyBlob(input);
    }
    const sources = inputs.slice(1).map((input) => blobs.get(input));
    const candidates = [];
    for (const [name, parts] of [
      ["three", sources],
      ...(blobs.has(optionalInputs[0])
        ? [["four", [...sources, blobs.get(optionalInputs[0])]]]
        : []),
    ]) {
      for (const [suffix, separator] of [
        ["lf", "\n"],
        ["empty", ""],
      ]) {
        candidates.push({ name: `${name}-${suffix}`, css: parts.join(separator) });
      }
    }
    mkdirSync(join(dir, "src"));
    // Use that revision's actual generator, not a duplicate concatenation rule.
    execFileSync(process.execPath, [join(dir, "ci/build-leaf-css.mjs")], {
      ...options,
      cwd: dir,
      env: { PATH: process.env.PATH },
    });
    const module = readFileSync(join(dir, "src/leaf-critical-css.ts"), "utf8");
    const parsed = parseLeafModule(module);
    if (!parsed) throw new Error("generated bundle does not parse");
    const matches = candidates.filter((candidate) => candidate.css === parsed.css);
    if (matches.length === 0) throw new Error("generated CSS does not match revision sources");
    const bytes = matches[0].css;
    const sha256 = createHash("sha256").update(bytes, "utf8").digest("base64");
    if (sha256 !== parsed.sha256 || /<\/style/i.test(bytes))
      throw new Error("invalid generated bundle");
    return {
      sha,
      sha256,
      bytes: Buffer.byteLength(bytes, "utf8"),
      recipes: matches.map((match) => match.name),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  if (process.argv.length !== 4) throw new Error("expected base and head commit SHAs");
  const base = snapshot(process.argv[2]);
  const head = snapshot(process.argv[3]);
  const changed = base.sha256 !== head.sha256;
  const report = { version: 1, ok: true, changed, base, head };
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "## Generated leaf-CSS / CSP review evidence",
        "",
        `Derived bytes and CSP hash: **${changed ? "changed" : "unchanged"}**. Review the stylesheet and generator source diff alongside this delta.`,
        "",
        "| Snapshot | Commit | CSP hash | CSS bytes |",
        "| --- | --- | --- | --- |",
        `| Base | \`${base.sha}\` | \`sha256-${base.sha256}\` | ${base.bytes} |`,
        `| Head | \`${head.sha}\` | \`sha256-${head.sha256}\` | ${head.bytes} |`,
        "",
        "The drift suite checks generated-output coherence, not an independently committed hash pin.",
        "",
      ].join("\n"),
    );
  }
  console.log(JSON.stringify(report));
} catch (error) {
  console.log(
    JSON.stringify({
      version: 1,
      ok: false,
      error_code: "leaf_css_review_failed",
      retryable: false,
      detail: String(error?.message ?? error)
        .split("\n")[0]
        .slice(0, 300),
      next_action:
        "Fetch both full commit revisions, then verify each revision's ci/build-leaf-css.mjs and the CSS inputs it reads; rerun node ci/leaf-css-review.mjs <base-sha> <head-sha>.",
    }),
  );
  process.exitCode = 1;
}
