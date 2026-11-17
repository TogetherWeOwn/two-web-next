import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDataConfig } from "./inventory-data-config.mjs";

const header = 'import { defineConfig } from "@playwright/test";';
const config = (body, prefix = "") =>
  `${header} ${prefix} export default defineConfig({ ${body} });`;
const validate = (source) => validateDataConfig(source, "fixture");

test("accepts data-only configs and declared spreads", () => {
  assert.doesNotThrow(() =>
    validate(config('testDir: "./e2e", projects: [{ name: "p", use: { mobile: true } }]')),
  );
  assert.doesNotThrow(() =>
    validate(config("...base, grep: /chosen$/", 'import base from "./playwright.base.config";')),
  );
});

test("rejects unmodeled callee bindings, export mutation and executable values", () => {
  for (const source of [
    "function defineConfig(c) { return c; } export default defineConfig({});",
    `${header} const c = defineConfig({}); c.grep = /chosen$/; export default c;`,
    config("metadata: Object.assign({}, {})"),
    config("...base"),
    config(
      "...base",
      'import base from "./playwright.base.config"; import alias from "./other"; alias.grep = /chosen$/;',
    ),
  ])
    assert.throws(() => validate(source));
});

test("rejects prototype setters at config and project scopes", () => {
  for (const selector of ["grep", "grepInvert"]) {
    for (const key of ["__proto__", '"__proto__"', "'__proto__'"]) {
      assert.throws(() => validate(config(`${key}: { ${selector}: /chosen$/ }`)));
      assert.throws(() => validate(config(`projects: [{ ${key}: { ${selector}: /chosen$/ } }]`)));
    }
  }
});

test("rejects trailing syntax and decoy import strings", () => {
  assert.throws(() => validate(`${config("")} Object.prototype.grep = /chosen$/;`));
  assert.throws(() => validate(config("...base", 'const note = "import base from other";')));
});
