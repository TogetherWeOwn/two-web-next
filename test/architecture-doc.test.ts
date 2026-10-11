// Architecture-doc drift test: pins docs/architecture.md §"Module map"
// against the src/ tree and its own relative links. A new src/ root module
// or directory must be assigned to exactly one named area here; a map row
// for a deleted path must be removed; a relative link in the doc must
// resolve. Keep this suite DB-free: filesystem reads only.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docPath = resolve(root, "docs/architecture.md");
const docsDir = resolve(root, "docs");
const srcDir = resolve(root, "src");

const MAP_START = "<!-- module-map:start -->";
const MAP_END = "<!-- module-map:end -->";

function readDoc(): string {
  return readFileSync(docPath, "utf8");
}

function readMapRows(text: string): { path: string; area: string }[] {
  const start = text.indexOf(MAP_START);
  const end = text.indexOf(MAP_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Expected exactly one module-map block");
  }
  const block = text.slice(start + MAP_START.length, end);
  const rows: { path: string; area: string }[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .trim()
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/`/g, ""));
    if (cells.length === 2 && cells[0] === "Path" && cells[1] === "Area") continue;
    if (cells.length === 2 && cells[0] === "---" && cells[1] === "---") continue;
    expect(cells.length, `Module-map row needs Path and Area: ${line}`).toBe(2);
    const path = cells[0] ?? "";
    const area = cells[1] ?? "";
    expect(path.length > 0, `Module-map row needs a path: ${line}`).toBe(true);
    expect(area.length > 0, `Module-map row needs an area: ${line}`).toBe(true);
    rows.push({ path, area });
  }
  return rows;
}

function srcRootEntries(): string[] {
  return readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => (entry.isDirectory() ? `src/${entry.name}/` : `src/${entry.name}`))
    .sort();
}

function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, "");
}

function relativeLinkTargets(text: string): string[] {
  const body = stripFencedCode(text);
  const targets: string[] = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const captured = match[1];
    if (captured === undefined) continue;
    const raw = captured.trim();
    if (!raw || raw.startsWith("#")) continue;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) continue;
    targets.push(raw);
  }
  return targets;
}

describe("architecture doc module map", () => {
  it("assigns every src/ root file and directory to exactly one area", () => {
    const rows = readMapRows(readDoc());
    const actual = srcRootEntries();
    const mapped = rows.map((row) => row.path).sort();
    const duplicates = mapped.filter((path, index) => mapped.indexOf(path) !== index);
    expect(duplicates, `Module map assigns a path twice: ${duplicates.join(", ")}`).toEqual([]);
    const missing = actual.filter((entry) => !mapped.includes(entry));
    expect(missing, `New src/ module missing from the map: ${missing.join(", ")}`).toEqual([]);
    const stale = mapped.filter((path) => !actual.includes(path));
    expect(stale, `Map names a path that no longer exists: ${stale.join(", ")}`).toEqual([]);
  });

  it("resolves every relative link in the doc", () => {
    const broken: string[] = [];
    for (const raw of relativeLinkTargets(readDoc())) {
      const file = (raw.split("#")[0] ?? "").split("?")[0]?.trim() ?? "";
      if (!file) continue;
      if (!existsSync(resolve(docsDir, file))) broken.push(raw);
    }
    expect(broken, `Relative link does not resolve: ${broken.join(", ")}`).toEqual([]);
  });
});
