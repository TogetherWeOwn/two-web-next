import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KIT_ASSETSIGNORE, classifyKitAssets } from "./kit-complete-assets.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");

const baseFiles = () => ({
  ".assetsignore": KIT_ASSETSIGNORE,
  "_worker.js": "export default {};\n",
  _headers: "/*\n  X-Test: 1\n",
  "_app/version.json": '{"version":"1"}',
  "_app/immutable/entry/app.abc123.js": "console.log(1);\n",
});

const write = (root, name, content) => {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const withDir = async (files, run) => {
  const root = mkdtempSync(join(tmpdir(), "kit-assets-"));
  try {
    const dir = join(root, "out");
    mkdirSync(dir);
    for (const [name, content] of Object.entries(files)) write(dir, name, content);
    return await run(dir, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const rejects = (files, mutate) =>
  withDir(files, async (dir, root) => {
    if (mutate) await mutate(dir, root);
    await assert.rejects(async () => classifyKitAssets(dir));
  });

const classify = (dir) => Promise.resolve(classifyKitAssets(dir));

test("Actions executes the classifier fixtures and retains the real build classification", () => {
  const workflow = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/ci.yml"),
    "utf8",
  );
  assert.ok(workflow.includes("node --test ci/kit-complete-assets.test.mjs"));
  assert.ok(
    workflow.includes(
      "node ci/kit-complete-assets.mjs web/.svelte-kit/cloudflare artifacts/kit-upload-rehearsal/public-assets.json",
    ),
  );
  assert.ok(workflow.includes("            artifacts/kit-upload-rehearsal/"));
});

test("constant has the exact ignore bytes without a final newline", () => {
  assert.equal(KIT_ASSETSIGNORE, "\n_worker.js\n_routes.json\n_headers\n_redirects");
});

test("classifies a complete build and is deterministic", async () => {
  await withDir(baseFiles(), async (dir) => {
    const a = await classify(dir);
    const b = await classify(dir);
    assert.deepEqual(a, b);
    assert.equal(a.schema, "two.kit-complete-assets.v1");
    assert.equal(a.evidence, "independently-classified-build-inputs-only");
    assert.deepEqual(
      a.publicAssets.map((x) => x.url),
      ["/_app/immutable/entry/app.abc123.js", "/_app/version.json"],
    );
    const version = a.publicAssets.find((x) => x.url === "/_app/version.json");
    assert.equal(version.member, "_app/version.json");
    assert.equal(version.bytes, 15);
    assert.equal(version.sha256, sha('{"version":"1"}'));
    assert.equal(version.mime, "application/json");
    const js = a.publicAssets.find((x) => x.url.endsWith(".js"));
    assert.equal(js.mime, "text/javascript; charset=utf-8");
    assert.deepEqual(a.modules, [
      {
        member: "_worker.js",
        bytes: 19,
        sha256: sha("export default {};\n"),
        reason: "adapter-worker",
      },
    ]);
    assert.deepEqual(
      a.controls.map((x) => x.member),
      [".assetsignore", "_headers"],
    );
    assert.deepEqual(a.ignored, []);
    assert.match(a.treeSha256, /^[0-9a-f]{64}$/);
  });
});

test("an added public asset changes the exact set and the tree hash", async () => {
  await withDir(baseFiles(), async (dir) => {
    const before = await classify(dir);
    write(dir, "robots.txt", "User-agent: *\n");
    const after = await classify(dir);
    assert.notEqual(after.treeSha256, before.treeSha256);
    assert.equal(after.publicAssets.length, before.publicAssets.length + 1);
    const added = after.publicAssets.find((x) => x.url === "/robots.txt");
    assert.equal(added.mime, "text/plain; charset=utf-8");
    assert.deepEqual(
      after.publicAssets.map((x) => x.url),
      [...after.publicAssets.map((x) => x.url)].sort(),
    );
  });
});

test("mutating an ignored worker or module changes the tree hash", async () => {
  await withDir(baseFiles(), async (dir) => {
    const before = await classify(dir);
    write(dir, "_worker.js", "export default { changed: true };\n");
    const after = await classify(dir);
    assert.notEqual(after.treeSha256, before.treeSha256);
    assert.notEqual(after.modules[0].sha256, before.modules[0].sha256);
    assert.deepEqual(after.publicAssets, before.publicAssets);
  });
});

test("rejects unknown ignore patterns, negation, prefix and final newline", async () => {
  for (const bytes of [
    `${KIT_ASSETSIGNORE}\nextra.txt`,
    `${KIT_ASSETSIGNORE}\n!keep.txt`,
    `${KIT_ASSETSIGNORE}\n`,
    `# comment${KIT_ASSETSIGNORE}`,
    KIT_ASSETSIGNORE.slice(1),
    `\n_worker.js\n_headers\n_redirects`,
    KIT_ASSETSIGNORE.replace("\n", "\r\n"),
    "",
  ]) {
    await rejects({ ...baseFiles(), ".assetsignore": bytes });
  }
});

test("rejects missing or empty required files", async () => {
  for (const name of [
    "_worker.js",
    "_headers",
    "_app/version.json",
    "_app/immutable/entry/app.abc123.js",
    ".assetsignore",
  ]) {
    const missing = baseFiles();
    delete missing[name];
    await rejects(missing);
    if (name !== ".assetsignore") await rejects({ ...baseFiles(), [name]: "" });
  }
});

test("rejects a build with no immutable public file", async () => {
  const files = baseFiles();
  delete files["_app/immutable/entry/app.abc123.js"];
  files["_app/other.js"] = "1";
  await rejects(files);
});

test("rejects symlinked files, directories and ancestors", async () => {
  await rejects(baseFiles(), (dir) => {
    write(dir, "real.txt", "x");
    symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
  });
  await rejects(baseFiles(), (dir, root) => {
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(dir, "linked-dir"));
  });
  await withDir(baseFiles(), async (dir, root) => {
    const alias = join(root, "alias");
    symlinkSync(dir, alias);
    await assert.rejects(async () => classifyKitAssets(alias));
  });
  await withDir(baseFiles(), async (_dir, root) => {
    mkdirSync(join(root, "real", "nested"), { recursive: true });
    for (const [name, content] of Object.entries(baseFiles())) {
      write(join(root, "real", "nested"), name, content);
    }
    symlinkSync(join(root, "real"), join(root, "ancestor"));
    await assert.rejects(async () => classifyKitAssets(join(root, "ancestor", "nested")));
  });
});

test("rejects non-regular files without opening them", async () => {
  await rejects(baseFiles(), (dir) => {
    const made = spawnSync("mkfifo", [join(dir, "pipe.txt")]);
    assert.equal(made.status, 0);
  });
});

test("rejects nested special-named files outside the root worker subtree", async () => {
  for (const name of [
    "docs/_worker.js",
    "docs/_routes.json",
    "docs/_headers",
    "docs/_redirects",
    "docs/.assetsignore",
    "_app/immutable/_headers",
  ]) {
    await rejects({ ...baseFiles(), [name]: "x" });
  }
});

test("rejects unsafe url alias names", async () => {
  for (const name of [
    "a%20b.txt",
    "a b.txt",
    "a#b.txt",
    "a?b.txt",
    "a%2fb.txt",
    "café.txt",
    "a\\b.txt",
    "a:b.txt",
  ]) {
    await rejects({ ...baseFiles(), [name]: "x" });
  }
});

test("rejects directory argument aliases before normalization", async () => {
  await withDir(baseFiles(), async (dir) => {
    for (const alias of [`${dir}/.`, `${dir}/../out`, `${dir}//`]) {
      await assert.rejects(async () => classifyKitAssets(alias));
    }
  });
});

test("rejects case-insensitive collisions", async () => {
  await rejects({ ...baseFiles(), "Logo.png": "a", "logo.png": "b" });
  await rejects({ ...baseFiles(), "Docs/a.txt": "a", "docs/b.txt": "b" });
});

test("rejects unknown extensions and accepts the allowlist", async () => {
  await rejects({ ...baseFiles(), "file.exe": "x" });
  await rejects({ ...baseFiles(), "noext": "x" });
  await rejects({ ...baseFiles(), "map.js.map": "x" });
  const expected = {
    "a.js": "text/javascript; charset=utf-8",
    "a.css": "text/css; charset=utf-8",
    "a.json": "application/json",
    "a.webmanifest": "application/manifest+json",
    "a.html": "text/html; charset=utf-8",
    "a.txt": "text/plain; charset=utf-8",
    "a.svg": "image/svg+xml",
    "a.png": "image/png",
    "a.webp": "image/webp",
    "a.jpg": "image/jpeg",
    "a.jpeg": "image/jpeg",
    "a.ico": "image/vnd.microsoft.icon",
    "a.woff2": "font/woff2",
    "a.woff": "font/woff",
  };
  await withDir(
    { ...baseFiles(), ...Object.fromEntries(Object.keys(expected).map((n) => [n, "x"])) },
    async (dir) => {
      const result = await classify(dir);
      for (const [name, mime] of Object.entries(expected)) {
        assert.equal(result.publicAssets.find((x) => x.url === `/${name}`)?.mime, mime, name);
      }
    },
  );
});

test("optional _redirects is a control and optional _routes.json is ignored", async () => {
  await withDir(
    { ...baseFiles(), _redirects: "/a /b 301\n", "_routes.json": '{"version":1}' },
    async (dir) => {
      const result = await classify(dir);
      assert.deepEqual(
        result.controls.map((x) => x.member),
        [".assetsignore", "_headers", "_redirects"],
      );
      assert.deepEqual(result.ignored, [
        {
          member: "_routes.json",
          bytes: 13,
          sha256: sha('{"version":1}'),
          reason: "adapter-build-only",
        },
      ]);
      assert.ok(!result.publicAssets.some((x) => /_routes|_redirects|_headers/.test(x.url)));
    },
  );
});

test("a _worker.js directory subtree is classified as modules", async () => {
  const files = baseFiles();
  delete files["_worker.js"];
  await withDir(
    {
      ...files,
      "_worker.js/index.js": "export default {};\n",
      "_worker.js/chunks/a.mjs": "export const a = 1;\n",
      "_worker.js/data/blob.bin": "\u0000\u0001",
      "_worker.js/nested/_headers": "x",
    },
    async (dir) => {
      const result = await classify(dir);
      assert.deepEqual(
        result.modules.map((x) => x.member),
        [
          "_worker.js/chunks/a.mjs",
          "_worker.js/data/blob.bin",
          "_worker.js/index.js",
          "_worker.js/nested/_headers",
        ],
      );
      assert.ok(result.modules.every((x) => x.reason === "adapter-worker"));
      assert.ok(!result.publicAssets.some((x) => x.url.startsWith("/_worker.js")));
    },
  );
  const empty = baseFiles();
  delete empty["_worker.js"];
  await rejects(empty);
});
