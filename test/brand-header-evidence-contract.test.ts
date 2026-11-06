import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/e2e.yml", "utf8");
const captureStep = workflow.match(
  /      - name: Brand header captures\n([\s\S]*?)(?=      - name:)/,
)?.[1];

describe("brand header screenshot evidence", () => {
  it("retains completed captures on success as well as failure", () => {
    expect(captureStep).toBeDefined();
    expect(captureStep).toContain("if: ${{ always() && !cancelled() }}");
    expect(captureStep).toContain(
      "name: brand-header-captures-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(captureStep).toContain("retention-days: 7");
  });

  it("uploads only named PNGs with the existing pinned artifact action", () => {
    expect(captureStep).toContain(
      "uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    );
    expect(captureStep?.match(/path: (.+)/)?.[1]).toBe(
      "test-results-kit-parity/**/brand-*.png",
    );
    expect(captureStep).toContain("if-no-files-found: ignore");
    expect(captureStep).not.toContain("env:");
    expect(captureStep).not.toContain(".dev.vars");
    expect(captureStep).not.toContain("trace");
  });
});
