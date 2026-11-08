// Hermetic fixtures only: every tree lives under a temp directory. The repo's
// raw config and lock files are copied in as read-only inputs; nothing is built,
// uploaded or sent over the network.
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KIT_ASSETSIGNORE } from "./kit-complete-assets.mjs";
import { freezeKitInputs, verifyFrozenKitInputs } from "./kit-frozen-inputs.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const context = { sourceSha: "a".repeat(40), runId: "12345", runAttempt: "2" };
const rawInputs = [
  "wrangler.jsonc",
  "web/wrangler.production.jsonc",
  "web/worker.js",
  "web/_headers",
  "package-lock.json",
  "web/package-lock.json",
];

const write = (root, name, content) => {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

// Restore writable modes so fixtures can be edited and removed.
function unlock(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) unlock(join(path, name));
  } else {
    chmodSync(path, 0o644);
  }
}

// Put a tree back into the required read-only modes.
function lock(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) lock(join(path, name));
    chmodSync(path, 0o555);
  } else {
    chmodSync(path, 0o444);
  }
}

const mode = (path) => statSync(path).mode & 0o777;

function fixture(parent) {
  const root = join(parent, "root");
  for (const path of rawInputs) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repo, path), join(root, path));
  }
  const adapter = join(root, "web/.svelte-kit/cloudflare");
  write(adapter, ".assetsignore", KIT_ASSETSIGNORE);
  write(adapter, "_worker.js", "export default {};\n");
  write(adapter, "_headers", "/*\n  X-Test: 1\n");
  write(adapter, "_app/version.json", '{"version":"1"}');
  write(adapter, "_app/immutable/a.js", "console.log(1);\n");
  const build = join(parent, "build");
  write(build, "worker.js", "export default { fetch() {} };\n");
  write(build, "bundle-meta.json", "{}");
  const replay = join(parent, "replay");
  write(replay, "worker.js", "export default { fetch() {} };\n");
  write(replay, "bundle-meta.json", "{}");
  return { root, adapter, build, replay, destination: join(parent, "frozen") };
}

const withFixture = async (run) => {
  const parent = mkdtempSync(join(tmpdir(), "kit-frozen-"));
  try {
    return await run(fixture(parent), parent);
  } finally {
    if (existsSync(parent)) {
      unlock(parent);
      rmSync(parent, { recursive: true, force: true });
    }
  }
};

const freeze = (f, ctx = context) => freezeKitInputs(f.root, f.build, f.replay, f.destination, ctx);

// Unlock the frozen tree, edit it, then restore the exact read-only modes so a
// failure can only come from the content/shape change, not from the mode check.
const tamper = (f, edit) => {
  unlock(f.destination);
  edit(f.destination);
  lock(f.destination);
};

const walkFiles = (directory) => {
  const out = [];
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    if (lstatSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
};

test("freezes a complete fixture and verifies it with a matching manifest", async () => {
  await withFixture(async (f) => {
    const manifest = freeze(f);
    assert.equal(manifest.schema, "two.kit-frozen-inputs.v1");
    assert.equal(manifest.evidence, "read-only-build-input-snapshot-only");
    assert.equal(manifest.sourceSha, context.sourceSha);
    assert.equal(manifest.runId, context.runId);
    assert.equal(manifest.runAttempt, context.runAttempt);
    assert.equal(manifest.target, "two-web-next-production");
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
    for (const file of manifest.files) {
      assert.deepEqual(Object.keys(file).sort(), ["bytes", "path", "sha256"]);
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isInteger(file.bytes) && file.bytes >= 0);
    }
    for (const directory of ["build", "replay", "adapter", "source"]) {
      assert.ok(lstatSync(join(f.destination, directory)).isDirectory(), directory);
    }
    assert.ok(existsSync(join(f.destination, "manifest.json")));
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.destination, "manifest.json"), "utf8")),
      manifest,
    );
    assert.deepEqual(verifyFrozenKitInputs(f.destination, context), manifest);
    // The snapshot must not claim anything beyond build inputs.
    const text = JSON.stringify(manifest);
    assert.doesNotMatch(text, /native|effective|custody/i);
  });
});

test("freezing identical inputs twice is deterministic", async () => {
  await withFixture(async (f, parent) => {
    const first = freeze(f);
    const again = join(parent, "frozen-again");
    const second = freezeKitInputs(f.root, f.build, f.replay, again, context);
    assert.deepEqual(second, first);
    assert.deepEqual(
      readFileSync(join(parent, "frozen-again/manifest.json")),
      readFileSync(join(f.destination, "manifest.json")),
    );
  });
});

test("retains a generated manifest.json separately from the root receipt", async () => {
  await withFixture(async (f) => {
    write(f.build, "manifest.json", '{"generated":true}');
    const manifest = freeze(f);
    assert.ok(manifest.files.some((file) => file.path === "build/manifest.json"));
    assert.deepEqual(
      readFileSync(join(f.destination, "build/manifest.json")),
      readFileSync(join(f.build, "manifest.json")),
    );
  });
});

test("an added empty directory invalidates exact snapshot membership", async () => {
  await withFixture(async (f) => {
    freeze(f);
    tamper(f, (dest) => mkdirSync(join(dest, "adapter/extra")));
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("Actions verifies and retains the snapshot after fixtures", () => {
  const workflow = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
  const commands = [
    "node --test ci/kit-frozen-inputs.test.mjs",
    "node ci/kit-frozen-inputs.mjs freeze artifacts/kit-production-worker-dry-run artifacts/kit-production-worker-replay artifacts/kit-frozen-inputs",
    "node ci/kit-frozen-inputs.mjs verify artifacts/kit-frozen-inputs",
    "      - name: Production Kit bundle build evidence",
  ];
  let previous = -1;
  for (const command of commands) {
    const index = workflow.indexOf(command);
    assert.ok(index > previous, `missing or out-of-order snapshot command: ${command}`);
    previous = index;
  }
  assert.ok(workflow.includes("            artifacts/kit-frozen-inputs/"));
});

test("manifest digests match the frozen bytes", async () => {
  await withFixture(async (f) => {
    const manifest = freeze(f);
    const { createHash } = await import("node:crypto");
    const frozen = walkFiles(f.destination).filter((p) => !p.endsWith("manifest.json"));
    assert.equal(manifest.files.length, frozen.length);
    for (const path of frozen) {
      const bytes = readFileSync(path);
      const digest = createHash("sha256").update(bytes).digest("hex");
      assert.ok(
        manifest.files.some((file) => file.sha256 === digest && file.bytes === bytes.length),
        `no manifest entry for ${path}`,
      );
    }
  });
});

test("snapshot is read-only: files 0444, directories 0555 including the root", async () => {
  await withFixture(async (f) => {
    freeze(f);
    assert.equal(mode(f.destination), 0o555);
    const visit = (directory) => {
      for (const name of readdirSync(directory)) {
        const full = join(directory, name);
        if (lstatSync(full).isDirectory()) {
          assert.equal(mode(full), 0o555, full);
          visit(full);
        } else {
          assert.equal(mode(full), 0o444, full);
        }
      }
    };
    visit(f.destination);
  });
});

test("snapshot holds copies, not hardlinks or symlinks", async () => {
  await withFixture(async (f) => {
    freeze(f);
    const sources = [
      [join(f.build, "worker.js"), join(f.destination, "build/worker.js")],
      [join(f.replay, "worker.js"), join(f.destination, "replay/worker.js")],
      [join(f.adapter, "_headers"), join(f.destination, "adapter/_headers")],
      [join(f.root, "web/_headers"), join(f.destination, "source/web/_headers")],
      [join(f.root, "package-lock.json"), join(f.destination, "source/package-lock.json")],
    ];
    for (const [from, to] of sources) {
      assert.ok(!lstatSync(to).isSymbolicLink(), to);
      assert.notEqual(statSync(to).ino, statSync(from).ino, `shared inode: ${to}`);
      assert.equal(statSync(to).nlink, 1, `hardlinked: ${to}`);
      assert.equal(statSync(from).nlink, 1, `source hardlinked: ${from}`);
      assert.deepEqual(readFileSync(to), readFileSync(from));
    }
  });
});

test("mutating sources after freeze leaves the snapshot unchanged and verifiable", async () => {
  await withFixture(async (f) => {
    const manifest = freeze(f);
    const before = walkFiles(f.destination).map((p) => [p, readFileSync(p)]);
    writeFileSync(join(f.build, "worker.js"), "tampered\n");
    writeFileSync(join(f.replay, "worker.js"), "tampered\n");
    writeFileSync(join(f.adapter, "_headers"), "tampered\n");
    writeFileSync(join(f.root, "web/_headers"), "tampered\n");
    writeFileSync(join(f.root, "web/wrangler.production.jsonc"), "{}\n");
    rmSync(join(f.root, "package-lock.json"));
    for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes, path);
    assert.deepEqual(verifyFrozenKitInputs(f.destination, context), manifest);
  });
});

test("frozen content tampering fails on digest even with correct modes", async () => {
  await withFixture(async (f) => {
    freeze(f);
    tamper(f, (dest) => writeFileSync(join(dest, "build/worker.js"), "export default {};\n"));
    assert.equal(mode(join(f.destination, "build/worker.js")), 0o444);
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("tampering with the manifest itself fails verification", async () => {
  await withFixture(async (f) => {
    freeze(f);
    tamper(f, (dest) => {
      const path = join(dest, "manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.files[0].sha256 = "0".repeat(64);
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    });
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("an extra file in the snapshot fails verification", async () => {
  await withFixture(async (f) => {
    freeze(f);
    tamper(f, (dest) => writeFileSync(join(dest, "adapter/_app/extra.js"), "x\n"));
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("an extra top-level file in the snapshot fails verification", async () => {
  await withFixture(async (f) => {
    freeze(f);
    tamper(f, (dest) => writeFileSync(join(dest, "extra.txt"), "x\n"));
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("a missing file in the snapshot fails verification", async () => {
  await withFixture(async (f) => {
    freeze(f);
    tamper(f, (dest) => rmSync(join(dest, "build/bundle-meta.json")));
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("a missing source copy fails verification", async () => {
  await withFixture(async (f) => {
    freeze(f);
    tamper(f, (dest) => rmSync(join(dest, "source/web/worker.js")));
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("a writable file fails verification", async () => {
  await withFixture(async (f) => {
    freeze(f);
    const path = join(f.destination, "adapter/_headers");
    chmodSync(path, 0o644);
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
    chmodSync(path, 0o444);
    assert.doesNotThrow(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("a writable subdirectory fails verification", async () => {
  await withFixture(async (f) => {
    freeze(f);
    const path = join(f.destination, "build");
    chmodSync(path, 0o755);
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
    chmodSync(path, 0o555);
    assert.doesNotThrow(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("a writable destination root fails verification", async () => {
  await withFixture(async (f) => {
    freeze(f);
    chmodSync(f.destination, 0o755);
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
    chmodSync(f.destination, 0o555);
    assert.doesNotThrow(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("verification rejects a different source SHA, run ID or run attempt", async () => {
  await withFixture(async (f) => {
    freeze(f);
    const wrongSha = { ...context, sourceSha: "b".repeat(40) };
    assert.throws(() => verifyFrozenKitInputs(f.destination, wrongSha));
    assert.throws(() => verifyFrozenKitInputs(f.destination, { ...context, runId: "12346" }));
    assert.throws(() => verifyFrozenKitInputs(f.destination, { ...context, runAttempt: "3" }));
  });
});

test("malformed context is rejected by freeze and verify", async () => {
  const bad = [
    { ...context, sourceSha: "A".repeat(40) },
    { ...context, sourceSha: "a".repeat(39) },
    { ...context, sourceSha: undefined },
    { ...context, runId: "0" },
    { ...context, runId: "01" },
    { ...context, runId: "12a" },
    { ...context, runId: undefined },
    { ...context, runAttempt: "0" },
    { ...context, runAttempt: "-1" },
    { ...context, runAttempt: "" },
  ];
  await withFixture(async (f, parent) => {
    bad.forEach((ctx, index) => {
      const destination = join(parent, `bad-${index}`);
      assert.throws(() => freezeKitInputs(f.root, f.build, f.replay, destination, ctx));
      assert.ok(!existsSync(destination), `destination created for bad context ${index}`);
    });
    freeze(f);
    for (const ctx of bad) assert.throws(() => verifyFrozenKitInputs(f.destination, ctx));
  });
});

test("a symlinked build input is rejected", async () => {
  await withFixture(async (f, parent) => {
    write(parent, "outside.js", "export default {};\n");
    rmSync(join(f.build, "worker.js"));
    symlinkSync(join(parent, "outside.js"), join(f.build, "worker.js"));
    assert.throws(() => freeze(f));
  });
});

test("a symlinked adapter file is rejected", async () => {
  await withFixture(async (f, parent) => {
    write(parent, "outside.js", "console.log(1);\n");
    rmSync(join(f.adapter, "_app/immutable/a.js"));
    symlinkSync(join(parent, "outside.js"), join(f.adapter, "_app/immutable/a.js"));
    assert.throws(() => freeze(f));
  });
});

test("a symlinked source file is rejected", async () => {
  await withFixture(async (f, parent) => {
    write(parent, "outside-headers", "/*\n  X-Test: 1\n");
    rmSync(join(f.root, "web/_headers"));
    symlinkSync(join(parent, "outside-headers"), join(f.root, "web/_headers"));
    assert.throws(() => freeze(f));
  });
});

test("a symlinked replay directory is rejected", async () => {
  await withFixture(async (f, parent) => {
    const real = join(parent, "real-replay");
    mkdirSync(real);
    for (const name of readdirSync(f.replay)) copyFileSync(join(f.replay, name), join(real, name));
    rmSync(f.replay, { recursive: true });
    symlinkSync(real, f.replay);
    assert.throws(() => freeze(f));
  });
});

test("a symlink as the destination is rejected and its target left untouched", async () => {
  await withFixture(async (f, parent) => {
    const target = join(parent, "elsewhere");
    mkdirSync(target);
    symlinkSync(target, f.destination);
    assert.throws(() => freeze(f));
    assert.deepEqual(readdirSync(target), []);
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("a symlink inside a frozen snapshot fails verification", async () => {
  await withFixture(async (f, parent) => {
    freeze(f);
    write(parent, "outside.js", "x\n");
    tamper(f, (dest) => {
      rmSync(join(dest, "replay/bundle-meta.json"));
      symlinkSync(join(parent, "outside.js"), join(dest, "replay/bundle-meta.json"));
    });
    assert.throws(() => verifyFrozenKitInputs(f.destination, context));
  });
});

test("an existing destination is refused, even when empty, and left intact", async () => {
  await withFixture(async (f) => {
    mkdirSync(f.destination);
    assert.throws(() => freeze(f));
    assert.deepEqual(readdirSync(f.destination), []);

    write(f.destination, "sentinel.txt", "keep\n");
    assert.throws(() => freeze(f));
    assert.deepEqual(readdirSync(f.destination), ["sentinel.txt"]);
    assert.equal(readFileSync(join(f.destination, "sentinel.txt"), "utf8"), "keep\n");
  });
});

test("an existing destination file is refused", async () => {
  await withFixture(async (f) => {
    writeFileSync(f.destination, "keep\n");
    assert.throws(() => freeze(f));
    assert.equal(readFileSync(f.destination, "utf8"), "keep\n");
  });
});

test("a second freeze into a frozen destination is refused", async () => {
  await withFixture(async (f) => {
    const manifest = freeze(f);
    assert.throws(() => freeze(f));
    assert.deepEqual(verifyFrozenKitInputs(f.destination, context), manifest);
  });
});

test("drifted adapter control bytes are rejected before anything is written", async () => {
  await withFixture(async (f) => {
    writeFileSync(join(f.adapter, ".assetsignore"), `${KIT_ASSETSIGNORE}\nextra`);
    assert.throws(() => freeze(f));
    assert.ok(!existsSync(f.destination));
  });
});

test("a drifted source production config is rejected", async () => {
  await withFixture(async (f) => {
    const path = join(f.root, "web/wrangler.production.jsonc");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("two-web-next-production", "two-web-next-other"),
    );
    assert.throws(() => freeze(f));
    assert.ok(!existsSync(f.destination));
  });
});

test("a missing source input is rejected", async () => {
  for (const name of rawInputs) {
    await withFixture(async (f) => {
      rmSync(join(f.root, name));
      assert.throws(() => freeze(f), name);
      assert.ok(!existsSync(f.destination), name);
    });
  }
});

test("a missing build Worker, metafile or adapter file is rejected", async () => {
  await withFixture(async (f) => {
    rmSync(join(f.build, "worker.js"));
    assert.throws(() => freeze(f));
  });
  await withFixture(async (f) => {
    rmSync(join(f.build, "bundle-meta.json"));
    assert.throws(() => freeze(f));
  });
  await withFixture(async (f) => {
    rmSync(join(f.adapter, "_app/version.json"));
    assert.throws(() => freeze(f));
  });
  await withFixture(async (f) => {
    writeFileSync(join(f.build, "worker.js"), "");
    writeFileSync(join(f.replay, "worker.js"), "");
    assert.throws(() => freeze(f));
  });
});

test("a replay Worker that differs from the build Worker is rejected", async () => {
  await withFixture(async (f) => {
    writeFileSync(join(f.replay, "worker.js"), "export default { fetch() { return 1; } };\n");
    assert.throws(() => freeze(f));
    assert.ok(!existsSync(f.destination));
  });
});

test("an unreviewed adapter asset type is rejected", async () => {
  await withFixture(async (f) => {
    write(f.adapter, "_app/immutable/payload.bin", "\0\0");
    assert.throws(() => freeze(f));
    assert.ok(!existsSync(f.destination));
  });
});
