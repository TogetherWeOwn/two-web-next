import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runFixtureCommand } from "./fixture-process.mjs";
import { createEvidence, routeCssFiles } from "./kit-css-evidence.mjs";

test("fixture command reports success, failure and spawn errors", async () => {
  const options = { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 5000 };
  await runFixtureCommand(process.execPath, ["-e", "process.exit(0)"], options);
  await assert.rejects(
    runFixtureCommand(process.execPath, ["-e", "process.exit(1)"], options),
    /failed/,
  );
  await assert.rejects(runFixtureCommand("/missing-fixture-command", [], options), {
    code: "ENOENT",
  });
});

test("fixture startup errors without pipes remain catchable", async () => {
  const runner = `import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {EventEmitter} from 'node:events';
    childProcess.spawn = () => {
      const child = new EventEmitter();
      child.stdout = null; child.stderr = null;
      process.nextTick(() => child.emit('error', Object.assign(new Error('spawn failed'), {code:'EMFILE'})));
      return child;
    };
    syncBuiltinESMExports();
    const {runFixtureCommand} = await import(${JSON.stringify(new URL("./fixture-process.mjs", import.meta.url).href)});
    try { await runFixtureCommand('fixture', [], {cwd:process.cwd(), timeoutMs:1000}); process.exitCode = 1; }
    catch (error) { if (error.code !== 'EMFILE') process.exitCode = 1; }
    await new Promise(resolve => setImmediate(resolve));`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", runner], {
    timeout: 5000,
  });
});

test("fixture timeout kills the owned process group", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "fixture-group-"));
  try {
    const child = `require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000)`;
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio:'inherit'}); setInterval(() => {}, 1000)`;
    await assert.rejects(
      runFixtureCommand(process.execPath, ["-e", parent], {
        cwd: root,
        env: { PATH: process.env.PATH },
        timeoutMs: 2000,
      }),
      /timed out/,
    );
    const pid = Number(await readFile(join(root, "child.pid"), "utf8"));
    const state = await readFile(`/proc/${pid}/status`, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    assert.ok(!state || /^State:\s+Z/m.test(state));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signal failure retains scratch even if the child closes", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "fixture-signal-"));
  try {
    const failure = Object.assign(new Error("signal denied"), { code: "EPERM" });
    await assert.rejects(
      runFixtureCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
        cwd: root,
        env: { PATH: process.env.PATH },
        timeoutMs: 100,
        cleanupMs: 3000,
        signalGroup: () => {
          throw failure;
        },
      }),
      (error) => error.retainFixture === true && error.cause === failure,
    );
    assert.ok((await stat(root)).isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function killFixture(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

test("leader exit signals surviving owned descendants", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "fixture-leader-"));
  try {
    const worker = `require('fs').writeFileSync('child.pid', String(process.pid)); setTimeout(() => {}, 8000)`;
    const parent = `const fs = require('fs'); require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {stdio:'ignore'}).unref(); const timer = setInterval(() => { if (fs.existsSync('child.pid')) { clearInterval(timer); } }, 10)`;
    const signals = [];
    await assert.rejects(
      runFixtureCommand(process.execPath, ["-e", parent], {
        cwd: root,
        env: { PATH: process.env.PATH },
        timeoutMs: 5000,
        signalGroup: (pid, signal) => {
          signals.push([pid, signal]);
          return process.kill(pid, signal);
        },
      }),
      (error) => error.retainFixture === true && /group still exists/.test(error.message),
    );
    assert.equal(signals.length, 1);
    assert.ok(signals[0][0] < 0);
    assert.equal(signals[0][1], "SIGKILL");
  } finally {
    const pid = Number(await readFile(join(root, "child.pid"), "utf8").catch(() => 0));
    if (pid) killFixture(pid);
    await rm(root, { recursive: true, force: true });
  }
});

test("escaped pipe holder cannot keep the runner alive", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "fixture-escaped-"));
  try {
    const escaped = `require('fs').writeFileSync('escaped.pid', String(process.pid)); setTimeout(() => process.exit(), 10000)`;
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(escaped)}], {detached:true,stdio:'inherit'}).unref(); setInterval(() => {}, 1000)`;
    const runner = `import {runFixtureCommand} from ${JSON.stringify(new URL("./fixture-process.mjs", import.meta.url).href)};
      try { await runFixtureCommand(process.execPath, ['-e', ${JSON.stringify(parent)}], {cwd:process.cwd(),env:{PATH:process.env.PATH},timeoutMs:2000,cleanupMs:500}); process.exitCode=1; }
      catch (error) { if (!error.retainFixture) process.exitCode=1; }`;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", runner], {
      cwd: root,
      timeout: 7000,
    });
  } finally {
    const pid = Number(await readFile(join(root, "escaped.pid"), "utf8").catch(() => 0));
    if (pid) killFixture(pid);
    await rm(root, { recursive: true, force: true });
  }
});

const node = (n) => `.svelte-kit/generated/build/client-optimized/nodes/${n}.js`;
const manifest = {
  [node(0)]: { file: "n0.js", imports: [node(2)], dynamicImports: [node(3)], css: ["a0.css"] },
  [node(1)]: { file: "n1.js", css: ["a1.css"] },
  [node(2)]: { file: "n2.js", css: ["a2.css"] },
  [node(3)]: { file: "n3.js", css: ["dyn.css"] },
  [node(4)]: { file: "n4.js", css: ["other.css"] },
};
const routeEvidence = {
  routes: [
    { id: "/x", page: { leaf: 0, layouts: [1], errors: [null] } },
    { id: "/api", page: null },
  ],
};

test("routeCssFiles follows static edges and only optionally dynamic edges", () => {
  assert.deepEqual(routeCssFiles(manifest, routeEvidence, "/x"), ["a0.css", "a1.css", "a2.css"]);
  assert.deepEqual(routeCssFiles(manifest, routeEvidence, "/x", { dynamic: true }), [
    "a0.css",
    "a1.css",
    "a2.css",
    "dyn.css",
  ]);
  assert.throws(() => routeCssFiles(manifest, routeEvidence, "/missing"), /Unknown route/);
  assert.throws(() => routeCssFiles(manifest, routeEvidence, "/api"), /no page/);
});

test("route traversal handles cycles, shared CSS and missing graph entries", () => {
  const graph = {
    [node(0)]: { css: ["z.css", "same.css"], imports: ["shared"] },
    [node(1)]: { css: ["same.css", "a.css"], imports: ["shared"] },
    shared: { css: ["shared.css"], imports: [node(0)] },
  };
  assert.deepEqual(routeCssFiles(graph, routeEvidence, "/x"), [
    "a.css",
    "same.css",
    "shared.css",
    "z.css",
  ]);
  assert.throws(
    () => routeCssFiles({ [node(0)]: {} }, routeEvidence, "/x"),
    /Missing client node 1/,
  );
  assert.throws(
    () => routeCssFiles({ ...graph, shared: { imports: ["missing"] } }, routeEvidence, "/x"),
    /Manifest references missing chunk: missing/,
  );
});

test("route queries reject missing or mismatched client CSS even after a match", () => {
  for (const client of [
    [{ file: "a0.css", text: "match" }],
    [
      { file: "a0.css", text: "match" },
      { file: "/a1.css", text: "" },
      { file: "a2.css", text: "" },
    ],
  ]) {
    const e = createEvidence({ client, server: [], manifest, routeEvidence });
    assert.throws(() => e.routeCssContains("/x", "absent"), /No compiled client CSS: a1.css/);
    assert.throws(() => e.routeCssContains("/x", "match"), /No compiled client CSS: a1.css/);
  }
});

test("evidence queries match strings and patterns without crossing routes", () => {
  const client = [
    { file: "a0.css", text: ".a{--m:1}" },
    { file: "other.css", text: ".o{--m:2}" },
    { file: "a1.css", text: "" },
    { file: "a2.css", text: "" },
  ];
  const e = createEvidence({
    root: "/r",
    output: "/o",
    client,
    server: [],
    manifest,
    routeEvidence,
  });
  assert.deepEqual(e.cssContaining("--m:"), ["a0.css", "other.css"]);
  assert.deepEqual(e.cssContaining(/--m:2/), ["other.css"]);
  const global = /--m:/g;
  assert.deepEqual(e.cssContaining(global), ["a0.css", "other.css"]);
  assert.equal(e.routeCssContains("/x", global), true);
  assert.equal(e.routeCssContains("/x", global), true);
  assert.equal(global.lastIndex, 0);
  assert.equal(e.routeCssContains("/x", "--m:1"), true);
  assert.equal(e.routeCssContains("/x", "--m:2"), false);
  assert.throws(() => e.cssText("nope.css"), /No compiled client CSS/);
});
