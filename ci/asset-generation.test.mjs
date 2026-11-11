// Helper and workflow-shape tests for the controlled draft asset generation
// route. Local fixtures only: scratch git repositories, no install, no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  classifyStatus,
  collect,
  compareVersions,
  inventoryHooks,
  jobPolicyProblems,
  parseStatus,
  REVIEWED_ROOT_HOOKS,
  validateRaw,
  verdict,
} from "./asset-generation.mjs";

const scratches = [];
const scratch = (prefix) => {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), prefix));
  scratches.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const ALLOWED = ["public/a.js", "public/b.js", "public/new.js"];
const ENV = {
  GITHUB_REPOSITORY: "o/r",
  GITHUB_RUN_ID: "1",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "asset-generation",
  GITHUB_SERVER_URL: "https://github.example",
};

// A scratch repository shaped like the generator inputs collect() identifies.
function repo() {
  const root = scratch("asset-gen-repo-");
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  for (const f of [
    "ci/minify-assets.mjs",
    "ci/build-ember-tokens.mjs",
    "ci/budget-fragments.mjs",
    "ci/build-leaf-css.mjs",
    "ci/asset-generation.mjs",
  ]) {
    put(root, f, `// ${f}\n`);
  }
  put(root, "package-lock.json", "{}\n");
  put(root, "tsconfig.json", "{}\n");
  put(root, "assets/a.js", "source\n");
  put(root, "public/a.js", "old-a\n");
  put(root, "public/b.js", "old-b\n");
  put(root, "src/ember-fallback-style.ts", "export {};\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return { root, head: git(root, "rev-parse", "HEAD").trim() };
}

function work(over = {}) {
  const dir = scratch("asset-gen-work-");
  const files = {
    "initial.exit": "0",
    "post.exit": "0",
    "initial.log": "ok\n",
    "npm.version": "11.10.0\n",
    "esbuild.json": JSON.stringify({ version: "0.28.2" }),
    "inventory.json": "{}",
    "npm-fixtures.json": '{"ok":true,"checks":[]}',
    ...over,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function run(setup, workOver = {}, env = {}) {
  const { root, head } = repo();
  setup(root);
  const out = scratch("asset-gen-out-");
  const manifest = collect({
    root,
    outDir: out,
    work: work(workOver),
    allowed: ALLOWED,
    env: { ...ENV, PR_HEAD_SHA: head, PR_BASE_SHA: "b".repeat(40), PR_NUMBER: "7", ...env },
  });
  return { root, out, manifest, head };
}

describe("versions and policy", () => {
  it("orders npm versions numerically", () => {
    assert.equal(compareVersions("11.10.0", "11.10.0"), 0);
    assert.equal(compareVersions("11.9.9", "11.10.0"), -1);
    assert.equal(compareVersions("12.0.0", "11.10.0"), 1);
    assert.equal(compareVersions("10.9.2", "11.10.0"), -1);
  });
  it("requires both job-scoped npm policy values", () => {
    assert.deepEqual(
      jobPolicyProblems({ npm_config_ignore_scripts: "true", npm_config_min_release_age: "3" }),
      [],
    );
    assert.equal(jobPolicyProblems({}).length, 2);
    assert.equal(
      jobPolicyProblems({ npm_config_ignore_scripts: "false", npm_config_min_release_age: "3" })
        .length,
      1,
    );
  });
});

describe("hook inventory", () => {
  const lock = (packages) => JSON.stringify({ packages: { "": {}, ...packages } });
  const fixture = (hooks, packages = {}) => {
    const root = scratch("asset-gen-inv-");
    put(root, "package.json", JSON.stringify({ scripts: hooks }));
    put(root, "package-lock.json", lock(packages));
    return root;
  };
  it("accepts the reviewed root hook and records locked dependency hooks", () => {
    const inv = inventoryHooks(
      fixture(REVIEWED_ROOT_HOOKS, {
        "node_modules/esbuild": {
          version: "0.28.2",
          hasInstallScript: true,
          resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz",
          integrity: "sha512-x",
        },
        "node_modules/vendored": { version: "1.0.0", resolved: "git+https://example.com/x.git" },
      }),
    );
    assert.equal(inv.ok, true);
    assert.deepEqual(
      inv.lockedDependencyHooks.map((h) => h.path),
      ["node_modules/esbuild"],
    );
    assert.deepEqual(
      inv.nonRegistrySources.map((s) => s.path),
      ["node_modules/vendored"],
    );
    assert.match(inv.lockSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      inv.rootHookGenerators.map((g) => [g.hook, g.path, g.reviewed]),
      [
        ["postinstall", "ci/build-ember-tokens.mjs", true],
        ["postinstall", "ci/build-leaf-css.mjs", true],
      ],
    );
  });
  it("covers prepack, postpack, prepublishOnly and prepare as hooks", () => {
    for (const name of ["prepack", "postpack", "prepublishOnly", "prepare"]) {
      const inv = inventoryHooks(fixture({ ...REVIEWED_ROOT_HOOKS, [name]: "echo hi" }));
      assert.equal(inv.ok, false, name);
      assert.ok(name in inv.rootHooks, name);
    }
  });
  it("classifies an unreviewed script named by the reviewed hook name as a failure", () => {
    const inv = inventoryHooks(fixture({ postinstall: "node ci/other-generator.mjs" }));
    assert.equal(inv.ok, false);
    assert.equal(inv.rootHookGenerators[0].reviewed, false);
    assert.match(inv.problems.join(" "), /unreviewed script ci\/other-generator\.mjs/);
  });
  it("matches the repository's actual root hooks", () => {
    const inv = inventoryHooks(new URL("..", import.meta.url).pathname);
    assert.deepEqual(inv.problems, []);
    assert.deepEqual(Object.keys(inv.rootHooks), ["postinstall"]);
  });
  it("fails closed on an added, changed or removed root hook", () => {
    for (const hooks of [
      { ...REVIEWED_ROOT_HOOKS, preinstall: "node x.js" },
      { postinstall: "node other.js" },
      {},
    ]) {
      const inv = inventoryHooks(fixture(hooks));
      assert.equal(inv.ok, false);
      assert.match(inv.problems[0], /differ from the reviewed set/);
    }
  });
});

describe("status and diff validation", () => {
  it("parses porcelain -z entries including renames", () => {
    assert.deepEqual(parseStatus(" M public/a.js\0?? public/n.js\0R  b.js\0a.js\0"), [
      { xy: " M", path: "public/a.js" },
      { xy: "??", path: "public/n.js" },
      { xy: "R ", path: "b.js", from: "a.js" },
    ]);
  });
  it("allows only modified or new files on the allowed list", () => {
    const { files, unexpected } = classifyStatus(
      parseStatus(" M public/a.js\0 D public/b.js\0 M src/x.ts\0?? other.txt\0"),
      ALLOWED,
    );
    assert.deepEqual(files, ["public/a.js"]);
    assert.equal(unexpected.length, 3);
  });
  it("rejects deletions, renames, mode changes and unlisted paths in the raw diff", () => {
    const meta = (oldMode, newMode, status) => `:${oldMode} ${newMode} s1 s2 ${status}\0`;
    assert.deepEqual(validateRaw(`${meta("100644", "100644", "M")}public/a.js\0`, ALLOWED), []);
    assert.deepEqual(validateRaw(`${meta("000000", "100644", "A")}public/b.js\0`, ALLOWED), []);
    const deleted = validateRaw(`${meta("100644", "000000", "D")}public/a.js\0`, ALLOWED);
    assert.equal(deleted.length > 0, true);
    assert.equal(validateRaw(`${meta("100644", "100755", "M")}public/a.js\0`, ALLOWED).length, 1);
    assert.equal(validateRaw(`${meta("100644", "120000", "M")}public/a.js\0`, ALLOWED).length, 1);
    assert.equal(validateRaw(`${meta("100644", "100644", "M")}src/x.ts\0`, ALLOWED).length, 1);
    assert.equal(validateRaw(`${meta("100755", "100644", "M")}public/a.js\0`, ALLOWED).length, 1);
  });
});

describe("clean checkout", () => {
  it("imports no installed dependency before npm ci", () => {
    const source = readFileSync(new URL("./asset-generation.mjs", import.meta.url), "utf8");
    const staticImports = [...source.matchAll(/from "([^"]+)";/g)].map((m) => m[1]);
    assert.equal(
      staticImports.every((spec) => spec.startsWith("node:")),
      true,
      staticImports.join(", "),
    );
  });
});

describe("collect", () => {
  it("records no drift with no patch when nothing changed", () => {
    const { manifest, out } = run(() => {});
    assert.equal(manifest.status, "no-drift");
    assert.equal(manifest.patch, null);
    assert.equal(existsSync(join(out, "public-assets.patch")), false);
    assert.equal(verdict(manifest).code, 0);
    assert.equal(manifest.outputs["public/a.js"].changed, false);
  });

  it("emits an applicable patch for drift but keeps the initial verdict red", () => {
    const { root, out, manifest, head } = run(
      (r) => {
        put(r, "public/a.js", "new-a\n");
        put(r, "public/b.js", "new-b\n");
      },
      { "initial.exit": "1", "initial.log": "drifted\n" },
    );
    assert.equal(manifest.status, "drift-patch");
    assert.equal(manifest.initialDrift.drifted, true);
    assert.equal(manifest.sourceSha, head);
    assert.equal(manifest.baseSha, "b".repeat(40));
    assert.deepEqual(manifest.patch.files, ["public/a.js", "public/b.js"]);
    assert.equal(verdict(manifest).code, 1);
    const patch = join(out, "public-assets.patch");
    assert.equal(readFileSync(patch).length, manifest.patch.bytes);
    // The patch applies to a pristine tree and yields the generated bytes.
    const pristine = scratch("asset-gen-apply-");
    git(pristine, "init", "-q");
    for (const p of ["public/a.js", "public/b.js", "assets/a.js"]) {
      put(pristine, p, git(root, "show", `HEAD:${p}`));
    }
    git(pristine, "apply", "--check", patch);
    git(pristine, "apply", patch);
    assert.equal(readFileSync(join(pristine, "public/a.js"), "utf8"), "new-a\n");
  });

  it("includes a new allowed file in the patch", () => {
    const { manifest, out } = run((r) => put(r, "public/new.js", "n\n"), { "initial.exit": "1" });
    assert.equal(manifest.status, "drift-patch");
    assert.deepEqual(manifest.patch.files, ["public/new.js"]);
    assert.match(readFileSync(join(out, "public-assets.patch"), "utf8"), /new file mode 100644/);
  });

  it("fails closed on any non-public tracked output and uploads no patch", () => {
    const { manifest, out } = run(
      (r) => {
        put(r, "public/a.js", "new-a\n");
        put(r, "src/ember-fallback-style.ts", "export const changed = 1;\n");
      },
      { "initial.exit": "1" },
    );
    assert.equal(manifest.status, "failed");
    assert.match(manifest.unexpectedOutputs.join(" "), /src\/ember-fallback-style\.ts/);
    assert.equal(manifest.patch, null);
    assert.equal(existsSync(join(out, "public-assets.patch")), false);
    assert.equal(verdict(manifest).code, 1);
  });

  it("fails closed on an untracked file outside the allowed list", () => {
    const { manifest } = run((r) => put(r, "stray.txt", "x"));
    assert.equal(manifest.status, "failed");
    assert.match(manifest.unexpectedOutputs.join(" "), /stray\.txt/);
  });

  it("fails closed on a deleted allowed output", () => {
    const { manifest } = run((r) => rmSync(join(r, "public/a.js")), { "initial.exit": "1" });
    assert.equal(manifest.status, "failed");
  });

  it("fails closed on a mode change or symlink swap", () => {
    for (const mutate of [
      (r) => chmodSync(join(r, "public/a.js"), 0o755),
      (r) => {
        rmSync(join(r, "public/a.js"));
        symlinkSync("b.js", join(r, "public/a.js"));
      },
    ]) {
      const { manifest, out } = run(mutate, { "initial.exit": "1" });
      assert.equal(manifest.status, "failed");
      assert.equal(existsSync(join(out, "public-assets.patch")), false);
    }
  });

  it("fails closed when the checked-out HEAD is not the PR head", () => {
    const { manifest } = run(() => {}, {}, { PR_HEAD_SHA: "c".repeat(40) });
    assert.equal(manifest.status, "failed");
    assert.match(manifest.problems[0], /is not the PR head/);
  });

  it("fails closed on inconsistent generator evidence", () => {
    const changed = (r) => put(r, "public/a.js", "new-a\n");
    // Initial check passed yet regeneration changed bytes.
    assert.equal(run(changed, { "initial.exit": "0" }).manifest.status, "failed");
    // Initial check failed yet regeneration changed nothing.
    assert.equal(run(() => {}, { "initial.exit": "1" }).manifest.status, "failed");
    // Canonical check failed after generation.
    assert.equal(run(changed, { "initial.exit": "1", "post.exit": "1" }).manifest.status, "failed");
  });

  it("keeps credentials and environment out of the manifest", () => {
    const { out } = run(() => {}, {}, { GITHUB_TOKEN: "ghs_secret", NPM_TOKEN: "npm_secret" });
    const text = readFileSync(join(out, "manifest.json"), "utf8");
    assert.equal(text.includes("ghs_secret") || text.includes("npm_secret"), false);
    assert.equal(JSON.parse(text).schema, "asset-generation/v1");
  });
});

describe("workflow shape", () => {
  const text = readFileSync(
    new URL("../.github/workflows/asset-generation.yml", import.meta.url),
    "utf8",
  );
  const code = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  it("runs on pull_request only, never pull_request_target, from the exact head", () => {
    assert.match(code, /^on:\n {2}pull_request:/m);
    assert.equal(code.includes("pull_request_target"), false);
    assert.match(code, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
    assert.match(code, /persist-credentials: false/);
  });

  it("is read-only with no secrets, environments or repository writes", () => {
    assert.match(code, /^permissions:\n {2}contents: read\n/m);
    // A write grant is a permission scope set to write, not the word in a step title.
    assert.equal(/^\s+[\w-]+:\s*write(-all)?\s*$/m.test(code), false);
    assert.equal(/permissions:\s*write-all/.test(code), false);
    assert.equal(/secrets\./.test(code), false);
    assert.equal(/^\s+environment:/m.test(code), false);
    assert.equal(/git (commit|push)|gh pr|GITHUB_TOKEN/.test(code), false);
  });

  it("scopes the npm policy to the job and installs from the locked tree without hooks", () => {
    assert.match(code, /npm_config_ignore_scripts: "true"/);
    assert.match(code, /npm_config_min_release_age: "3"/);
    assert.match(
      code,
      /npm ci --include=dev --ignore-scripts --min-release-age=3 --no-audit --no-fund/,
    );
    assert.equal(/npm (rebuild|install|update|i )/.test(code), false);
    assert.equal(/npm (install|i) -g|corepack|npx /.test(code), false);
    assert.equal(/\.npmrc/.test(code), false);
  });

  it("orders inventory and enforcement fixtures before the install", () => {
    const at = (needle) => code.indexOf(needle);
    assert.ok(at("asset-generation.mjs inventory") > 0);
    assert.ok(at("asset-generation.mjs inventory") < at("npm-fixtures"));
    assert.ok(at("npm-fixtures") < at("npm ci --include=dev"));
    assert.ok(at("npm ci --include=dev") < at("verify-esbuild"));
    assert.ok(at("--check > ") < at("run: node ci/minify-assets.mjs\n"));
    assert.ok(at("run: node ci/minify-assets.mjs\n") < at("asset-generation.mjs collect"));
  });

  it("pins the exact Node release and npm bundled with it, with no npm bootstrap", () => {
    assert.match(code, /node-version: 24\.\d+\.\d+\n/);
    assert.match(code, /ASSET_GEN_NODE: v24\.\d+\.\d+/);
    assert.match(code, /ASSET_GEN_NPM: 11\.\d+\.\d+/);
    assert.match(code, /test "\$\(npm --version\)" = "\$ASSET_GEN_NPM"/);
  });

  it("uploads with bounded retention and fails when the artifact is missing", () => {
    assert.match(code, /if-no-files-found: error/);
    assert.match(code, /retention-days: 3/);
    assert.match(code, /name: Remove job-private files\n\s+if: always\(\)/);
  });
});
