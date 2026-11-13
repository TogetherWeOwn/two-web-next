import { describe, expect, it } from "vitest";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";

// The UI token points at the swap face and must stay away from content leaves.
const unguardedUiRules = (css: string): string[] =>
  (css.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+{[^{}]*}/g) ?? [])
    .map((rule) => ({
      selector: rule.slice(0, rule.indexOf("{")).trim(),
      body: rule.slice(rule.indexOf("{") + 1, -1),
    }))
    .filter(
      (rule) =>
        rule.body
          .split(";")
          .some((declaration) =>
            /^\s*font(?:-family)?\s*:[^;{}]*var\(--font-ui\)/.test(declaration),
          ) &&
        rule.selector.split(/,(?![^(]*\))/).some((part) => !part.includes(":not(.content-theme)")),
    )
    .map((rule) => rule.selector);

describe("content UI font guard", () => {
  it("keeps the swap-based UI token away from content pages", () => {
    expect(unguardedUiRules(LEAF_CRITICAL_CSS)).toEqual([]);
    expect(unguardedUiRules(".base-theme h1{font:700 1rem var(--font-ui)}")).toEqual([
      ".base-theme h1",
    ]);
    expect(
      unguardedUiRules(
        ".base-theme:not(.content-theme) h1,.base-theme h2{font-family:var(--font-ui)}",
      ),
    ).toHaveLength(1);
    expect(unguardedUiRules(".base-theme:not(.content-theme){font-family:var(--font-ui)}")).toEqual(
      [],
    );
  });
});
