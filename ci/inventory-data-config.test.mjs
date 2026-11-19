import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDataConfig } from "./inventory-data-config.mjs";
import { composeSelectorFields } from "./inventory-selector-fields.mjs";

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

test("rejects reserved import bindings and malformed regular expressions", () => {
  const names =
    "await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield implements interface let package private protected public static eval arguments undefined defineConfig";
  for (const name of names.split(" ")) {
    assert.throws(() => validate(config(`...${name}`, `import ${name} from "./base";`)), name);
  }
  for (const expression of ["/*/", "/a/gg", "/a/z", "/a/**", "/+/", "/?/"]) {
    assert.throws(() => validate(config(`grep: ${expression}`)), expression);
  }
  assert.doesNotThrow(() =>
    validate(config("...base, grep: /chosen$/i, class: true", 'import base from "./base";')),
  );
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

test("composes recognized file-selector fields in source order", () => {
  const base = { testDir: "base", testMatch: ["a.spec.ts"], projects: [{ testDir: "p" }] };
  assert.deepEqual(composeSelectorFields([base, { testDir: "child" }]), {
    ...base,
    testDir: "child",
  });
  assert.deepEqual(composeSelectorFields([{ testDir: "child" }, base]), base);
  assert.deepEqual(composeSelectorFields([base, { testIgnore: [] }, { projects: [] }]), {
    ...base,
    testIgnore: [],
    projects: [],
  });
  const inherited = composeSelectorFields([base, { testMatch: ["b.spec.ts"] }]);
  base.projects[0].testDir = "mutated";
  base.testMatch.push("mutated");
  assert.deepEqual(inherited, {
    testDir: "base",
    testMatch: ["b.spec.ts"],
    projects: [{ testDir: "p" }],
  });
});

test("never discards config or project title filters during composition", () => {
  const unfiltered = { testMatch: ["example.spec.ts"] };
  for (const selector of ["grep", "grepInvert"]) {
    for (const filtered of [{ [selector]: "chosen" }, { projects: [{ [selector]: "chosen" }] }]) {
      for (const records of [
        [unfiltered, filtered],
        [filtered, unfiltered],
      ]) {
        assert.throws(() => composeSelectorFields(records), /Unsupported selector field/);
      }
    }
  }
});

test("refuses unsupported and malformed selector data instead of discarding it", () => {
  for (const record of [
    { grep: "filtered" },
    { projects: [{ grepInvert: "filtered" }] },
    { testDir: null },
    { testMatch: ["a", 1] },
    { testIgnore: Array(1) },
    { projects: Array(1) },
    { projects: [{ projects: [] }] },
  ])
    assert.throws(() => composeSelectorFields([record]), TypeError);
  assert.deepEqual(composeSelectorFields([]), {});
});
