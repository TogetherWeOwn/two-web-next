// This dormant primitive compares supplied observations with reviewed evidence.
// It does not discover commands, read files, install packages or audit effects.
function fail(message) {
  throw new Error(`Invocation certificate: ${message}`);
}

function text(value) {
  return typeof value === "string" && value.length > 0;
}

function location(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function stringArgv(value) {
  return Array.isArray(value) && Array.from(value).every((arg) => typeof arg === "string");
}

function identity(value) {
  if (
    !value ||
    !text(value.workflow) ||
    !location(value.job) ||
    !location(value.step) ||
    !location(value.run) ||
    !location(value.terminal) ||
    !Array.isArray(value.edges) ||
    value.edges.some(
      (edge) => !edge || !text(edge.root) || !text(edge.script) || !location(edge.offset),
    )
  ) {
    fail("invalid occurrence identity");
  }
  return JSON.stringify([
    value.workflow,
    value.job,
    value.step,
    value.run,
    value.edges.map(({ root, script, offset }) => [root, script, offset]),
    value.terminal,
  ]);
}

function pins(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`missing ${label} pins`);
  const result = new Map();
  for (const pin of value) {
    if (
      !pin ||
      !text(pin.path) ||
      typeof pin.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(pin.sha256) ||
      result.has(pin.path)
    ) {
      fail(`invalid ${label} pin`);
    }
    result.set(pin.path, pin.sha256);
  }
  return result;
}

function samePins(reviewed, observed, label) {
  const expected = pins(reviewed, label);
  const actual = pins(observed, label);
  if (
    expected.size !== actual.size ||
    [...expected].some(([path, hash]) => actual.get(path) !== hash)
  ) {
    fail(`${label} pins differ`);
  }
}

function validateContext(reviewed, observed) {
  if (!reviewed || !observed) fail("missing context");
  samePins(reviewed.templateInputs, observed.templateInputs, "template");
  const install = observed.install;
  const expectedInstall = reviewed.install;
  if (
    !install ||
    !expectedInstall ||
    !text(install.job) ||
    !text(install.root) ||
    !text(install.checkout) ||
    install.job !== expectedInstall.job ||
    install.root !== expectedInstall.root ||
    install.checkout !== expectedInstall.checkout ||
    install.method !== "npm-ci" ||
    expectedInstall.method !== "npm-ci" ||
    install.outcome !== "success" ||
    install.dependency !== "required-success" ||
    !text(install.scriptsPolicy) ||
    install.scriptsPolicy !== expectedInstall.scriptsPolicy ||
    !stringArgv(install.argv) ||
    !stringArgv(expectedInstall.argv) ||
    install.argv[0] !== "ci" ||
    JSON.stringify(install.argv) !== JSON.stringify(expectedInstall.argv)
  ) {
    fail("invalid install evidence");
  }
  samePins(expectedInstall.inputs, install.inputs, "install");

  const loader = observed.loader;
  const expectedLoader = reviewed.loader;
  if (
    !loader ||
    !expectedLoader ||
    !["local-playwright", "local-playwright-tsx"].includes(loader.route) ||
    loader.route !== expectedLoader.route ||
    loader.root !== install.root ||
    loader.root !== expectedLoader.root ||
    loader.checkout !== install.checkout ||
    loader.checkout !== expectedLoader.checkout ||
    !text(loader.entrypoint) ||
    loader.entrypoint !== expectedLoader.entrypoint ||
    !stringArgv(loader.argv) ||
    !stringArgv(expectedLoader.argv) ||
    JSON.stringify(loader.argv) !== JSON.stringify(expectedLoader.argv) ||
    loader.nodeOptions !== (loader.route === "local-playwright-tsx" ? "--import tsx" : "") ||
    loader.nodePath !== "" ||
    loader.tsconfigOverride !== "" ||
    loader.resolutionOverride !== "" ||
    !Array.isArray(loader.unknownSettings) ||
    loader.unknownSettings.length !== 0
  ) {
    fail("invalid loader evidence");
  }
  samePins(expectedLoader.inputs, loader.inputs, "loader");

  if (!Array.isArray(reviewed.effects) || !Array.isArray(observed.effects))
    fail("missing effects evidence");
  if (reviewed.effects.length !== observed.effects.length) fail("effects differ");
  for (let i = 0; i < reviewed.effects.length; i++) {
    const expected = reviewed.effects[i];
    const effect = observed.effects[i];
    if (
      !expected ||
      !effect ||
      !text(expected.name) ||
      expected.name !== effect.name ||
      !text(expected.audit) ||
      effect.audit !== expected.audit ||
      !Array.isArray(expected.writes) ||
      !Array.isArray(effect.writes) ||
      expected.writes.some((write) => !text(write)) ||
      JSON.stringify(expected.writes) !== JSON.stringify(effect.writes)
    ) {
      fail("invalid effects evidence");
    }
    samePins(expected.inputs, effect.inputs, "effect");
  }
}

// Records and observations must describe exactly the same set of occurrences.
// A caller must independently establish that observations are complete and that
// reviewed pins, install dependency and effect audits describe the actual run.
export function validateInvocationCertificates(occurrences, records) {
  if (!Array.isArray(occurrences) || !Array.isArray(records))
    fail("expected occurrence and record arrays");
  const reviewed = new Map();
  for (const record of records) {
    const key = identity(record?.identity);
    if (reviewed.has(key)) fail("duplicate reviewed identity");
    reviewed.set(key, record.context);
  }
  const seen = new Set();
  for (const occurrence of occurrences) {
    const key = identity(occurrence?.identity);
    if (seen.has(key)) fail("duplicate discovered identity");
    seen.add(key);
    if (!reviewed.has(key)) fail("unexpected occurrence");
    validateContext(reviewed.get(key), occurrence.context);
  }
  if (seen.size !== reviewed.size) fail("missing occurrence");
}
