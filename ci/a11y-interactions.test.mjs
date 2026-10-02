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

test("themed interactions leave other routes and failures untouched", async () => {
  assert.deepEqual(await assertHomeInteractions({}, { route: "/about", status: 200 }), []);
  assert.deepEqual(await assertHomeInteractions({}, { route: "/", status: 503 }), []);
  assert.deepEqual(await assertHomeInteractions({}, { route: "/e/:key", status: 404 }), []);
});

for (const [identity, status, selectors] of [
  ["guest", 200, [".skip-link", '[data-testid="signin"]', ".event-pitch .btn", ".skip-link"]],
  ["member", 200, [".skip-link", ".skip-link"]],
  ["moderator", 200, [".skip-link", ".skip-link"]],
  ["guest", 410, [".skip-link", ".event-gone .btn", ".skip-link"]],
]) {
  test(`event ${identity} ${status} checks the actual themed entry points`, async () => {
    const calls = [];
    const page = {
      locator(selector) {
        return {
          hover: async () => {},
          evaluate: async () =>
            selector === ".skip-link" && calls.length === 0
              ? (calls.push("first-tab"), true)
              : { foreground: "rgb(21, 23, 32)", background: "rgb(163, 255, 18)" },
        };
      },
      keyboard: {
        press: async (key) => {
          assert.equal(key, "Tab");
        },
      },
      mouse: { move: async () => calls.push("clear-hover") },
      evaluate: async () => calls.push("clear-focus"),
    };
    const results = await assertHomeInteractions(page, { route: "/e/:key", identity, status });
    assert.deepEqual(
      results.map((item) => item.selector),
      selectors,
    );
    assert(results.every((item) => item.contrast >= 4.5));
    assert.deepEqual(calls, ["first-tab", "clear-hover", "clear-focus"]);
  });
}
