import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const check = workflow.slice(workflow.indexOf("\n  check:\n"));
const step = check.match(
  /      - name: Seeded admin properties \(10s budget, local fixtures\)\n([\s\S]*?)(?=      - )/,
);
const command = step?.[1].match(/^        run: (.+)$/m)?.[1];
const args = ["run", "test/admin-validation.property.test.ts"];
const workflowArgs = [...args, "--pool=threads"];

test("the required check runs the identical property suite without npm startup, inside the original 10s gate", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts["test:admin-properties"], `vitest ${args.join(" ")}`);
  // Direct invocation must not silently bypass lifecycle work added later.
  assert.equal(manifest.scripts["pretest:admin-properties"], undefined);
  assert.equal(manifest.scripts["posttest:admin-properties"], undefined);
  assert.equal(
    command,
    `timeout 10s node node_modules/vitest/vitest.mjs ${workflowArgs.join(" ")}`,
  );
  assert.doesNotMatch(step[1], /continue-on-error:|\bif:/);
  assert.match(check, /node --test ci\/a11y-\*\.test\.mjs ci\/admin-properties-ci\.test\.mjs/);
});

// Execute the actual workflow command with a local CLI fixture, not the app or
// a database. Its exit status, not a passing-looking summary, controls the gate.
for (const [label, body, expected] of [
  ["success", "process.exitCode = 0;", 0],
  ["test failure", "process.exitCode = 7;", 7],
  [
    "deadline after a passing summary",
    'console.log("Tests 25 passed"); setInterval(() => {}, 1000);',
    124,
  ],
]) {
  test(`the property gate propagates ${label}`, { timeout: 20000 }, async (t) => {
    assert.equal(
      command,
      `timeout 10s node node_modules/vitest/vitest.mjs ${workflowArgs.join(" ")}`,
    );
    const fixture = await mkdtemp(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "admin-property-gate-"),
    );
    t.after(() => rm(fixture, { recursive: true, force: true }));
    await mkdir(join(fixture, "node_modules/vitest"), { recursive: true });
    await writeFile(
      join(fixture, "node_modules/vitest/vitest.mjs"),
      `
      import assert from "node:assert/strict";
      assert.deepEqual(process.argv.slice(2), ${JSON.stringify(workflowArgs)});
      ${body}
    `,
    );
    const child = spawn("sh", ["-e", "-c", command], {
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
    if (expected === 124) assert.match(stdout, /Tests 25 passed/);
  });
}
