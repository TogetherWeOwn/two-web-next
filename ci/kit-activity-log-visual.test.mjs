import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
  const modes = "document asset disallowed pending rejected hono fonts capture-fonts nav";
  for (const mode of modes.split(" ")) {
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
        if (mode === "hono") throw new TimeoutError("close timed out");
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
        if (!(mode === "capture-fonts" || (mode === "fonts" && closed === 5))) return;
        queueMicrotask(() => t.mock.timers.tick(5_000));
        return new Promise(noop);
      },
      setDefaultTimeout: noop,
      goto: async (href) => {
        url = href;
        const status = consumed.has(cookie) ? 302 : 200;
        consumed.add(cookie);
        if (mode === "nav") throw new TimeoutError();
        const renderer = mode === "hono" ? "hono" : "kit";
        const headers = { "x-two-renderer": renderer, "cache-control": "private, no-store" };
        const response = {
          url: () => href,
          status: () => status,
          headers: () => headers,
          dispose: noop,
        };
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
    const fakeClock = mode.endsWith("fonts");
    if (fakeClock) t.mock.timers.enable({ apis: ["setTimeout"] });
    const options = { audit: noop, measure, mark, ms: 10, TimeoutError };
    const report = visual.collectVisuals(browser, mint, ".", options);
    const early = ["hono", "nav", "capture-fonts"].includes(mode);
    if (mode === "nav") await assert.rejects(report, TimeoutError);
    else if (mode === "capture-fonts") await assert.rejects(report, visual.BrowserDeadline);
    else if (early) await assert.rejects(report, /provenance drift/);
    else if (mode === "disallowed") await assert.rejects(report, /unexpected visual diagnostic/);
    else assert.equal(await report, null);
    if (fakeClock) t.mock.timers.reset();
    if (mode === "capture-fonts") assert.deepEqual(stages, ["CAPTURE", "FONTS"]);
    assert.equal(lateFetch.mock.callCount(), 0);
    assert.equal(closed, early ? 1 : 6);
    assert.equal(consumed.size, closed + 1);
    assert.equal(measure.mock.callCount(), Number(mode === "pending" || mode === "rejected"));
    assert.deepEqual(shots, early ? [] : Object.keys(viewportPngs));
    assert.deepEqual(keys, early ? [] : [...Array(11).fill("Tab"), "ArrowRight"]);
  }
});

for (const stallAt of ["AXE_INJECT", "AXE_EVALUATE"]) {
  test(`a stall in ${stallAt} rejects instead of producing audit metrics`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stages = [];
    const page = {
      evaluate: t.mock.fn(() => {
        if (stages.at(-1) !== stallAt) return undefined;
        queueMicrotask(() => t.mock.timers.tick(5_000));
        return new Promise(() => undefined);
      }),
    };
    const mark = (stage) => stages.push(stage);
    const audit = routeA11y(page, mark, () => ({ source: "stub", tags: [] }));
    await assert.rejects(audit, visual.BrowserDeadline);
    assert.equal(stages.at(-1), stallAt);
    assert.equal(page.evaluate.mock.callCount(), stallAt === "AXE_INJECT" ? 1 : 2);
  });
}

test("fixture CLI exits after cleanup despite a live measurement handle", () => {
  const source = readFileSync(new URL("./kit-activity-log-assert.mjs", import.meta.url), "utf8");
  const entry = source.match(/^await main\(\)\.then\([\s\S]+$/m)?.[0];
  assert.ok(entry);
  for (const code of [0, 21]) {
    const thrown = code ? 'throw new errors.TimeoutError("private-exception")' : "";
    const stub = `const visual = { AssertionFailure: class extends Error {}, BrowserDeadline: class extends Error {} };
      const errors = { TimeoutError: class extends Error {} };
      async function main(){setInterval(()=>{},60_000);await new Promise(setImmediate);${thrown}}`;
    const argv = ["--input-type=module", "-e", `${stub}\n${entry}`];
    const run = spawnSync(process.execPath, argv, { encoding: "utf8", timeout: 3_000 });
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
  const stub = `set -euo pipefail
scratch=$RUNNER_TEMP
timeout() {
  [[ $WATCHDOG != yes ]] || printf "timeout: sending signal TERM to command 'bash'\\n" >&2
  printf 'private-watchdog-file\\n' >&2
  shift 4; "$@"
}
`;
  const metrics = [
    "populated-desktop.png a11y: PASS violations=0 incomplete=0",
    "empty-desktop.png a11y: PASS violations=0 incomplete=0",
    "populated-desktop.png lighthouse: unavailable",
  ];
  const cases = [
    ["AXE_EVALUATE\n", 124, true, "WATCHDOG", "AXE_EVALUATE"],
    ["TEARDOWN\n", 137, true, "WATCHDOG", "TEARDOWN"],
    ["TEARDOWN\n", 137, false, "UNKNOWN", "TEARDOWN"],
    ["MODERATOR\n", 20, false, "ASSERTION", "MODERATOR"],
    ["FONTS\n", 21, false, "DEADLINE", "FONTS"],
    ["FIXTURE\n", 22, false, "ERROR", "FIXTURE"],
    ["MODERATOR\n", 1, false, "UNKNOWN", "MODERATOR"],
    ["CAPTURE\n", 0, false, "UNKNOWN", "CAPTURE"],
    ["COMPLETE\n", 1, false, "UNKNOWN", "COMPLETE"],
    ["COMPLETE\nprivate-status\n", 0, false, "UNKNOWN", "UNKNOWN"],
    ["COMPLETE\n\0", 0, false, "UNKNOWN", "UNKNOWN"],
    ["COMPLETE", 0, false, "UNKNOWN", "UNKNOWN"],
    [null, 0, false, "UNKNOWN", "UNKNOWN"],
    ["COMPLETE\n", 0, false, "PASS", "COMPLETE"],
  ];
  for (const [record, exitCode, watchdog, outcome, stage] of cases) {
    const dir = mkdtempSync(join(root, "case-"));
    mkdirSync(join(dir, "screenshots"));
    if (record !== null) writeFileSync(join(dir, "browser-stage"), record);
    writeFileSync(join(dir, "metrics.txt"), `${metrics.join("\n")}\n`);
    const run = spawnSync("bash", ["-c", `${stub}${runner}`], {
      env: {
        PATH: `${root}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        RESULT: String(exitCode),
        WATCHDOG: watchdog ? "yes" : "no",
      },
      encoding: "utf8",
      timeout: 3_000,
    });
    const passed = outcome === "PASS";
    assert.deepEqual([run.status, run.stderr], [passed ? 0 : 1, ""]);
    const lines = [`Activity-log browser: outcome=${outcome} stage=${stage}`, ...metrics];
    if (passed) lines.push("PASS: Activity-log fixture, rendered states and route a11y");
    assert.equal(run.stdout, `${lines.join("\n")}\n`);
    assert.equal(existsSync(join(dir, "kit-activity-log-approved")), passed);
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
