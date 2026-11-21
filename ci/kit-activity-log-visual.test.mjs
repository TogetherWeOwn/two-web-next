import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { memberRefusal, runWork } from "./kit-activity-log-assert.mjs";
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
  const noop = async () => undefined;
  const lapse = clock(t);
  const stall = () => new Promise((_, reject) => setImmediate(reject, new TimeoutError()));
  const modes =
    "dom asset-dom asset-body late late-method capture-timeout capture-budget document asset disallowed pending rejected hono fonts capture-fonts capture-stalled";
  for (const mode of modes.split(" ")) {
    const hono = mode === "hono";
    const expired = mode === "capture-budget";
    const navError = new Error("target closed");
    const stalled = hono || mode === "capture-stalled";
    const early = hono || mode.startsWith("capture-");
    const lateDenied = mode.startsWith("late");
    const shots = [];
    const keys = [];
    const consumed = new Set([0]); // Functional context already rotated its cookie.
    let closed = 0;
    let closing = false;
    let cookie = 0;
    let url, intercept;
    let observe;
    const navigation = Promise.withResolvers();
    const abortNavigation = t.mock.fn(() => {
      navigation.reject(navError);
      return pending;
    });
    const lateFetch = t.mock.fn(stall);
    const lateFulfill = t.mock.fn(noop);
    const assetBody = t.mock.fn(stall);
    const stages = [];
    const request = (href, nav, fetch, abort = noop, fulfill = noop, method = "GET") => {
      const req = { url: () => href, isNavigationRequest: () => nav, method: () => method };
      observe?.(req);
      // Playwright emits request events during close but doesn't call route handlers.
      if (closing) return;
      return intercept({
        request: () => req,
        fetch,
        fulfill,
        abort,
      });
    };
    const lateRequest = () => {
      const href = `${visual.origin}/${mode === "late" ? "unexpected.css" : "styles.css"}`;
      const method = mode === "late-method" ? "POST" : "GET";
      void request(href, false, lateFetch, noop, lateFulfill, method);
    };
    const fixture = {
      close: async () => {
        closing = true;
        await Promise.resolve();
        if ((++closed === 6 && (mode === "pending" || lateDenied)) || expired) lateRequest();
        if (hono || expired) return lapse(visual.browserWorkMs);
      },
      addCookies: ([session]) => {
        closing = false;
        cookie = session.value;
      },
      route: (_, handler) => {
        intercept = handler;
      },
      newPage: () => fixture,
      on: (event, handler) => {
        if (event === "request") observe = handler;
      },
      evaluate: () =>
        mode === "capture-fonts" || (mode === "fonts" && closed === 5) ? lapse(5_000) : true,
      setDefaultTimeout: noop,
      waitForLoadState: async () => (/^asset(-dom)?$/.test(mode) ? stall() : undefined),
      goto: async (href, { waitUntil } = {}) => {
        url = href;
        const status = consumed.has(cookie) ? 302 : 200;
        consumed.add(cookie);
        const renderer = mode === "hono" ? "hono" : "kit";
        const headers = { "x-two-renderer": renderer, "cache-control": "private, no-store" };
        const dom = closed === 5 && mode === "dom";
        const response = {
          url: () => href,
          status: () => status,
          headers: () => headers,
          dispose: async () => (dom ? Promise.reject(navError) : stalled ? pending : undefined),
        };
        if (stalled) setImmediate(() => lapse(hono ? visual.browserWorkMs : 5_000));
        if (mode === "capture-timeout") {
          void request(href, true, stall, abortNavigation);
          return navigation.promise;
        }
        if (stalled) {
          void request(href, true, async () => response);
          throw navError;
        }
        if (dom) await request(href, true, async () => response);
        if (closed !== 5 || !/^(document|asset|disallowed)/.test(mode)) return response;
        if (mode === "document") void request(href, true, stall);
        else {
          await request(href, true, async () => response);
          const css = () => ({ ...response, body: assetBody });
          void request(`${visual.origin}/styles.css`, false, mode === "asset-body" ? css : stall);
          if (mode === "disallowed") void request(`${visual.origin}/unexpected.css`, false, noop);
          if (waitUntil === "commit" || mode === "asset-body") return response;
        }
        throw new Error("navigation timed out first");
      },
      waitForFunction: () => assert.equal(keys.at(-1), "ArrowRight"),
      keyboard: { press: (key) => keys.push(key) },
      getByTestId: () => ({
        evaluate: () => {
          const scroll = closed === 4 && keys.at(-1) === "ArrowRight";
          if (closed === 5 && mode.endsWith("dom")) return [[], [true, scroll, scroll]];
          return [visual.expectedContent(url.includes("?")), [true, scroll, scroll]];
        },
      }),
      screenshot: ({ path }) => (expired ? lapse(visual.browserWorkMs) : shots.push(path)),
    };
    const browser = { newContext: () => fixture };
    const measure = t.mock.fn(() =>
      mode === "rejected" ? Promise.reject(new Error("transport")) : new Promise(noop),
    );
    const mint = () => ({ value: consumed.size });
    const mark = (stage) => {
      stages.push(stage);
      if (stage === "TEARDOWN" && closed === 5 && mode === "pending") lateRequest();
    };
    const drift = mode.endsWith("dom");
    const denied = mode === "disallowed" || mode === "asset-body";
    const options = { audit: noop, measure, mark, ms: drift || denied ? 0 : 10, TimeoutError };
    const collect = ({ signal } = new AbortController()) =>
      visual.collectVisuals(browser, mint, ".", { ...options, signal });
    const report = hono || expired ? runWork(collect, mark, fixture.close) : collect();
    if (mode === "capture-fonts" || expired) await assert.rejects(report, visual.BrowserDeadline);
    else if (drift) await assert.rejects(report, /visual content drift/, mode);
    else if (hono || lateDenied) await assert.rejects(report, visual.AssertionFailure);
    else if (denied) await assert.rejects(report, /unexpected visual diagnostic/, mode);
    else if (mode === "capture-timeout") {
      await assert.rejects(report, TimeoutError);
      await assert.rejects(navigation.promise, (error) => error === navError);
      assert.equal(abortNavigation.mock.callCount(), 1);
    } else if (early) await assert.rejects(report, (error) => error === navError);
    else assert.equal(await report, null);
    assert.deepEqual([lateFetch.mock.callCount(), lateFulfill.mock.callCount()], [0, 0], mode);
    if (mode === "asset-body") assert.equal(assetBody.mock.callCount(), 1);
    if (early) assert.equal(stages.at(-1), mode.endsWith("fonts") ? "FONTS" : "CAPTURE");
    assert.equal(closed, early ? Number(hono || expired) : drift || denied ? 5 : 6);
    assert.equal(consumed.size, early ? 2 : 7);
    assert.equal(measure.mock.callCount(), Number(lateDenied || /^(pending|rejected)$/.test(mode)));
    if (stalled) await new Promise(setImmediate);
    assert.deepEqual(shots, early ? [] : Object.keys(viewportPngs));
    assert.deepEqual(keys, early ? [] : [...Array(11).fill("Tab"), "ArrowRight"]);
  }
});

test("fixture CLI exits after cleanup despite a live measurement handle", () => {
  const expectExit = (code, ...args) => {
    const run = spawnSync(process.execPath, args, { env: {}, timeout: 3_000 });
    assert.deepEqual([run.status, run.stdout.length, run.stderr.length], [code, 0, 0]);
  };
  expectExit(22, "ci/kit-activity-log-assert.mjs");
  const stub = `import { exitFixture } from './ci/kit-activity-log-assert.mjs';
    import { AssertionFailure, BrowserDeadline } from './ci/kit-activity-log-visual.mjs';
    const Failure = [null, AssertionFailure, BrowserDeadline, RangeError, Error][process.argv[1]];
    setInterval(()=>{},60_000); await exitFixture(Failure ? Promise.reject(new Failure('private')) : Promise.resolve(), RangeError);`;
  for (const [i, code] of [0, 20, 21, 21, 22].entries()) expectExit(code, "-e", stub, `${i}`);
});

test("fixture cleanup attempts both closes, preserving the first failure without completing", async (t) => {
  const lapse = clock(t);
  for (const dual of [true, false]) {
    const calls = [];
    const browser = t.mock.fn(() => (dual ? lapse(10_000) : undefined));
    const sql = t.mock.fn(() => Promise.reject(new Error("SQL close failed")));
    const run = runWork(() => null, calls.push.bind(calls), browser, sql);
    await assert.rejects(run, dual ? visual.BrowserDeadline : /SQL close failed/);
    assert.deepEqual([calls, browser.mock.callCount(), sql.mock.callCount()], [["TEARDOWN"], 1, 1]);
  }
});

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
  await assert.rejects(runWork(work, assert.fail), visual.BrowserDeadline);
  assert.equal(request.mock.calls[0].arguments[1].signal.aborted, true);
  late.resolve("denied");
  await assert.rejects(probes, visual.BrowserDeadline);
  assert.equal(request.mock.callCount(), 1);
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
