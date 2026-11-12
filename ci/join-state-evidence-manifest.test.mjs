import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { writeManifest } from "./join-state-evidence-manifest.mjs";

const states = ["fresh-populated", "stale-populated", "stale-empty", "expired", "fresh-empty"];
const names = ["hono", "kit"].flatMap((renderer) =>
  [1280, 390].flatMap((width) => states.map((state) => `${renderer} ${state} at ${width}`)),
);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
let root, app, controller, output, githubSha, report;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const options = () => ({ app, controller, output, githubSha, runId: "123", runAttempt: "1" });

before(async () => {
  assert.ok(process.env.APP_ROOT, "APP_ROOT must be the pinned application checkout");
  app = resolve(process.env.APP_ROOT);
  root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "manifest-test-"));
  controller = join(root, "controller");
  output = join(root, "output");
  await mkdir(join(controller, "ci"), { recursive: true });
  await mkdir(output);
  git(controller, "init", "-q");
  git(controller, "config", "user.email", "fixture@example.invalid");
  git(controller, "config", "user.name", "Fixture");
  for (const file of [
    "join-state-evidence.test.mjs",
    "join-state-evidence-source.mjs",
    "join-state-fixtures.mjs",
  ]) {
    await writeFile(join(controller, "ci", file), `fixture ${file}\n`);
  }
  git(controller, "add", "ci");
  git(controller, "commit", "-qm", "fixture");
  githubSha = git(controller, "rev-parse", "HEAD");
  for (const renderer of ["hono", "kit"]) {
    for (const width of [1280, 390]) {
      for (const state of states) {
        await writeFile(
          join(output, `${renderer}-${state}-${width}.png`),
          `image ${renderer} ${state} ${width}`,
        );
      }
    }
  }
  const tapSource = join(root, "capture.test.mjs");
  await writeFile(
    tapSource,
    `import { describe, test } from 'node:test';\ndescribe('Join presence state evidence', () => {\n${names.map((name) => `test(${JSON.stringify(name)}, () => {});`).join("\n")}\n});\n`,
  );
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  report = execFileSync(process.execPath, ["--test", "--test-reporter=tap", tapSource], {
    encoding: "utf8",
    env: childEnv,
  });
  await writeFile(join(output, "test-report.tap"), report);
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("writes pinned identities, complete image metadata and file hashes", async () => {
  await writeManifest(options());
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.applicationSha, "60c47d13e96b254e71303f24e777932a0e506713");
  assert.equal(manifest.controllerSha, githubSha);
  assert.equal(manifest.runId, "123");
  assert.equal(manifest.images.length, 20);
  for (const image of manifest.images) {
    assert.equal(image.sha256, sha256(await readFile(join(output, image.file))));
    assert.equal(image.route, "/join");
    assert.equal(image.viewport.height, image.viewport.width === 390 ? 844 : 800);
  }
  assert.equal(manifest.reportSha256, sha256(report));
  assert.equal(
    manifest.sourceLockfiles.root,
    sha256(await readFile(join(app, "package-lock.json"))),
  );
  assert.equal(
    manifest.sourceLockfiles.web,
    sha256(await readFile(join(app, "web/package-lock.json"))),
  );
  for (const [key, file] of Object.entries({
    harnessSha256: "join-state-evidence.test.mjs",
    sourceHelperSha256: "join-state-evidence-source.mjs",
    fixtureHelperSha256: "join-state-fixtures.mjs",
  })) {
    assert.equal(manifest[key], sha256(await readFile(join(controller, "ci", file))));
  }
});

test("removes stale manifest on metadata and identity failures", async () => {
  const manifestPath = join(output, "manifest.json");
  for (const overrides of [{ githubSha: "bad" }, { app: controller }]) {
    await writeFile(manifestPath, "stale evidence");
    await assert.rejects(writeManifest({ ...options(), ...overrides }));
    await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
  }
});

test("rejects incorrect identity and malformed Actions metadata", async () => {
  for (const overrides of [
    { app: controller },
    { githubSha: "0".repeat(40) },
    { githubSha: "bad" },
    { runId: "0" },
    { runAttempt: "01" },
    { output: "" },
  ])
    await assert.rejects(writeManifest({ ...options(), ...overrides }));
});

test("rejects missing, duplicated, or unsuccessful TAP cases and summaries", async () => {
  const reportPath = join(output, "test-report.tap");
  const cases = [
    report.replace(`# pass 20`, `# pass 19`),
    `${report}\n# fail 0\n`,
    report.replace(`    # Subtest: ${names[0]}`, "    # Subtest: unexpected case"),
    report.replace(`    ok 1 - ${names[0]}`, "    ok 1 - unexpected case"),
    report.replace(/    ok 1 - /, "    not ok 1 - "),
    `${report}\nnot ok 2 - unexpected failure\n`,
    report.replace("# skipped 0", "# skipped 1"),
  ];
  try {
    for (const invalid of cases) {
      assert.notEqual(invalid, report);
      await writeFile(reportPath, invalid);
      await writeFile(join(output, "manifest.json"), "stale evidence");
      await assert.rejects(writeManifest(options()));
      await assert.rejects(readFile(join(output, "manifest.json")), { code: "ENOENT" });
    }
  } finally {
    await writeFile(reportPath, report);
  }
});

test("rejects missing or unexpected images", async () => {
  const unexpected = join(output, "extra.png");
  await writeFile(unexpected, "extra");
  try {
    await assert.rejects(writeManifest(options()));
  } finally {
    await rm(unexpected);
  }
  const missing = join(output, "kit-expired-390.png");
  const original = await readFile(missing);
  await writeFile(missing, "");
  await writeFile(join(output, "manifest.json"), "stale evidence");
  try {
    await assert.rejects(writeManifest(options()), /empty screenshot/);
    await assert.rejects(readFile(join(output, "manifest.json")), { code: "ENOENT" });
  } finally {
    await writeFile(missing, original);
  }
  await rm(missing);
  try {
    await assert.rejects(writeManifest(options()));
  } finally {
    await writeFile(missing, original);
  }
});
