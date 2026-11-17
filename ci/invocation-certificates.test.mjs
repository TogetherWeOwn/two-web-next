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
      job: "job-1",
      root: ".",
      checkout: "checkout-1",
      method: "npm-ci",
      outcome: "success",
      dependency: "required-success",
      scriptsPolicy: "ignore-scripts=true",
      argv: ["ci"],
      inputs: [pin("package-lock.json")],
    },
    loader: {
      route: "local-playwright",
      root: ".",
      checkout: "checkout-1",
      entrypoint: "node_modules/playwright/cli.js",
      argv: ["test"],
      nodeOptions: "",
      nodePath: "",
      tsconfigOverride: "",
      resolutionOverride: "",
      unknownSettings: [],
      inputs: [pin("playwright.config.ts")],
    },
    effects: [
      {
        name: "prepare",
        audit: "reviewed fixture",
        writes: ["application-output"],
        inputs: [pin("prepare.mjs")],
      },
    ],
  };
  return { identity, context };
}
const copy = (value) => structuredClone(value);

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

test("rejects an uncertified consumer of the same config across jobs and chains", () => {
  for (const distinguish of [
    (identity) => identity.job++,
    (identity) => identity.edges.push({ root: ".", script: "nested", offset: 6 }),
  ]) {
    for (const mutate of [
      (context) => (context.install.outcome = "failure"),
      (context) => (context.loader.nodeOptions = "--require hook"),
      (context) => context.effects[0].writes.push("playwright.config.ts"),
      (context) => (context.templateInputs[0].sha256 = "b".repeat(64)),
    ]) {
      const good = fixture();
      const bad = copy(good);
      distinguish(bad.identity);
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
      c.effects[0].inputs[0].sha256 = "c".repeat(64);
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
