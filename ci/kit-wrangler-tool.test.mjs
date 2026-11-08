import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { verifyWranglerTool } from "./kit-wrangler-tool.mjs";

const VERSION = "4.156.1";
const RESOLVED = `https://registry.npmjs.org/wrangler/-/wrangler-${VERSION}.tgz`;
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const PACKAGE = {
  name: "wrangler",
  version: VERSION,
  bin: { wrangler: "./bin/wrangler.js" },
  main: "wrangler-dist/cli.js",
};
const FILES = {
  "package.json": `${JSON.stringify(PACKAGE, null, 2)}\n`,
  "bin/wrangler.js": "#!/usr/bin/env node\nimport '../wrangler-dist/cli.js';\n",
  "wrangler-dist/cli.js": "export const runtime = 'synthetic';\n",
};
const roots = [];

const sha = (text) => createHash("sha256").update(text).digest("hex");
const lockText = (overrides = {}) =>
  `${JSON.stringify(
    {
      lockfileVersion: 3,
      packages: {
        "node_modules/wrangler": {
          version: VERSION,
          resolved: RESOLVED,
          integrity: INTEGRITY,
          bin: { wrangler: "bin/wrangler.js" },
          ...overrides,
        },
      },
    },
    null,
    2,
  )}\n`;
const pin = () => ({
  schema: "two.wrangler-package-pin.v1",
  name: "wrangler",
  version: VERSION,
  resolved: RESOLVED,
  integrity: INTEGRITY,
  files: Object.keys(FILES)
    .sort()
    .map((path) => ({ path, bytes: Buffer.byteLength(FILES[path]), sha256: sha(FILES[path]) })),
});
const put = async (root, rel, text) => {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};
const pkg = (root, rel = "") => join(root, "node_modules/wrangler", rel);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kit-wrangler-tool-"));
  roots.push(root);
  await put(root, "package-lock.json", lockText());
  await put(root, "web/package-lock.json", lockText());
  for (const [rel, text] of Object.entries(FILES)) await put(pkg(root), rel, text);
  return root;
}
const rejects = (root, p = pin()) => assert.rejects(async () => verifyWranglerTool(root, p));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

test("Actions checks published tool bytes around direct Kit dry-run invocations", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const start = workflow.indexOf("      - name: Production Kit Worker config dry run");
  const end = workflow.indexOf("      - name: Production Kit read-only input snapshot", start);
  assert.ok(start >= 0 && end > start);
  const steps = workflow.slice(start, end);
  assert.match(steps, /node --test ci\/kit-wrangler-tool\.test\.mjs/);
  const buildCheck = steps.indexOf("node ci/kit-wrangler-tool.mjs");
  const build = steps.indexOf("node node_modules/wrangler/bin/wrangler.js deploy");
  const replayCheck = steps.indexOf("node ci/kit-wrangler-tool.mjs", buildCheck + 1);
  const replay = steps.indexOf("node node_modules/wrangler/bin/wrangler.js versions upload");
  const finalCheck = steps.indexOf("node ci/kit-wrangler-tool.mjs", replayCheck + 1);
  assert.ok(buildCheck >= 0 && build > buildCheck && replayCheck > build);
  assert.ok(replay > replayCheck && finalCheck > replay);
  for (const file of ["tool-before-replay.json", "tool-after-replay.json"]) {
    assert.ok(
      steps.includes(
        `cmp artifacts/kit-upload-rehearsal/tool-before-build.json artifacts/kit-upload-rehearsal/${file}`,
      ),
    );
  }
  assert.equal((steps.match(/test -z "\$\{NODE_OPTIONS:-\}"/g) ?? []).length, 2);
  assert.equal((steps.match(/test -z "\$\{NODE_PATH:-\}"/g) ?? []).length, 2);
  assert.doesNotMatch(steps, /npx wrangler|continue-on-error/);
});

describe("verifyWranglerTool", () => {
  test("accepts the unchanged installed package and returns the evidence", async () => {
    const root = await fixture();
    const result = await verifyWranglerTool(root, pin());
    const expected = pin();
    assert.equal(result.schema, "two.kit-wrangler-tool.v1");
    assert.equal(result.evidence, "installed-wrangler-package-only");
    assert.equal(result.name, "wrangler");
    assert.equal(result.version, VERSION);
    assert.equal(result.resolved, RESOLVED);
    assert.equal(result.integrity, INTEGRITY);
    assert.deepEqual(result.files, expected.files);
    assert.equal(result.entry, "node_modules/wrangler/bin/wrangler.js");
    assert.equal(result.runtime, "node_modules/wrangler/wrangler-dist/cli.js");
    assert.deepEqual(
      result.locks.map((l) => l.path),
      ["package-lock.json", "web/package-lock.json"],
    );
    for (const lock of result.locks) {
      assert.equal(lock.bytes, Buffer.byteLength(lockText()));
    }
    assert.equal(result.locks.length, 2);
    for (const lock of result.locks) {
      assert.equal(lock.sha256, sha(await readFile(join(root, lock.path), "utf8")));
    }
  });

  for (const rel of ["bin/wrangler.js", "wrangler-dist/cli.js", "package.json"]) {
    test(`rejects modified ${rel}`, async () => {
      const root = await fixture();
      // Same length, different bytes.
      const text = FILES[rel].replace(/.$/s, "\n").replace(/s|e/, "X");
      assert.notEqual(text, FILES[rel]);
      await writeFile(pkg(root, rel), text);
      await rejects(root);
    });
  }

  test("rejects a size change", async () => {
    const root = await fixture();
    await writeFile(pkg(root, "wrangler-dist/cli.js"), `${FILES["wrangler-dist/cli.js"]}//\n`);
    await rejects(root);
  });

  test("rejects extra members, including nested node_modules below the root one", async () => {
    for (const rel of ["extra.js", "bin/extra.js", "wrangler-dist/node_modules/x/index.js"]) {
      const root = await fixture();
      await put(pkg(root), rel, "x\n");
      await rejects(root);
    }
  });

  test("rejects an unlisted empty directory", async () => {
    const root = await fixture();
    await mkdir(pkg(root, "extra"));
    await rejects(root);
  });

  test("rejects a symlinked excluded dependency root", async () => {
    const root = await fixture();
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), pkg(root, "node_modules"));
    await rejects(root);
  });

  test("rejects a missing member", async () => {
    for (const rel of Object.keys(FILES)) {
      const root = await fixture();
      await unlink(pkg(root, rel));
      await rejects(root);
    }
  });

  test("allows installed transitive deps under node_modules but does not count them", async () => {
    const root = await fixture();
    await put(root, "node_modules/wrangler/node_modules/dep/index.js", "dep\n");
    await put(root, "node_modules/other/index.js", "other\n");
    const result = await verifyWranglerTool(root, pin());
    assert.deepEqual(result.files, pin().files);
    assert.ok(!JSON.stringify(result).includes("dep/index.js"));
    // Tampering inside the uncovered subtree is not proof failure.
    await put(root, "node_modules/wrangler/node_modules/dep/index.js", "changed\n");
    await verifyWranglerTool(root, pin());
  });

  test("a missing dependency tree is not a proof failure", async () => {
    const root = await fixture();
    await rm(pkg(root, "node_modules"), { recursive: true, force: true });
    await verifyWranglerTool(root, pin());
  });

  for (const lock of ["package-lock.json", "web/package-lock.json"]) {
    for (const [label, overrides] of [
      ["version", { version: "4.156.2" }],
      ["resolved", { resolved: RESOLVED.replace("4.156.1.tgz", "4.156.2.tgz") }],
      ["integrity", { integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}` }],
      ["bin mapping", { bin: { wrangler: "bin/other.js" } }],
      ["missing bin", { bin: undefined }],
    ]) {
      test(`rejects ${lock} ${label} drift`, async () => {
        const root = await fixture();
        await writeFile(join(root, lock), lockText(overrides));
        await rejects(root);
      });
    }

    test(`rejects missing ${lock}`, async () => {
      const root = await fixture();
      await unlink(join(root, lock));
      await rejects(root);
    });

    test(`rejects ${lock} missing the wrangler entry`, async () => {
      const root = await fixture();
      await writeFile(join(root, lock), `${JSON.stringify({ lockfileVersion: 3, packages: {} })}\n`);
      await rejects(root);
    });
  }

  for (const [label, change] of [
    ["name", { name: "not-wrangler" }],
    ["version", { version: "4.156.2" }],
    ["bin", { bin: { wrangler: "./bin/other.js" } }],
    ["main", { main: "wrangler-dist/other.js" }],
  ]) {
    test(`rejects installed package ${label} mismatch even when the pin matches the bytes`, async () => {
      const root = await fixture();
      const text = `${JSON.stringify({ ...PACKAGE, ...change }, null, 2)}\n`;
      await writeFile(pkg(root, "package.json"), text);
      const p = pin();
      p.files.find((f) => f.path === "package.json").bytes = Buffer.byteLength(text);
      p.files.find((f) => f.path === "package.json").sha256 = sha(text);
      await rejects(root, p);
    });
  }

  test("rejects a pin that disagrees with the locks", async () => {
    const root = await fixture();
    await rejects(root, { ...pin(), version: "4.156.2" });
    await rejects(root, { ...pin(), integrity: `sha512-${Buffer.alloc(64, 9).toString("base64")}` });
  });

  describe("symlinks", () => {
    test("rejects a symlinked file with identical bytes", async () => {
      for (const rel of Object.keys(FILES)) {
        const root = await fixture();
        await put(root, "elsewhere/copy", FILES[rel]);
        await unlink(pkg(root, rel));
        await symlink(join(root, "elsewhere/copy"), pkg(root, rel));
        await rejects(root);
      }
    });

    test("rejects a symlinked directory with identical contents", async () => {
      const root = await fixture();
      await put(root, "elsewhere/wrangler-dist/cli.js", FILES["wrangler-dist/cli.js"]);
      await rm(pkg(root, "wrangler-dist"), { recursive: true });
      await symlink(join(root, "elsewhere/wrangler-dist"), pkg(root, "wrangler-dist"));
      await rejects(root);
    });

    test("rejects a symlinked package directory ancestor", async () => {
      const root = await fixture();
      await mkdir(join(root, "elsewhere"));
      const real = join(root, "elsewhere/wrangler");
      await put(real, "package.json", FILES["package.json"]);
      await put(real, "bin/wrangler.js", FILES["bin/wrangler.js"]);
      await put(real, "wrangler-dist/cli.js", FILES["wrangler-dist/cli.js"]);
      await rm(pkg(root), { recursive: true });
      await symlink(real, pkg(root));
      await rejects(root);
    });

    test("rejects a symlinked node_modules ancestor", async () => {
      const root = await fixture();
      await mkdir(join(root, "elsewhere"));
      await rename(join(root, "node_modules"), join(root, "elsewhere/node_modules"));
      await symlink(join(root, "elsewhere/node_modules"), join(root, "node_modules"));
      await rejects(root);
    });

    test("rejects an extra symlink member", async () => {
      const root = await fixture();
      await symlink(pkg(root, "package.json"), pkg(root, "alias.json"));
      await rejects(root);
    });

    test("rejects a dangling symlink member", async () => {
      const root = await fixture();
      await symlink(join(root, "does-not-exist"), pkg(root, "dangling"));
      await rejects(root);
    });
  });

  test("rejects a directory where a file is expected", async () => {
    const root = await fixture();
    await unlink(pkg(root, "bin/wrangler.js"));
    await mkdir(pkg(root, "bin/wrangler.js"));
    await rejects(root);
  });

  test("rejects an unsafe pin path", async () => {
    const root = await fixture();
    for (const path of ["../package.json", "/etc/passwd", "bin/../package.json", "bin\\wrangler.js"]) {
      const p = pin();
      p.files.push({ path, bytes: 1, sha256: sha("x") });
      await rejects(root, p);
    }
  });

  test("rejects a malformed pin", async () => {
    const root = await fixture();
    await rejects(root, { ...pin(), schema: "other" });
    await rejects(root, { ...pin(), name: "other" });
    await rejects(root, { ...pin(), files: [] });
    await rejects(root, { ...pin(), files: pin().files.filter((f) => f.path !== "bin/wrangler.js") });
    await rejects(root, {
      ...pin(),
      files: pin().files.map((f) => ({ ...f, bytes: 32 * 1024 * 1024 + 1 })),
    });
    const dup = pin();
    dup.files.push(dup.files[0]);
    await rejects(root, dup);
  });
});
