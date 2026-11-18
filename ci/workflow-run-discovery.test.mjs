import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Pair, Scalar, YAMLMap, YAMLSeq } from "yaml";
import { enumerateInvocationOccurrences } from "./invocation-occurrences.mjs";
import { discoverWorkflowRuns, workflowRunPlainData } from "./workflow-run-discovery.mjs";

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

test("projects discovered YAML context as isolated plain data", () => {
  const [discovered] = discoverWorkflowRuns(
    "ci.yml",
    `jobs:
  browser:
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: npm run browser
`,
  );
  const context = workflowRunPlainData(discovered);
  const root = { origin: context.origin, location: 0, npmEdges: [], context };
  const [result] = enumerateInvocationOccurrences([root], {}, (occurrence, source, workflow) => {
    workflow.context.precedingSteps[0].with["fetch-depth"] = 99;
    return { occurrence, context: source.context };
  });
  assert.equal(result.context.precedingSteps[0].with["fetch-depth"], 0);
  assert.equal(result.context.step.run, "npm run browser");
  assert.equal(context.job.steps[0].uses, "actions/checkout@v4");
  assert.equal(discovered.precedingSteps[0].get("uses"), "actions/checkout@v4");
});

test("projects actual browser workflow contexts within the clone bounds", () => {
  for (const [name, needle] of [
    ["e2e.yml", "playwright.waitlist-capture.config.ts"],
    ["e2e.yml", "npm run e2e"],
    ["e2e-staging.yml", "npm run e2e:staging"],
  ]) {
    const text = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
    const runs = discoverWorkflowRuns(name, text).filter(({ run }) => run.includes(needle));
    assert.ok(runs.length > 0, `${name}: missing ${needle}`);
    for (const run of runs) {
      const context = workflowRunPlainData(run);
      const root = { origin: context.origin, location: 0, npmEdges: [], context };
      const [projection] = enumerateInvocationOccurrences(
        [root],
        {},
        (_occurrence, source) => source,
      );
      assert.equal(projection.context.step.run, run.run);
      assert.deepEqual(projection.context.origin, run.origin);
      assert.equal(projection.context.precedingSteps.length, run.precedingSteps.length);
    }
  }
});

test("plain data conversion rejects unsupported YAML semantics", () => {
  for (const prefix of [
    "defaults: &defaults { shell: bash }\n",
    "defaults: !custom value\n",
    "defaults: { <<: { shell: bash } }\n",
    "defaults: { ? [complex, key] : value }\n",
  ]) {
    const alias = prefix.includes("&defaults") ? "    env: *defaults\n" : "";
    const [run] = discoverWorkflowRuns(
      "ci.yml",
      `${prefix}jobs:\n  build:\n${alias}    steps:\n      - run: npm test\n`,
    );
    assert.throws(() => workflowRunPlainData(run), /ci.yml: unsupported/);
  }
});

test("plain data conversion preserves safe keys and rejects ambiguous keys", () => {
  const run = {
    origin: { workflow: "ci.yml" },
    run: "",
    job: new Scalar(null),
    step: new Scalar(null),
    precedingSteps: [],
  };
  const mapping = (...pairs) => {
    const node = new YAMLMap();
    node.items = pairs.map(([key, value]) => new Pair(new Scalar(key), new Scalar(value)));
    return node;
  };
  run.workflow = mapping(["__proto__", "safe"], ["constructor", "also safe"]);
  const result = workflowRunPlainData(run).workflow;
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.equal(result.__proto__, "safe");
  assert.equal(result.constructor, "also safe");
  for (const entries of [
    [
      ["duplicate", 1],
      ["duplicate", 2],
    ],
    [[42, "value"]],
    [["<<", "value"]],
  ]) {
    run.workflow = mapping(...entries);
    assert.throws(() => workflowRunPlainData(run), /ci.yml: unsupported workflow mapping key/);
  }
});

test("plain data conversion enforces depth and shared work boundaries", () => {
  const run = {
    origin: { workflow: "ci.yml" },
    run: "",
    job: new Scalar(null),
    step: new Scalar(null),
    precedingSteps: [],
  };
  const nested = (depth) => {
    let node = new Scalar("value");
    for (let i = 0; i < depth; i++) {
      const sequence = new YAMLSeq();
      sequence.items = [node];
      node = sequence;
    }
    return node;
  };
  run.workflow = nested(128);
  assert.doesNotThrow(() => workflowRunPlainData(run));
  run.workflow = nested(129);
  assert.throws(() => workflowRunPlainData(run), /ci.yml: unsupported workflow data/);

  const sequence = new YAMLSeq();
  sequence.items = Array(99_997).fill(new Scalar("value"));
  run.workflow = sequence;
  assert.doesNotThrow(() => workflowRunPlainData(run));
  run.precedingSteps = [new Scalar(null)];
  assert.throws(() => workflowRunPlainData(run), /ci.yml: unsupported workflow data/);
});

test("workflow discovery refuses malformed or aliased executable structure", () => {
  for (const text of [
    "jobs: [unterminated",
    "jobs: { build: { uses: [] } }",
    "jobs: { build: { uses: 42 } }",
    "jobs: { build: { steps, uses: ./.github/workflows/reuse.yml } }",
    "jobs: { build: { steps: null, uses: ./.github/workflows/reuse.yml } }",
    "jobs: { build: { steps: { run: hi } } }",
    "jobs: { build: { steps: [{ run }] } }",
    "jobs: { build: { steps: [{ run: null }] } }",
    "jobs: { build: { steps: [{ run: [hi] }] } }",
    "jobs: { build: { steps: [&x { run: hi }, *x] } }",
  ]) {
    assert.throws(() => discoverWorkflowRuns("ci.yml", text), /ci.yml:/);
  }
});
