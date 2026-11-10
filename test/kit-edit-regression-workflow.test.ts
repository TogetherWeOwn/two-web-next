import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/kit-edit-regression-proof.yml", "utf8"));
const steps = workflow.jobs.persistence.steps;
const validation = steps.find(
  (step: { name?: string }) => step.name === "Validate exact dispatch SHA",
);
const head = "3bcb90cac133ed17eac678aa79b983b38a92690f";

function validate(headSha: string, dispatchSha: string) {
  return spawnSync("bash", ["-c", validation.run], {
    env: { PATH: process.env.PATH, HEAD_SHA: headSha, DISPATCH_SHA: dispatchSha },
    encoding: "utf8",
    timeout: 1000,
  });
}

describe("Kit edit historical proof isolation", () => {
  it("runs only by explicit dispatch, never as a recurring pull-request gate", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.head_sha).toMatchObject({
      required: true,
      type: "string",
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("validates the full SHA before checkout and uses it for source and evidence identity", () => {
    const checkout = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(steps.indexOf(validation)).toBeLessThan(steps.indexOf(checkout));
    expect(validation.env).toEqual({
      HEAD_SHA: "${{ inputs.head_sha }}",
      DISPATCH_SHA: "${{ github.sha }}",
    });
    expect(checkout.with).toMatchObject({
      ref: "${{ inputs.head_sha }}",
      "persist-credentials": false,
    });
    expect(workflow.concurrency.group).toBe("kit-edit-regression-proof-${{ inputs.head_sha }}");
    const upload = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(upload.with.name).toBe("kit-edit-regression-${{ inputs.head_sha }}");
    expect(validate(head, head).status).toBe(0);
  });

  it.each(["", "main", head.slice(0, 8), `${head}0`, "g".repeat(40), "$(exit 0)"])(
    "rejects a non-SHA input %j",
    (input) => {
      const result = validate(input, input);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
    },
  );

  it("rejects a different valid SHA rather than silently testing a drifting dispatch ref", () => {
    const result = validate(head, "1fe09ab868a6fea4a7873e4a096523b78747b232");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
  });
});
