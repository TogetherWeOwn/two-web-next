// Fail-closed required check: the @puppeteer/browsers optional proxy-agent
// peer must resolve to a satisfactory version in the installed tree.
//
// The independently owned toolchain suite pins the declared peer metadata
// (range and optional flag). This script pins the installed half: the root
// proxy-agent pin exists, satisfies the peer range the browser helper
// actually declares, and is the copy Node resolves from the helper's
// context. LHCI's nested proxy-agent 6.x lives outside that resolution
// path, so it must never satisfy this check.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`proxy-peer check: cannot compare ${a} with ${b}`);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// The browser helper declares its peer as a >= floor. Any other range shape
// fails closed so a silent upstream redeclaration never reads green.
export function parseGteFloor(range) {
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(range ?? "");
  return match ? match[1] : null;
}

export function checkTree({ pin, peerRange, resolved }) {
  if (!pin) {
    return {
      ok: false,
      message:
        'root devDependencies["proxy-agent"] pin is missing; the ' +
        "@puppeteer/browsers optional peer has no root provider.",
    };
  }
  const floor = parseGteFloor(peerRange);
  if (!floor) {
    return {
      ok: false,
      message:
        `unrecognized @puppeteer/browsers proxy-agent peer range ${JSON.stringify(peerRange)}; ` +
        "the checker only understands >=x.y.z — update the checker, do not skip it.",
    };
  }
  if (parseVersion(pin) && compareVersions(pin, floor) < 0) {
    return {
      ok: false,
      message: `root proxy-agent pin ${pin} is below the peer floor ${floor}.`,
    };
  }
  if (!resolved || resolved.error || !resolved.version) {
    return {
      ok: false,
      message:
        "proxy-agent does not resolve from the @puppeteer/browsers context " +
        `(${resolved?.error ?? "missing"}); the optional peer is unmet in the installed tree.`,
    };
  }
  if (compareVersions(resolved.version, floor) < 0) {
    return {
      ok: false,
      message:
        `installed proxy-agent ${resolved.version} (resolved from @puppeteer/browsers) ` +
        `is below the peer floor ${floor}.`,
    };
  }
  return {
    ok: true,
    detail:
      `proxy-agent ${resolved.version} resolves from @puppeteer/browsers ` +
      `and satisfies the peer floor ${floor} (root pin ${pin}).`,
  };
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// proxy-agent 8.x ships an exports map without ./package.json, so resolve
// the usable entry point and walk up to the owning manifest instead of
// resolving the manifest subpath (which throws ERR_PACKAGE_PATH_NOT_EXPORTED).
export function resolvePackageVersion(requireFn, name) {
  const entry = requireFn.resolve(name);
  let dir = dirname(entry);
  for (;;) {
    try {
      const manifest = loadJson(join(dir, "package.json"));
      if (manifest.name === name) return manifest.version;
    } catch {
      // Not a manifest, or not this package: keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`${name} entry ${entry} has no owning ${name}/package.json`);
}

function hop(currentRequire, name, trail) {
  try {
    return currentRequire.resolve(`${name}/package.json`);
  } catch (error) {
    throw new Error(
      `proxy-peer check: cannot resolve ${name} from ${trail} (${error.code ?? error.message})`,
    );
  }
}

export function check(rootDir = ROOT, output = console) {
  const rootPkg = loadJson(resolve(rootDir, "package.json"));
  const pin = rootPkg.devDependencies?.["proxy-agent"];
  let currentRequire = createRequire(resolve(rootDir, "package.json"));
  let manifest = rootPkg;
  let trail = "the root project";
  for (const name of ["@lhci/cli", "lighthouse", "puppeteer-core", "@puppeteer/browsers"]) {
    const nextPath = hop(currentRequire, name, trail);
    currentRequire = createRequire(nextPath);
    manifest = loadJson(nextPath);
    trail = name;
  }
  const peerRange = manifest.peerDependencies?.["proxy-agent"];
  let resolved;
  try {
    resolved = { version: resolvePackageVersion(currentRequire, "proxy-agent") };
  } catch (error) {
    resolved = { error: error.code ?? String(error.message) };
  }
  const result = checkTree({ pin, peerRange, resolved });
  if (result.ok) {
    output.log(`proxy-peer check: ${result.detail}`);
    return 0;
  }
  output.error(`proxy-peer check: ${result.message}`);
  return 1;
}

function selftest() {
  let count = 0;
  const pass = (name) => {
    count += 1;
    console.log(`PASS ${name}`);
  };
  assert.deepEqual(parseVersion("8.0.2"), [8, 0, 2]);
  assert.equal(parseVersion("^8.0.2"), null);
  assert.equal(parseVersion("8.0"), null);
  assert.equal(parseVersion(""), null);
  pass("parseVersion accepts exact versions only");
  assert.equal(compareVersions("8.0.2", "8.0.1"), 1);
  assert.equal(compareVersions("8.0.1", "8.0.1"), 0);
  assert.equal(compareVersions("6.5.0", "8.0.1"), -1);
  assert.throws(() => compareVersions("^8.0.2", "8.0.1"));
  pass("compareVersions orders releases numerically");
  assert.equal(parseGteFloor(">=8.0.1"), "8.0.1");
  assert.equal(parseGteFloor("^8.0.1"), null);
  assert.equal(parseGteFloor("8.0.1"), null);
  assert.equal(parseGteFloor(undefined), null);
  pass("parseGteFloor accepts only >= floors");
  // An exports map without ./package.json (proxy-agent 8.x shape) must not
  // break version detection: the entry resolves, the manifest is found up-tree.
  {
    const fixture = mkdtempSync(join(tmpdir(), "proxy-peer-"));
    try {
      const pkgDir = join(fixture, "node_modules", "fixture-peer");
      mkdirSync(join(pkgDir, "dist"), { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "fixture-peer",
          version: "8.0.2",
          exports: { ".": "./dist/index.js" },
        }),
      );
      writeFileSync(join(pkgDir, "dist", "index.js"), "export default 1;\n");
      writeFileSync(join(fixture, "consumer.mjs"), "export default 1;\n");
      const consumerRequire = createRequire(join(fixture, "consumer.mjs"));
      assert.equal(resolvePackageVersion(consumerRequire, "fixture-peer"), "8.0.2");
      assert.throws(() => resolvePackageVersion(consumerRequire, "fixture-absent"), {
        code: "MODULE_NOT_FOUND",
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
    pass("resolvePackageVersion sees through exports maps");
  }
  const cases = [
    [
      "satisfied peer passes",
      { pin: "8.0.2", peerRange: ">=8.0.1", resolved: { version: "8.0.2" } },
      true,
      "satisfies the peer floor",
    ],
    [
      "missing pin fails",
      { pin: undefined, peerRange: ">=8.0.1", resolved: { version: "8.0.2" } },
      false,
      "pin is missing",
    ],
    [
      "unrecognized range fails closed",
      { pin: "8.0.2", peerRange: "^8.0.1", resolved: { version: "8.0.2" } },
      false,
      "unrecognized",
    ],
    [
      "pin below floor fails",
      { pin: "8.0.0", peerRange: ">=8.0.1", resolved: { version: "8.0.0" } },
      false,
      "below the peer floor",
    ],
    [
      "unmet resolution fails",
      { pin: "8.0.2", peerRange: ">=8.0.1", resolved: { error: "MODULE_NOT_FOUND" } },
      false,
      "does not resolve",
    ],
    [
      "stale resolved copy fails",
      { pin: "8.0.2", peerRange: ">=8.0.1", resolved: { version: "6.5.0" } },
      false,
      "below the peer floor",
    ],
  ];
  for (const [name, input, expected, message] of cases) {
    const result = checkTree(input);
    assert.equal(result.ok, expected, name);
    assert.ok(
      (result.ok ? result.detail : result.message).includes(message),
      `${name}: missing diagnostic`,
    );
    pass(name);
  }
  console.log(`proxy-peer selftest: ${count} cases passed.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , ...args] = process.argv;
  if (args.length === 1 && args[0] === "--selftest") {
    process.exitCode = selftest();
  } else if (args.length === 0) {
    try {
      process.exitCode = check();
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else {
    console.error("Usage: node ci/check-proxy-peer.mjs [--selftest]");
    process.exitCode = 2;
  }
}
