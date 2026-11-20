import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { viewportPngs } from "./kit-activity-log-png.mjs";
import {
  collectVisuals,
  expectedContent,
  kitDocument,
  validateView,
} from "./kit-activity-log-visual.mjs";

test("capture refuses renderer, fixture content and keyboard drift", () => {
  assert.equal(
    kitDocument(200, { "x-two-renderer": "hono", "cache-control": "private, no-store" }),
    false,
  );
  assert.equal(expectedContent(true).at(-1), "/admin/activity-log?page=1");
  const state = [true, false, false];
  const content = expectedContent(false);
  validateView(content, state, false, false);
  assert.throws(() => validateView(content, [true, true, false], false, true), /state/);
  assert.throws(() => validateView(["unapproved"], state, false, false), /content/);
});

test("keyboard capture drives native keys before an isolated Lighthouse timeout", async () => {
  const shots = [];
  const keys = [];
  const noop = () => undefined;
  let closed = 0;
  let closedBeforeMeasure;
  let intercept;
  const browser = {
    newContext: async () => {
      let url;
      let scrolled = false;
      const page = {
        goto: async (href) => {
          url = href;
          return {
            url: () => url,
            status: () => 200,
            headers: () => ({ "x-two-renderer": "kit", "cache-control": "private, no-store" }),
          };
        },
        on: noop,
        evaluate: noop,
        setDefaultTimeout: noop,
        waitForFunction: () => assert.ok(scrolled),
        keyboard: {
          press: async (key) => {
            keys.push(key);
            scrolled = key === "ArrowRight";
          },
        },
        getByTestId: () => ({
          evaluate: async () => [expectedContent(url.includes("?")), [true, scrolled, scrolled]],
        }),
        screenshot: async ({ path }) => shots.push(path),
      };
      return {
        addCookies: noop,
        close: async () => {
          closed++;
        },
        newPage: async () => page,
        route: (_, handler) => {
          intercept = handler;
        },
      };
    },
  };
  const measure = async (_, url) => {
    closedBeforeMeasure = closed;
    await intercept({
      request: () => ({ url: () => url, isNavigationRequest: () => true, method: () => "GET" }),
      fetch: () => Promise.reject(new Error("timeout")),
      abort: noop,
    });
    return "partial result";
  };
  assert.equal(await collectVisuals(browser, {}, ".", noop, measure), null);
  assert.equal(closedBeforeMeasure, 5);
  assert.equal(closed, 6);
  assert.deepEqual(shots, Object.keys(viewportPngs));
  assert.deepEqual(keys, [...Array(11).fill("Tab"), "ArrowRight"]);
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
