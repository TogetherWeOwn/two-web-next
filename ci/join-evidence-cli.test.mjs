import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "./join-evidence-cli.mjs";

const run = (script) => runCli(process.execPath, ["-e", script], { timeoutMs: 5000 });

test("CLI collects complete stdout and stderr at the byte limit", async () => {
  const result = await run(
    "process.stdout.write('x'.repeat(65536)); process.stderr.write('y'.repeat(65536))",
  );
  assert.equal(result.code, 0);
  assert.equal(result.drained, true);
  assert.equal(Buffer.byteLength(result.stdout), 65536);
  assert.equal(Buffer.byteLength(result.stderr), 65536);
});

test("CLI marks either oversized output stream incomplete", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const result = await run(`process.${stream}.write('x'.repeat(65537))`);
    assert.equal(result.code, 0);
    assert.equal(result.drained, false);
    assert.equal(Buffer.byteLength(result[stream]), 65536);
  }
});

test("CLI applies the limit to bytes rather than Unicode characters", async () => {
  const result = await run("process.stdout.write('é'.repeat(32769))");
  assert.equal(result.code, 0);
  assert.equal(result.drained, false);
  assert.equal(Buffer.byteLength(result.stdout), 65536);
});

test("CLI bounds stream drain when a descendant holds the pipe", async () => {
  const script = `const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { detached: true, stdio: 'inherit' }).unref();
process.stdout.write('last line\\n');`;
  const result = await runCli(process.execPath, ["-e", script], { timeoutMs: 5000, drainMs: 200 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "last line\n");
  assert.equal(result.drained, false);
});

test("CLI reports spawn errors and timeouts as incomplete", async () => {
  const absent = await runCli("/nonexistent/join-evidence-cli", [], { timeoutMs: 1000 });
  assert.equal(absent.code, null);
  assert.equal(absent.drained, false);
  const timed = await runCli(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    timeoutMs: 200,
  });
  assert.equal(timed.timedOut, true);
});
