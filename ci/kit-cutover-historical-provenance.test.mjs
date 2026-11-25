import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STAGING_WORKER, sourceInputs, writeManifest } from "./kit-cutover-evidence.mjs";
import { verifyHistoricalCutover } from "./kit-cutover-historical-provenance.mjs";
import { KIT_ROUTE_FLAGS } from "./production-deploy-gate.mjs";

test("historical isolated cutover binds the selected checkout to the protected dispatch attempt", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "kit-historical-provenance-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, "source");
  const packetDir = join(scratch, "packet");
  const eventPath = join(scratch, "event.json");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const writeJson = (file, value) => writeFile(file, JSON.stringify(value));
  await mkdir(join(root, "drizzle/meta"), { recursive: true });
  await mkdir(join(root, "web"));
  git("init", "--object-format=sha1", "--initial-branch=main");

  const name = "two-web-next-production";
  const journal = join(root, "drizzle/meta/_journal.json");
  await writeJson(join(root, "wrangler.jsonc"), {
    main: "src/worker.ts",
    env: { production: { name } },
  });
  await writeJson(join(root, "web/wrangler.production.jsonc"), {
    name,
    main: ".svelte-kit/cloudflare/_worker.js",
    assets: { directory: ".svelte-kit/cloudflare" },
    vars: Object.fromEntries(KIT_ROUTE_FLAGS.map((flag) => [flag, "false"])),
    triggers: { crons: [] },
    workers_dev: false,
    preview_urls: false,
  });
  await writeJson(join(root, "package-lock.json"), {
    packages: { "node_modules/wrangler": { version: "1.2.3" } },
  });
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  const record = async (revision) => {
    await writeJson(journal, { entries: [{ tag: revision }] });
    git("add", ".");
    git("commit", "-m", revision);
    return git("rev-parse", "HEAD");
  };
  const sourceSha = await record("selected source");
  const source = await sourceInputs(root);
  const dispatcherSha = await record("protected dispatch");
  const laterSha = await record("main advanced");
  git("checkout", "--detach", sourceSha);
  const untrustedSha = await record("off main");
  git("checkout", "--detach", sourceSha);

  for (const profile of ["hono", "kit"]) {
    await mkdir(join(packetDir, profile, "modules"), { recursive: true });
    await mkdir(join(packetDir, profile, "assets"));
    await writeFile(join(packetDir, profile, "assets/index.html"), profile);
  }
  await writeFile(join(packetDir, "hono/modules/worker.js"), "synthetic Hono");
  await writeFile(join(packetDir, "kit/modules/_worker.js"), "synthetic Kit");
  await writeFile(join(packetDir, "kit/modules/kit-adapter.js"), "synthetic adapter");
  const repository = "TogetherWeOwn/two-web-next";
  const ref = "refs/heads/main";
  const path = ".github/workflows/xfs-qualification.yml";
  const runId = "21";
  const runAttempt = "3";
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: ref,
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: dispatcherSha,
    GITHUB_WORKFLOW_REF: `${repository}/${path}@${ref}`,
    GITHUB_WORKFLOW_SHA: dispatcherSha,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: runAttempt,
    GITHUB_EVENT_PATH: eventPath,
  };
  const input = { source_sha: sourceSha, qualify_cutover: "true", cutover_profile: "all-off" };
  const writeEvent = (changes) => writeJson(eventPath, { inputs: { ...input, ...changes } });
  await writeEvent();
  const context = { sourceSha, runId, runAttempt };
  const digest = await writeManifest(packetDir, context, source);
  const identity = { ...context, digest };
  const hono = "11111111-1111-1111-1111-111111111111";
  const kit = "22222222-2222-2222-2222-222222222222";
  const proof = {
    schema: 1,
    identity,
    worker: `${STAGING_WORKER}-${runId}-${runAttempt}`,
    hono,
    kit,
    configs: { hono: digest, kit: digest },
    routeCount: 1,
    bindingCheck: "isolated-and-all-off",
    kitReadinessSamples: 6,
    checks: ["1033", "1037"].flatMap((state) =>
      ["hono", "kit", "undo"].map((step) => ({
        state,
        step,
        version: step === "kit" ? kit : hono,
        status: 200,
        pending: 0,
        smoke: "passed",
      })),
    ),
  };
  const verify = (changes) =>
    verifyHistoricalCutover({
      env,
      sourceRoot: root,
      selectedSha: sourceSha,
      packetDir,
      manifestDigest: digest,
      proof,
      ...changes,
    });

  await t.test(
    "admits the earlier main commit while keeping the dispatcher SHA separate",
    async () => {
      assert.notEqual(sourceSha, dispatcherSha);
      assert.equal(git("rev-parse", "main"), laterSha);
      assert.deepEqual(await verify(), { dispatcherSha, ...identity });
    },
  );

  await t.test("refuses when the provider supplies only successful attempt metadata", async () => {
    const own = { full_name: repository, fork: false, id: 23 };
    await writeJson(eventPath, {
      id: Number(runId),
      run_attempt: Number(runAttempt),
      repository: own,
      head_repository: own,
      head_sha: dispatcherSha,
      head_branch: "main",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      path,
      display_title: `qualify ${sourceSha}`,
    });
    await assert.rejects(verify(), /lacks an explicit full source_sha input/);
    await assert.rejects(
      verify({ env: { ...env, GITHUB_EVENT_PATH: undefined } }),
      /dispatch event payload unavailable/,
    );
    await writeEvent();
  });

  await t.test("refuses abbreviated, malformed, missing, and mismatched selections", async () => {
    for (const source_sha of [undefined, sourceSha.slice(0, 12), `${sourceSha}\n`, [sourceSha]]) {
      await writeEvent({ source_sha });
      await assert.rejects(verify(), /lacks an explicit full source_sha input/);
    }
    await writeEvent();
    await assert.rejects(verify({ selectedSha: dispatcherSha }), /differs from dispatch input/);
  });

  await t.test("accepts a valid dispatch at 1 MiB and refuses larger or invalid JSON", async () => {
    const maxBytes = 1024 * 1024;
    const payload = JSON.stringify({ inputs: input });
    await writeFile(eventPath, payload.padEnd(maxBytes));
    assert.deepEqual(await verify(), { dispatcherSha, ...identity });
    for (const raw of [payload.padEnd(maxBytes + 1), "", payload.slice(0, -1)]) {
      await writeFile(eventPath, raw);
      await assert.rejects(verify(), /dispatch event payload unavailable/);
    }
    await writeEvent();
  });

  await t.test("requires explicit qualification opt-in and a recognized profile", async () => {
    for (const changes of [
      { qualify_cutover: undefined },
      { qualify_cutover: "false" },
      { qualify_cutover: true },
      { cutover_profile: "unknown" },
    ]) {
      await writeEvent(changes);
      await assert.rejects(verify(), /lacks an isolated cutover profile/);
    }
    await writeEvent();
  });

  await t.test("refuses an unprotected dispatch or a different producer", async () => {
    for (const changes of [
      { GITHUB_REF_PROTECTED: "false" },
      { GITHUB_REPOSITORY: "another/two-web-next" },
      { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/other.yml@${ref}` },
      { GITHUB_WORKFLOW_SHA: sourceSha },
      { GITHUB_RUN_ATTEMPT: "03" },
    ]) {
      await assert.rejects(verify({ env: { ...env, ...changes } }), /protected main XFS dispatch/);
    }
  });

  await t.test(
    "refuses a sibling or later main commit even when selected and checked out",
    async () => {
      for (const selectedSha of [untrustedSha, laterSha]) {
        git("checkout", "--detach", selectedSha);
        await writeEvent({ source_sha: selectedSha });
        await assert.rejects(verify({ selectedSha }), /not provably in protected main history/);
      }
      git("checkout", "--detach", sourceSha);
      await writeEvent();
    },
  );

  await t.test(
    "refuses the dispatcher checkout, dirty tracked files, and ignored inputs",
    async () => {
      git("checkout", "--detach", dispatcherSha);
      await assert.rejects(verify(), /checked out source tree/i);
      git("checkout", "--detach", sourceSha);
      await assert.rejects(verify({ sourceRoot: join(root, "web") }), /checked out source tree/i);
      await writeJson(journal, { entries: [] });
      await assert.rejects(verify(), /checked out source tree/i);
      git("restore", "drizzle/meta/_journal.json");
      const ignored = join(root, "ignored.txt");
      await writeFile(ignored, "synthetic ignored input");
      await assert.rejects(verify(), /checked out source tree/i);
      await rm(ignored);
    },
  );

  await t.test(
    "refuses mismatched manifest digest, source, source inputs, or attempt",
    async () => {
      const refusal = /packet failed manifest or source verification/;
      await assert.rejects(verify({ manifestDigest: "a".repeat(64) }), refusal);
      for (const [context, inputs] of [
        [{ ...identity, sourceSha: dispatcherSha }, source],
        [{ ...identity, runId: "22" }, source],
        [{ ...identity, runAttempt: "2" }, source],
        [identity, { ...source, digests: { ...source.digests, journal: "c".repeat(64) } }],
      ]) {
        await rm(join(packetDir, "manifest.json"));
        const { sourceSha, runId, runAttempt } = context;
        const digest = await writeManifest(packetDir, { sourceSha, runId, runAttempt }, inputs);
        const pin = { sourceSha, runId, runAttempt, digest };
        await assert.rejects(
          verify({ manifestDigest: digest, proof: { ...proof, identity: pin } }),
          refusal,
        );
      }
      await rm(join(packetDir, "manifest.json"));
      assert.equal(await writeManifest(packetDir, context, source), digest);
    },
  );

  await t.test("refuses proof replay from another source, run, attempt or profile", async () => {
    const refusal = /proof failed attempt or profile verification/;
    for (const change of [
      { sourceSha: dispatcherSha },
      { runId: "22" },
      { runAttempt: "2" },
      { digest: "a".repeat(64) },
    ]) {
      await assert.rejects(
        verify({ proof: { ...proof, identity: { ...identity, ...change } } }),
        refusal,
      );
    }
    await writeEvent({ cutover_profile: "ember" });
    await assert.rejects(verify(), refusal);
    await writeEvent();
  });
});
