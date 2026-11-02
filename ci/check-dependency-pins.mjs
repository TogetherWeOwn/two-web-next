// Dependency-pin guard: the weekly sweep must not float packages whose exact
// resolved version is pinned elsewhere in the repo.
//
// Pin sources (all discovered, nothing hardcoded):
//   1. Installed-version test pins — a test reads node_modules/<pkg>/package.json
//      (or require("<pkg>/package.json")) and asserts `.version` equals an exact
//      semver, e.g. test/remote-runner-isolation.test.ts pins wrangler 4.152.0
//      while package.json allows ^4.152.0. A bare `npm update` floats these.
//      Pins read through a consumer's resolver (lhciRequire, req, ...) stay
//      held back but verify in the owning test. A transitive pin read from
//      the root copy (bare require() or an explicit node_modules/ path) is
//      verified against the root lockfile entry: the guard only vouches for
//      copies it can resolve, and it never claims an unchecked pin is verified.
//   2. Manifest pins — test/performance-ci.test.ts asserts package.json ranges
//      and overrides entries verbatim (e.g. devDependencies["@lhci/cli"],
//      overrides["basic-ftp"], and the absence of overrides["zod"]). `npm
//      update` never rewrites the manifest, so these are verify-only.
//   3. Exact ranges and overrides in package.json — checked against the
//      lockfile's resolved copies: exact direct deps must resolve to the exact
//      version, string overrides must hold for every installed copy, and nested
//      overrides must hold for the copy their scope package resolves (skipped
//      with a note when the scope declares no such dependency edge).
//
// Sweep usage (holds back floatable pins, then verifies the lockfile kept them):
//
//   UPDATE=$(node ci/check-dependency-pins.mjs --updatable)
//   [ -n "$UPDATE" ] && npm update $UPDATE
//   node ci/check-dependency-pins.mjs   # exit 1 names drifted pins
//
// A drifted direct pin is restored lockfile-only with
// `npm install --package-lock-only <pkg>@<version>` (a bare `npm install
// <pkg>@<version>` would save the version into the manifest range; verified
// against npm 11: the manifest is untouched while the lockfile entry is
// restored with its resolved URL and integrity). Drift on a transitive pin
// files a follow-up instead: installing a transitive package by name would
// promote it to a direct dependency. Adoption of the newer version is
// filed as a follow-up instead of being floated by the sweep. After undrafting
// a sweep PR, wait for the heavy jobs (check/node22-compat re-run on
// ready_for_review) rather than trusting draft-CI green: drafts skip them.
//
// Stdout is pure JSON (pipe it to jq); the human one-liner goes to stderr.
// Exit 0 is pass (or successful listing), 1 is pin drift, 2 is usage.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const TEST_SCAN_DIRS = ["test", "ci"];
// A package.json reference and its version assertion must fall inside this
// line window to count as one pin. Wide enough for the multi-line
// expect(JSON.parse(readFileSync(...)).version).toBe("x.y.z") shape, tight
// enough that an unrelated semver (openapi "3.1.0", fixture constants) in the
// same file does not attach to a reference.
const REF_ASSERT_WINDOW = 10;

const SEMVER = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const PKG = "(?:@[A-Za-z0-9-~][A-Za-z0-9-._~]*\\/)?[A-Za-z0-9-~][A-Za-z0-9-._~]*";
// One pattern for both spellings: require("<pkg>/package.json") and
// path.join(root, "node_modules/<pkg>/package.json").
const REF_PATTERN = new RegExp(`["'](?:node_modules\\/)?(${PKG})\\/package\\.json["']`, "g");
const VERSION_ASSERT_PATTERN = new RegExp(
  `(?:\\.to(?:Be|Equal|StrictEqual)\\(\\s*["'](${SEMVER})["']\\s*\\)|assert(?:\\.\\w+)?\\(.*?,\\s*["'](${SEMVER})["']\\s*\\))`,
);
const MANIFEST_PIN_PATTERN =
  /expect\(\s*pkg\.(devDependencies|dependencies|optionalDependencies|overrides)\[\s*["']([^"']+)["']\s*\]\s*\)\s*\.\s*to(?:Be|Equal|StrictEqual)\(\s*(\S)/g;
const ABSENT_OVERRIDE_PATTERN =
  /expect\(\s*pkg\.overrides\s*\)\s*\.\s*not\s*\.\s*toHaveProperty\(\s*["']([^"']+)["']\s*\)/g;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// A bare semver with no range operator, tag, alias, URL or workspace prefix:
// the only spec `npm update` provably cannot float.
export const isExactRange = (spec) =>
  typeof spec === "string" && new RegExp(`^${SEMVER}$`).test(spec.trim());

function manifestDirectDeps(manifest) {
  const deps = {};
  for (const section of MANIFEST_SECTIONS) {
    if (isObject(manifest[section])) Object.assign(deps, manifest[section]);
  }
  return deps;
}

/** Exact manifest ranges and overrides keys: safe under `npm update`, verified. */
export function parseManifestPins(manifest) {
  const exact = [];
  for (const section of MANIFEST_SECTIONS) {
    if (!isObject(manifest[section])) continue;
    for (const [name, spec] of Object.entries(manifest[section])) {
      if (isExactRange(spec)) exact.push({ name, version: spec.trim(), section });
    }
  }
  const overrides = [];
  if (isObject(manifest.overrides)) {
    for (const key of Object.keys(manifest.overrides)) overrides.push({ key });
  }
  return { exact, overrides };
}

/** Merge physical lines continued by a trailing `(` or `,` into logical lines. */
export function joinContinuations(lines) {
  const logical = [];
  let current = null;
  lines.forEach((line, index) => {
    if (current === null) current = { text: line, line: index };
    else current.text += `\n${line}`;
    if (/[,(]\s*$/.test(line) && index + 1 < lines.length) return;
    logical.push(current);
    current = null;
  });
  if (current !== null) logical.push(current);
  return logical;
}

const RECEIVER_PATTERN = /([A-Za-z_$][\w$]*)\.version\b/;
const BARE_REQUIRE_TAIL = /(?<![A-Za-z0-9_$])require\s*\(\s*$/;
const CALL_TAIL = /([A-Za-z_$][\w$]*)\(\s*$/;
const ALIAS_TAIL = /([A-Za-z_$][\w$]*)\s*=\s*[^;]*$/;

/** Version assertions in one test source tied to package.json references. */
export function scanTestSource(source, relpath) {
  const logical = joinContinuations(source.split("\n"));
  const refs = [];
  for (const { text, line } of logical) {
    REF_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(REF_PATTERN)) {
      const before = text.slice(0, match.index);
      const via = CALL_TAIL.exec(before)?.[1] ?? null;
      refs.push({
        name: match[1],
        line,
        versionOnLine: /\.version\b/.test(text),
        // A bare require() from the test file, or an explicit node_modules/
        // path, reads the root copy. Any other resolver (lhciRequire, req, ...)
        // reads a consumer's copy, which the owning test verifies.
        root: match[0].includes("node_modules/") || BARE_REQUIRE_TAIL.test(before),
        via,
        alias: ALIAS_TAIL.exec(before)?.[1] ?? null,
      });
    }
  }
  const aliasTargets = new Map();
  for (const ref of refs) {
    if (ref.alias !== null) aliasTargets.set(ref.alias, ref.name);
  }
  const assertions = [];
  for (const { text, line } of logical) {
    const match = VERSION_ASSERT_PATTERN.exec(text);
    if (match) {
      assertions.push({
        version: match[1] ?? match[2],
        line,
        versionOnLine: /\.version\b/.test(text),
        receiver: RECEIVER_PATTERN.exec(text)?.[1] ?? null,
      });
    }
  }
  const installed = [];
  for (const assertion of assertions) {
    // The `.version` read must sit on the reference line or the assertion
    // line itself, and no finished statement may lie between them. A
    // dependencies-table assertion such as
    // `assert.equal(puppeteer.dependencies["chromium-bidi"], "157.0.8090-0")`
    // carries a semver but pins no installed package, so it must not attach
    // to a reference in a neighboring statement. When the asserted receiver
    // is a known alias (`const wrangler = require("wrangler/package.json")`
    // then `expect(wrangler.version)`), only that alias's package may attach,
    // even when an unrelated reference sits nearer.
    const nearby = refs.filter((ref) => {
      if (Math.abs(ref.line - assertion.line) > REF_ASSERT_WINDOW) return false;
      if (!assertion.versionOnLine && !ref.versionOnLine) return false;
      // An asserted alias names its package explicitly (`expect(a.version)` for
      // `const a = require("foo/package.json")`), so it binds across finished
      // statements; proximity-only matches still respect statement boundaries.
      if (assertion.receiver !== null && aliasTargets.has(assertion.receiver)) {
        return ref.name === aliasTargets.get(assertion.receiver);
      }
      const between = logical
        .slice(
          logical.findIndex((entry) => entry.line === Math.min(ref.line, assertion.line)) + 1,
          logical.findIndex((entry) => entry.line === Math.max(ref.line, assertion.line)),
        )
        .map((entry) => entry.text);
      return !between.some((line) => /;\s*$/.test(line) || /^\s*$/.test(line));
    });
    if (nearby.length === 0) continue;
    const nearest = nearby.reduce((best, ref) =>
      Math.abs(ref.line - assertion.line) < Math.abs(best.line - assertion.line) ? ref : best,
    );
    if (installed.some((pin) => pin.name === nearest.name && pin.version === assertion.version)) {
      continue;
    }
    installed.push({
      name: nearest.name,
      version: assertion.version,
      file: relpath,
      line: nearest.line + 1,
      root: nearest.root,
      via: nearest.via,
    });
  }
  const manifest = [];
  MANIFEST_PIN_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(MANIFEST_PIN_PATTERN)) {
    manifest.push({
      section: match[1],
      key: match[2],
      expectedKind: match[3] === '"' || match[3] === "'" ? "string" : "expression",
      file: relpath,
    });
  }
  const absentOverrides = [];
  ABSENT_OVERRIDE_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(ABSENT_OVERRIDE_PATTERN)) {
    absentOverrides.push({ key: match[1], file: relpath });
  }
  // Resolve string expectations from the assertion line for exact verification;
  // expression expectations (toEqual({...})) stay presence-checked: the owning
  // test does the deep comparison.
  const manifestLines = manifest.map((pin) => {
    if (pin.expectedKind !== "string") return pin;
    const pattern = new RegExp(
      `expect\\(\\s*pkg\\.${pin.section}\\[\\s*["']${pin.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*\\]\\s*\\)\\s*\\.\\s*to(?:Be|Equal|StrictEqual)\\(\\s*["']([^"']+)["']\\s*\\)`,
    );
    const found = pattern.exec(source);
    return { ...pin, expected: found ? found[1] : null };
  });
  return { installed, manifest: manifestLines, absentOverrides };
}

function listTestFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(rel);
      } else if (/\.test\.(mjs|cjs|js|ts)$/.test(entry.name)) {
        found.push(rel);
      }
    }
  };
  for (const dir of TEST_SCAN_DIRS) {
    try {
      walk(dir);
    } catch {
      // A missing scan dir is not a pin violation.
    }
  }
  return found.sort();
}

/** Full pin inventory for the repo root. Nothing is hardcoded. */
export function collectPins(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (!isObject(lockfile.packages)) {
    throw new Error("package-lock.json has no `packages` map (requires lockfileVersion 2 or 3)");
  }
  const { exact, overrides } = parseManifestPins(manifest);
  const installed = [];
  const manifestPins = [];
  const absentOverrides = [];
  for (const rel of listTestFiles(root)) {
    const scanned = scanTestSource(readFileSync(join(root, rel), "utf8"), rel);
    installed.push(...scanned.installed);
    manifestPins.push(...scanned.manifest);
    absentOverrides.push(...scanned.absentOverrides);
  }
  return { manifest, lockfile, exact, overrides, installed, manifestPins, absentOverrides };
}

function lockVersion(lockfile, name) {
  const entry = lockfile.packages?.[`node_modules/${name}`];
  return typeof entry?.version === "string" ? entry.version : null;
}

/** The trailing package name of a lockfile `packages` key. */
function packageBasename(key) {
  const tail = key
    .split("node_modules/")
    .at(-1)
    ?.split("/")
    .filter((segment) => segment.length > 0);
  if (!tail || tail.length === 0) return null;
  if (tail[0].startsWith("@")) return tail.length >= 2 ? `${tail[0]}/${tail[1]}` : null;
  return tail[0];
}

/** Every lockfile copy of a package, at any depth. */
function lockEntriesFor(lockfile, name) {
  return Object.entries(lockfile.packages ?? {})
    .filter(([key, entry]) => packageBasename(key) === name && typeof entry?.version === "string")
    .map(([key, entry]) => ({ path: key, version: entry.version }));
}

/** Node-style resolution of `sub` from inside the `scope` package. */
function resolveFromScope(lockfile, scope, sub) {
  const roots = [`node_modules/${scope}/node_modules/${sub}`, `node_modules/${sub}`];
  for (const path of roots) {
    const version = lockfile.packages?.[path]?.version;
    if (typeof version === "string") return { path, version };
  }
  return null;
}

/** Verify every pin against the manifest and lockfile. */
export function verifyPins({
  manifest,
  lockfile,
  exact,
  overrides,
  installed,
  manifestPins,
  absentOverrides,
}) {
  const checks = [];
  const direct = manifestDirectDeps(manifest);
  for (const pin of installed) {
    const id = `installed:${pin.name}`;
    const directName = Object.hasOwn(direct, pin.name);
    if (pin.root === false) {
      checks.push({
        id,
        status: "info",
        detail: `consumer-resolved pin ${pin.name}@${pin.version} (${pin.file}:${pin.line}${pin.via ? ` via ${pin.via}` : ""}); the owning test reads a consumer copy, not the root entry, so it stays held back but verifies there`,
      });
      continue;
    }
    const actual = lockVersion(lockfile, pin.name);
    if (actual === null) {
      checks.push({
        id,
        status: "fail",
        detail: `no root lockfile entry for pinned ${pin.name} (expected ${pin.version}; ${pin.file}:${pin.line})`,
      });
    } else if (actual !== pin.version) {
      checks.push(
        directName
          ? {
              id,
              status: "fail",
              detail: `${pin.name} drifted to ${actual} (pinned ${pin.version}; ${pin.file}:${pin.line}); restore with \`npm install --package-lock-only ${pin.name}@${pin.version}\` and file a follow-up`,
            }
          : {
              id,
              status: "fail",
              detail: `transitive pin ${pin.name} drifted to ${actual} (pinned ${pin.version}; ${pin.file}:${pin.line}); file a follow-up (installing it by name would promote it to a direct dependency)`,
            },
      );
    } else {
      checks.push({
        id,
        status: "pass",
        detail: directName
          ? `${pin.name}@${actual} matches ${pin.file}:${pin.line}`
          : `transitive pin ${pin.name}@${actual} matches the root lockfile entry (${pin.file}:${pin.line})`,
      });
    }
  }
  for (const pin of exact) {
    const id = `exact:${pin.name}`;
    const actual = manifest[pin.section]?.[pin.name];
    if (actual !== pin.version) {
      checks.push({
        id,
        status: "fail",
        detail: `${pin.section}["${pin.name}"] is ${JSON.stringify(actual)} (expected exact ${pin.version})`,
      });
      continue;
    }
    const resolved = lockVersion(lockfile, pin.name);
    checks.push(
      resolved === pin.version
        ? {
            id,
            status: "pass",
            detail: `${pin.section}["${pin.name}"] is exact ${pin.version}, lockfile agrees`,
          }
        : {
            id,
            status: "fail",
            detail: `${pin.name} lockfile is ${resolved ?? "missing"} (manifest pins exact ${pin.version}); restore with \`npm install --package-lock-only ${pin.name}@${pin.version}\` and file a follow-up`,
          },
    );
  }
  for (const pin of overrides) {
    const id = `override:${pin.key}`;
    if (!isObject(manifest.overrides) || !Object.hasOwn(manifest.overrides, pin.key)) {
      checks.push({ id, status: "fail", detail: `overrides["${pin.key}"] was removed` });
      continue;
    }
    const spec = manifest.overrides[pin.key];
    if (typeof spec === "string") {
      const copies = lockEntriesFor(lockfile, pin.key);
      if (copies.length === 0) {
        checks.push({
          id,
          status: "info",
          detail: `overrides["${pin.key}"] pins ${spec} but no copy is installed in this tree`,
        });
      } else if (copies.every((copy) => copy.version === spec)) {
        checks.push({
          id,
          status: "pass",
          detail: `overrides["${pin.key}"] pins ${spec}; ${copies.length} installed ${copies.length === 1 ? "copy agrees" : "copies agree"}`,
        });
      } else {
        const offenders = copies
          .filter((copy) => copy.version !== spec)
          .map((copy) => `${copy.path}@${copy.version}`)
          .join(", ");
        checks.push({
          id,
          status: "fail",
          detail: `overrides["${pin.key}"] pins ${spec} but ${offenders} drifted; restore with \`npm install --package-lock-only ${pin.key}@${spec}\` and file a follow-up`,
        });
      }
      continue;
    }
    if (!isObject(spec)) {
      checks.push({
        id,
        status: "fail",
        detail: `overrides["${pin.key}"] is not a version or map`,
      });
      continue;
    }
    for (const [sub, subSpec] of Object.entries(spec)) {
      const subId = `override:${pin.key}[${sub}]`;
      if (typeof subSpec !== "string") {
        checks.push({
          id: subId,
          status: "info",
          detail: `overrides["${pin.key}"]["${sub}"] uses a nested selector; verified by the owning test`,
        });
        continue;
      }
      const edge = lockfile.packages?.[`node_modules/${pin.key}`]?.dependencies?.[sub];
      if (edge === undefined) {
        checks.push({
          id: subId,
          status: "info",
          detail: `overrides["${pin.key}"]["${sub}"] is vacuous (${pin.key} declares no ${sub} edge); verified by the owning test`,
        });
        continue;
      }
      const resolved = resolveFromScope(lockfile, pin.key, sub);
      checks.push(
        resolved?.version === subSpec
          ? {
              id: subId,
              status: "pass",
              detail: `overrides["${pin.key}"]["${sub}"] pins ${subSpec} (${resolved.path} agrees)`,
            }
          : {
              id: subId,
              status: "fail",
              detail: `overrides["${pin.key}"]["${sub}"] pins ${subSpec} but resolves to ${resolved ? `${resolved.path}@${resolved.version}` : "nothing installed"}; restore with \`npm install\` from a clean tree and file a follow-up`,
            },
      );
    }
    if (Object.keys(spec).length === 0) {
      checks.push({ id, status: "info", detail: `overrides["${pin.key}"] is an empty map` });
    } else {
      checks.push({ id, status: "pass", detail: `overrides["${pin.key}"] present` });
    }
  }
  for (const pin of manifestPins) {
    const id = `manifest:${pin.section}[${pin.key}]`;
    const actual = manifest[pin.section]?.[pin.key];
    if (pin.expectedKind === "string" && pin.expected !== null) {
      checks.push(
        actual === pin.expected
          ? {
              id,
              status: "pass",
              detail: `${pin.section}["${pin.key}"] is ${JSON.stringify(pin.expected)} per ${pin.file}`,
            }
          : {
              id,
              status: "fail",
              detail: `${pin.section}["${pin.key}"] is ${JSON.stringify(actual)} (test pins ${JSON.stringify(pin.expected)} in ${pin.file})`,
            },
      );
    } else {
      checks.push(
        actual !== undefined
          ? {
              id,
              status: "pass",
              detail: `${pin.section}["${pin.key}"] present per ${pin.file} (deep check lives in the owning test)`,
            }
          : {
              id,
              status: "fail",
              detail: `${pin.section}["${pin.key}"] is missing (pinned in ${pin.file})`,
            },
      );
    }
  }
  for (const pin of absentOverrides) {
    const id = `absent-override:${pin.key}`;
    checks.push(
      isObject(manifest.overrides) && Object.hasOwn(manifest.overrides, pin.key)
        ? {
            id,
            status: "fail",
            detail: `overrides["${pin.key}"] must stay absent (pinned in ${pin.file})`,
          }
        : { id, status: "pass", detail: `overrides["${pin.key}"] absent per ${pin.file}` },
    );
  }
  const failed = checks.filter((check) => check.status === "fail");
  return { ok: failed.length === 0, checks, failed: failed.length };
}

/** Installed-version pins whose manifest range can float: `npm update` must skip these. */
export function holdBackNames(pins) {
  const direct = manifestDirectDeps(pins.manifest);
  return [
    ...new Set(
      pins.installed
        .filter((pin) => Object.hasOwn(direct, pin.name) && !isExactRange(direct[pin.name]))
        .map((pin) => pin.name),
    ),
  ].sort();
}

/** Direct dependencies safe to pass to `npm update`. */
export function updatableNames(pins) {
  const held = new Set(holdBackNames(pins));
  return Object.keys(manifestDirectDeps(pins.manifest))
    .filter((name) => !held.has(name))
    .sort();
}

function report(root = ROOT) {
  const pins = collectPins(root);
  return {
    check: "dependency-pins",
    version: 1,
    ...verifyPins(pins),
    holdBack: holdBackNames(pins),
    updatable: updatableNames(pins),
  };
}

function selftest() {
  let cases = 0;
  const assert = (cond, label) => {
    cases += 1;
    if (!cond) throw new Error(`selftest case failed: ${label}`);
  };
  assert(isExactRange("4.152.0") === true, "bare semver is exact");
  assert(isExactRange("^4.152.0") === false, "caret range is not exact");
  assert(isExactRange(">=1.0.0") === false, "inequality is not exact");
  assert(isExactRange("latest") === false, "tag is not exact");
  assert(isExactRange(" 2.9.1 ") === true, "surrounding whitespace is exact");
  // Wrangler shape: multi-line expect with a node_modules reference.
  const wranglerReal = [
    "expect(",
    '  JSON.parse(readFileSync(path.join(root, "node_modules/wrangler/package.json"), "utf8")).version,',
    ').toBe("4.152.0");',
  ].join("\n");
  const found = scanTestSource(wranglerReal, "test/remote-runner-isolation.test.ts");
  assert(
    found.installed.length === 1 &&
      found.installed[0].name === "wrangler" &&
      found.installed[0].version === "4.152.0",
    "wrangler multi-line pin is discovered with evidence",
  );
  // LHCI shape: same-line require().version with assert.equal.
  const lhciSource = 'assert.equal(require("@lhci/cli/package.json").version, "0.15.1");';
  const lhci = scanTestSource(lhciSource, "test/performance-ci.test.ts");
  assert(
    lhci.installed.length === 1 &&
      lhci.installed[0].name === "@lhci/cli" &&
      lhci.installed[0].version === "0.15.1",
    "scoped same-line require pin is discovered",
  );
  // Transitive require through another package's resolver is still discovered;
  // the verifier (not the scanner) marks it informational.
  const transitive = scanTestSource(
    'assert.equal(lhciRequire("tmp/package.json").version, "0.2.7");',
    "t.ts",
  );
  assert(
    transitive.installed.length === 1 && transitive.installed[0].name === "tmp",
    "nested require pin is discovered",
  );
  // Unrelated semvers without a package.json reference are not pins.
  const openapi = scanTestSource(
    'expect(doc.openapi).toBe("3.1.0");\nexpect(doc.info.version).toBe("1.0.0");',
    "t.ts",
  );
  assert(openapi.installed.length === 0, "openapi versions without a reference are ignored");
  // Dependencies-table assertions pin a manifest edge, not an installed package.
  const depsTable = scanTestSource(
    [
      'const puppeteer = lighthouseRequire("puppeteer-core/package.json");',
      'assert.equal(puppeteer.version, "25.16.0");',
      'assert.equal(puppeteer.dependencies["@puppeteer/browsers"], "3.2.6");',
    ].join("\n"),
    "t.ts",
  );
  assert(
    depsTable.installed.length === 1 &&
      depsTable.installed[0].name === "puppeteer-core" &&
      depsTable.installed[0].version === "25.16.0",
    "dependencies-table semvers do not forge pins",
  );
  // Synthetic fixture writes use path.join segments, never a package.json literal.
  const fixture = scanTestSource(
    [
      "writeFileSync(",
      '  path.join(repo, "node_modules", name),',
      '  JSON.stringify({ version: "0.0.0-fixture" }),',
      ");",
      'expected = { revision, wranglerVersion: "4.143.1" };',
      "expect(result).toEqual(expected);",
    ].join("\n"),
    "t.ts",
  );
  assert(
    fixture.installed.length === 0,
    "fixture writes without a package.json literal are ignored",
  );
  // Manifest pins: string expectations resolve, expressions stay presence-checked.
  const manifestSource = [
    'expect(pkg.devDependencies["@lhci/cli"]).toBe("0.15.1");',
    'expect(pkg.overrides["basic-ftp"]).toBe("6.2.1");',
    'expect(pkg.overrides["@lhci/cli"]).toEqual({',
    '  tmp: "0.2.7",',
    "});",
    'expect(pkg.overrides).not.toHaveProperty("zod");',
  ].join("\n");
  const scannedManifest = scanTestSource(manifestSource, "test/performance-ci.test.ts");
  assert(scannedManifest.manifest.length === 3, "manifest pins are discovered");
  const lhciManifest = scannedManifest.manifest.find(
    (pin) => pin.section === "overrides" && pin.key === "@lhci/cli",
  );
  assert(lhciManifest?.expectedKind === "expression", "toEqual pins stay expression-kind");
  const ftp = scannedManifest.manifest.find((pin) => pin.key === "basic-ftp");
  assert(ftp?.expected === "6.2.1", "toBe string expectations resolve");
  assert(
    scannedManifest.absentOverrides.length === 1 &&
      scannedManifest.absentOverrides[0].key === "zod",
    "absent-override pins are discovered",
  );
  // Verify: pass, drift with restore hint, missing lock entry, transitive info.
  const base = {
    manifest: {
      dependencies: { zod: "4.6.7" },
      devDependencies: { wrangler: "^4.152.0", "@lhci/cli": "0.15.1" },
      overrides: { esbuild: "0.28.2", "basic-ftp": "6.2.1" },
    },
    lockfile: {
      packages: {
        "node_modules/wrangler": { version: "4.152.0" },
        "node_modules/zod": { version: "4.6.7" },
      },
    },
    exact: [{ name: "zod", version: "4.6.7", section: "dependencies" }],
    overrides: [{ key: "esbuild" }, { key: "basic-ftp" }],
    installed: [{ name: "wrangler", version: "4.152.0", file: "t.ts", line: 1 }],
    manifestPins: [
      {
        section: "overrides",
        key: "basic-ftp",
        expectedKind: "string",
        expected: "6.2.1",
        file: "t.ts",
      },
    ],
    absentOverrides: [{ key: "zod", file: "t.ts" }],
  };
  assert(verifyPins(base).ok === true, "clean tree verifies");
  assert(
    holdBackNames(base).join(" ") === "wrangler" && !updatableNames(base).includes("wrangler"),
    "floatable test pin is held back from updates",
  );
  assert(
    updatableNames(base).includes("zod"),
    "exact-range deps stay updatable (npm update no-ops them)",
  );
  const drifted = {
    ...base,
    lockfile: { packages: { "node_modules/wrangler": { version: "4.156.0" } } },
  };
  const driftResult = verifyPins(drifted);
  assert(
    driftResult.ok === false &&
      driftResult.checks.some((c) =>
        c.detail.includes("npm install --package-lock-only wrangler@4.152.0"),
      ),
    "drift fails with a lockfile-only restore hint",
  );
  const missing = { ...base, lockfile: { packages: {} } };
  assert(verifyPins(missing).ok === false, "missing lockfile entry fails closed");
  // Consumer-resolved transitive pins (the shape the scanner emits for
  // `lhciRequire("tmp/package.json")`) stay informational and never held back.
  const withTransitive = {
    ...base,
    installed: [
      ...base.installed,
      { name: "tmp", version: "0.2.7", file: "t.ts", line: 9, root: false, via: "lhciRequire" },
    ],
  };
  const transitiveResult = verifyPins(withTransitive);
  assert(
    transitiveResult.ok === true &&
      transitiveResult.checks.some((c) => c.id === "installed:tmp" && c.status === "info") &&
      !holdBackNames(withTransitive).includes("tmp"),
    "consumer-resolved transitive pins are informational, never held back",
  );
  // A transitive pin read from the root copy is verified against the root
  // lockfile entry instead of passing blindly.
  const withRootTransitive = {
    ...base,
    installed: [
      ...base.installed,
      { name: "lighthouse", version: "12.6.1", file: "t.ts", line: 12, root: true },
    ],
    lockfile: {
      packages: {
        ...base.lockfile.packages,
        "node_modules/lighthouse": { version: "12.6.1" },
      },
    },
  };
  const rootTransitiveResult = verifyPins(withRootTransitive);
  assert(
    rootTransitiveResult.ok === true &&
      rootTransitiveResult.checks.some(
        (c) => c.id === "installed:lighthouse" && c.status === "pass",
      ),
    "root-resolved transitive pins verify when the lockfile agrees",
  );
  const driftedRootTransitive = {
    ...withRootTransitive,
    lockfile: {
      packages: {
        ...withRootTransitive.lockfile.packages,
        "node_modules/lighthouse": { version: "12.6.2" },
      },
    },
  };
  const driftedRootTransitiveResult = verifyPins(driftedRootTransitive);
  assert(
    driftedRootTransitiveResult.ok === false &&
      driftedRootTransitiveResult.checks.some(
        (c) =>
          c.id === "installed:lighthouse" &&
          c.status === "fail" &&
          !c.detail.includes("npm install"),
      ),
    "root-resolved transitive drift fails without an install-by-name hint",
  );
  const missingRootTransitive = {
    ...withRootTransitive,
    lockfile: { packages: { ...base.lockfile.packages } },
  };
  assert(
    verifyPins(missingRootTransitive).ok === false,
    "missing root entry for a root-resolved transitive pin fails closed",
  );
  // Multiline assertions: a trailing `(` continues onto the next physical line.
  const splitCall = scanTestSource(
    ['expect(JSON.parse(readFileSync("foo/package.json")).version', '  ).toBe("1.2.3");'].join(
      "\n",
    ),
    "t.ts",
  );
  assert(
    splitCall.installed.length === 1 &&
      splitCall.installed[0].name === "foo" &&
      splitCall.installed[0].version === "1.2.3",
    "assertions split across continuation lines are discovered",
  );
  // Alias receivers: the asserted alias wins over a nearer unrelated reference.
  const aliased = scanTestSource(
    [
      'const a = require("foo/package.json");',
      'const b = require("bar/package.json");',
      'expect(a.version).toBe("1.2.3");',
    ].join("\n"),
    "t.ts",
  );
  assert(
    aliased.installed.length === 1 &&
      aliased.installed[0].name === "foo" &&
      aliased.installed[0].version === "1.2.3",
    "alias receivers attach to their own package",
  );
  // Consumer-resolved pins stay held back but verify where the owning test reads.
  const viaConsumer = {
    ...base,
    installed: [
      {
        name: "wrangler",
        version: "4.152.0",
        file: "t.ts",
        line: 1,
        root: false,
        via: "lhciRequire",
      },
    ],
  };
  const viaResult = verifyPins(viaConsumer);
  assert(
    viaResult.ok === true &&
      viaResult.checks.some((c) => c.id === "installed:wrangler" && c.status === "info") &&
      holdBackNames(viaConsumer).join(" ") === "wrangler",
    "consumer-resolved pins are held back but verify as informational",
  );
  // Exact ranges are checked against the lockfile, not just the manifest.
  const exactDrift = {
    ...base,
    lockfile: { packages: { ...base.lockfile.packages, "node_modules/zod": { version: "9.9.9" } } },
  };
  const exactDriftResult = verifyPins(exactDrift);
  assert(
    exactDriftResult.ok === false &&
      exactDriftResult.checks.some(
        (c) =>
          c.id === "exact:zod" && c.detail.includes("npm install --package-lock-only zod@4.6.7"),
      ),
    "exact-range drift fails with a restore hint",
  );
  // String overrides must hold for every installed copy.
  const overrideBase = {
    ...base,
    manifest: { ...base.manifest, overrides: { ...base.manifest.overrides, undici: "7.30.1" } },
    overrides: [...base.overrides, { key: "undici" }],
    exact: [],
    lockfile: {
      packages: {
        ...base.lockfile.packages,
        "node_modules/undici": { version: "7.30.1" },
        "node_modules/foo/node_modules/undici": { version: "7.30.0" },
      },
    },
  };
  const overrideDrift = verifyPins(overrideBase);
  assert(
    overrideDrift.ok === false &&
      overrideDrift.checks.some((c) => c.id === "override:undici" && c.status === "fail"),
    "a drifted nested copy fails the string override",
  );
  const overrideFixed = {
    ...overrideBase,
    lockfile: {
      packages: {
        ...overrideBase.lockfile.packages,
        "node_modules/foo/node_modules/undici": { version: "7.30.1" },
      },
    },
  };
  assert(verifyPins(overrideFixed).ok === true, "agreeing copies pass the string override");
  // Nested overrides follow the scope package; a missing edge is vacuous, not a pass.
  const nestedBase = {
    ...base,
    manifest: {
      ...base.manifest,
      overrides: { ...base.manifest.overrides, "@lhci/cli": { tmp: "0.2.7" } },
    },
    overrides: [...base.overrides, { key: "@lhci/cli" }],
    exact: [],
    installed: [],
    manifestPins: [],
    lockfile: {
      packages: {
        ...base.lockfile.packages,
        "node_modules/@lhci/cli": { version: "0.15.1", dependencies: { tmp: "^0.2.7" } },
        "node_modules/tmp": { version: "0.2.7" },
      },
    },
  };
  const nestedResult = verifyPins(nestedBase);
  assert(
    nestedResult.ok === true &&
      nestedResult.checks.some((c) => c.id === "override:@lhci/cli[tmp]" && c.status === "pass"),
    "nested overrides verify the copy their scope resolves",
  );
  const vacuousBase = {
    ...nestedBase,
    lockfile: {
      packages: {
        ...base.lockfile.packages,
        "node_modules/@lhci/cli": { version: "0.15.1", dependencies: {} },
        "node_modules/tmp": { version: "9.9.9" },
      },
    },
  };
  const vacuousResult = verifyPins(vacuousBase);
  assert(
    vacuousResult.ok === true &&
      vacuousResult.checks.some((c) => c.id === "override:@lhci/cli[tmp]" && c.status === "info"),
    "vacuous nested overrides stay informational instead of passing blindly",
  );
  console.log(`dependency pins selftest: ${cases} cases passed.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && args[0] === "--selftest") {
      process.exitCode = selftest();
    } else if (args.length === 0) {
      const result = report();
      console.log(JSON.stringify(result, null, 2));
      console.error(
        result.ok
          ? `dependency-pins: ok (${result.checks.length} checks; hold back: ${result.holdBack.join(" ") || "none"})`
          : `dependency-pins: FAIL (${result.failed} failing; see JSON report above)`,
      );
      process.exitCode = result.ok ? 0 : 1;
    } else if (args.length === 1 && (args[0] === "--names" || args[0] === "--updatable")) {
      const pins = collectPins();
      const names = args[0] === "--names" ? holdBackNames(pins) : updatableNames(pins);
      if (names.length > 0) console.log(names.join(" "));
    } else {
      console.log(
        JSON.stringify(
          {
            check: "dependency-pins",
            version: 1,
            ok: false,
            error_code: "invalid_arguments",
            retryable: false,
            next_action:
              "Run node ci/check-dependency-pins.mjs with no flags (verify), --names (hold-back set), --updatable (safe npm-update list), or --selftest.",
          },
          null,
          2,
        ),
      );
      console.error(
        "Usage: node ci/check-dependency-pins.mjs [--names | --updatable | --selftest]",
      );
      process.exitCode = 2;
    }
  } catch (err) {
    console.log(
      JSON.stringify(
        {
          check: "dependency-pins",
          version: 1,
          ok: false,
          error_code: "check_error",
          retryable: false,
          next_action: `The gate itself failed: ${err instanceof Error ? err.message : err}. Fix the gate or the files it reads, then rerun.`,
        },
        null,
        2,
      ),
    );
    console.error(`dependency-pins: error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
