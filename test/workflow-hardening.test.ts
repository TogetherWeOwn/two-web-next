import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Supply-chain hardening for every workflow (grep-level, no YAML parser):
//  - each `uses:` is pinned to a full commit SHA, so a moved tag cannot swap code
//    into a job that holds secrets;
//  - each `actions/checkout` sets `persist-credentials: false`, so the job token
//    is not left in .git/config beside code that `npm ci` lifecycle scripts run;
//  - no workflow grants a write scope to every job; a job that needs one declares
//    it itself.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, lines: readFileSync(join(dir, name), "utf8").split("\n") }));

const indent = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => /^\s*#/.test(line);

/** `uses:` values (unquoted, trailing comment dropped) with their 1-based line. */
function usesRefs(lines: string[]) {
  const found: { line: number; ref: string }[] = [];
  lines.forEach((text, i) => {
    if (isComment(text)) return;
    const ref = text.match(/^\s*(?:- )?uses:\s*["']?([^\s"'#]+)/)?.[1];
    if (ref) found.push({ line: i + 1, ref });
  });
  return found;
}

/** Lines of the step that owns the `uses:` line at `usesIndex` (0-based). */
function stepOf(lines: string[], usesIndex: number) {
  const usesLine = lines[usesIndex] ?? "";
  const itemIndent = /^\s*- /.test(usesLine) ? indent(usesLine) : indent(usesLine) - 2;
  let start = usesIndex;
  while (
    start > 0 &&
    !(indent(lines[start] ?? "") === itemIndent && /^\s*- /.test(lines[start] ?? ""))
  )
    start -= 1;
  let end = usesIndex + 1;
  while (
    end < lines.length &&
    ((lines[end] ?? "").trim() === "" || indent(lines[end] ?? "") > itemIndent)
  )
    end += 1;
  return lines.slice(start, end);
}

/** The top-level `permissions:` entry: its inline value plus any indented block. */
function topLevelPermissions(lines: string[]) {
  const at = lines.findIndex((line) => /^permissions:/.test(line));
  if (at === -1) return undefined;
  const body = [lines[at] ?? ""];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || isComment(line) || indent(line) > 0) body.push(line);
    else break;
  }
  return body.filter((line) => !isComment(line) && line.trim() !== "");
}

describe("workflow supply-chain hardening", () => {
  it("finds the workflows and their action refs", () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const { name, lines } of workflows)
      expect(usesRefs(lines).length, name).toBeGreaterThan(0);
  });

  it("pins every action to a full commit SHA", () => {
    const unpinned: string[] = [];
    for (const { name, lines } of workflows) {
      for (const { line, ref } of usesRefs(lines)) {
        if (ref.startsWith("./")) continue;
        const pinned = ref.startsWith("docker://")
          ? /@sha256:[0-9a-f]{64}$/.test(ref)
          : /@[0-9a-f]{40}$/.test(ref);
        if (!pinned) unpinned.push(`${name}:${line} ${ref}`);
      }
    }
    expect(unpinned).toEqual([]);
  });

  it("never persists the checkout token", () => {
    const persisted: string[] = [];
    let checkouts = 0;
    for (const { name, lines } of workflows) {
      for (const { line, ref } of usesRefs(lines)) {
        if (!ref.startsWith("actions/checkout@")) continue;
        checkouts += 1;
        const step = stepOf(lines, line - 1).filter((text) => !isComment(text));
        if (!step.some((text) => /^\s+persist-credentials:\s*false\s*$/.test(text)))
          persisted.push(`${name}:${line}`);
      }
    }
    expect(checkouts).toBeGreaterThan(0);
    expect(persisted).toEqual([]);
  });

  it("declares workflow-level permissions and grants no write scope there", () => {
    const missing: string[] = [];
    const writable: string[] = [];
    for (const { name, lines } of workflows) {
      const block = topLevelPermissions(lines);
      if (!block) {
        missing.push(name);
        continue;
      }
      for (const text of block) {
        const value = text.replace(/\s+#.*$/, "");
        if (/\bwrite(-all)?\b/.test(value)) writable.push(`${name}: ${value.trim()}`);
      }
    }
    expect(missing).toEqual([]);
    expect(writable).toEqual([]);
  });
});
