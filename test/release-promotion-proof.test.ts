import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("requires trusted post-smoke provenance before release repair creates a tag", () => {
  const output = execFileSync(
    "node",
    ["--test", "--test-reporter=tap", "ci/release-promotion-proof.acceptance.cjs"],
    {
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  expect(output).toMatch(/# fail 0\b/);
}, 120_000);
