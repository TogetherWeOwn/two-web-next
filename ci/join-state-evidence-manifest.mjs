import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = "60c47d13e96b254e71303f24e777932a0e506713";
const harness = "afbed516b6fdcd322d847317e4b95c42de7e95f1";
const fixtures = {
  "fresh-populated": { ageMs: 1000, channels: "populated" },
  "stale-populated": { ageMs: 61000, channels: "populated" },
  "stale-empty": { ageMs: 61000, channels: "empty" },
  expired: { ageMs: 180000, channels: "snapshot expired" },
  "fresh-empty": { ageMs: 1000, channels: "empty", control: true },
};

const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const revision = (cwd) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();

export async function writeManifest({ app, controller, output, githubSha, runId, runAttempt }) {
  assert.ok(output, "evidence path is required");
  // Each capture must have its own output directory; concurrent writers are unsupported.
  const manifestPath = join(output, "manifest.json");
  await rm(manifestPath, { force: true });
  assert.ok(app && controller, "source paths are required");
  assert.match(githubSha || "", /^[a-f0-9]{40}$/, "controller SHA is required");
  assert.match(runId || "", /^[1-9][0-9]*$/, "Actions run ID is required");
  assert.match(runAttempt || "", /^[1-9][0-9]*$/, "Actions run attempt is required");
  const applicationSha = revision(app);
  const controllerSha = revision(controller);
  assert.equal(applicationSha, target);
  assert.equal(controllerSha, githubSha);

  const reportPath = join(output, "test-report.tap");
  const report = await readFile(reportPath, "utf8");
  for (const [name, value] of Object.entries({
    tests: 20,
    pass: 20,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  })) {
    const matches = [...report.matchAll(new RegExp(`^# ${name} ([0-9]+)$`, "gm"))];
    assert.equal(matches.length, 1, `expected one TAP ${name} summary`);
    assert.equal(Number(matches[0][1]), value, `unexpected TAP ${name} count`);
  }
  const testNames = [];
  const images = [];
  for (const renderer of ["hono", "kit"]) {
    for (const width of [1280, 390]) {
      for (const [state, fixture] of Object.entries(fixtures)) {
        const file = `${renderer}-${state}-${width}.png`;
        assert.ok((await stat(join(output, file))).size > 0, `empty screenshot ${file}`);
        testNames.push(`${renderer} ${state} at ${width}`);
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
  const passedCases = [...report.matchAll(/^    ok [0-9]+ - (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(
    passedCases.sort(),
    testNames.sort(),
    "TAP must contain every successful capture case",
  );
  assert.deepEqual(
    (await readdir(output)).filter((name) => name.endsWith(".png")).sort(),
    images.map(({ file }) => file).sort(),
  );
  const manifest = {
    controllerSha,
    applicationSha,
    originalHarnessSha: harness,
    runId,
    runAttempt,
    nodeVersion: process.version,
    harnessSha256: await digest(join(controller, "ci/join-state-evidence.test.mjs")),
    sourceHelperSha256: await digest(join(controller, "ci/join-state-evidence-source.mjs")),
    fixtureHelperSha256: await digest(join(controller, "ci/join-state-fixtures.mjs")),
    sourceLockfiles: {
      root: await digest(join(app, "package-lock.json")),
      web: await digest(join(app, "web/package-lock.json")),
    },
    reportSha256: await digest(reportPath),
    limitations:
      "Real Hono and built Kit renderers use fixture loads and hooks; this is not a live authentication, data-load, security, or production proof.",
    images,
  };
  const temporaryPath = join(output, `.manifest-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, manifestPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeManifest({
    app: process.env.APP_ROOT,
    controller: process.env.CONTROLLER_ROOT,
    output: process.env.JOIN_EVIDENCE_DIR,
    githubSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
}
