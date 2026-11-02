// Dependency-pin guard: the weekly sweep must not float packages whose exact
// resolved version is pinned elsewhere in the repo.
//
// Pin sources (all discovered, nothing hardcoded):
//   1. Installed-version test pins — a test reads node_modules/<pkg>/package.json
//      (or require("<pkg>/package.json")) and asserts `.version` equals an exact
//      semver, e.g. test/remote-runner-isolation.test.ts pins wrangler 4.152.0
//      while package.json allows ^4.152.0. A bare `npm update` floats these.
//   2. Manifest pins — test/performance-ci.test.ts asserts package.json ranges
//      and overrides entries verbatim (e.g. devDependencies["@lhci/cli"],
//      overrides["basic-ftp"], and the absence of overrides["zod"]). `npm
//      update` never rewrites the manifest, so these are verify-only.
//   3. Exact ranges and overrides keys in package.json — inherently safe under
//      `npm update`, listed for visibility and verified against the lockfile.
//
// Sweep usage (holds back floatable pins, then verifies the lockfile kept them):
//
//   UPDATE=$(node ci/check-dependency-pins.mjs --updatable)
//   [ -n "$UPDATE" ] && npm update $UPDATE
//   node ci/check-dependency-pins.mjs   # exit 1 names drifted pins
//
// A drifted pin is restored lockfile-only with `npm install <pkg>@<version>`
// (the manifest range is left untouched) and adoption of the newer version is
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

/** Version assertions in one test source tied to package.json references. */
export function scanTestSource(source, relpath) {
  const lines = source.split("\n");
  const refs = [];
  lines.forEach((line, index) => {
    REF_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(REF_PATTERN)) {
      refs.push({ name: match[1], line: index, versionOnLine: /\.version\b/.test(line) });
    }
  });
  const assertions = [];
  lines.forEach((line, index) => {
    const match = VERSION_ASSERT_PATTERN.exec(line);
    if (match) {
      assertions.push({
        version: match[1] ?? match[2],
        line: index,
        versionOnLine: /\.version\b/.test(line),
      });
    }
  });
  const installed = [];
  for (const assertion of assertions) {
    // The `.version` read must sit on the reference line or the assertion
    // line itself, and no finished statement may lie between them. A
    // dependencies-table assertion such as
    // `assert.equal(puppeteer.dependencies["chromium-bidi"], "157.0.8090-0")`
    // carries a semver but pins no installed package, so it must not attach
    // to a reference in a neighboring statement.
    const nearby = refs.filter((ref) => {
      if (Math.abs(ref.line - assertion.line) > REF_ASSERT_WINDOW) return false;
      if (!assertion.versionOnLine && !ref.versionOnLine) return false;
      const between = lines.slice(
        Math.min(ref.line, assertion.line) + 1,
        Math.max(ref.line, assertion.line),
      );
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
    if (!Object.hasOwn(direct, pin.name)) {
      checks.push({
        id,
        status: "info",
        detail: `transitive pin ${pin.name}@${pin.version} (${pin.file}:${pin.line}); enforced by overrides, verified by the owning test`,
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
      checks.push({
        id,
        status: "fail",
        detail: `${pin.name} drifted to ${actual} (pinned ${pin.version}; ${pin.file}:${pin.line}); restore with \`npm install ${pin.name}@${pin.version}\` and file a follow-up`,
      });
    } else {
      checks.push({
        id,
        status: "pass",
        detail: `${pin.name}@${actual} matches ${pin.file}:${pin.line}`,
      });
    }
  }
  for (const pin of exact) {
    const id = `exact:${pin.name}`;
    const actual = manifest[pin.section]?.[pin.name];
    checks.push(
      actual === pin.version
        ? { id, status: "pass", detail: `${pin.section}["${pin.name}"] is exact ${pin.version}` }
        : {
            id,
            status: "fail",
            detail: `${pin.section}["${pin.name}"] is ${JSON.stringify(actual)} (expected exact ${pin.version})`,
          },
    );
  }
  for (const pin of overrides) {
    const id = `override:${pin.key}`;
    checks.push(
      isObject(manifest.overrides) && Object.hasOwn(manifest.overrides, pin.key)
        ? { id, status: "pass", detail: `overrides["${pin.key}"] present` }
        : { id, status: "fail", detail: `overrides["${pin.key}"] was removed` },
    );
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
      driftResult.checks.some((c) => c.detail.includes("npm install wrangler@4.152.0")),
    "drift fails with a lockfile-only restore hint",
  );
  const missing = { ...base, lockfile: { packages: {} } };
  assert(verifyPins(missing).ok === false, "missing lockfile entry fails closed");
  const withTransitive = {
    ...base,
    installed: [...base.installed, { name: "tmp", version: "0.2.7", file: "t.ts", line: 9 }],
  };
  const transitiveResult = verifyPins(withTransitive);
  assert(
    transitiveResult.ok === true &&
      transitiveResult.checks.some((c) => c.id === "installed:tmp" && c.status === "info") &&
      !holdBackNames(withTransitive).includes("tmp"),
    "transitive pins are informational, never held back",
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
