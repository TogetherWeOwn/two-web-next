import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memberRefusal, runWork } from "./kit-activity-log-assert.mjs";
import { routeA11y } from "./kit-activity-log-metrics.mjs";
import { viewportPngs } from "./kit-activity-log-png.mjs";
import * as visual from "./kit-activity-log-visual.mjs";

test("capture refuses fixture content and keyboard drift", () => {
  assert.equal(visual.expectedContent(true).at(-1), "/admin/activity-log?page=1");
  const state = [true, false, false];
  const content = visual.expectedContent(false);
  visual.validateView(content, state, false, false);
  assert.throws(() => visual.validateView(content, [true, true, false], false, true), /state/);
  assert.throws(() => visual.validateView(["unapproved"], state, false, false), /content/);
});

class TimeoutError extends Error {}
test("fresh capture sessions isolate Lighthouse timeouts but not policy drift", async (t) => {
  const noop = async () => undefined;
  const stall = () => new Promise((_, reject) => setImmediate(reject, new TimeoutError()));
  const modes =
    "document asset disallowed pending rejected hono fonts capture-fonts capture-error capture-inflight capture-timeout";
  for (const mode of modes.split(" ")) {
    const navError = mode === "capture-timeout" ? new TimeoutError() : new Error("target closed");
    const shots = [];
    const keys = [];
    const consumed = new Set([0]); // Functional context already rotated its cookie.
    let closed = 0;
    let cookie = 0;
    let url, intercept;
    const lateFetch = t.mock.fn(stall);
    const stages = [];
    const request = (href, nav, fetch) =>
      intercept({
        request: () => ({ url: () => href, isNavigationRequest: () => nav, method: () => "GET" }),
        fetch,
        fulfill: noop,
        abort: noop,
      });
    const fixture = {
      close: async () => {
        if (++closed === 6 && mode === "pending")
          await request(`${visual.origin}/styles.css`, false, lateFetch);
        if (mode === "hono") {
          t.mock.timers.tick(visual.browserWorkMs);
          return new Promise(noop);
        }
      },
      addCookies: ([session]) => {
        cookie = session.value;
      },
      route: (_, handler) => {
        intercept = handler;
      },
      newPage: () => fixture,
      on: noop,
      evaluate: () => {
        if (!(mode === "capture-fonts" || (mode === "fonts" && closed === 5))) return true;
        queueMicrotask(() => t.mock.timers.tick(5_000));
        return new Promise(noop);
      },
      setDefaultTimeout: noop,
      goto: async (href) => {
        url = href;
        const status = consumed.has(cookie) ? 302 : 200;
        consumed.add(cookie);
        const renderer = mode === "hono" ? "hono" : "kit";
        const headers = { "x-two-renderer": renderer, "cache-control": "private, no-store" };
        const response = {
          url: () => href,
          status: () => status,
          headers: () => headers,
          dispose: noop,
        };
        const closeFetch = () => new Promise((_, reject) => setImmediate(reject, navError));
        if (mode === "capture-inflight") void request(href, true, closeFetch);
        if (mode.startsWith("capture-") && mode !== "capture-fonts") throw navError;
        if (closed !== 5 || !["document", "asset", "disallowed"].includes(mode)) return response;
        if (mode === "document") void request(href, true, stall);
        else {
          await request(href, true, async () => response);
          void request(`${visual.origin}/styles.css`, false, stall);
          if (mode === "disallowed") void request(`${visual.origin}/unexpected.css`, false, noop);
        }
        throw new TimeoutError("navigation timed out first");
      },
      waitForFunction: () => assert.equal(keys.at(-1), "ArrowRight"),
      keyboard: { press: (key) => keys.push(key) },
      getByTestId: () => ({
        evaluate: () => {
          const scroll = closed === 4 && keys.at(-1) === "ArrowRight";
          return [visual.expectedContent(url.includes("?")), [true, scroll, scroll]];
        },
      }),
      screenshot: ({ path }) => shots.push(path),
    };
    const browser = { newContext: () => fixture };
    const mark = (stage) => stages.push(stage);
    const measure = t.mock.fn(() =>
      mode === "rejected" ? Promise.reject(new Error("transport")) : new Promise(noop),
    );
    const mint = () => ({ value: consumed.size });
    const fakeClock = mode === "hono" || mode.endsWith("fonts");
    if (fakeClock) t.mock.timers.enable({ apis: ["setTimeout"] });
    const options = { audit: noop, measure, mark, ms: 10 };
    const collect = () => visual.collectVisuals(browser, mint, ".", options);
    const teardown = () => visual.withDeadline(() => fixture.close(), 10_000);
    const report = mode === "hono" ? runWork(collect, teardown, mark) : collect();
    const early = mode === "hono" || mode.startsWith("capture-");
    if (mode === "capture-fonts") await assert.rejects(report, visual.BrowserDeadline);
    else if (mode === "hono") await assert.rejects(report, /provenance drift/);
    else if (early) await assert.rejects(report, (error) => error === navError);
    else if (mode === "disallowed") await assert.rejects(report, /unexpected visual diagnostic/);
    else assert.equal(await report, null);
    if (fakeClock) t.mock.timers.reset();
    if (early && mode !== "capture-fonts") assert.deepEqual(stages, ["CAPTURE"]);
    assert.equal(lateFetch.mock.callCount(), 0);
    assert.equal(closed, early ? Number(mode === "hono") : mode === "disallowed" ? 5 : 6);
    assert.equal(consumed.size, early ? 2 : 7);
    assert.equal(measure.mock.callCount(), Number(mode === "pending" || mode === "rejected"));
    assert.deepEqual(shots, early ? [] : Object.keys(viewportPngs));
    assert.deepEqual(keys, early ? [] : [...Array(11).fill("Tab"), "ArrowRight"]);
  }
});

for (const stallAt of ["AXE_INJECT", "AXE_EVALUATE"]) {
  test(`a stall in ${stallAt} rejects instead of producing audit metrics`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const mark = t.mock.fn();
    const evaluate = () => {
      if (mark.mock.calls.at(-1).arguments[0] !== stallAt) return;
      queueMicrotask(() => t.mock.timers.tick(5_000));
      return new Promise(() => undefined);
    };
    const audit = routeA11y({ evaluate }, mark, { source: "stub", tags: [] });
    await assert.rejects(audit, visual.BrowserDeadline);
    assert.equal(mark.mock.callCount(), stallAt === "AXE_INJECT" ? 1 : 2);
  });
}

test("refusal deadlines abort fetch and prevent follow-on reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const late = Promise.withResolvers();
  const request = t.mock.fn(() => ({
    status: 403,
    headers: new Headers({ "x-two-renderer": "kit" }),
    text: () => {
      queueMicrotask(() => t.mock.timers.tick(visual.browserWorkMs));
      return late.promise;
    },
  }));
  let probes;
  const work = (budget) => (probes = memberRefusal("/", {}, budget, request).then(assert.fail));
  const run = runWork(work, async () => undefined, assert.fail);
  await assert.rejects(run, visual.BrowserDeadline);
  assert.equal(request.mock.calls[0].arguments[1].signal.aborted, true);
  late.resolve("denied");
  await assert.rejects(probes, visual.BrowserDeadline);
  assert.equal(request.mock.callCount(), 1);
});

test("fixture CLI exits after cleanup despite a live measurement handle", () => {
  const harness = new URL("./kit-activity-log-assert.mjs", import.meta.url);
  for (const code of [0, 21]) {
    const stub = `import { exitFixture } from ${JSON.stringify(harness.href)};
      setInterval(()=>{},60_000);
      await exitFixture(${code ? 'Promise.reject(new RangeError("private-exception"))' : "Promise.resolve()"}, RangeError);`;
    const run = spawnSync(process.execPath, ["-e", stub], { encoding: "utf8", timeout: 3_000 });
    assert.deepEqual([run.status, run.stdout, run.stderr], [code, "", ""]);
  }
});

test("runner separates watchdog and assertion failures and admits only a valid completion", (t) => {
  const source = readFileSync(new URL("./kit-activity-log-run.sh", import.meta.url), "utf8");
  const runner = source.match(/^LC_ALL=C timeout [\s\S]+$/m)?.[0];
  assert.ok(runner);
  const root = mkdtempSync(join(tmpdir(), "kit-watchdog-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake =
    '#!/bin/bash\nprintf "private-out\\n"; printf "private-err\\n" >&2; exit "$RESULT"\n';
  writeFileSync(join(root, "node"), fake, { mode: 0o700 });
  mkdirSync(join(root, "screenshots"));
  const stub = `set -euo pipefail
export PATH="$1:$PATH" RESULT=$2
scratch=$1 RUNNER_TEMP=$1 watchdog=$3
timeout() {
  [[ $watchdog != true ]] || printf "timeout: sending signal TERM to command 'bash'\\n" >&2
  printf 'private-watchdog-file\\n' >&2
  shift 4; "$@"
}
`;
  const metrics = `populated-desktop.png a11y: PASS violations=0 incomplete=0
empty-desktop.png a11y: PASS violations=0 incomplete=0
populated-desktop.png lighthouse: unavailable
`;
  writeFileSync(join(root, "metrics.txt"), metrics);
  const cases = [
    ["AXE_EVALUATE\n", 124, true, "WATCHDOG stage=AXE_EVALUATE"],
    ["TEARDOWN\n", 137, true, "WATCHDOG stage=TEARDOWN"],
    ["TEARDOWN\n", 137, false, "UNKNOWN stage=TEARDOWN"],
    ["MODERATOR\n", 20, false, "ASSERTION stage=MODERATOR"],
    ["FONTS\n", 21, false, "DEADLINE stage=FONTS"],
    ["CAPTURE\n", 0, false, "UNKNOWN stage=CAPTURE"],
    ["COMPLETE\n", 1, false, "UNKNOWN stage=COMPLETE"],
    ["COMPLETE\nprivate-status\n", 0, false, "UNKNOWN stage=UNKNOWN"],
    ["COMPLETE\n\0", 0, false, "UNKNOWN stage=UNKNOWN"],
    [null, 0, false, "UNKNOWN stage=UNKNOWN"],
    ["COMPLETE\n", 0, false, "PASS stage=COMPLETE"],
  ];
  for (const [record, exitCode, watchdog, verdict] of cases) {
    const status = join(root, "browser-stage");
    if (record === null) rmSync(status);
    else writeFileSync(status, record);
    const argv = ["-c", stub + runner, "fixture", root, String(exitCode), String(watchdog)];
    const env = { PATH: process.env.PATH };
    const run = spawnSync("bash", argv, { env, encoding: "utf8", timeout: 3_000 });
    const passed = verdict.startsWith("PASS");
    const tail = passed ? "PASS: Activity-log fixture, rendered states and route a11y\n" : "";
    assert.deepEqual([run.status, run.stderr], [passed ? 0 : 1, ""]);
    assert.equal(run.stdout, `Activity-log browser: outcome=${verdict}\n${metrics}${tail}`);
    assert.equal(existsSync(join(root, "kit-activity-log-approved")), passed);
  }
});

test("only the protected diagnostic publishes the validated directory", () => {
  const url = new URL("../.github/workflows/kit-activity-log-diagnostic.yml", import.meta.url);
  const source = readFileSync(url, "utf8");
  assert.match(source, /^on:\s+workflow_dispatch:/m);
  assert.match(source, /PUBLICATION_ADMITTED.*== true/);
  assert.match(source, /validatePngDirectory\([\s\S]+uses: actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(source, /path: .*\/kit-activity-log-approved\/\s+retention-days: 1/);
  assert.equal(source.match(/uses: actions\/upload-artifact@/g)?.length, 1);
});
