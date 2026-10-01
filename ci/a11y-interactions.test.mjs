import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHomeInteractions, textContrast } from "./a11y-interactions.mjs";

test("computed-color contrast catches both original hover regressions", () => {
  assert(textContrast("rgb(163, 255, 18)", "rgb(204, 255, 58)") < 1.1);
  assert(textContrast("rgb(245, 246, 251)", "rgb(163, 255, 18)") < 1.2);
  assert(textContrast("rgb(163, 255, 18)", "rgb(34, 36, 48)") >= 4.5);
  assert(textContrast("rgb(21, 23, 32)", "rgb(163, 255, 18)") >= 4.5);
});

test("contrast follows WCAG luminance and is symmetric", () => {
  assert.equal(textContrast("rgb(0, 0, 0)", "rgb(255, 255, 255)"), 21);
  assert.equal(textContrast("rgb(255, 255, 255)", "rgb(0, 0, 0)"), 21);
  assert.equal(textContrast("rgb(34, 36, 48)", "rgb(34, 36, 48)"), 1);
});

test("transparent colors do not silently pass an opaque contrast check", () => {
  assert.throws(() => textContrast("rgb(21, 23, 32)", "rgba(0, 0, 0, 0)"), /opaque computed RGB/);
});

test("home interactions leave other routes and failures untouched", async () => {
  assert.deepEqual(await assertHomeInteractions({}, { route: "/about", status: 200 }), []);
  assert.deepEqual(await assertHomeInteractions({}, { route: "/", status: 503 }), []);
});
