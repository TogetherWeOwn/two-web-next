import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
import { requireGithubRunner } from "../e2e/ci-only.mjs";

requireGithubRunner();

test("repeated termination signals wait for the direct child and remove scratch", {
  timeout: 15_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kit-worker-signals-"));
  for (const dir of [
    "ci",
    "lib",
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
  writeFileSync(join(root, "web/.svelte-kit/cloudflare/_worker.js"), "fixture\n");
  const wrangler = join(root, "web/node_modules/.bin/wrangler");
  writeFileSync(
    wrangler,
    `#!${process.execPath}\nprocess.on("SIGTERM", () => process.stdout.write("stopping\\n"));\nprocess.stdin.once("data", () => process.exit(0));\nprocess.stdout.write("ready\\n");\n`,
  );
  chmodSync(wrangler, 0o755);
  const child = spawn(process.execPath, [join(root, "ci/kit-worker-dev.mjs")], {
    env: {
      ...process.env,
      SSR_CAPTURE_FIXTURE: "false",
      KIT_WORKER_PORT: "8788",
      KIT_WORKER_TEST_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1/fixture",
      PAPERCLIP_RUN_SCRATCH_DIR: join(root, "scratch"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let closed = false;
  const completion = once(child, "close").then(([code, signal]) => {
    closed = true;
    return { code, signal };
  });
  t.after(() => {
    if (!closed) child.kill("SIGKILL");
    if (closed) rmSync(root, { recursive: true, force: true });
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const waitFor = async (text) => {
    while (!output.includes(text)) {
      await Promise.race([
        once(child.stdout, "data"),
        completion.then(() => {
          throw new Error(`launcher closed before ${JSON.stringify(text)}: ${output}`);
        }),
      ]);
    }
  };
  await waitFor("ready\n");
  assert.equal(child.kill("SIGTERM"), true);
  await waitFor("stopping\n");
  assert.equal(child.kill("SIGTERM"), true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(closed, false, "launcher exited before its child closed");
  assert.equal(readdirSync(join(root, "scratch")).length, 1);
  child.stdin.end("release\n");
  assert.deepEqual(await completion, { code: 0, signal: null });
  assert.deepEqual(readdirSync(join(root, "scratch")), []);
});
