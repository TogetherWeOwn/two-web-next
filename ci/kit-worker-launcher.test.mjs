import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("launcher removes scratch after child exit and spawn failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kit-worker-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of [
    "ci",
    "lib",
    "e2e",
    "web/.svelte-kit/cloudflare",
    "web/node_modules/.bin",
    "scratch",
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  copyFileSync("ci/kit-worker-dev.mjs", join(root, "ci/kit-worker-dev.mjs"));
  copyFileSync("ci/kit-worker-shutdown.mjs", join(root, "ci/kit-worker-shutdown.mjs"));
  writeFileSync(
    join(root, "lib/loopback-hosts.mjs"),
    'export const isLoopbackHostname = (host) => host === "127.0.0.1";\n',
  );
  writeFileSync(
    join(root, "ci/kit-capture-build.mjs"),
    "export const requireCaptureArtifact = () => {};\n",
  );
  writeFileSync(join(root, "e2e/ci-only.mjs"), "export const requireGithubRunner = () => {};\n");
  writeFileSync(join(root, "web/.svelte-kit/cloudflare/_worker.js"), "fixture\n");
  const wrangler = join(root, "web/node_modules/.bin/wrangler");
  const env = {
    ...process.env,
    KIT_COMPONENT_GALLERY: "false",
    SSR_CAPTURE_FIXTURE: "false",
    KIT_WORKER_TEST_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1/fixture",
    KIT_WORKER_PORT: "8788",
    PAPERCLIP_RUN_SCRATCH_DIR: join(root, "scratch"),
  };
  delete env.KIT_GALLERY_READINESS_NONCE;
  for (const port of ["", "0", "65536", "1.5", "abc"]) {
    const result = spawnSync(process.execPath, [join(root, "ci/kit-worker-dev.mjs")], {
      env: { ...env, KIT_WORKER_PORT: port },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /KIT_WORKER_PORT must be a TCP port/);
    assert.deepEqual(readdirSync(join(root, "scratch")), []);
  }
  writeFileSync(wrangler, "#!/bin/sh\nexit 7\n");
  chmodSync(wrangler, 0o755);
  const exited = spawnSync(process.execPath, [join(root, "ci/kit-worker-dev.mjs")], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(exited.status, 7, exited.stderr);
  assert.deepEqual(readdirSync(join(root, "scratch")), []);

  rmSync(wrangler);
  const failed = spawnSync(process.execPath, [join(root, "ci/kit-worker-dev.mjs")], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /Wrangler process error/);
  assert.deepEqual(readdirSync(join(root, "scratch")), []);

  // Inject synchronous failures in the fixture process without modifying the launcher.
  const preload = join(root, "fail-launcher.cjs");
  writeFileSync(
    preload,
    `
    const fs = require("node:fs");
    const childProcess = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");
    const writeFileSync = fs.writeFileSync;
    fs.writeFileSync = (...args) => {
      if (process.env.FAIL_LAUNCHER === "config" && String(args[0]).endsWith("wrangler.jsonc")) {
        throw new Error("injected config failure");
      }
      return writeFileSync(...args);
    };
    if (process.env.FAIL_LAUNCHER === "spawn") {
      childProcess.spawn = () => { throw new Error("injected spawn failure"); };
    }
    syncBuiltinESMExports();
  `,
  );
  for (const failure of ["config", "spawn"]) {
    const result = spawnSync(
      process.execPath,
      ["--require", preload, join(root, "ci/kit-worker-dev.mjs")],
      {
        env: { ...env, FAIL_LAUNCHER: failure },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`injected ${failure} failure`));
    assert.deepEqual(readdirSync(join(root, "scratch")), []);
  }
});
