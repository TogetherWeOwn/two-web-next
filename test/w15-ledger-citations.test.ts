// W15 acceptance-ledger citation pins.
// docs/w15-events-acceptance-ledger.md cites src/test file:line ranges as
// implementation evidence. After the admin store split, two ranges pointed
// past the end of src/admin/store.ts (a 30-line re-export barrel). This
// suite fails when any current-head citation dangles past EOF, so a moved
// function breaks here instead of going stale in the doc.
//
// Scope: backtick-quoted `src/...` / `test/...` / `e2e/...` refs with line
// ranges, plus bare `:start-end` continuations resolved against the nearest
// preceding `test/...` or `e2e/...` anchor (full `path:range` ref or bare file
// mention) on the same line. `src/...` refs never anchor a bare continuation:
// in these rows the bare ranges continue the test/e2e proof while `src/...`
// refs are parenthetical implementation pointers (resolving against them
// misattributes the range and either misses drift or flags the wrong file),
// so a continuation of a `src/...` range carries its explicit `src/...` prefix
// (row 116 `:27-52` / `:46-48`, row 120 `:218`). Legacy `*.php` ranges likewise
// carry an explicit `EventTimezoneTest.php:` prefix, so no bare range ever
// continues a PHP ref and no legacy skip exists to swallow current-head refs.
// Excluded: historical pins qualified with `at <sha>` / `at that revision`
// (they describe a past revision, not current head).
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
 * Current-head refs: backtick `src/...` / `test/...` / `e2e/...` paths with one
 * or more :line / :start-end ranges, plus bare `:range` continuations. A bare
 * range inherits the nearest preceding `test/...` or `e2e/...` anchor on the
 * same ledger line (a full ref or a bare file mention); every ledger line
 * carrying a bare ref also names its file, so same-line resolution is
 * complete. `src/...` refs and non-ref prose (including legacy `*.php` refs)
 * never move the anchor. A bare range with no anchor is returned as
 * unresolved so the suite fails instead of silently dropping it.
 */
function currentHeadRefs(doc: string): {
  refs: { path: string; spec: string }[];
  unresolved: string[];
} {
  const refs: { path: string; spec: string }[] = [];
  const unresolved: string[] = [];
  const historical = (line: string, end: number): boolean =>
    / at (`?[0-9a-f]{7,40}`?|that revision)(?![0-9a-z])/.test(line.slice(end, end + 30));
  let lineNo = 0;
  for (const line of doc.split("\n")) {
    lineNo += 1;
    let anchor: string | null = null;
    for (const m of line.matchAll(/`([^`]*)`/g)) {
      const tok = m[1]!;
      const end = m.index! + m[0].length;
      const full = tok.match(
        /^(src|test|e2e)\/([A-Za-z0-9_.\-/]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/,
      );
      if (full) {
        const path = `${full[1]}/${full[2]}`;
        if (full[1] !== "src") anchor = path;
        if (!historical(line, end)) refs.push({ path, spec: full[3]! });
        continue;
      }
      const file = tok.match(/^(src|test|e2e)\/([A-Za-z0-9_.\-/]+)$/);
      if (file) {
        if (file[1] !== "src") anchor = `${file[1]}/${file[2]}`;
        continue;
      }
      const bare = tok.match(/^:(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/);
      if (bare) {
        if (historical(line, end)) continue;
        if (anchor) refs.push({ path: anchor, spec: bare[1]! });
        else unresolved.push(`line ${lineNo} :${bare[1]}`);
        continue;
      }
      // Any other backticked token (legacy *.php refs, prose) is ignored: it
      // neither anchors nor skips. Legacy ranges carry an explicit PHP prefix
      // and src continuations carry an explicit src prefix, so no bare range
      // ever needs to resolve through one of these tokens.
    }
  }
  return { refs, unresolved };
}

describe("w15 acceptance-ledger citations resolve within EOF", () => {
  it("every current-head src/test/e2e range ends at or before the file's last line", () => {
    const doc = read(LEDGER);
    const { refs, unresolved } = currentHeadRefs(doc);
    // A bare range with no test/e2e anchor is a gap in the guard, not a
    // legacy citation: fail instead of skipping it.
    expect(unresolved, `ledger has unanchored bare refs:\n${unresolved.join("\n")}`).toEqual([]);
    // Full refs plus bare continuations: dropping either class below the
    // floor fails, so the guard cannot silently narrow again.
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
    expect(row!).toContain("src/admin/store-event-writes.ts:549-607");
    expect(row!).toContain("src/admin/store-event-writes.ts:610-661");
    const writes = read("src/admin/store-event-writes.ts").split("\n");
    const transitionStart = writes.findIndex((line) =>
      line.includes("export async function transitionEvent"),
    );
    const rsvpStart = writes.findIndex((line) =>
      line.includes("export async function setRsvpOpen"),
    );
    expect(transitionStart, "transitionEvent declaration exists").toBeGreaterThanOrEqual(0);
    expect(rsvpStart, "setRsvpOpen declaration exists").toBeGreaterThanOrEqual(0);
    // transitionEvent (cancelled-terminal guard via nextStatus) ...
    expect(writes.slice(transitionStart, transitionStart + 57).join("\n")).toContain(
      "nextStatus(from, to)",
    );
    // ... and setRsvpOpen (draft/ended reopen refusal).
    expect(writes.slice(rsvpStart, rsvpStart + 51).join("\n")).toContain(
      "Only published events that have not ended can pause or reopen RSVPs.",
    );
  });
});

describe("w15 acceptance-ledger EventGoneTest row", () => {
  it("pins each cited range at an it() block so within-EOF drift fails", () => {
    const doc = read(LEDGER);
    const row = doc.split("\n").find((line) => line.includes("EventGoneTest.php"));
    expect(row, "ledger keeps the EventGoneTest row").toBeDefined();
    expect(row!).toContain("test/event-gone-surfaces.test.ts:145-244");
    for (const sub of [
      ":145-171",
      ":173-178",
      ":180-193",
      ":195-204",
      ":206-216",
      ":218-224",
      ":226-233",
      ":235-244",
    ]) {
      expect(row!, `gone row must cite ${sub}`).toContain(sub);
    }
    const lines = read("test/event-gone-surfaces.test.ts").split("\n");
    // Each cited range must open on an it() block: a 2-line shift within EOF
    // (main #790 grew the file 243 -> 245 via the jsonLdOf hunk at line 73)
    // then fails here instead of landing stale.
    for (const start of [145, 173, 180, 195, 206, 218, 226, 235]) {
      expect(
        lines[start - 1],
        `gone row range starting :${start}- must open an it() block`,
      ).toContain("it(");
    }
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
