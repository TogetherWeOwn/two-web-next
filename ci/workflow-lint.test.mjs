import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lintWorkflows, projectWorkflow } from "./workflow-lint.mjs";

const workflow = (
  concurrency,
  job = "    runs-on: ubuntu-latest\n    steps:\n      - run: echo fixture\n",
) => `name: fixture\non: push\n${concurrency}jobs:\n  test:\n${job}`;
const block = (value = "max", cancel = "false") =>
  `concurrency:\n  group: fixture-\${{ github.ref }}\n  cancel-in-progress: ${cancel}\n  queue: ${value}\n`;

for (const value of ["max", "single"]) {
  test(`validates workflow and job ${value} queues and preserves source locations`, () => {
    const source = workflow(
      block(value),
      `    ${block(value).replaceAll("\n", "\n    ").trimEnd()}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo fixture\n`,
    );
    const projected = projectWorkflow(source);
    assert.equal(projected.length, source.length);
    assert.equal(projected.split("\n").length, source.split("\n").length);
    assert.doesNotMatch(projected, /queue:/);
    assert.equal(
      projected,
      source.replace(/queue: (?:max|single)/g, (match) => " ".repeat(match.length)),
    );
    assert.match(projected, /fixture-\$\{\{ github.ref \}\}/);
  });
}

test("queue also accepts absent cancellation and leaves no-queue YAML byte-identical", () => {
  const source = workflow(block().replace("  cancel-in-progress: false\n", ""));
  assert.doesNotMatch(projectWorkflow(source), /queue:/);
  const ordinary = workflow("concurrency: fixture\n");
  assert.equal(projectWorkflow(ordinary), ordinary);
});

for (const value of [
  "unknown",
  "true",
  "12",
  "[max]",
  "{mode: max}",
  "'max'",
  '"max"',
  "${{ github.ref }}",
  "",
  "|\n    max",
]) {
  test(`rejects invalid queue ${JSON.stringify(value)}`, () => {
    assert.throws(() => projectWorkflow(workflow(block(value))), /queue/);
  });
}
for (const cancel of ["true", "'false'", "${{ false }}", "[false]"]) {
  test(`rejects incompatible cancellation ${cancel}`, () => {
    assert.throws(() => projectWorkflow(workflow(block("max", cancel))), /cancel-in-progress/);
  });
}

test("rejects duplicate keys, malformed YAML, flow queues and alias/merge ambiguity", () => {
  assert.throws(() => projectWorkflow(workflow(`${block()}  queue: single\n`)), /unique/i);
  assert.throws(() => projectWorkflow("jobs: ["));
  assert.throws(
    () => projectWorkflow(workflow("concurrency: {group: fixture, queue: max}\n")),
    /block-style/,
  );
  assert.throws(
    () => projectWorkflow(workflow(block().replace("group: fixture-", "group: &group fixture-"))),
    /anchors/,
  );
  assert.throws(() => projectWorkflow(workflow(`${block()}  <<: {group: fixture}\n`)), /merge/);
  assert.throws(
    () => projectWorkflow(workflow(block().replace("concurrency:", "concurrency: &shared"))),
    /anchors/,
  );
});

test("preserves unrelated environment aliases used by the deploy workflow", () => {
  const source = workflow(
    block(),
    "    runs-on: ubuntu-latest\n    steps:\n      - run: echo first\n        env: &shared-env\n          NAME: fixture\n      - run: echo second\n        env: *shared-env\n",
  );
  const projected = projectWorkflow(source);
  assert.equal(projected, source.replace("queue: max", "          "));
  assert.match(projected, /env: &shared-env/);
  assert.match(projected, /env: \*shared-env/);
});

test("preserves misplaced queue keys and every unrelated invalid field for actionlint", () => {
  const source = workflow(
    block(),
    "    queue: max\n    runs-on: ubuntu-latest\n    steps:\n      - typo: bad\n",
  );
  const projected = projectWorkflow(source);
  assert.match(projected, /    queue: max/);
  assert.match(projected, /typo: bad/);
});

test("runs pinned actionlint against supported queues and still refuses unrelated errors", () => {
  const binary = process.env.ACTIONLINT;
  assert.ok(binary, "ACTIONLINT must name the pinned CI binary");
  const lint = (source) =>
    spawnSync(
      binary,
      ["-shellcheck=", "-pyflakes=", "-stdin-filename", ".github/workflows/fixture.yml", "-"],
      { input: projectWorkflow(source), encoding: "utf8" },
    );
  assert.equal(lint(workflow(block())).status, 0);
  assert.notEqual(
    lint(
      workflow(
        block(),
        "    runs-on: ubuntu-latest\n    steps:\n      - run: echo \${{ needs.missing.outputs.value }}\n",
      ),
    ).status,
    0,
  );
  assert.notEqual(
    lint(
      workflow(
        block(),
        "    queue: max\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo fixture\n",
      ),
    ).status,
    0,
  );
  assert.notEqual(
    lint(workflow(block(), "    runs-on: ubuntu-latest\n    steps:\n      - typo: bad\n")).status,
    0,
  );
});

test("driver preserves linter failures and refuses an empty inventory", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-lint-"));
  try {
    const file = join(directory, "fixture.yml");
    writeFileSync(file, workflow(block()));
    let calls = 0;
    assert.equal(
      lintWorkflows("actionlint", [file], (_binary, args, options) => {
        calls++;
        assert.deepEqual(args, ["-shellcheck=", "-pyflakes=", "-stdin-filename", file, "-"]);
        assert.doesNotMatch(options.input, /queue:/);
        return { status: 1 };
      }),
      1,
    );
    assert.equal(calls, 1);
    assert.equal(
      lintWorkflows("actionlint", [file], () => ({ status: null })),
      1,
    );
    assert.throws(() => lintWorkflows("actionlint", []), /no workflow/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
