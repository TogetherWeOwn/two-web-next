// W15 acceptance-ledger citation pins.
// docs/w15-events-acceptance-ledger.md cites src/test file:line ranges as
// implementation evidence. After the admin store split, two ranges pointed
// past the end of src/admin/store.ts (a 30-line re-export barrel). This
// suite fails when any current-head citation dangles past EOF, so a moved
// function breaks here instead of going stale in the doc.
//
// Scope: backtick-quoted `src/...` / `test/...` refs with line ranges, plus
// bare `:start-end` continuations resolved against the nearest preceding
// `test/...` anchor (full `path:range` ref or bare file mention) on the same
// line. `src/...` refs never anchor a bare continuation: in these rows the
// bare ranges always continue the test proof while `src/...` refs are
// parenthetical implementation pointers (resolving against them misattributes
// the range and either misses drift or flags the wrong file).
// Excluded: historical pins qualified with `at <sha>` / `at that revision`
// (they describe a past revision, not current head) and bare continuations in
// a legacy clause (nearest preceding ref names a `*.php` file: those ranges
// describe the read-only legacy snapshot, not this repository).
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

/**
 * Current-head refs: backtick `src/...` / `test/...` paths with one or more
 * :line / :start-end ranges, plus bare `:range` continuations. A bare range
 * inherits the nearest preceding `test/...` anchor on the same ledger line
 * (a full ref or a bare file mention); every ledger line carrying a bare ref
 * also names its file, so same-line resolution is complete. `src/...` refs
 * and non-ref prose never move the anchor, and a bare ref following a legacy
 * `*.php` ref is skipped as a legacy-snapshot citation.
 */
function currentHeadRefs(doc: string): { path: string; spec: string }[] {
  const out: { path: string; spec: string }[] = [];
  const historical = (line: string, end: number): boolean =>
    / at (`?[0-9a-f]{7,40}`?|that revision)(?![0-9a-z])/.test(line.slice(end, end + 30));
  for (const line of doc.split("\n")) {
    let anchor: string | null = null;
    let legacy = false;
    for (const m of line.matchAll(/`([^`]*)`/g)) {
      const tok = m[1]!;
      const end = m.index! + m[0].length;
      const full = tok.match(/^(src|test)\/([A-Za-z0-9_.\-/]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/);
      if (full) {
        const path = `${full[1]}/${full[2]}`;
        if (full[1] === "test") anchor = path;
        legacy = false;
        if (!historical(line, end)) out.push({ path, spec: full[3]! });
        continue;
      }
      const file = tok.match(/^(src|test)\/([A-Za-z0-9_.\-/]+)$/);
      if (file) {
        const path = `${file[1]}/${file[2]}`;
        if (file[1] === "test") anchor = path;
        legacy = false;
        continue;
      }
      const bare = tok.match(/^:(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/);
      if (bare) {
        if (!legacy && anchor && !historical(line, end)) out.push({ path: anchor, spec: bare[1]! });
        continue;
      }
      // Any other backticked token leaves the anchor alone, except a legacy
      // PHP ref, which starts a legacy clause whose bare ranges are skipped.
      if (/\.php/.test(tok)) legacy = true;
    }
  }
  return out;
}

describe("w15 acceptance-ledger citations resolve within EOF", () => {
  it("every current-head src/test range ends at or before the file's last line", () => {
    const doc = read(LEDGER);
    const refs = currentHeadRefs(doc);
    // Full refs (~92) plus bare continuations (~130): dropping either class
    // below the floor fails, so the guard cannot silently narrow again.
    expect(refs.length, "ledger must keep current-head citations to guard").toBeGreaterThan(150);
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
