// Serialized dry-run fields only, not remote inheritance or non-versioned settings.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { sha256 } from "./worker-bundle-evidence.mjs";

export function verifyKitMultipartConfig(metadata, sourceConfig) {
  assert.ok(
    sourceConfig?.schema === "two.kit-source-config.v1" && sourceConfig.config,
    "verified source config required",
  );
  const config = sourceConfig.config;
  const bindings = [
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    ...config.queues.producers.map(({ binding: name, queue: queue_name }) => ({
      name,
      type: "queue",
      queue_name,
    })),
    ...config.hyperdrive.map(({ binding: name, id }) => ({ name, type: "hyperdrive", id })),
    { name: config.version_metadata.binding, type: "version_metadata" },
    { name: config.assets.binding, type: "assets" },
  ];
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const expected = {
    main_module: "worker.js",
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    keep_bindings: ["plain_text", "json", "secret_text", "secret_key"],
    tail_consumers: config.tail_consumers,
    annotations: {},
    bindings: bindings.sort(byName),
  };
  assert.ok(config.keep_vars === true, "reviewed keep-vars contract required");
  assert.ok(
    metadata && typeof metadata === "object" && !Array.isArray(metadata),
    "multipart config object required",
  );
  // Package instrumentation is descriptive telemetry, not Worker configuration.
  // Its installed-version claims remain unverified; never copy them to a receipt.
  const { package_dependencies: packages, ...semantic } = metadata;
  if (packages !== undefined) {
    assert.ok(
      Array.isArray(packages) && packages.length > 0 && packages.length <= 200,
      "invalid multipart package telemetry",
    );
    const names = new Set();
    for (const entry of packages) {
      assert.ok(
        entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          isDeepStrictEqual(Object.keys(entry).sort(), [
            "installedVersion",
            "name",
            "packageJsonVersion",
          ]) &&
          [entry.name, entry.packageJsonVersion, entry.installedVersion].every(
            (value) => typeof value === "string" && value.length > 0 && value.length <= 512,
          ) &&
          !names.has(entry.name),
        "invalid multipart package telemetry entry",
      );
      names.add(entry.name);
    }
  }
  assert.ok(Array.isArray(semantic.bindings), "multipart config bindings required");
  const actual = { ...semantic, bindings: [...semantic.bindings].sort(byName) };
  // assert.deepEqual would attach raw binding values to the thrown error.
  assert.ok(isDeepStrictEqual(actual, expected), "multipart config differs from frozen source");
  return {
    schema: "two.kit-multipart-config.v1",
    evidence: "serialized-dry-run-config-fields-only",
    checkedFields: Object.keys(expected).sort(),
    configSha256: sha256(JSON.stringify(expected)),
    packageTelemetry: packages === undefined ? "absent" : "unverified",
  };
}
