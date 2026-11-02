// Admin chronology cells (roster Answered, activity-log When) keep one line
// through the admin-only stylesheet, never the shared inlined bundle: the
// homepage LCP ratchets forbid regrowing the shared inlined bytes, and both
// admin shells (Hono and Kit) link the admin sheet externally.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";

const cssPath = (entry: string) =>
  readFileSync(new URL(`../public/${entry}`, import.meta.url), "utf8");

describe("admin chronology CSS placement", () => {
  it("keeps time cells on one line from the admin-only sheet", () => {
    expect(cssPath("admin-rsvp-review.css")).toMatch(
      /\.admin-table \.admin-chronology\s*\{\s*white-space:\s*nowrap/,
    );
  });

  it("keeps the rule out of the shared inlined bundle", () => {
    expect(cssPath("styles.css")).not.toContain("admin-chronology");
    expect(LEAF_CRITICAL_CSS).not.toContain("admin-chronology");
  });
});
