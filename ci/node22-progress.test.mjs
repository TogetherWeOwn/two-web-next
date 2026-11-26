import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sampleProcesses, startProgress } from "./node22-progress.mjs";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = workflow.split("\n  node22-shard:\n")[1]?.split("\n  node22-compat:\n")[0];
const merge = workflow.split("\n  node22-compat:\n")[1]?.split("\n  bundle-budget:\n")[0];
const step = job
  ?.split("\n      - name: Run Node 22.23.0 Vitest shard\n")[1]
  ?.split("\n      - ")[0];
const command = step
  ?.match(/        run: \|\n([\s\S]*?)(?=        env:)/)?.[1]
  .replace(/^          /gm, "");
const shardCommand = (shard) =>
  `npm test -- --shard=${shard}/3 --reporter=dot --reporter=blob --outputFile.blob=vitest-${shard}.json`;
const sentinel = "fixture-private-value-not-for-telemetry";
// Test-only readiness wrapper, installed in the fixture at the
// `ci/node22-progress.mjs` path the pinned workflow shell invokes. The shell
// starts the sidecar and the suite concurrently, so on a loaded runner node
// may still be booting the sidecar when a fast-failing stage exits and the
// shell can end before the first sample is queued (observed: a lint-stage
// failure whose monitored stderr was exactly `err:lint`). The wrapper runs
// the verbatim production CLI (argv[1] rewritten so its entry check passes)
// and only then touches DIAGNOSTIC_READY_FILE, after the first sample is
// queued; the fake npm waits for that file before its stage timer, which
// makes the stderr marker below deterministic instead of a startup race.
const readinessWrapper = `import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
process.argv[1] = fileURLToPath(new URL("./node22-progress.real.mjs", import.meta.url));
await import("./node22-progress.real.mjs");
const readyFile = process.env.DIAGNOSTIC_READY_FILE;
if (!readyFile) throw new Error("test fixture must set DIAGNOSTIC_READY_FILE");
writeFileSync(readyFile, "ready\\n");
`;

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
  for (let minute = 2; minute <= 45; minute++) t.mock.timers.tick(60000);
  assert.equal(records.length, 43);
  for (const line of records) {
    const record = JSON.parse(line.slice("[node22-progress] ".length));
    assert.equal(record.processes.length, 32);
    assert.equal(record.truncated, true);
    assert.ok(Buffer.byteLength(line) <= 8192);
  }
  assert.ok(Buffer.byteLength(records.join("")) <= 43 * 8192);
  assert.throws(() => sampleProcesses(101, { maxProcesses: 33 }), /bounds/);
  assert.throws(() => startProgress(101, { maxSamples: 44 }), /bounds/);
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
  assert.ok(command, "workflow must start the sidecar around the shard command");
  assert.match(command, /^node ci\/node22-progress\.mjs "\$\$" &\n/);
  assert.match(
    command,
    /trap 'kill "\$diagnostics_pid" 2>\/dev\/null \|\| :; wait "\$diagnostics_pid" 2>\/dev\/null \|\| :' EXIT/,
  );
  assert.match(
    job,
    /if: \$\{\{ !cancelled\(\) && needs\.scope\.result == 'success' && needs\.scope\.outputs\.docs_only != 'true' && needs\.scope\.outputs\.draft != 'true' && needs\.scope\.outputs\.isolated != 'true' \}\}/,
  );
  assert.doesNotMatch(step, /continue-on-error|timeout-minutes/);
  assert.match(job, /timeout-minutes: 45\n/);
  assert.match(job, /^    runs-on: ubuntu-latest$/m);
  assert.match(job, /image: node:22\.23\.0-bookworm/);
  assert.match(job, /run: node --test ci\/node22-progress\.test\.mjs/);
  assert.match(job, /shard: \[1, 2, 3\]/);
  assert.match(step, /SHARDS: \$\{\{ strategy\.job-total \}\}/);
  assert.match(merge, /needs: \[scope, node22-shard\]/);
  assert.match(
    merge,
    /SHARD_RESULT: \$\{\{ needs\.node22-shard\.result \}\}\n        run: test "\$SHARD_RESULT" = success/,
  );
  assert.match(workflow, /NODE22_COMPAT_RESULT: \$\{\{ needs\.node22-compat\.result }}/);
  assert.match(workflow, /run: test "\$NODE22_COMPAT_RESULT" = success/);
});

test("the report merge rejects partial or empty input before calling Vitest", async (t) => {
  const dir = await scratch(t);
  const blobs = join(dir, "vitest-blob");
  const cli = join(dir, "node_modules/vitest/vitest.mjs");
  await mkdir(blobs);
  await mkdir(join(dir, "ci"));
  await mkdir(join(dir, "node_modules/vitest"), { recursive: true });
  await writeFile(
    join(dir, "ci/verify-vitest-shards.mjs"),
    await readFile(new URL("./verify-vitest-shards.mjs", import.meta.url)),
  );
  await writeFile(
    join(dir, "node_modules/vitest/package.json"),
    JSON.stringify({ exports: { "./node": "./node.mjs" } }),
  );
  await writeFile(
    join(dir, "node_modules/vitest/node.mjs"),
    `import { resolve } from "node:path";
export async function createVitest({ shard }) {
  const [index, count] = shard.split("/");
  if (count !== "3") throw new Error("Wrong shard count");
  return {
    config: { sequence: { sequencer: class {
      async shard(specifications) {
        return specifications.filter((specification) => specification.shard === index);
      }
    } } },
    getRelevantTestSpecifications: async () => [
      ...["1", "2", "3"].map((shard) => ({ shard, moduleId: resolve("shard-" + shard + ".test.ts") })),
      { shard: "2", moduleId: resolve("extra.test.ts") },
    ],
    close: async () => {},
  };
}`,
  );
  await writeFile(cli, 'console.log("merged"); process.exitCode = Number(process.env.MERGE_EXIT);');
  // A Flatted Vitest tuple with one entry per file task and its filepath.
  const blob = (paths) =>
    JSON.stringify([
      ["1", "2", "3", null, 0, "4"],
      "5.1.0",
      paths.map((_, index) => String(5 + 2 * index)),
      [],
      {},
      ...paths.flatMap((filepath, index) => [{ filepath: String(6 + 2 * index) }, filepath]),
    ]);
  const step = merge.split("      - name: Merge Node 22 Vitest reports\n")[1];
  const script = step.split("        run: |\n")[1];
  const run = (exit = 0) =>
    spawnSync("sh", ["-e", "-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, MERGE_EXIT: String(exit) },
    });
  for (const shard of [1, 2, 3]) {
    assert.notEqual(run().status, 0);
    const paths = [join(dir, `shard-${shard}.test.ts`)];
    if (shard === 2) paths.push(join(dir, "extra.test.ts"));
    await writeFile(join(blobs, `vitest-${shard}.json`), blob(paths));
  }
  const complete = run();
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(complete.stdout.trim(), "merged");
  assert.equal(run(9).status, 9);
  const shard2 = join(blobs, "vitest-2.json");
  for (const [paths, error] of [
    [["shard-2.test.ts"], /missing: extra\.test\.ts/],
    [["shard-2.test.ts", "shard-1.test.ts"], /unexpected or duplicate: shard-1\.test\.ts/],
    [
      ["shard-2.test.ts", "extra.test.ts", "extra.test.ts"],
      /unexpected or duplicate: extra\.test\.ts/,
    ],
  ]) {
    await writeFile(shard2, blob(paths.map((path) => join(dir, path))));
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /vitest-2\.json: Vitest inventory mismatch/);
    assert.match(invalid.stderr, error);
    assert.doesNotMatch(invalid.stdout, /merged/);
  }
  for (const [contents, error] of [
    ["{", /SyntaxError/],
    ["{}", /vitest-2\.json: invalid Vitest blob tuple/],
    ['[["1","99"]]', /vitest-2\.json: invalid Vitest blob reference/],
  ]) {
    await writeFile(shard2, contents);
    const malformed = run();
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, error);
    assert.doesNotMatch(malformed.stdout, /merged/);
  }
  await writeFile(shard2, "");
  assert.notEqual(run().status, 0);
});

for (const [failAt, expected, shard = 1] of [
  ["none", 0],
  ["lint", 7],
  ["typecheck", 8],
  ["test", 9],
  ["signal", 143],
  ["none", 0, 2],
]) {
  test(`shard shell preserves output, environment, order, exit and cleanup: ${shard}/${failAt}`, {
    timeout: 15000,
  }, async (t) => {
    assert.ok(command);
    const dir = await scratch(t);
    await mkdir(join(dir, "ci"));
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "ci/node22-progress.real.mjs"),
      await readFile(new URL("./node22-progress.mjs", import.meta.url)),
    );
    await writeFile(join(dir, "ci/node22-progress.mjs"), readinessWrapper);
    await writeFile(
      join(dir, "bin/npm"),
      `#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
assert.equal(process.env.DIAGNOSTIC_CANARY, ${JSON.stringify(sentinel)});
const readyFile = process.env.DIAGNOSTIC_READY_FILE;
if (readyFile) {
  const deadline = Date.now() + 10000;
  while (!existsSync(readyFile)) {
    if (Date.now() > deadline) throw new Error("node22-progress sidecar never signalled readiness");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const args = process.argv.slice(2);
const stage = args[0] === "test" ? "test" : args[1];
if (stage === "test") assert.deepEqual(args, ${JSON.stringify(shardCommand(shard).split(" ").slice(1))});
else {
  assert.ok(["lint", "typecheck"].includes(stage));
  assert.deepEqual(args, ["run", stage]);
}
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
    async function run(shellCommand, extraEnv = {}) {
      const child = spawn("sh", ["-e", "-c", shellCommand], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          DIAGNOSTIC_CANARY: sentinel,
          FAIL_AT: failAt,
          SHARD: String(shard),
          SHARDS: "3",
          ...extraEnv,
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
    const baseline = await run(
      `${shard === 1 ? "npm run lint && npm run typecheck && " : ""}${shardCommand(shard)}`,
    );
    const monitored = await run(command, { DIAGNOSTIC_READY_FILE: join(dir, "sidecar-ready") });
    assert.equal(monitored.code, expected, monitored.stderr);
    assert.equal(monitored.code, baseline.code);
    assert.equal(monitored.signal, baseline.signal);
    assert.equal(monitored.stdout, baseline.stdout);
    assert.equal(monitored.stderr.replace(/^\[node22-progress\].*\n/gm, ""), baseline.stderr);
    assert.doesNotMatch(monitored.stderr, new RegExp(sentinel));
    assert.match(monitored.stderr, /\[node22-progress\]/);
    // The ready rendezvous above makes this marker deterministic: the fake
    // npm cannot exit before the wrapper queues the first sample.
    // `close` waits for inherited diagnostic pipes, so a leaked sidecar hangs this test.
  });
}
