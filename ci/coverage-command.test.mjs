import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const check = workflow.slice(workflow.indexOf("\n  check:\n"));
const args = ["run", "--coverage", "--pool=threads"];

test("the required check keeps full coverage in isolated serial threads inside main's job budget", async () => {
  assert.equal(manifest.scripts["test:coverage"], `vitest ${args.join(" ")}`);
  assert.equal(manifest.scripts["pretest:coverage"], undefined);
  assert.equal(manifest.scripts["posttest:coverage"], undefined);
  // main owns the budget (raised 10 -> 20 -> 40 for shared-runner container setup);
  // isolated threads must fit inside it, never widen it.
  const budget = Number(check.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
  assert.ok(budget > 0 && budget <= 40, `check timeout-minutes ${budget} exceeds main's 40`);
  const step = check.match(
    /      - name: Check \(lint \+ typecheck \+ coverage gate\)\n([\s\S]*?)(?=      - )/,
  );
  assert.equal(
    step?.[1].match(/^        run: (.+)$/m)?.[1],
    "npm run lint && npm run typecheck && npm run test:coverage && node --test ci/a11y-*.test.mjs ci/admin-properties-ci.test.mjs ci/coverage-command.test.mjs",
  );
  // Only the docs-only/draft scope gate (TOG-11811/TOG-14880) may guard the step; nothing may bypass it.
  assert.doesNotMatch(step[1], /continue-on-error:/);
  const guards = step[1].match(/^        if:.*$/gm) ?? [];
  assert.equal(guards.length, 1);
  assert.ok(
    guards[0].includes("needs.scope.outputs.docs_only != 'true'") &&
      guards[0].includes("needs.scope.outputs.draft != 'true'"),
    `Step guard must stay scope-gated: ${guards[0]}`,
  );
  const config = await readFile(new URL("../vitest.config.ts", import.meta.url), "utf8");
  assert.match(config, /include: \["test\/\*\*\/\*\.test\.ts", "test\/\*\*\/\*\.test\.mjs"\]/);
  assert.match(config, /fileParallelism: false/);
  assert.doesNotMatch(config, /\bisolate:\s*false/);
});

// Exercise the shipped npm script against a local CLI fixture. A successful-looking
// summary must not turn a failed coverage invocation into a passing required gate.
for (const [label, body, expected] of [
  ["success", "process.exitCode = 0;", 0],
  [
    "coverage failure after a passing summary",
    'console.log("Tests 2808 passed"); process.exitCode = 7;',
    7,
  ],
]) {
  test(`the full coverage command propagates ${label}`, { timeout: 20000 }, async (t) => {
    const fixture = await mkdtemp(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "coverage-command-"),
    );
    t.after(() => rm(fixture, { recursive: true, force: true }));
    await mkdir(join(fixture, "node_modules/.bin"), { recursive: true });
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        scripts: { "test:coverage": manifest.scripts["test:coverage"] },
      }),
    );
    const cli = join(fixture, "node_modules/.bin/vitest");
    await writeFile(
      cli,
      `#!/usr/bin/env node
import assert from "node:assert/strict";
assert.deepEqual(process.argv.slice(2), ${JSON.stringify(args)});
${body}
`,
    );
    await chmod(cli, 0o755);
    const child = spawn("npm", ["run", "--silent", "test:coverage"], {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve([code, signal]));
    });
    assert.equal(signal, null, stderr);
    assert.equal(code, expected, stderr);
    if (expected === 7) assert.match(stdout, /Tests 2808 passed/);
  });
}
