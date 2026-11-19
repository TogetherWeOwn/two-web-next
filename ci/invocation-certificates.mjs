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
    Array.from(value.edges).some(
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
      !repoPath(pin.path) ||
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

function repoPath(value) {
  return (
    text(value) &&
    !/[:\\\p{Cc}]/u.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function under(root, path) {
  return root === "." ? path : `${root}/${path}`;
}

function hasPins(pins, paths) {
  return paths.every((path) => pins.some((pin) => pin.path === path));
}

function before(a, b) {
  return a.step < b.step || (a.step === b.step && a.run < b.run);
}

function frozenArgv(argv) {
  if (!stringArgv(argv) || argv[0] !== "ci") return false;
  const options = argv.slice(1);
  const keys = options.map((arg) => arg.split("=", 1)[0]);
  return (
    new Set(keys).size === keys.length &&
    options.every((arg) =>
      /^(--include=dev|--ignore-scripts(?:=true)?|--no-audit|--no-fund|--min-release-age=[0-9]+)$/.test(
        arg,
      ),
    )
  );
}

// Admit only positional filters and a single literal long-form config file.
function configMatches({ argv, cwd, config }) {
  let selected = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) continue;
    if (selected || arg !== "--config") return false;
    const path = argv[++i]?.replace(/^\.\//, "");
    if (!repoPath(path) || path.startsWith("-") || under(cwd, path) !== config) return false;
    selected = true;
  }
  return true;
}

function validateContext(reviewed, observed, terminal) {
  if (!reviewed || !observed) fail("missing context");
  samePins(reviewed.templateInputs, observed.templateInputs, "template");
  if (!hasPins(observed.templateInputs, [terminal.workflow])) fail("missing workflow pin");
  const install = observed.install;
  const expectedInstall = reviewed.install;
  if (
    !install ||
    !expectedInstall ||
    install.workflow !== terminal.workflow ||
    install.workflow !== expectedInstall.workflow ||
    install.job !== terminal.job ||
    install.job !== expectedInstall.job ||
    !location(install.step) ||
    !location(install.run) ||
    !before(install, terminal) ||
    install.step !== expectedInstall.step ||
    install.run !== expectedInstall.run ||
    !(install.root === "." || repoPath(install.root)) ||
    terminal.edges.some((edge) => edge.root !== install.root) ||
    !text(install.checkout) ||
    install.root !== expectedInstall.root ||
    install.checkout !== expectedInstall.checkout ||
    install.method !== "npm-ci" ||
    expectedInstall.method !== "npm-ci" ||
    [install, expectedInstall].some(
      (item) =>
        item.outcome !== "success" ||
        item.dependency !== "required-success" ||
        item.scriptsPolicy !== "ignore-scripts=true" ||
        item.shrinkwrapAbsent !== true ||
        item.npmConfig?.includeDev !== true ||
        item.npmConfig.installStrategy !== "hoisted" ||
        !Array.isArray(item.npmConfig.unknownSettings) ||
        item.npmConfig.unknownSettings.length !== 0 ||
        Object.keys(item.npmConfig).length !== 3,
    ) ||
    !frozenArgv(install.argv) ||
    !frozenArgv(expectedInstall.argv) ||
    JSON.stringify(install.argv) !== JSON.stringify(expectedInstall.argv)
  ) {
    fail("invalid install evidence");
  }
  samePins(expectedInstall.inputs, install.inputs, "install");
  if (
    !hasPins(
      install.inputs,
      ["package.json", "package-lock.json"].map((p) => under(install.root, p)),
    )
  ) {
    fail("missing install manifest or lockfile pin");
  }
  const loader = observed.loader;
  const expectedLoader = reviewed.loader;
  const tsx = loader?.route === "local-playwright-tsx";
  if (
    !loader ||
    !expectedLoader ||
    !["local-playwright", "local-playwright-tsx"].includes(loader.route) ||
    loader.route !== expectedLoader.route ||
    loader.root !== install.root ||
    loader.root !== expectedLoader.root ||
    loader.checkout !== install.checkout ||
    loader.checkout !== expectedLoader.checkout ||
    !["node_modules/playwright/cli.js", "node_modules/@playwright/test/cli.js"].some(
      (path) => loader.entrypoint === under(install.root, path),
    ) ||
    loader.entrypoint !== expectedLoader.entrypoint ||
    loader.tsxEntrypoint !==
      (tsx ? under(install.root, "node_modules/tsx/dist/loader.mjs") : null) ||
    loader.tsxEntrypoint !== expectedLoader.tsxEntrypoint ||
    loader.cwd !== install.root ||
    loader.cwd !== expectedLoader.cwd ||
    !repoPath(loader.config) ||
    loader.config !== expectedLoader.config ||
    !(loader.tsconfig === null || repoPath(loader.tsconfig)) ||
    loader.tsconfig !== expectedLoader.tsconfig ||
    !stringArgv(loader.argv) ||
    !stringArgv(expectedLoader.argv) ||
    loader.argv[0] !== "test" ||
    !configMatches(loader) ||
    JSON.stringify(loader.argv) !== JSON.stringify(expectedLoader.argv) ||
    loader.nodeOptions !== expectedLoader.nodeOptions ||
    [loader, expectedLoader].some(
      (item) =>
        !(tsx
          ? ["--import tsx", "--import=tsx"].includes(item.nodeOptions)
          : item.nodeOptions === "") ||
        item.nodePath !== "" ||
        item.tsconfigOverride !== "" ||
        item.resolutionOverride !== "" ||
        !Array.isArray(item.unknownSettings) ||
        item.unknownSettings.length !== 0,
    )
  ) {
    fail("invalid loader evidence");
  }
  samePins(expectedLoader.inputs, loader.inputs, "loader");
  if (
    !hasPins(
      loader.inputs,
      [loader.config, loader.tsconfig].filter((path) => path !== null),
    ) ||
    [loader, expectedLoader].some(
      ({ resolutionPaths }) =>
        !Array.isArray(resolutionPaths) || !Array.from(resolutionPaths).every(repoPath),
    ) ||
    JSON.stringify(loader.resolutionPaths) !== JSON.stringify(expectedLoader.resolutionPaths)
  ) {
    fail("invalid loader resolution evidence");
  }

  validateEffects(reviewed, observed, terminal);
}

// The caller must prove each GITHUB_ENV write emits exactly one NAME=value line
// with a nonempty [A-Za-z0-9._:/@+-] value, bounded in bytes on all admitted paths.
// It must also audit every use of the key: an application prefix alone proves nothing.
function validateEnvWrites(names, expected = [], observed = []) {
  if (
    new Set(names).size !== names.length ||
    !Array.isArray(expected) ||
    !Array.isArray(observed) ||
    expected.length !== names.length ||
    observed.length !== names.length
  ) {
    fail("invalid environment write evidence");
  }
  for (const [i, name] of names.entries()) {
    const actual = observed[i];
    if (
      !/^(?:APP|E2E)_[A-Z][A-Z0-9_]{0,62}$/.test(name) ||
      [expected[i], actual].some(
        (entry) =>
          !entry ||
          Object.keys(entry).length !== 3 ||
          entry.name !== name ||
          entry.format !== "github-env-ascii-token" ||
          !Number.isSafeInteger(entry.maxBytes) ||
          entry.maxBytes < 1 ||
          entry.maxBytes > 4096 ||
          entry.maxBytes !== actual?.maxBytes,
      )
    ) {
      fail("invalid environment write evidence");
    }
  }
}

function validateEffects(reviewed, observed, terminal) {
  if (!Array.isArray(reviewed.effects) || !Array.isArray(observed.effects))
    fail("missing effects evidence");
  if (reviewed.effects.length !== observed.effects.length) fail("effects differ");
  const { install, loader, effects } = observed;
  for (const [i, effect] of effects.entries()) {
    samePins(reviewed.effects[i]?.inputs, effect?.inputs, "effect");
  }
  const snapshot = new Map();
  for (const inputs of [
    observed.templateInputs,
    install.inputs,
    loader.inputs,
    ...effects.map((effect) => effect.inputs),
  ]) {
    for (const { path, sha256 } of inputs) {
      if (snapshot.has(path) && snapshot.get(path) !== sha256) fail("conflicting snapshot pins");
      snapshot.set(path, sha256);
    }
  }
  const shrinkwrap = under(install.root, "npm-shrinkwrap.json");
  if (snapshot.has(shrinkwrap)) fail("conflicting shrinkwrap evidence");
  const protectedPaths = [
    under(install.root, "node_modules"),
    under(install.root, ".npmrc"),
    shrinkwrap,
    ...snapshot.keys(),
    ...loader.resolutionPaths,
  ];
  const related = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const sites = new Set();
  let checkouts = 0;
  let installs = 0;
  let previous = null;
  for (let i = 0; i < reviewed.effects.length; i++) {
    const expected = reviewed.effects[i];
    const effect = observed.effects[i];
    if (
      !expected ||
      !effect ||
      !text(expected.name) ||
      expected.name !== effect.name ||
      !text(expected.site) ||
      expected.site !== effect.site ||
      sites.has(effect.site) ||
      !location(expected.step) ||
      !location(expected.run) ||
      expected.step !== effect.step ||
      expected.run !== effect.run ||
      !before(effect, terminal) ||
      (previous && !before(previous, effect)) ||
      !["audited", "checkout", "install"].includes(expected.kind) ||
      expected.kind !== effect.kind ||
      !text(expected.audit) ||
      effect.audit !== expected.audit ||
      !Array.isArray(expected.writes) ||
      !Array.isArray(effect.writes) ||
      !Array.from(expected.writes).every(text) ||
      !Array.from(effect.writes).every(text) ||
      JSON.stringify(expected.writes) !== JSON.stringify(effect.writes)
    ) {
      fail("invalid effects evidence");
    }
    sites.add(effect.site);
    previous = effect;
    if (
      [expected, effect].some(
        (item) =>
          (item.kind !== "checkout" && item.checkout !== undefined) ||
          (item.kind !== "audited" && item.envWrites !== undefined),
      )
    ) {
      fail("invalid effects evidence");
    }
    if (effect.kind === "checkout") {
      if (
        ++checkouts > 1 ||
        !before(effect, install) ||
        effect.checkout !== install.checkout ||
        expected.checkout !== effect.checkout ||
        effect.writes.length !== 1 ||
        effect.writes[0] !== "checkout"
      ) {
        fail("invalid checkout effect");
      }
    } else if (effect.kind === "install") {
      if (
        ++installs > 1 ||
        effect.step !== install.step ||
        effect.run !== install.run ||
        effect.writes.join() !== "installed-packages"
      ) {
        fail("invalid install effect");
      }
    } else {
      const names = [];
      for (const write of effect.writes) {
        if (write.startsWith("env:")) {
          names.push(write.slice(4));
        } else {
          const file = write.startsWith("file:") ? write.slice(5) : null;
          if (!repoPath(file) || protectedPaths.some((path) => related(file, path))) {
            fail("invalid effect write");
          }
        }
      }
      validateEnvWrites(names, expected.envWrites, effect.envWrites);
    }
  }
  if (installs !== 1) fail("missing install effect");
}

// Records and observations must describe exactly the same set of occurrences.
// The caller must independently derive effective settings, the complete prefix
// and its writes, and the canonical resolution closure (including absent
// candidates in resolutionPaths). Effects must have distinct (step, run)
// positions strictly before the terminal. If the prefix contains a checkout, the
// caller must audit its action/ref/path and prove that its required success yields
// the pinned snapshot. The checkout identity is shared by checkout/install/loader.
// An audited effect lists env:NAME writes in writes and provides matching envWrites
// entries in that order on both sides. Record bounds, never actual environment values.
// Edges share the pinned install manifest. Config file resolution stays caller-owned.
// Only package-lock.json is supported: the caller must verify the absence of
// the higher-priority npm-shrinkwrap.json at the install root.
// This checks a reviewed static contract; install.outcome is the required
// outcome, not an observation of execution.
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
    validateContext(reviewed.get(key), occurrence.context, occurrence.identity);
  }
  if (seen.size !== reviewed.size) fail("missing occurrence");
}
