import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { assertEventDetailRollback } from "./fixtures/kit-event-detail-rollback.mjs";
import {
  assertEventMarkdownParity,
  withEventMarkdownDatabaseCleanup,
} from "./fixtures/kit-event-markdown-parity.mjs";
import { cleanUpWorkers, withWorkerCleanup } from "./fixtures/kit-worker-lifecycle.mjs";
import { startLoopbackWorker } from "./kit-worker-loopback.mjs";

const kitName = "kit-ember-event-detail";
const honoName = "hono-event-detail-rollback";
const event = {
  key: "SyntheticEventIdentifier",
  title: "Synthetic Event",
  headers: { cookie: "sample-session=synthetic-cookie-canary" },
};
const privateDetail = "synthetic error body, fixture config and identifier path canary";
const query = "?archivePage=2&archiveQuery=Synthetic%20Markdown";
const path = `/e/${event.key}${query}`;
const headers = {
  "cache-control": "private, no-store",
  vary: "Cookie",
  "content-type": "text/html",
};

async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), "kit-event-detail-phases-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const markers = [];
  const workers = [];
  const signals = [];
  const phasesAtClose = [];
  const output = { main: join(scratch, "fake-entry"), assets: join(scratch, "fake-assets") };
  t.mock.method(console, "log", (line) => markers.push(line));
  const stderr = t.mock.method(process.stderr, "write", () => true);

  function startWorker(name, _entry, _assets, _vars, reportPhase) {
    const { promise: closed, resolve } = Promise.withResolvers();
    const worker = {
      name,
      origin: "http://127.0.0.1:1",
      log: privateDetail,
      reportPhase,
      suppressFailureLog: reportPhase !== undefined,
      stopped: false,
      closed,
      child: {
        kill(signal) {
          signals.push([name, signal]);
          // Acknowledging SIGTERM leaves the child alive until its close event.
          void setImmediate().then(() => {
            phasesAtClose.push([name, phases(name).at(-1)]);
            worker.stopped = true;
            resolve();
          });
        },
      },
    };
    workers.push(worker);
    return worker;
  }

  function run(injected) {
    return withWorkerCleanup(
      () =>
        assertEventDetailRollback({
          scratch,
          event,
          kit: output,
          hono: output,
          startWorker,
          waitForWorker: async () => {},
          ...injected,
        }),
      (failed) => cleanUpWorkers(workers, scratch, failed),
    );
  }

  function phases(name) {
    const prefix = `[event-detail-rollback] ${name} `;
    return markers
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length));
  }

  async function assertCleanup() {
    assert.deepEqual(signals.sort(), [
      [honoName, "SIGTERM"],
      [kitName, "SIGTERM"],
    ]);
    assert.deepEqual(phasesAtClose.sort(), [
      [honoName, "stop start"],
      [kitName, "stop start"],
    ]);
    await assert.rejects(stat(scratch), { code: "ENOENT" });
    assert.equal(stderr.mock.callCount(), 0);
  }

  return { run, startWorker, phases, markers, assertCleanup };
}

test("a failed detail body leaves redirect as the last completed request phase and stops both Workers", async (t) => {
  const { run, phases, markers, assertCleanup } = await fixture(t);
  const requests = [];
  await assert.rejects(
    run({
      async fetchPage(url) {
        requests.push(url);
        if (requests.length === 1)
          return new Response(null, { headers: { "x-two-renderer": "kit" } });
        if (requests.length === 2)
          return new Response(null, { status: 301, headers: { ...headers, location: path } });
        return {
          status: 200,
          headers: new Headers(headers),
          async text() {
            throw new Error(`${privateDetail} ${url} ${event.headers.cookie}`);
          },
        };
      },
    }),
    (error) => {
      assert.equal(error.message, "Event detail rollback phase failed: event-detail-request");
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.deepEqual(requests, [
    "http://127.0.0.1:1/",
    `http://127.0.0.1:1/e/${event.key.toLowerCase()}${query}`,
    `http://127.0.0.1:1${path}`,
  ]);
  assert.deepEqual(phases(kitName), [
    "launch start",
    "launch complete",
    "readiness start",
    "readiness complete",
    "home-control start",
    "home-control complete",
    "event-detail-redirect start",
    "event-detail-redirect complete",
    "event-detail-request start",
    "stop start",
    "stop complete",
  ]);
  assert.deepEqual(phases(honoName), [
    "launch start",
    "launch complete",
    "readiness start",
    "readiness complete",
    "stop start",
    "stop complete",
  ]);
  assert.equal(markers.length, 17);
  await assertCleanup();
});

test("a bad redirect header fails the redirect phase before requesting the document", async (t) => {
  const { run, phases, assertCleanup } = await fixture(t);
  const fetchPage = t.mock.fn(async (url) =>
    new URL(url).pathname === "/"
      ? new Response(null, { headers: { "x-two-renderer": "kit" } })
      : new Response(null, {
          status: 301,
          headers: { ...headers, location: path, "cache-control": "public" },
        }),
  );
  await assert.rejects(run({ fetchPage }), {
    message: "Event detail rollback phase failed: event-detail-redirect",
  });
  assert.equal(fetchPage.mock.callCount(), 2);
  assert.deepEqual(phases(kitName).slice(-4), [
    "home-control complete",
    "event-detail-redirect start",
    "stop start",
    "stop complete",
  ]);
  await assertCleanup();
});

test("the first startup failure survives a later sibling launch failure", async (t) => {
  const { run, startWorker, phases, assertCleanup } = await fixture(t);
  const { promise: readinessFailed, resolve } = Promise.withResolvers();
  const fetchPage = t.mock.fn();
  await assert.rejects(
    run({
      async startWorker(name, ...args) {
        if (name === honoName) return startWorker(name, ...args);
        await readinessFailed;
        await setImmediate();
        startWorker(name, ...args);
        throw new Error(privateDetail);
      },
      async waitForWorker() {
        resolve();
        throw new Error(privateDetail);
      },
      fetchPage,
    }),
    { message: "Event detail rollback phase failed: readiness" },
  );
  assert.equal(fetchPage.mock.callCount(), 0);
  assert.deepEqual(phases(kitName), ["launch start", "stop start", "stop complete"]);
  assert.deepEqual(phases(honoName), [
    "launch start",
    "launch complete",
    "readiness start",
    "stop start",
    "stop complete",
  ]);
  await assertCleanup();
});

test("the Markdown fixture preserves a proof error through database teardown", async (t) => {
  const proofError = new Error("Synthetic proof failure");
  const report = t.mock.method(console, "error", () => {});
  const rejectCleanup = () => Promise.reject(new Error(privateDetail));
  const sql = Object.assign(t.mock.fn(rejectCleanup), { end: t.mock.fn(rejectCleanup) });
  sql.mock.mockImplementationOnce(() => Promise.reject(proofError));
  await assert.rejects(
    assertEventMarkdownParity({
      hono: { origin: "http://127.0.0.1:1" },
      startKit: async () => {},
      databaseUrl: "postgres://127.0.0.1:1/fixture",
      connectDatabase: () => sql,
    }),
    (error) => error === proofError,
  );
  assert.equal(sql.mock.callCount(), 2);
  const message = "Event Markdown fixture database cleanup failed";
  const cleanupOnly = withEventMarkdownDatabaseCleanup(async () => {}, sql, "synthetic", []);
  await assert.rejects(cleanupOnly, { message });
  assert.equal(sql.end.mock.callCount(), 2);
  const diagnostics = report.mock.calls.map((call) => call.arguments);
  assert.deepEqual(diagnostics, [[message]]);
});

test("a bind timeout marks only the final attempt and redacts all Worker output", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "kit-event-detail-bind-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const workers = [];
  const stderr = t.mock.method(process.stderr, "write", () => true);
  const reportPhase = t.mock.fn();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const firstPort = 32123;
  const collision = `Address already in use (127.0.0.1:${firstPort}). Please check that you are not already running a server on this address or specify a different port with --port.`;

  await assert.rejects(
    startLoopbackWorker(
      kitName,
      (port) => {
        const collided = port === firstPort;
        const child = Object.assign(new EventEmitter(), {
          exitCode: collided ? 1 : null,
          signalCode: null,
          stderr: new EventEmitter(),
          kill: t.mock.fn(() => child.emit("close")),
        });
        if (!collided) now += 60_000;
        void setImmediate().then(() => {
          child.stderr.emit("data", collided ? `${collision}\n${privateDetail}` : privateDetail);
          if (collided) child.emit("close");
        });
        return child;
      },
      workers,
      { selectPort: () => firstPort + workers.length, reportPhase },
    ),
    /Timed out waiting for Wrangler to bind/,
  );
  await setImmediate();
  assert.equal(workers.length, 2);
  assert.ok(workers.every((worker) => worker.log.includes(privateDetail)));
  assert.equal(workers[0].reportPhase, undefined);
  assert.equal(workers[1].stopped, false);
  await cleanUpWorkers(workers, scratch, true);
  assert.equal(workers[0].child.kill.mock.callCount(), 0);
  assert.equal(workers[1].child.kill.mock.callCount(), 1);
  const stopMarkers = reportPhase.mock.calls.map((call) => call.arguments);
  assert.deepEqual(stopMarkers, [
    ["stop", "start"],
    ["stop", "complete"],
  ]);
  assert.equal(stderr.mock.callCount(), 0);
  await assert.rejects(stat(scratch), { code: "ENOENT" });
});

test("a deferred rollback Worker starts its first HTTP probe when readiness is awaited", async (t) => {
  const runner = readFileSync(new URL("./kit-worker-e2e.mjs", import.meta.url), "utf8");
  assert.match(
    runner.split("assertEventDetailRollback({")[1],
    /reportPhase,\s+deferHttpReadiness: true,/,
  );
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response());
  const reportPhase = t.mock.fn();
  const worker = await startLoopbackWorker(
    kitName,
    (port) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
      const ready = { event: "DEV_SERVER_READY", ip: "127.0.0.1", port };
      void setImmediate().then(() => child.emit("message", JSON.stringify(ready)));
      return child;
    },
    [],
    { selectPort: () => 32123, deferHttpReadiness: true, reportPhase },
  );
  assert.equal(worker.reportPhase, reportPhase);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await worker.waitForReadiness(), null);
  assert.equal(await worker.waitForReadiness(), null);
  assert.equal(fetch.mock.callCount(), 1);
});
