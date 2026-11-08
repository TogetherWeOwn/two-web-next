import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { verifyKitMultipartConfig } from "./kit-multipart-config.mjs";

const SENTINEL_A = "SENTINEL-VAR-ALPHA-7f3a";
const SENTINEL_B = "SENTINEL-VAR-BETA-91c2";
const SENTINEL_CHANGED = "SENTINEL-CHANGED-4d5e";

function sourceConfig() {
  return {
    schema: "two.kit-source-config.v1",
    config: {
      vars: { ZETA_VAR: SENTINEL_A, ALPHA_VAR: SENTINEL_B },
      queues: { producers: [{ binding: "JOBS_QUEUE", queue: "example-jobs" }] },
      hyperdrive: [{ binding: "DB_HYPERDRIVE", id: "hd-0123456789abcdef" }],
      version_metadata: { binding: "VERSION_META" },
      assets: { binding: "STATIC_ASSETS" },
      keep_vars: true,
      compatibility_date: "2026-01-15",
      compatibility_flags: ["nodejs_compat", "example_flag"],
      tail_consumers: [{ service: "example-tail" }],
    },
  };
}

function metadata() {
  return {
    main_module: "worker.js",
    compatibility_date: "2026-01-15",
    compatibility_flags: ["nodejs_compat", "example_flag"],
    keep_bindings: ["plain_text", "json", "secret_text", "secret_key"],
    tail_consumers: [{ service: "example-tail" }],
    annotations: {},
    bindings: [
      { name: "ALPHA_VAR", type: "plain_text", text: SENTINEL_B },
      { name: "DB_HYPERDRIVE", type: "hyperdrive", id: "hd-0123456789abcdef" },
      { name: "JOBS_QUEUE", type: "queue", queue_name: "example-jobs" },
      { name: "STATIC_ASSETS", type: "assets" },
      { name: "VERSION_META", type: "version_metadata" },
      { name: "ZETA_VAR", type: "plain_text", text: SENTINEL_A },
    ],
  };
}

function telemetry() {
  return [
    { name: "pkg-one", packageJsonVersion: "^1.0.0", installedVersion: "1.2.3" },
    { name: "pkg-two", packageJsonVersion: "^2.0.0", installedVersion: "2.0.1" },
  ];
}

function assertRejectsWithoutLeak(mutate, source = sourceConfig()) {
  const value = metadata();
  mutate(value);
  let caught;
  try {
    verifyKitMultipartConfig(value, source);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected rejection");
  for (const text of [String(caught.message), inspect(caught, { depth: 10 })]) {
    for (const secret of [SENTINEL_A, SENTINEL_B, SENTINEL_CHANGED]) {
      assert.ok(!text.includes(secret), "error leaked a sentinel value");
    }
  }
  assert.ok(caught.actual === undefined || typeof caught.actual === "boolean");
  assert.ok(caught.expected === undefined || typeof caught.expected === "boolean");
}

const binding = (value, name) => value.bindings.find((entry) => entry.name === name);

test("accepts a matching config and returns a sanitized projection", () => {
  const result = verifyKitMultipartConfig(metadata(), sourceConfig());
  assert.equal(result.schema, "two.kit-multipart-config.v1");
  assert.equal(result.evidence, "serialized-dry-run-config-fields-only");
  assert.deepEqual(result.checkedFields, [
    "annotations",
    "bindings",
    "compatibility_date",
    "compatibility_flags",
    "keep_bindings",
    "main_module",
    "tail_consumers",
  ]);
  assert.match(result.configSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.packageTelemetry, "absent");
  const text = JSON.stringify(result);
  for (const secret of [SENTINEL_A, SENTINEL_B]) {
    assert.ok(!text.includes(secret));
  }
});

test("binding order does not matter and does not change the digest", () => {
  const reordered = metadata();
  reordered.bindings.reverse();
  assert.deepEqual(
    verifyKitMultipartConfig(reordered, sourceConfig()),
    verifyKitMultipartConfig(metadata(), sourceConfig()),
  );
});

test("source var order does not matter", () => {
  const source = sourceConfig();
  source.config.vars = { ALPHA_VAR: SENTINEL_B, ZETA_VAR: SENTINEL_A };
  assert.equal(verifyKitMultipartConfig(metadata(), source).packageTelemetry, "absent");
});

test("a changed binding value changes the digest of the expected config", () => {
  const source = sourceConfig();
  source.config.vars.ALPHA_VAR = SENTINEL_CHANGED;
  const changed = metadata();
  binding(changed, "ALPHA_VAR").text = SENTINEL_CHANGED;
  assert.notEqual(
    verifyKitMultipartConfig(changed, source).configSha256,
    verifyKitMultipartConfig(metadata(), sourceConfig()).configSha256,
  );
});

test("requires a verified source config", () => {
  assert.throws(() => verifyKitMultipartConfig(metadata(), undefined), /source config required/);
  assert.throws(
    () => verifyKitMultipartConfig(metadata(), { schema: "other", config: sourceConfig().config }),
    /source config required/,
  );
  assert.throws(
    () => verifyKitMultipartConfig(metadata(), { schema: "two.kit-source-config.v1" }),
    /source config required/,
  );
});

test("requires the reviewed keep_vars contract", () => {
  for (const keepVars of [false, undefined, "true"]) {
    const source = sourceConfig();
    source.config.keep_vars = keepVars;
    assert.throws(() => verifyKitMultipartConfig(metadata(), source), /keep-vars/);
  }
});

test("requires a plain metadata object with a bindings array", () => {
  for (const bad of [null, undefined, [], "text"]) {
    assert.throws(() => verifyKitMultipartConfig(bad, sourceConfig()), /object required/);
  }
  const noBindings = metadata();
  delete noBindings.bindings;
  assert.throws(() => verifyKitMultipartConfig(noBindings, sourceConfig()), /bindings required/);
  const badBindings = metadata();
  badBindings.bindings = {};
  assert.throws(() => verifyKitMultipartConfig(badBindings, sourceConfig()), /bindings required/);
});

test("rejects missing top-level fields", () => {
  for (const key of Object.keys(metadata())) {
    if (key === "bindings") continue;
    assertRejectsWithoutLeak((value) => {
      delete value[key];
    });
  }
});

test("rejects extra top-level fields", () => {
  for (const [key, extra] of [
    ["assets", { jwt: "x", config: {} }],
    ["observability", { enabled: true }],
    ["placement", { mode: "smart" }],
    ["limits", { cpu_ms: 50 }],
    ["unknown_field", SENTINEL_CHANGED],
  ]) {
    assertRejectsWithoutLeak((value) => {
      value[key] = extra;
    });
  }
});

test("rejects changed top-level fields", () => {
  assertRejectsWithoutLeak((value) => {
    value.main_module = "other.js";
  });
  assertRejectsWithoutLeak((value) => {
    value.compatibility_date = "2026-02-01";
  });
  assertRejectsWithoutLeak((value) => {
    value.compatibility_flags = ["nodejs_compat"];
  });
  assertRejectsWithoutLeak((value) => {
    value.compatibility_flags = ["example_flag", "nodejs_compat"];
  });
  assertRejectsWithoutLeak((value) => {
    value.compatibility_flags = [...value.compatibility_flags, "extra_flag"];
  });
});

test("rejects tail consumer changes", () => {
  assertRejectsWithoutLeak((value) => {
    value.tail_consumers = [];
  });
  assertRejectsWithoutLeak((value) => {
    value.tail_consumers = [{ service: "other-tail" }];
  });
  assertRejectsWithoutLeak((value) => {
    value.tail_consumers = [{ service: "example-tail" }, { service: "second-tail" }];
  });
});

test("rejects bad preservation categories", () => {
  const variants = [
    [],
    ["plain_text", "json", "secret_text"],
    ["plain_text", "json", "secret_text", "secret_key", "kv_namespace"],
    ["secret_key", "secret_text", "json", "plain_text"],
    ["plain_text", "json", "secret_text", "secret_text"],
  ];
  for (const categories of variants) {
    assertRejectsWithoutLeak((value) => {
      value.keep_bindings = categories;
    });
  }
  assertRejectsWithoutLeak((value) => {
    value.keep_bindings = "plain_text";
  });
});

test("rejects non-empty annotations", () => {
  for (const annotations of [{ "workers/message": "x" }, { "workers/tag": SENTINEL_CHANGED }]) {
    assertRejectsWithoutLeak((value) => {
      value.annotations = annotations;
    });
  }
});

test("rejects a changed binding value", () => {
  assertRejectsWithoutLeak((value) => {
    binding(value, "ALPHA_VAR").text = SENTINEL_CHANGED;
  });
  assertRejectsWithoutLeak((value) => {
    binding(value, "JOBS_QUEUE").queue_name = "other-jobs";
  });
  assertRejectsWithoutLeak((value) => {
    binding(value, "DB_HYPERDRIVE").id = "hd-other";
  });
});

test("rejects a changed binding type", () => {
  assertRejectsWithoutLeak((value) => {
    const entry = binding(value, "ALPHA_VAR");
    entry.type = "secret_text";
  });
  assertRejectsWithoutLeak((value) => {
    const entry = binding(value, "ZETA_VAR");
    entry.type = "json";
    entry.json = SENTINEL_A;
    delete entry.text;
  });
  assertRejectsWithoutLeak((value) => {
    binding(value, "STATIC_ASSETS").type = "version_metadata";
  });
});

test("rejects a changed binding name", () => {
  assertRejectsWithoutLeak((value) => {
    binding(value, "ALPHA_VAR").name = "RENAMED_VAR";
  });
});

test("rejects extra binding properties", () => {
  assertRejectsWithoutLeak((value) => {
    binding(value, "ALPHA_VAR").extra = SENTINEL_CHANGED;
  });
  assertRejectsWithoutLeak((value) => {
    binding(value, "VERSION_META").namespace = "x";
  });
});

test("rejects missing bindings", () => {
  for (const name of ["ALPHA_VAR", "JOBS_QUEUE", "DB_HYPERDRIVE", "VERSION_META", "STATIC_ASSETS"]) {
    assertRejectsWithoutLeak((value) => {
      value.bindings = value.bindings.filter((entry) => entry.name !== name);
    });
  }
  assertRejectsWithoutLeak((value) => {
    value.bindings = [];
  });
});

test("rejects extra bindings", () => {
  assertRejectsWithoutLeak((value) => {
    value.bindings.push({ name: "EXTRA_VAR", type: "plain_text", text: SENTINEL_CHANGED });
  });
  assertRejectsWithoutLeak((value) => {
    value.bindings.push({ name: "EXTRA_KV", type: "kv_namespace", namespace_id: "abc" });
  });
});

test("rejects duplicate bindings", () => {
  assertRejectsWithoutLeak((value) => {
    value.bindings.push({ ...binding(value, "ALPHA_VAR") });
  });
  assertRejectsWithoutLeak((value) => {
    value.bindings.push({ name: "ALPHA_VAR", type: "plain_text", text: SENTINEL_CHANGED });
  });
});

test("rejects inherit bindings", () => {
  assertRejectsWithoutLeak((value) => {
    value.bindings[0] = { name: value.bindings[0].name, type: "inherit" };
  });
  assertRejectsWithoutLeak((value) => {
    value.bindings.push({ name: "INHERITED", type: "inherit" });
  });
});

test("valid package telemetry is accepted, labeled unverified, and not echoed", () => {
  const value = metadata();
  value.package_dependencies = telemetry();
  const result = verifyKitMultipartConfig(value, sourceConfig());
  assert.equal(result.packageTelemetry, "unverified");
  assert.ok(!result.checkedFields.includes("package_dependencies"));
  const text = JSON.stringify(result);
  for (const needle of ["pkg-one", "pkg-two", "1.2.3", "2.0.1", "^1.0.0"]) {
    assert.ok(!text.includes(needle));
  }
  assert.equal(
    result.configSha256,
    verifyKitMultipartConfig(metadata(), sourceConfig()).configSha256,
  );
});

test("package telemetry is still subject to the bindings checks", () => {
  assertRejectsWithoutLeak((value) => {
    value.package_dependencies = telemetry();
    binding(value, "ALPHA_VAR").text = SENTINEL_CHANGED;
  });
});

test("rejects malformed package telemetry", () => {
  const entry = () => telemetry()[0];
  const tooMany = Array.from({ length: 201 }, (_, index) => ({ ...entry(), name: `pkg-${index}` }));
  const boundary = Array.from({ length: 200 }, (_, index) => ({ ...entry(), name: `pkg-${index}` }));
  const variants = [
    [],
    {},
    "pkg",
    null,
    tooMany,
    [null],
    ["pkg-one"],
    [[]],
    [{ ...entry(), extra: "x" }],
    [{ name: "pkg-one", packageJsonVersion: "^1.0.0" }],
    [{ name: "pkg-one", installedVersion: "1.2.3" }],
    [{ packageJsonVersion: "^1.0.0", installedVersion: "1.2.3" }],
    [{ ...entry(), name: "" }],
    [{ ...entry(), packageJsonVersion: "" }],
    [{ ...entry(), installedVersion: "" }],
    [{ ...entry(), name: 7 }],
    [{ ...entry(), installedVersion: null }],
    [{ ...entry(), packageJsonVersion: undefined }],
    [{ ...entry(), name: "n".repeat(513) }],
    [{ ...entry(), packageJsonVersion: "v".repeat(513) }],
    [{ ...entry(), installedVersion: "v".repeat(513) }],
    [entry(), entry()],
    [entry(), { ...entry(), installedVersion: "9.9.9" }],
  ];
  for (const packages of variants) {
    const value = metadata();
    value.package_dependencies = packages;
    assert.throws(() => verifyKitMultipartConfig(value, sourceConfig()), /package telemetry/);
  }
  const ok = metadata();
  ok.package_dependencies = boundary;
  assert.equal(verifyKitMultipartConfig(ok, sourceConfig()).packageTelemetry, "unverified");
  const edge = metadata();
  edge.package_dependencies = [
    {
      name: "n".repeat(512),
      packageJsonVersion: "v".repeat(512),
      installedVersion: "i".repeat(512),
    },
  ];
  assert.equal(verifyKitMultipartConfig(edge, sourceConfig()).packageTelemetry, "unverified");
});
