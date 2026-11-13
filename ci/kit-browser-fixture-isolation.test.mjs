import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withKitBrowserFixture } from "./kit-browser-fixture.mjs";

test("Kit browser fixture copies safely and cleans up on success and failure", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "kit-fixture-test-"));
  const source = join(sandbox, "source");
  const scratch = join(sandbox, "scratch");
  const bin = join(sandbox, "bin");
  const oldPath = process.env.PATH;
  const oldScratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR;
  try {
    await Promise.all([
      mkdir(join(source, "web/node_modules"), { recursive: true }),
      mkdir(join(source, "node_modules"), { recursive: true }),
      mkdir(scratch),
      mkdir(bin),
    ]);
    await writeFile(join(source, "tracked.txt"), "original");
    execFileSync("git", ["init", "-q", source]);
    execFileSync("git", ["add", "tracked.txt"], { cwd: source });
    await writeFile(
      join(bin, "npm"),
      '#!/bin/sh\nprintf \'%s\' "$npm_config_cache" > "$HOME/cache-path"\n',
    );
    await chmod(join(bin, "npm"), 0o755);
    process.env.PATH = `${bin}:${oldPath}`;
    process.env.PAPERCLIP_RUN_SCRATCH_DIR = scratch;
    let fixtureRoot;
    await withKitBrowserFixture({ source, page: "<p>fixture</p>" }, async ({ root }) => {
      fixtureRoot = root;
      assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "original");
      assert.equal(await readFile(join(root, "cache-path"), "utf8"), join(root, ".npm-cache"));
      assert.equal(
        await readFile(join(root, "web/src/routes/__browser_fixture__/+page.svelte"), "utf8"),
        "<p>fixture</p>",
      );
    });
    assert.deepEqual(await readdir(scratch), [], "success removes scratch copy");
    await assert.rejects(
      withKitBrowserFixture({ source, page: "test" }, async () => {
        throw new Error("callback failed");
      }),
      /callback failed/,
    );
    assert.deepEqual(await readdir(scratch), [], "callback failure removes scratch copy");
    await writeFile(join(bin, "npm"), "#!/bin/sh\nexit 1\n");
    await assert.rejects(withKitBrowserFixture({ source, page: "test" }, async () => {}));
    assert.deepEqual(await readdir(scratch), [], "build failure removes scratch copy");
    await symlink(source, join(source, "node_modules/escape"));
    await assert.rejects(
      withKitBrowserFixture({ source, page: "test" }, async () => {}),
      /symlink escapes copy/,
    );
    assert.deepEqual(await readdir(scratch), [], "invalid link removes scratch copy");
    assert.ok(fixtureRoot.startsWith(`${scratch}/`));
    assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "original");

    const linkedSource = join(sandbox, "linked-source");
    const external = join(scratch, "shared-web");
    await mkdir(join(linkedSource, "node_modules"), { recursive: true });
    await mkdir(join(sandbox, "shared-web/node_modules"), { recursive: true });
    await mkdir(external);
    await writeFile(join(sandbox, "shared-web/node_modules/payload"), "do not copy");
    await writeFile(join(external, "sentinel"), "untouched");
    await symlink("../shared-web", join(linkedSource, "web"));
    execFileSync("git", ["init", "-q", linkedSource]);
    execFileSync("git", ["add", "web"], { cwd: linkedSource });
    await assert.rejects(
      withKitBrowserFixture({ source: linkedSource, page: "test" }, async () => {}),
      /symlink in destination/,
    );
    assert.deepEqual(await readdir(external), ["sentinel"], "external target is untouched");
    assert.equal(await readFile(join(external, "sentinel"), "utf8"), "untouched");
    assert.deepEqual(await readdir(scratch), ["shared-web"], "rejected copy removes its root");
  } finally {
    process.env.PATH = oldPath;
    if (oldScratch === undefined) delete process.env.PAPERCLIP_RUN_SCRATCH_DIR;
    else process.env.PAPERCLIP_RUN_SCRATCH_DIR = oldScratch;
    await rm(sandbox, { recursive: true, force: true });
  }
});
