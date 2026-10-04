import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertHomeInteractions,
  assertProfileInteractions,
  textContrast,
} from "./a11y-interactions.mjs";

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

function profileFixture({ moderator = false, lowContrastAdmin = false } = {}) {
  const calls = [];
  const control = (name, { visible = true, lowContrast = false } = {}) => ({
    isVisible: async () => visible,
    hover: async () => calls.push(`${name}:hover`),
    focus: async () => calls.push(`${name}:focus`),
    evaluate: async () => ({
      foreground: lowContrast ? "rgb(245, 246, 251)" : "rgb(21, 23, 32)",
      background: "rgb(163, 255, 18)",
    }),
  });
  const controls = {
    ".profile-header-bar .btn": [
      control("Your profile"),
      ...(moderator ? [control("Moderator admin", { lowContrast: lowContrastAdmin })] : []),
    ],
    '[data-testid="profile-save"]': [control("Save")],
    '[data-testid="profile-cancel"]': [control("Cancel", { visible: false })],
  };
  const page = {
    locator(selector) {
      if (["body", ".skip-link"].includes(selector)) return { evaluate: async () => true };
      const matches = controls[selector] || [];
      return {
        count: async () => matches.length,
        nth: (index) => matches[index],
        isVisible: async () => {
          assert(matches.length <= 1, "strict mode violation: locator matches multiple controls");
          return matches.length === 1 && matches[0].isVisible();
        },
        hover: async () => matches[0].hover(),
        focus: async () => matches[0].focus(),
        evaluate: async () => matches[0].evaluate(),
      };
    },
    keyboard: { press: async (key) => calls.push(key) },
    mouse: { move: async () => calls.push("clear-hover") },
    evaluate: async () => true,
  };
  return { page, calls, controls };
}

for (const identity of ["member", "moderator"]) {
  test(`profile ${identity} audits every visible control in a multi-match selector`, async () => {
    const { page, calls, controls } = profileFixture({ moderator: identity === "moderator" });
    const results = await assertProfileInteractions(page, { route: "/members/:user", status: 200 });
    const names =
      identity === "moderator"
        ? ["Your profile", "Moderator admin", "Save"]
        : ["Your profile", "Save"];
    assert.deepEqual(
      calls.filter((call) => !["Tab", "clear-hover"].includes(call)),
      names.flatMap((name) => [`${name}:hover`, `${name}:focus`]),
    );
    assert.equal(results.length, names.length * 2);
    assert(results.every((result) => result.contrast >= 4.5));
    assert(!results.some((result) => result.selector === '[data-testid="profile-cancel"]'));
    // Missing optional controls must also be safe, without a strict single-element operation.
    controls['[data-testid="profile-save"]'] = [];
    await assertProfileInteractions(page, { route: "/profile", status: 200, state: "editing" });
  });
}

test("profile audit rejects low contrast on the second header action", async () => {
  const { page, calls } = profileFixture({ moderator: true, lowContrastAdmin: true });
  await assert.rejects(
    assertProfileInteractions(page, { route: "/profile", status: 200 }),
    /\.profile-header-bar \.btn\[1\] hover contrast .* is below 4\.5:1/,
  );
  assert(calls.includes("Your profile:focus"));
  assert(calls.includes("Moderator admin:hover"));
  assert.equal(calls.at(-1), "clear-hover");
});
