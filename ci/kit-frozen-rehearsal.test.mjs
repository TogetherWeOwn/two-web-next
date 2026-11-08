import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rehearseFrozenKitInputs } from "./kit-frozen-rehearsal.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

const context = { sourceSha: "a".repeat(40), runId: "123", runAttempt: "1" };
const worker = "export default { fetch() {} };\n";
const readme = "Wrangler dry-run output.\n";

function fixture(run) {
  const parent = mkdtempSync(join(tmpdir(), "kit-frozen-rehearsal-"));
  const root = join(parent, "root");
  const snapshot = join(parent, "snapshot");
  const destination = join(parent, "rehearsal");
  mkdirSync(root);
  mkdirSync(join(snapshot, "build"), { recursive: true });
  writeFileSync(join(snapshot, "build/worker.js"), worker);
  const tool = {
    entry: "node_modules/wrangler/bin/wrangler.js",
    locks: ["package-lock.json", "web/package-lock.json"].map((path) => ({
      path,
      bytes: 2,
      sha256: sha256("{}"),
    })),
  };
  const inputs = {
    ...context,
    target: "two-web-next-production",
    files: tool.locks.map((lock) => ({ ...lock, path: `source/${lock.path}` })),
  };
  const calls = [];
  const collaborators = {
    verifyInputs: (path, ctx) => {
      assert.equal(path, snapshot);
      assert.deepEqual(ctx, context);
      return structuredClone(inputs);
    },
    verifyTool: (path) => {
      assert.equal(path, root);
      return structuredClone(tool);
    },
    run: (command, args, options) => {
      calls.push({ command, args, options });
      mkdirSync(join(destination, "output"));
      writeFileSync(join(destination, "output/worker.js"), worker);
      writeFileSync(join(destination, "output/README.md"), readme);
      return { status: 0, signal: null, stdout: "not evidence", stderr: "not evidence" };
    },
  };
  const invoke = () => rehearseFrozenKitInputs(root, snapshot, destination, context, collaborators);
  try {
    run({ root, snapshot, destination, tool, inputs, collaborators, calls, invoke });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test("snapshot rehearsal pins paths, dry-run flags, environment and bounded execution", () => {
  fixture((f) => {
    const receipt = f.invoke();
    const [{ command, args, options }] = f.calls;
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [
      join(f.root, f.tool.entry),
      "versions",
      "upload",
      "--dry-run",
      "--no-bundle",
      join(f.snapshot, "build/worker.js"),
      "--config",
      join(f.snapshot, "source/web/wrangler.production.jsonc"),
      "--assets",
      join(f.snapshot, "adapter"),
      "--outdir",
      join(f.destination, "output"),
    ]);
    assert.equal(options.cwd, f.destination);
    assert.equal(options.env.HOME, join(f.destination, "home"));
    assert.equal(options.env.TMPDIR, join(f.destination, "tmp"));
    assert.equal(options.timeout, 120000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.deepEqual(Object.keys(options.env).sort(), receipt.invocation.environmentKeys);
    for (const name of ["CLOUDFLARE_API_TOKEN", "NODE_OPTIONS", "NODE_PATH", "GITHUB_TOKEN"]) {
      assert.equal(Object.hasOwn(options.env, name), false);
    }
    assert.equal(receipt.schema, "two.kit-frozen-rehearsal.v1");
    assert.equal(receipt.workerSha256, sha256(worker));
    assert.deepEqual(receipt.emittedFiles, [
      { path: "README.md", bytes: Buffer.byteLength(readme), sha256: sha256(readme) },
      { path: "worker.js", bytes: Buffer.byteLength(worker), sha256: sha256(worker) },
    ]);
    assert.equal(receipt.snapshotSha256, sha256(JSON.stringify(f.inputs)));
    assert.equal(receipt.toolSha256, sha256(JSON.stringify(f.tool)));
    assert.deepEqual(JSON.parse(readFileSync(join(f.destination, "receipt.json"))), receipt);
    assert.doesNotMatch(JSON.stringify(receipt), /not evidence|versionId|qualified|native/i);
  });
});

test("rechecks snapshot and installed tool after the child exits", () => {
  fixture((f) => {
    let inputChecks = 0;
    let toolChecks = 0;
    const originalInputs = f.collaborators.verifyInputs;
    const originalTool = f.collaborators.verifyTool;
    f.collaborators.verifyInputs = (...args) => {
      inputChecks++;
      return originalInputs(...args);
    };
    f.collaborators.verifyTool = (...args) => {
      toolChecks++;
      return originalTool(...args);
    };
    f.invoke();
    assert.equal(inputChecks, 2);
    assert.equal(toolChecks, 2);
  });
});

for (const kind of ["snapshot", "tool"]) {
  test(`changed ${kind} after the child exits refuses a receipt`, () => {
    fixture((f) => {
      const run = f.collaborators.run;
      f.collaborators.run = (...args) => {
        const result = run(...args);
        if (kind === "snapshot") f.inputs.runAttempt = "2";
        else f.tool.entry = "changed.js";
        return result;
      };
      assert.throws(f.invoke, /changed during dry run/);
      assert.equal(existsSync(join(f.destination, "receipt.json")), false);
    });
  });
}

test("mismatching frozen lock refuses before invoking Wrangler", () => {
  fixture((f) => {
    f.inputs.files[0].sha256 = "b".repeat(64);
    assert.throws(f.invoke, /frozen lock differs/);
    assert.equal(f.calls.length, 0);
  });
});

for (const result of [{ status: 1 }, { status: null, signal: "SIGTERM" }, { error: true }]) {
  test(`child failure ${JSON.stringify(result)} never creates success evidence`, () => {
    fixture((f) => {
      f.collaborators.run = () => result;
      assert.throws(f.invoke, /frozen dry run failed/);
      assert.equal(existsSync(join(f.destination, "receipt.json")), false);
    });
  });
}

test("changed output Worker refuses a receipt", () => {
  fixture((f) => {
    const run = f.collaborators.run;
    f.collaborators.run = (...args) => {
      const result = run(...args);
      writeFileSync(join(f.destination, "output/worker.js"), "changed");
      return result;
    };
    assert.throws(f.invoke, /changed Worker bytes/);
    assert.equal(existsSync(join(f.destination, "receipt.json")), false);
  });
});

test("symlinked output Worker refuses a receipt", () => {
  fixture((f) => {
    f.collaborators.run = () => {
      mkdirSync(join(f.destination, "output"));
      symlinkSync(join(f.snapshot, "build/worker.js"), join(f.destination, "output/worker.js"));
      writeFileSync(join(f.destination, "output/README.md"), readme);
      return { status: 0 };
    };
    assert.throws(f.invoke);
    assert.equal(existsSync(join(f.destination, "receipt.json")), false);
  });
});

for (const name of ["extra.wasm", "extra.txt", "worker.js.map", ".hidden"]) {
  test(`unexpected emitted member ${name} refuses a receipt`, () => {
    fixture((f) => {
      const run = f.collaborators.run;
      f.collaborators.run = (...args) => {
        const result = run(...args);
        writeFileSync(join(f.destination, "output", name), "unexpected");
        return result;
      };
      assert.throws(f.invoke, /unexpected frozen dry-run output membership/);
      assert.equal(existsSync(join(f.destination, "receipt.json")), false);
    });
  });
}

for (const kind of ["directory", "missing", "empty", "oversized", "symlink"]) {
  test(`invalid emitted README ${kind} refuses a receipt`, () => {
    fixture((f) => {
      const run = f.collaborators.run;
      f.collaborators.run = (...args) => {
        const result = run(...args);
        const path = join(f.destination, "output/README.md");
        rmSync(path);
        if (kind === "directory") mkdirSync(path);
        if (kind === "empty") writeFileSync(path, "");
        if (kind === "oversized") writeFileSync(path, Buffer.alloc(64 * 1024 + 1));
        if (kind === "symlink") symlinkSync(join(f.snapshot, "build/worker.js"), path);
        return result;
      };
      assert.throws(f.invoke);
      assert.equal(existsSync(join(f.destination, "receipt.json")), false);
    });
  });
}

test("unexpected emitted directory refuses a receipt", () => {
  fixture((f) => {
    const run = f.collaborators.run;
    f.collaborators.run = (...args) => {
      const result = run(...args);
      mkdirSync(join(f.destination, "output/modules"));
      return result;
    };
    assert.throws(f.invoke, /unexpected frozen dry-run output membership/);
    assert.equal(existsSync(join(f.destination, "receipt.json")), false);
  });
});

test("an existing destination is never overwritten", () => {
  fixture((f) => {
    mkdirSync(f.destination);
    assert.throws(f.invoke, /EEXIST/);
    assert.equal(f.calls.length, 0);
  });
});

test("Actions runs frozen rehearsal after snapshot verification and retains only evidence", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const verified = workflow.indexOf(
    "node ci/kit-frozen-inputs.mjs verify artifacts/kit-frozen-inputs",
  );
  const tests = workflow.indexOf("node --test ci/kit-frozen-rehearsal.test.mjs");
  const replay = workflow.indexOf(
    "node ci/kit-frozen-rehearsal.mjs artifacts/kit-frozen-inputs artifacts/kit-frozen-rehearsal",
  );
  const archive = workflow.indexOf("      - name: Production Kit bundle build evidence");
  assert.ok(verified >= 0 && tests > verified && replay > tests && archive > replay);
  assert.ok(workflow.includes("            artifacts/kit-frozen-rehearsal/receipt.json"));
  assert.ok(workflow.includes("            artifacts/kit-frozen-rehearsal/output/"));
  assert.ok(!workflow.includes("            artifacts/kit-frozen-rehearsal/\n"));
});
