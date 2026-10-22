import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sampleProcesses, startProgress } from "./node22-progress.mjs";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = workflow.split("\n  node22-compat:\n")[1]?.split("\n  bundle-budget:\n")[0];
const step =
  job?.match(
    /      - name: Lint \+ typecheck \+ unit tests on Node 22\.23\.0\n([\s\S]*?)(?=\n  \w)/,
  )?.[1] ?? job?.slice(job.indexOf("      - name: Lint + typecheck + unit tests"));
const command = step
  ?.match(/        run: \|\n([\s\S]*?)(?=        env:)/)?.[1]
  .replace(/^          /gm, "");
const original = "npm run lint && npm run typecheck && npm test";
const sentinel = "fixture-private-value-not-for-telemetry";

async function scratch(t) {
  const dir = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "node22-progress-"),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function procFixture(root, pid, ppid, children = "", name = sentinel) {
  await mkdir(join(root, `${pid}/task/${pid}`), { recursive: true });
  const fields = Array(22).fill("0");
  Object.assign(fields, { 0: "S", 1: `${ppid}`, 11: "12", 12: "3", 17: "2", 19: "456", 21: "128" });
  await writeFile(join(root, `${pid}/stat`), `${pid} (${name}) ${fields.join(" ")}\n`);
  await writeFile(join(root, `${pid}/task/${pid}/children`), children);
}

test("snapshots expose only numeric resources and state, exclude the sidecar, and cap descendants", async (t) => {
  const root = await scratch(t);
  await procFixture(root, 101, 1, "102 103 104 ", `${sentinel}) tricky (name`);
  await procFixture(root, 102, 101);
  await procFixture(root, 103, 101);
  await procFixture(root, 104, 101);
  const snapshot = sampleProcesses(101, { procRoot: root, selfPid: 102, maxProcesses: 2 });
  assert.deepEqual(snapshot.processes, [
    { pid: 101, ppid: 1, state: "S", cpuTicks: 15, rssPages: 128, threads: 2, startTicks: 456 },
    { pid: 103, ppid: 101, state: "S", cpuTicks: 15, rssPages: 128, threads: 2, startTicks: 456 },
  ]);
  assert.equal(snapshot.truncated, true);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(sentinel));
  // Oversized or malformed resource files must not be logged or parsed as rows.
  await writeFile(join(root, "101/stat"), sentinel.repeat(1000));
  assert.equal(sampleProcesses(101, { procRoot: root }), null);
});

test("production defaults cap cadence, reads, process rows and total output before the job deadline", async (t) => {
  const root = await scratch(t);
  const children = Array.from({ length: 40 }, (_, i) => i + 102);
  await procFixture(root, 101, 1, children.join(" "));
  for (const pid of children) await procFixture(root, pid, 101);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const records = [];
  const stop = startProgress(101, { procRoot: root, write: (line) => records.push(line) });
  t.after(stop);
  assert.equal(records.length, 1);
  t.mock.timers.tick(59999);
  assert.equal(records.length, 1);
  t.mock.timers.tick(1);
  assert.equal(records.length, 2);
  for (let minute = 2; minute <= 30; minute++) t.mock.timers.tick(60000);
  assert.equal(records.length, 28);
  for (const line of records) {
    const record = JSON.parse(line.slice("[node22-progress] ".length));
    assert.equal(record.processes.length, 32);
    assert.equal(record.truncated, true);
    assert.ok(Buffer.byteLength(line) <= 8192);
  }
  assert.ok(Buffer.byteLength(records.join("")) <= 28 * 8192);
  assert.throws(() => sampleProcesses(101, { maxProcesses: 33 }), /bounds/);
  assert.throws(() => startProgress(101, { maxSamples: 29 }), /bounds/);
  assert.throws(() => startProgress(101, { intervalMs: NaN }), /bounds/);
});

test("a controlled hung child yields bounded live evidence without being stopped by the sampler", {
  timeout: 10000,
}, async (t) => {
  const child = spawn(
    process.execPath,
    ["-e", 'console.log("ready"); setInterval(() => {}, 1000)', sentinel],
    {
      env: { ...process.env, DIAGNOSTIC_CANARY: sentinel },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = once(child, "close");
  t.after(async () => {
    child.kill();
    await closed;
  });
  await once(child.stdout, "data");
  const records = [];
  let complete;
  const sampled = new Promise((resolve) => {
    complete = resolve;
  });
  const stop = startProgress(child.pid, {
    intervalMs: 20,
    maxSamples: 2,
    write: (line) => {
      records.push(line);
      if (records.length === 2) complete();
    },
  });
  t.after(stop);
  await sampled;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(records.length, 2);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  for (const line of records) {
    assert.ok(Buffer.byteLength(line) <= 8192);
    assert.doesNotMatch(line, new RegExp(sentinel));
    const record = JSON.parse(line.slice("[node22-progress] ".length));
    assert.equal(record.rootPid, child.pid);
    assert.equal(record.processes[0].pid, child.pid);
    assert.ok(record.processes[0].threads > 0);
    assert.ok(record.elapsedSeconds >= 0);
  }
  stop();
  stop();
});

test("unavailable proc data produces one fixed message, not raw errors or a lingering timer", async (t) => {
  const root = await scratch(t);
  const records = [];
  const stop = startProgress(99999, {
    procRoot: root,
    intervalMs: 5,
    write: (line) => records.push(line),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(records, ['[node22-progress] {"status":"root-unavailable"}\n']);
  stop();
});

test("PID reuse stops observation instead of reporting an unrelated root", async (t) => {
  const root = await scratch(t);
  await procFixture(root, 101, 1);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const records = [];
  const stop = startProgress(101, { procRoot: root, write: (line) => records.push(line) });
  t.after(stop);
  const stat = await readFile(join(root, "101/stat"), "utf8");
  await writeFile(join(root, "101/stat"), stat.replace(" 456 ", " 457 "));
  t.mock.timers.tick(60000);
  t.mock.timers.tick(60000);
  assert.equal(records.length, 2);
  assert.equal(records[1], '[node22-progress] {"status":"root-unavailable"}\n');
});

test("workflow retains the exact suite, scope gate, hosted runner, timeout and required dependency", () => {
  assert.ok(command, "workflow must start the sidecar around the original command");
  assert.match(command, /^node ci\/node22-progress\.mjs "\$\$" &\n/);
  assert.ok(command.trimEnd().endsWith(original));
  assert.match(
    command,
    /trap 'kill "\$diagnostics_pid" 2>\/dev\/null \|\| :; wait "\$diagnostics_pid" 2>\/dev\/null \|\| :' EXIT/,
  );
  assert.match(
    step,
    /if: \(needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.draft != 'true'\)/,
  );
  assert.doesNotMatch(step, /continue-on-error|timeout-minutes/);
  assert.match(job, /timeout-minutes: 30\n/);
  assert.match(job, /!github.event.repository.private && '\["ubuntu-latest"\]'/);
  assert.match(job, /image: node:22\.23\.0-bookworm/);
  assert.match(job, /run: node --test ci\/node22-progress\.test\.mjs/);
  assert.match(workflow, /NODE22_COMPAT_RESULT: \$\{\{ needs\.node22-compat\.result }}/);
  assert.match(workflow, /run: test "\$NODE22_COMPAT_RESULT" = success/);
});

for (const [failAt, expected] of [
  ["none", 0],
  ["lint", 7],
  ["typecheck", 8],
  ["test", 9],
  ["signal", 143],
]) {
  test(`actual workflow shell preserves output, environment, order, exit and cleanup: ${failAt}`, {
    timeout: 15000,
  }, async (t) => {
    assert.ok(command);
    const dir = await scratch(t);
    await mkdir(join(dir, "ci"));
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "ci/node22-progress.mjs"),
      await readFile(new URL("./node22-progress.mjs", import.meta.url)),
    );
    await writeFile(
      join(dir, "bin/npm"),
      `#!/usr/bin/env node
import assert from "node:assert/strict";
assert.equal(process.env.DIAGNOSTIC_CANARY, ${JSON.stringify(sentinel)});
const args = process.argv.slice(2);
assert.ok(JSON.stringify([["run", "lint"], ["run", "typecheck"], ["test"]]).includes(JSON.stringify(args)));
const stage = args.at(-1);
console.log("out:" + stage);
console.error("err:" + stage);
setTimeout(() => {
  if (process.env.FAIL_AT === "signal" && stage === "test") process.kill(process.pid, "SIGTERM");
  else process.exit(process.env.FAIL_AT === stage ? { lint: 7, typecheck: 8, test: 9 }[stage] : 0);
  // 500ms per stage: the lint case fails after the first stage, and the
  // sidecar's node startup can exceed a 100ms window on a loaded runner,
  // leaving no [node22-progress] line to assert (red node22-compat).
}, 500);
`,
      { mode: 0o755 },
    );
    async function run(shellCommand) {
      const child = spawn("sh", ["-e", "-c", shellCommand], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          DIAGNOSTIC_CANARY: sentinel,
          FAIL_AT: failAt,
        },
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
      const [code, signal] = await once(child, "close");
      return { code, signal, stdout, stderr };
    }
    const baseline = await run(original);
    const monitored = await run(command);
    assert.equal(monitored.code, expected, monitored.stderr);
    assert.equal(monitored.code, baseline.code);
    assert.equal(monitored.signal, baseline.signal);
    assert.equal(monitored.stdout, baseline.stdout);
    assert.equal(monitored.stderr.replace(/^\[node22-progress\].*\n/gm, ""), baseline.stderr);
    assert.doesNotMatch(monitored.stderr, new RegExp(sentinel));
    assert.match(monitored.stderr, /\[node22-progress\]/);
    // `close` waits for inherited diagnostic pipes, so a leaked sidecar hangs this test.
  });
}
