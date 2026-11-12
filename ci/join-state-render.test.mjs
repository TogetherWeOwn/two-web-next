import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { appGit } from "./join-state-evidence-source.mjs";
import { renderJoinFixtures, withoutServerNetwork } from "./join-state-render.mjs";

let app, output, scratchRoot, originalScratch;

before(async () => {
  assert.ok(process.env.APP_ROOT, "APP_ROOT is required");
  app = resolve(process.env.APP_ROOT);
  assert.equal(appGit(app, "rev-parse", "HEAD"), "60c47d13e96b254e71303f24e777932a0e506713");
  assert.equal(appGit(app, "status", "--porcelain", "--untracked-files=no"), "");
  output = join(app, "web/.svelte-kit/output");
  scratchRoot = await mkdtemp(join(tmpdir(), "join-render-test-"));
  originalScratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR;
  process.env.PAPERCLIP_RUN_SCRATCH_DIR = scratchRoot;
});

after(async () => {
  if (originalScratch === undefined) delete process.env.PAPERCLIP_RUN_SCRATCH_DIR;
  else process.env.PAPERCLIP_RUN_SCRATCH_DIR = originalScratch;
  if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true });
  if (app) assert.equal(appGit(app, "status", "--porcelain", "--untracked-files=no"), "");
});

test("renders the five real pinned application states without member names", async () => {
  const originalFetch = globalThis.fetch;
  const { fixtures, scratch } = await renderJoinFixtures(app, output);
  try {
    assert.equal(globalThis.fetch, originalFetch);
    assert.deepEqual(
      fixtures.map(({ name }) => name),
      ["fresh-populated", "stale-populated", "stale-empty", "expired", "fresh-empty"],
    );
    for (const fixture of fixtures) {
      for (const html of [fixture.hono, fixture.kit]) {
        assert.match(html, /join-heading/);
        assert.doesNotMatch(html, /private-member-one|private-member-two/);
        const text = html.replace(/<[^>]*>/g, "");
        if (fixture.name === "expired") assert.doesNotMatch(text, /42\s+members online/);
        else assert.match(text, /42\s+members online/);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  assert.deepEqual(await readdir(scratchRoot), []);
});

test("refuses server fetch and restores the original fetch after response failures", async () => {
  const originalFetch = globalThis.fetch;
  await assert.rejects(
    withoutServerNetwork(() => fetch("https://example.invalid/")),
    /unexpected server fetch/,
  );
  assert.equal(globalThis.fetch, originalFetch);
  await assert.rejects(
    withoutServerNetwork(async () => {
      throw new Error("response failed");
    }),
    /response failed/,
  );
  assert.equal(globalThis.fetch, originalFetch);
});

test("cleans scratch and restores fetch after a real non-200 server response", async () => {
  const originalFetch = globalThis.fetch;
  await assert.rejects(
    renderJoinFixtures(app, output, { requestPath: "/join-state-missing-route" }),
    (error) =>
      error.code === "ERR_ASSERTION" &&
      Number.isInteger(error.actual) &&
      error.actual !== 200 &&
      error.expected === 200,
  );
  assert.equal(globalThis.fetch, originalFetch);
  assert.deepEqual(await readdir(scratchRoot), []);
});

test("cleans scratch and restores fetch when built output is missing", async () => {
  const originalFetch = globalThis.fetch;
  await assert.rejects(renderJoinFixtures(app, join(scratchRoot, "missing-output")));
  assert.equal(globalThis.fetch, originalFetch);
  assert.deepEqual(await readdir(scratchRoot), []);
});
