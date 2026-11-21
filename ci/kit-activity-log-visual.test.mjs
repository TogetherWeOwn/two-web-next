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

const pending = Promise.withResolvers().promise;
function clock(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return (ms, work = pending) => {
    t.mock.timers.tick(ms);
    return work;
  };
}
class TimeoutError extends Error {}
test("fresh capture sessions isolate Lighthouse timeouts but not policy drift", async (t) => {
  const lapse = clock(t);
  const noop = async () => undefined;
  const rejectLater = (error) => () => new Promise((_, reject) => setImmediate(reject, error));
  const stall = rejectLater(new TimeoutError());
  const modes =
    "capture-budget document asset disallowed pending rejected hono fonts capture-fonts capture-dispose capture-timeout";
  for (const mode of modes.split(" ")) {
    const hono = mode === "hono";
    const expired = mode === "capture-budget";
    const navError = mode === "capture-timeout" ? new TimeoutError() : new Error("target closed");
    const disposeFails = hono || mode === "capture-dispose";
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
        continue: lateFetch,
        fulfill: noop,
        abort: noop,
      });
    const fixture = {
      close: async () => {
        if ((++closed === 6 && mode === "pending") || expired)
          await request(`${visual.origin}/styles.css`, false, lateFetch);
        if (hono || expired) return lapse(visual.browserWorkMs);
      },
      addCookies: ([session]) => {
        cookie = session.value;
      },
      route: (_, handler) => {
        intercept = handler;
      },
      newPage: () => fixture,
      on: noop,
      evaluate: () =>
        mode === "capture-fonts" || (mode === "fonts" && closed === 5) ? lapse(5_000) : true,
      setDefaultTimeout: noop,
      goto: async (href) => {
        url = href;
        const status = consumed.has(cookie) ? 302 : 200;
        consumed.add(cookie);
        const renderer = mode === "hono" ? "hono" : "kit";
        const headers = { "x-two-renderer": renderer, "cache-control": "private, no-store" };
        const closeTransport = rejectLater(navError);
        const response = {
          url: () => href,
          status: () => status,
          headers: () => headers,
          dispose: hono ? () => pending : disposeFails ? closeTransport : noop,
        };
        if (hono) setImmediate(() => !closed && lapse(visual.browserWorkMs));
        if (disposeFails || mode === "capture-timeout") {
          void request(href, true, disposeFails ? async () => response : closeTransport);
          throw navError;
        }
        if (closed !== 5 || !["document", "asset", "disallowed"].includes(mode)) return response;
        if (mode === "document") void request(href, true, stall);
        else {
          await request(href, true, async () => response);
          void request(`${visual.origin}/styles.css`, false, stall);
          if (mode === "disallowed") void request(`${visual.origin}/unexpected.css`, false, noop);
        }
        throw new Error("navigation timed out first");
      },
      waitForFunction: () => assert.equal(keys.at(-1), "ArrowRight"),
      keyboard: { press: (key) => keys.push(key) },
      getByTestId: () => ({
        evaluate: () => {
          const scroll = closed === 4 && keys.at(-1) === "ArrowRight";
          return [visual.expectedContent(url.includes("?")), [true, scroll, scroll]];
        },
      }),
      screenshot: ({ path }) => (expired ? lapse(visual.browserWorkMs) : shots.push(path)),
    };
    const browser = { newContext: () => fixture };
    const mark = (stage) => stages.push(stage);
    const measure = t.mock.fn(() =>
      mode === "rejected" ? Promise.reject(new Error("transport")) : new Promise(noop),
    );
    const mint = () => ({ value: consumed.size });
    const outer = hono || expired;
    const collect = ({ signal } = new AbortController()) =>
      visual.collectVisuals(browser, mint, ".", { audit: noop, measure, mark, signal, ms: 10 });
    const teardown = () => visual.withDeadline(() => fixture.close(), 10_000);
    const report = outer ? runWork(collect, teardown, mark) : collect();
    const early = hono || mode.startsWith("capture-");
    if (mode === "capture-fonts" || expired) await assert.rejects(report, visual.BrowserDeadline);
    else if (hono) await assert.rejects(report, visual.AssertionFailure);
    else if (early) await assert.rejects(report, (error) => error === navError);
    else if (mode === "disallowed") await assert.rejects(report, /unexpected visual diagnostic/);
    else assert.equal(await report, null);
    assert.equal(lateFetch.mock.callCount(), 0, mode);
    if (early) assert.equal(stages.at(-1), mode.endsWith("fonts") ? "FONTS" : "CAPTURE");
    assert.equal(closed, early ? Number(outer) : mode === "disallowed" ? 5 : 6);
    assert.equal(consumed.size, early ? 2 : 7);
    assert.equal(measure.mock.callCount(), Number(mode === "pending" || mode === "rejected"));
    assert.deepEqual(shots, early ? [] : Object.keys(viewportPngs));
    assert.deepEqual(keys, early ? [] : [...Array(11).fill("Tab"), "ArrowRight"]);
  }
});

for (const stallAt of ["AXE_INJECT", "AXE_EVALUATE"]) {
  test(`a stall in ${stallAt} rejects instead of producing audit metrics`, async (t) => {
    const lapse = clock(t);
    const mark = t.mock.fn();
    const evaluate = () =>
      mark.mock.calls.at(-1).arguments[0] === stallAt ? lapse(5_000) : undefined;
    const audit = routeA11y({ evaluate }, mark, { source: "stub", tags: [] });
    await assert.rejects(audit, visual.BrowserDeadline);
    assert.equal(mark.mock.callCount(), stallAt === "AXE_INJECT" ? 1 : 2);
  });
}
test("refusal deadlines abort fetch and prevent follow-on reads", async (t) => {
  const lapse = clock(t);
  const late = Promise.withResolvers();
  const request = t.mock.fn(() => ({
    status: 403,
    headers: new Headers({ "x-two-renderer": "kit" }),
    text: () => lapse(visual.browserWorkMs, late.promise),
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
  const stub = `import { exitFixture } from ${JSON.stringify(harness.href)};
    setInterval(()=>{},60_000); await exitFixture(Promise.resolve(), RangeError);`;
  const run = spawnSync(process.execPath, ["-e", stub], { encoding: "utf8", timeout: 3_000 });
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, "", ""]);
});
test("runner separates watchdog and assertion failures and admits only a valid completion", (t) => {
  const source = readFileSync(new URL("./kit-activity-log-run.sh", import.meta.url), "utf8");
  const [runner] = source.match(/^LC_ALL=C timeout [\s\S]+$/m);
  const root = mkdtempSync(join(tmpdir(), "kit-watchdog-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const node = '#!/bin/bash\nprintf "out\\n"; printf "err\\n" >&2; exit "$RESULT"\n';
  writeFileSync(join(root, "node"), node, { mode: 0o700 });
  mkdirSync(join(root, "screenshots"));
  const stub = `set -euo pipefail; export PATH="$1:$PATH" RESULT=$2
scratch=$1 RUNNER_TEMP=$1
timeout() { printf '%s\\n' "$marker" >&2; shift 4; "$@"; }
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
  const env = { PATH: process.env.PATH, marker: "" };
  const options = { env, encoding: "utf8", timeout: 3_000 };
  const status = join(root, "browser-stage");
  for (const [record, exitCode, watchdog, verdict] of cases) {
    if (record === null) rmSync(status);
    else writeFileSync(status, record);
    env.marker = watchdog ? "timeout: sending signal TERM to command 'bash'" : "unused";
    const run = spawnSync("bash", ["-c", stub + runner, "fixture", root, `${exitCode}`], options);
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
