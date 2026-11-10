import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { eventsTitle, pastEventsTitle } from "../src/seo";

// Independent code-point oracle: a compact implementation must retain the
// reviewed NUL/newline order, trim semantics and 40-point boundary.
function expectedQuery(raw: string): string {
  const points = Array.from(
    raw
      .replace(/\u0000/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim(),
  );
  return points.slice(0, 40).join("") + (points.length > 40 ? "…" : "");
}

function assertQuery(raw: string) {
  const query = expectedQuery(raw);
  expect(eventsTitle({ view: "list", month: "2030-06", q: raw })).toBe(
    query ? `Events matching “${query}”` : "Events",
  );
  expect(pastEventsTitle(3, raw)).toBe(
    query ? `Past events matching “${query}”` : "Past events — page 3",
  );
}

describe("discovery title query normalization and truncation parity", () => {
  it.each([
    "a\r\u0000\nb",
    `${"a".repeat(39)}\n🚀tail`,
    `${"🚀".repeat(40)}tail`,
    `${"🚀".repeat(39)}\n`,
    `${"a".repeat(39)}\ud800tail`,
    " \u0000\r\n ",
  ])("keeps code points, interior newlines and normalization order for %j", assertQuery);

  it("matches the independent array oracle across mixed Unicode and controls", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom("a", "é", "🚀", "\n", "\r", "\u0000", "\ud800", " "), {
            maxLength: 100,
          })
          .map((points) => points.join("")),
        assertQuery,
      ),
      { numRuns: 300 },
    );
  });
});
