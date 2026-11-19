import assert from "node:assert/strict";
import { test } from "node:test";
import { validateInvocationCertificates } from "./invocation-certificates.mjs";

const pin = (path, digit = "a") => ({ path, sha256: digit.repeat(64) });
function fixture() {
  const identity = {
    workflow: ".github/workflows/example.yml",
    job: 1,
    step: 2,
    run: 3,
    edges: [{ root: ".", script: "test", offset: 4 }],
    terminal: 5,
  };
  const context = {
    templateInputs: [pin(".github/workflows/example.yml")],
    install: {
      workflow: identity.workflow,
      job: identity.job,
      step: 1,
      run: 0,
      root: ".",
      checkout: "checkout-1",
      method: "npm-ci",
      outcome: "success",
      dependency: "required-success",
      scriptsPolicy: "ignore-scripts=true",
      shrinkwrapAbsent: true,
      npmConfig: { includeDev: true, installStrategy: "hoisted", unknownSettings: [] },
      argv: ["ci", "--include=dev", "--no-fund"],
      inputs: [pin("package-lock.json"), pin("package.json"), pin(".npmrc")],
    },
    loader: {
      route: "local-playwright",
      root: ".",
      checkout: "checkout-1",
      entrypoint: "node_modules/playwright/cli.js",
      tsxEntrypoint: null,
      cwd: ".",
      config: "playwright.config.ts",
      tsconfig: "tsconfig.json",
      resolutionPaths: ["playwright.config.js"],
      argv: ["test"],
      nodeOptions: "",
      nodePath: "",
      tsconfigOverride: "",
      resolutionOverride: "",
      unknownSettings: [],
      inputs: [pin("playwright.config.ts"), pin("tsconfig.json")],
    },
    effects: [
      {
        name: "prepare",
        site: "setup:prepare",
        step: 0,
        run: 0,
        kind: "audited",
        audit: "reviewed fixture",
        writes: ["file:generated/output.json", "env:APP_ORIGIN"],
        inputs: [pin("prepare.mjs"), pin("prepare-helper.mjs")],
      },
      {
        name: "npm ci",
        site: "setup:install",
        step: 1,
        run: 0,
        kind: "install",
        audit: "reviewed install contract",
        writes: ["installed-packages"],
        inputs: [pin("package-lock.json")],
      },
    ],
  };
  return { identity, context };
}
const copy = (value) => structuredClone(value);
const validate = (record, reviewed = record) =>
  validateInvocationCertificates([copy(record)], [copy(reviewed)]);

test("accepts a locked local tsx route after a successful-install prerequisite in the same step", () => {
  const record = fixture();
  const { install, loader, effects } = record.context;
  install.step = effects[1].step = record.identity.step;
  install.run = effects[1].run = record.identity.run - 1;
  install.argv.push("--ignore-scripts", "--min-release-age=3");
  loader.route = "local-playwright-tsx";
  loader.tsxEntrypoint = "node_modules/tsx/dist/loader.mjs";
  loader.nodeOptions = "--import=tsx";
  validate(record);
  loader.tsxEntrypoint = "elsewhere/loader.mjs";
  assert.throws(() => validate(record), /invalid loader/);
});

test("rejects an install at the exact invocation position", () => {
  const record = fixture();
  const { install, effects } = record.context;
  install.step = effects[1].step = record.identity.step;
  install.run = effects[1].run = record.identity.run;
  assert.throws(() => validate(record), /invalid install evidence/);
});

test("rejects matching records that fail occurrence, install, or resolution constraints", () => {
  for (const [mutate, error] of [
    [(c) => (c.install.workflow = "other.yml"), /invalid install/],
    [(c) => c.install.job++, /invalid install/],
    [(c) => (c.install.step = 3), /invalid install/],
    [(c) => (c.install.root = "web"), /invalid install/],
    [(c) => c.install.inputs.shift(), /missing install/],
    [(c) => (c.install.npmConfig.includeDev = false), /invalid install/],
    [(c) => c.install.npmConfig.unknownSettings.push("unknown"), /invalid install/],
    [(c) => (c.install.scriptsPolicy = "ignore-scripts=false"), /invalid install/],
    [(c) => c.install.argv.push("--ignore-scripts=false"), /invalid install/],
    [(c) => c.install.argv.push("--no-package-lock"), /invalid install/],
    [(c) => c.install.argv.push("--include=dev"), /invalid install/],
    [(c) => (c.loader.checkout = "another-checkout"), /invalid loader/],
    [(c) => (c.loader.cwd = "web"), /invalid loader/],
    [(c) => (c.loader.entrypoint = "somewhere/cli.js"), /invalid loader/],
    [(c) => c.loader.argv.push("--tsconfig=alternate.json"), /invalid loader/],
    [(c) => c.loader.inputs.pop(), /invalid loader resolution/],
    [(c) => c.loader.resolutionPaths.push("../elsewhere"), /invalid loader resolution/],
  ]) {
    const record = fixture();
    mutate(record.context);
    assert.throws(() => validate(record), error);
  }
});

test("matches every occurrence once, including repeated script paths", () => {
  const first = fixture();
  const second = copy(first);
  second.identity.edges[0].offset++;
  validateInvocationCertificates([first, second], [copy(second), copy(first)]);
  for (const [observed, reviewed] of [
    [[first, first], [first]],
    [[first], [first, first]],
    [[first], [first, second]],
    [[first, second], [first]],
  ]) {
    assert.throws(
      () => validateInvocationCertificates(observed, reviewed),
      /Invocation certificate/,
    );
  }
});

test("rejects invalid install and loader context regardless of sibling order", () => {
  const good = fixture();
  const cases = [
    (c) => (c.install.outcome = "failure"),
    (c) => (c.install.dependency = "ignored-failure"),
    (c) => (c.install.job = "other-job"),
    (c) => (c.install.root = "other-root"),
    (c) => (c.install.scriptsPolicy = "ignore-scripts=false"),
    (c) => (c.install.inputs[0].sha256 = "b".repeat(64)),
    (c) => (c.install.inputs[2].sha256 = "b".repeat(64)),
    (c) => (c.loader.resolutionPaths = []),
    (c) => (c.loader.nodeOptions = "--require unexpected"),
    (c) => (c.loader.nodePath = "elsewhere"),
    (c) => (c.loader.tsconfigOverride = "other.json"),
    (c) => (c.loader.resolutionOverride = "global"),
    (c) => {
      c.loader.argv.push("--loader=other");
    },
    (c) => {
      c.loader.route = "global-playwright";
    },
  ];
  for (const mutate of cases) {
    const bad = copy(good);
    bad.identity.job++;
    bad.context.install.job = bad.identity.job;
    const reviewed = [copy(good), copy(bad)];
    mutate(bad.context);
    for (const observed of [
      [good, bad],
      [bad, good],
    ]) {
      assert.throws(
        () => validateInvocationCertificates(observed, reviewed),
        /Invocation certificate/,
      );
    }
  }
});

test("rejects matching malformed install commands and unreviewed loader context", () => {
  for (const argv of [[], ["install"], ["ci", null], ["ci", 1]]) {
    const record = fixture();
    record.context.install.argv = argv;
    assert.throws(
      () => validateInvocationCertificates([copy(record)], [record]),
      /invalid install/,
    );
  }
  for (const field of ["root", "checkout"]) {
    for (const value of [undefined, "other"]) {
      const observed = fixture();
      const reviewed = copy(observed);
      reviewed.context.loader[field] = value;
      assert.throws(() => validateInvocationCertificates([observed], [reviewed]), /invalid loader/);
    }
  }
});

test("rejects invalid or missing reviewed prerequisites and loader settings", () => {
  for (const [section, field, invalid] of [
    ["install", "outcome", "failure"],
    ["install", "dependency", "ignored-failure"],
    ["loader", "nodeOptions", "--require hook"],
    ["loader", "nodePath", "elsewhere"],
    ["loader", "tsconfigOverride", "other.json"],
    ["loader", "resolutionOverride", "global"],
    ["loader", "unknownSettings", ["unknown"]],
  ]) {
    for (const value of [invalid, undefined]) {
      const observed = fixture();
      const reviewed = copy(observed);
      if (value === undefined) delete reviewed.context[section][field];
      else reviewed.context[section][field] = value;
      assert.throws(() => validateInvocationCertificates([observed], [reviewed]), /invalid/);
    }
  }
});

test("rejects matching malformed argv and non-string pin digests", () => {
  const sparseInstall = ["ci", "missing", "option"];
  const sparseLoader = ["test", "missing", "option"];
  delete sparseInstall[1];
  delete sparseLoader[1];
  for (const [field, argv] of [
    ["install", sparseInstall],
    ["loader", sparseLoader],
    ["loader", ["test", null]],
    ["loader", ["test", 1]],
  ]) {
    const record = fixture();
    record.context[field].argv = argv;
    assert.throws(() => validateInvocationCertificates([copy(record)], [record]), /invalid/);
  }
  const record = fixture();
  record.context.templateInputs[0].sha256 = ["a".repeat(64)];
  assert.throws(() => validateInvocationCertificates([record], [record]), /invalid template pin/);
});

test("rejects malformed edge positions and write arrays on either side", () => {
  const sparse = ["missing"];
  delete sparse[0];
  for (const [field, values, error] of [
    ["edges", [sparse, [null]], /invalid occurrence identity/],
    ["writes", [sparse, [null], [""], [1]], /invalid effects/],
  ]) {
    for (const value of values) {
      for (const side of ["both", "observed", "reviewed"]) {
        const observed = fixture();
        const reviewed = copy(observed);
        const set = (record) => {
          if (field === "edges") record.identity.edges = value;
          else record.context.effects[0].writes = value;
        };
        if (side !== "reviewed") set(observed);
        if (side !== "observed") set(reviewed);
        assert.throws(() => validateInvocationCertificates([observed], [reviewed]), error);
      }
    }
  }
});

test("checks matching effects for install order, checkout identity, and protected writes", () => {
  for (const [mutate, error] of [
    [(c) => c.effects.pop(), /missing install effect/],
    [(c) => c.effects.reverse(), /invalid effects/],
    [(c) => (c.effects[0].site = c.effects[1].site), /invalid effects/],
    [(c) => (c.effects[1].run = 1), /invalid install effect/],
    [(c) => (c.effects[1].inputs[0].sha256 = "b".repeat(64)), /conflicting snapshot pins/],
    [(c) => (c.effects[0].step = 3), /invalid effects/],
  ]) {
    const record = fixture();
    mutate(record.context);
    assert.throws(() => validate(record), error);
  }
  for (const write of [
    "env:PATH",
    "env:NODE_OPTIONS",
    "env:npm_config_ignore_scripts",
    "file:.npmrc",
    "file:playwright.config.js",
    "file:node_modules/example",
    "file:prepare-helper.mjs",
    "file:./generated/output.json",
  ]) {
    const record = fixture();
    record.context.effects[0].writes.push(write);
    assert.throws(() => validate(record), /invalid effect write/);
  }
  const record = fixture();
  const checkout = Object.assign(record.context.effects[0], {
    kind: "checkout",
    writes: ["checkout"],
    checkout: record.context.install.checkout,
  });
  validate(record);
  checkout.checkout = "another-checkout";
  assert.throws(() => validate(record), /invalid checkout effect/);
});

test("protects an absent npm config from preceding writes", () => {
  const record = fixture();
  const { install, effects } = record.context;
  install.inputs = install.inputs.filter(({ path }) => path !== ".npmrc");
  install.argv.push("--ignore-scripts");
  validate(record);
  effects[0].writes.push("file:.npmrc");
  assert.throws(() => validate(record), /invalid effect write/);
});

test("requires an absent shrinkwrap and protects its path before install", () => {
  const record = fixture();
  validate(record);
  const { install, effects } = record.context;
  for (const value of [undefined, false]) {
    const changed = copy(record);
    changed.context.install.shrinkwrapAbsent = value;
    assert.throws(() => validate(changed), /invalid install evidence/);
    assert.throws(() => validate(record, changed), /invalid install evidence/);
    assert.throws(() => validate(changed, record), /invalid install evidence/);
  }
  install.inputs.push(pin("npm-shrinkwrap.json"));
  assert.throws(() => validate(record), /conflicting shrinkwrap evidence/);
  install.inputs.pop();
  effects[0].writes.push("file:npm-shrinkwrap.json");
  assert.throws(() => validate(record), /invalid effect write/);
});

test("requires strictly ordered effects before the invocation", () => {
  const record = fixture();
  const { effects } = record.context;
  const last = { ...copy(effects[0]), site: "test:prepare", step: record.identity.step, run: 1 };
  effects.push(last);
  validate(record);
  last.run = record.identity.run;
  assert.throws(() => validate(record), /invalid effects/);
  last.run = record.identity.run + 1;
  assert.throws(() => validate(record), /invalid effects/);
  last.step = effects[1].step;
  last.run = effects[1].run;
  assert.throws(() => validate(record), /invalid effects/);
  effects.splice(1, 2, last, effects[1]);
  assert.throws(() => validate(record), /invalid effects/);
});

test("rejects changed or incomplete ordered effect evidence", () => {
  const reviewed = fixture();
  for (const mutate of [
    (c) => {
      c.effects = null;
    },
    (c) => {
      c.effects.push(copy(c.effects[0]));
    },
    (c) => {
      c.effects.reverse();
    },
    (c) => {
      c.effects[0].inputs[1].sha256 = "c".repeat(64);
    },
    (c) => {
      c.effects[0].writes.push("NODE_OPTIONS");
    },
    (c) => {
      c.effects[0].audit = "";
    },
    (c) => {
      c.effects[0].inputs = [];
    },
  ]) {
    const observed = copy(reviewed);
    mutate(observed.context);
    assert.throws(
      () => validateInvocationCertificates([observed], [reviewed]),
      /Invocation certificate/,
    );
  }
});
