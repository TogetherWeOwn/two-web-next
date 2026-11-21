import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
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

test("fresh capture sessions isolate Lighthouse timeouts but not policy drift", async (t) => {
  const noop = async () => undefined;
  const stall = () => new Promise((_, reject) => setImmediate(reject, new Error("fetch timeout")));
  for (const mode of ["document", "asset", "disallowed", "pending", "rejected", "hono"]) {
    const shots = [];
    const keys = [];
    const consumed = new Set([0]); // Functional context already rotated its cookie.
    let closed = 0;
    let cookie = 0;
    let url, intercept;
    const request = (href, nav, fetch) =>
      intercept({
        request: () => ({ url: () => href, isNavigationRequest: () => nav, method: () => "GET" }),
        fetch,
        fulfill: noop,
        abort: noop,
      });
    const fixture = {
      close: () => ++closed,
      addCookies: ([session]) => {
        cookie = session.value;
      },
      route: (_, handler) => {
        intercept = handler;
      },
      newPage: () => fixture,
      on: noop,
      evaluate: noop,
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
      screenshot: ({ path }) => shots.push(path),
    };
    const browser = { newContext: () => fixture };
    const measure = t.mock.fn(() =>
      mode === "rejected" ? Promise.reject(new Error("transport")) : new Promise(noop),
    );
    const mint = () => ({ value: consumed.size });
    const report = visual.collectVisuals(browser, mint, ".", { audit: noop, measure, ms: 10 });
    if (mode === "hono") await assert.rejects(report, /provenance drift/);
    else if (mode === "disallowed") await assert.rejects(report, /unexpected visual diagnostic/);
    else assert.equal(await report, null);
    assert.equal(closed, mode === "hono" ? 1 : 6);
    assert.equal(consumed.size, closed + 1);
    assert.equal(measure.mock.callCount(), Number(mode === "pending" || mode === "rejected"));
    assert.deepEqual(shots, mode === "hono" ? [] : Object.keys(viewportPngs));
    assert.deepEqual(keys, mode === "hono" ? [] : [...Array(11).fill("Tab"), "ArrowRight"]);
  }
});

test("fixture CLI exits after cleanup despite a live measurement handle", () => {
  const source = readFileSync(new URL("./kit-activity-log-assert.mjs", import.meta.url), "utf8");
  const entry = source.match(/^(?:await )?main\(\)\.then\([\s\S]+$/m)?.[0];
  assert.ok(entry);
  const stub = "async function main(){setInterval(()=>{},60_000);await new Promise(setImmediate);}";
  const argv = ["--input-type=module", "-e", `${stub}\n${entry}`];
  const run = execFileSync(process.execPath, argv, { timeout: 3_000 });
  assert.equal(run.toString(), "PASS kit-activity-log\n");
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
