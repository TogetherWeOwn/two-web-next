import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const app = process.env.APP_ROOT;
const controller = process.env.CONTROLLER_ROOT;
const output = process.env.JOIN_EVIDENCE_DIR;
const target = process.env.JOIN_APP_SHA;
const harness = "afbed516b6fdcd322d847317e4b95c42de7e95f1";
assert.ok(app && controller && output, "source and evidence paths are required");
const revision = (cwd) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const applicationSha = revision(app);
const controllerSha = revision(controller);
assert.equal(applicationSha, target);
assert.match(target ?? "", /^[0-9a-f]{40}$/);
assert.equal(controllerSha, process.env.CONTROLLER_SHA);
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const report = await readFile(join(output, "test-report.tap"), "utf8");
assert.match(report, /^# tests 20$/m);
assert.match(report, /^# pass 20$/m);
assert.match(report, /^# fail 0$/m);
assert.match(report, /^# skipped 0$/m);
const fixtures = {
  "fresh-populated": { ageMs: 1000, channels: "populated" },
  "age61s-populated": { ageMs: 61000, channels: "populated" },
  "age61s-empty": { ageMs: 61000, channels: "empty" },
  "age180s-populated": { ageMs: 180000, channels: "populated", observed: "base retains snapshot" },
  "fresh-empty": { ageMs: 1000, channels: "empty", control: true },
};
const images = [];
for (const renderer of ["hono", "kit"]) {
  for (const width of [1280, 390]) {
    for (const [state, fixture] of Object.entries(fixtures)) {
      const file = `${renderer}-${state}-${width}.png`;
      images.push({
        file,
        sha256: await digest(join(output, file)),
        renderer,
        route: "/join",
        viewport: { width, height: width === 390 ? 844 : 800 },
        state,
        ...fixture,
      });
    }
  }
}
assert.deepEqual(
  (await readdir(output)).filter((name) => name.endsWith(".png")).sort(),
  images.map(({ file }) => file).sort(),
);
const manifest = {
  controllerSha,
  applicationSha,
  originalHarnessSha: harness,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  nodeVersion: process.version,
  harnessSha256: await digest(join(controller, "ci/join-state-evidence.test.mjs")),
  sourceLockfiles: {
    root: await digest(join(app, "package-lock.json")),
    web: await digest(join(app, "web/package-lock.json")),
  },
  reportSha256: await digest(join(output, "test-report.tap")),
  limitations:
    "Real Hono and built Kit renderers use fixture loads and hooks; this is not a live authentication, data-load, security, or production proof.",
  images,
};
assert.ok(manifest.runId && manifest.runAttempt, "Actions run identity is required");
await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
