import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverWorkflowRuns } from "./workflow-run-discovery.mjs";

test("discovers decoded workflow runs with distinct jobs and preceding steps", () => {
  const runs = discoverWorkflowRuns(
    "ci.yml",
    `metadata: { run: ignored }
jobs:
  first:
    steps:
      - uses: actions/checkout@v4
      - run: >-
          npm run
          browser
      - run: npm run browser
  reusable:
    uses: ./.github/workflows/reuse.yml
  second:
    steps:
      - run: npm run browser
`,
  );
  assert.deepEqual(
    runs.map(({ origin, run, precedingSteps }) => [
      origin.job,
      origin.step,
      run,
      precedingSteps.length,
    ]),
    [
      [0, 1, "npm run browser", 1],
      [0, 2, "npm run browser", 2],
      [2, 0, "npm run browser", 0],
    ],
  );
  assert.equal(runs[0].precedingSteps[0].get("uses"), "actions/checkout@v4");
  assert.equal(runs[0].origin.workflow, "ci.yml");
});

test("workflow discovery refuses malformed or aliased executable structure", () => {
  for (const text of [
    "jobs: [unterminated",
    "jobs: { build: { uses: [] } }",
    "jobs: { build: { uses: 42 } }",
    "jobs: { build: { steps: { run: hi } } }",
    "jobs: { build: { steps: [{ run: [hi] }] } }",
    "jobs: { build: { steps: [&x { run: hi }, *x] } }",
  ]) {
    assert.throws(() => discoverWorkflowRuns("ci.yml", text), /ci.yml:/);
  }
});
