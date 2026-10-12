// W15 acceptance-ledger citation pins.
// docs/w15-events-acceptance-ledger.md cites src/test file:line ranges as
// implementation evidence. After the admin store split, two ranges pointed
// past the end of src/admin/store.ts (a 30-line re-export barrel). This
// suite fails when any current-head citation dangles past EOF, so a moved
// function breaks here instead of going stale in the doc.
//
// Scope: backtick-quoted `src/...` / `test/...` refs with line ranges.
// Excluded: historical pins qualified with `at <sha>` / `at that revision`
// (they describe a past revision, not current head) and bare `:start-end`
// continuations (they inherit the file from surrounding prose).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url).href);
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const lineCount = (rel: string): number => {
  const text = read(rel);
  const parts = text.split("\n");
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
};

const LEDGER = "docs/w15-events-acceptance-ledger.md";

/** Current-head refs: backtick path with one or more :line / :start-end ranges. */
function currentHeadRefs(doc: string): { path: string; spec: string }[] {
  const out: { path: string; spec: string }[] = [];
  const pat = /`((?:src|test)\/[A-Za-z0-9_.\-/]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)`/g;
  for (const m of doc.matchAll(pat)) {
    const after = doc.slice(m.index! + m[0].length, m.index! + m[0].length + 30);
    // Historical pin: `path:range` at <sha> / at that revision.
    if (/ at (`?[0-9a-f]{7,40}`?|that revision)(?![0-9a-z])/.test(after)) continue;
    out.push({ path: m[1]!, spec: m[2]! });
  }
  return out;
}

describe("w15 acceptance-ledger citations resolve within EOF", () => {
  it("every current-head src/test range ends at or before the file's last line", () => {
    const doc = read(LEDGER);
    const refs = currentHeadRefs(doc);
    expect(refs.length, "ledger must keep current-head citations to guard").toBeGreaterThan(50);
    const dangling: string[] = [];
    for (const { path, spec } of refs) {
      const total = lineCount(path);
      for (const part of spec.split(",")) {
        const end = part.includes("-") ? Number(part.split("-")[1]) : Number(part);
        if (end > total) dangling.push(`${path}:${spec} (part ${part}, file has ${total} lines)`);
      }
    }
    expect(dangling, `ledger cites past EOF:\n${dangling.join("\n")}`).toEqual([]);
  });
});

describe("w15 acceptance-ledger lifecycle row", () => {
  it("points refused cancel/reopen at the store-event-writes implementations", () => {
    const doc = read(LEDGER);
    const row = doc.split("\n").find((line) => line.includes("EventLifecycleTest.php"));
    expect(row, "ledger keeps the EventLifecycleTest row").toBeDefined();
    // The barrel split moved both functions out of src/admin/store.ts (30
    // lines): the old :352-400 / :403-452 ranges are beyond EOF.
    expect(row!, "no lifecycle citation may dangle past the store barrel").not.toMatch(
      /src\/admin\/store\.ts:\d+/,
    );
    expect(row!).toContain("src/admin/store-event-writes.ts:327-382");
    expect(row!).toContain("src/admin/store-event-writes.ts:385-434");
    const writes = read("src/admin/store-event-writes.ts").split("\n");
    // transitionEvent (cancelled-terminal guard via nextStatus) ...
    expect(writes[326]).toContain("export async function transitionEvent");
    expect(writes.slice(326, 382).join("\n")).toContain("nextStatus(from, to)");
    // ... and setRsvpOpen (draft/ended reopen refusal).
    expect(writes[384]).toContain("export async function setRsvpOpen");
    expect(writes.slice(384, 434).join("\n")).toContain(
      "Only published events that have not ended can pause or reopen RSVPs.",
    );
  });
});

describe("w15 acceptance-ledger A2 row", () => {
  it("cites the occupied-seat capacity error where it now lives", () => {
    const doc = read(LEDGER);
    const row = doc.split("\n").find((line) => line.startsWith("| A2 "));
    expect(row, "ledger keeps the A2 row").toBeDefined();
    const cited = row!.match(/src\/admin\/store-event-writes\.ts:(\d+(?:-\d+)?)/);
    expect(cited, "A2 row must cite the occupied-seat error range").not.toBeNull();
    const parts = cited![1]!.split("-").map(Number);
    const start = parts[0]!;
    const end = parts[1] ?? start;
    const lines = read("src/admin/store-event-writes.ts").split("\n");
    expect(end <= lines.length, "A2 citation must resolve within EOF").toBe(true);
    const block = lines.slice(start - 1, end).join("\n");
    expect(block, "A2 citation must hold the occupied-seat error").toContain("Occupied seats:");
  });
});
