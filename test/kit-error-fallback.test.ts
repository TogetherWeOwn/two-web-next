// Catastrophic failures must retain the status but never echo exception text.
// Browser semantics, offline recovery and presentation live in the ungated
// e2e/kit-catastrophic-fallback.spec.ts, not in source-string approximations.
import { describe, expect, it } from "vitest";
import {
  catastrophicTemplate,
  privateFailureMessages,
  renderCatastrophicFallback,
} from "./helpers/kit-catastrophic-fallback";

describe("Kit catastrophic-error fallback", () => {
  it("retains status substitution without admitting the raw exception token", () => {
    expect(catastrophicTemplate).toContain("%sveltekit.status%");
    expect(catastrophicTemplate).not.toContain("%sveltekit.error.message%");
  });

  it("stays a standalone English UTF-8 document", () => {
    expect(catastrophicTemplate).toMatch(/<!doctype html>/i);
    expect(catastrophicTemplate).toMatch(/<html\b[^>]*\blang=["']en["']/i);
    expect(catastrophicTemplate).toMatch(/<meta\b[^>]*\bcharset=["']utf-8["']/i);
  });

  for (const status of [500, 503]) {
    it(`${status}: substitutes a real status into the fallback document`, () => {
      const html = renderCatastrophicFallback(status, "fixture-only failure");
      expect(html).not.toContain("%sveltekit.status%");
      expect(html).toContain(String(status));
    });
  }

  for (const [index, message] of privateFailureMessages.entries()) {
    it(`hostile message ${index + 1}: output is independent of private error details`, () => {
      const html = renderCatastrophicFallback(500, message);
      expect(html).not.toContain("TEST_ONLY_PRIVATE_DETAIL");
      expect(html).not.toContain("private-fixture.invalid");
      expect(html).not.toContain("leak.invalid");
      expect(html).toBe(renderCatastrophicFallback(500, "a different private failure"));
    });
  }
});
