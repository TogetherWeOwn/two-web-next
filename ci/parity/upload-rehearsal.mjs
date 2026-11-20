import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { COMPANION_NAME, ENTRY_NAME } from "../../web/scripts/kit-facade-transaction.mjs";
import { sha256 } from "../worker-bundle-evidence.mjs";

export function rehearsalContext(sourceSha, env = process.env) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9][0-9]*$/);
  return { sourceSha, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT };
}

export function checkRehearsalInput(identity, context, configBytes, files) {
  for (const key of ["sourceSha", "runId", "runAttempt"]) {
    assert.equal(identity[key], context[key], `parity ${key} mismatch`);
  }
  assert.equal(sha256(configBytes), identity.kitConfigSha256, "production config digest mismatch");
  assert.equal(
    sha256(JSON.stringify(files)),
    identity.installedOutputSha256,
    "installed output digest mismatch",
  );
}

// Compare the actual serialized module parts, not merely Wrangler's copied entry.
// Retain only names and digests, never the multipart body or binding metadata.
export async function compareDryRun(bytes, expected, tag) {
  assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024 * 1024, "invalid dry-run envelope size");
  const boundary = /^--([A-Za-z0-9-]{1,70})\r\n/.exec(bytes.subarray(0, 74).toString("ascii"))?.[1];
  assert.ok(boundary, "invalid dry-run envelope boundary");
  const form = await new Response(bytes, {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  })
    .formData()
    .catch(() => {
      throw new Error("cannot parse dry-run multipart body");
    });
  const metadata = form.getAll("metadata");
  assert.ok(
    metadata.length === 1 && typeof metadata[0] === "string",
    "invalid dry-run metadata part",
  );
  let parsed;
  try {
    parsed = JSON.parse(metadata[0]);
  } catch {
    throw new Error("invalid dry-run metadata JSON");
  }
  assert.ok(parsed?.main_module === ENTRY_NAME, "dry run changed the main module name");
  assert.ok(parsed.annotations?.["workers/tag"] === tag, "dry run changed the candidate tag");
  const modules = new Map();
  for (const [name, value] of form) {
    if (name === "metadata") continue;
    assert.ok(
      typeof value !== "string" && !modules.has(name),
      "invalid or duplicate dry-run module part",
    );
    modules.set(name, { type: value.type, sha256: sha256(Buffer.from(await value.arrayBuffer())) });
  }
  const missing = Object.keys(expected).filter((name) => !modules.has(name));
  const extra = [...modules.keys()].filter((name) => !Object.hasOwn(expected, name)).sort();
  const changed = Object.keys(expected).filter((name) => {
    const part = modules.get(name);
    return part && (part.sha256 !== expected[name] || part.type !== "application/javascript+module");
  });
  return {
    sameModuleBytes: missing.length === 0 && extra.length === 0 && changed.length === 0,
    expected,
    observed: Object.fromEntries(modules),
    missing,
    extra,
    changed,
  };
}

export async function rehearseUpload({
  repo,
  installed,
  configBytes,
  identity,
  context,
  outputIdentity,
}) {
  const config = join(installed.assets, "../../wrangler.production.jsonc");
  const before = await outputIdentity(installed);
  checkRehearsalInput(identity, context, configBytes, before);
  // Place the unmodified config next to the installed tree so its relative main
  // and assets resolve to the parity inputs without CLI overrides or copies.
  await writeFile(config, configBytes, { flag: "wx", mode: 0o600 });
  const lock = JSON.parse(await readFile(join(repo, "web/package-lock.json"), "utf8"));
  const tool = join(repo, "web/node_modules/wrangler");
  const { version } = JSON.parse(await readFile(join(tool, "package.json"), "utf8"));
  assert.equal(version, lock.packages[""].devDependencies.wrangler, "Wrangler must use the web pin");
  assert.equal(version, lock.packages["node_modules/wrangler"].version, "Wrangler lock mismatch");
  const prefix = `${basename(installed.assets)}/`;
  const assetInputs = Object.fromEntries(
    Object.entries(before)
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, digest]) => [path.slice(prefix.length), digest]),
  );
  const expected = Object.fromEntries(
    [ENTRY_NAME, COMPANION_NAME].map((name) => [name, assetInputs[name]]),
  );
  const tag = `${context.sourceSha}-${context.runId}-${context.runAttempt}`;
  const dir = await mkdtemp(join(dirname(config), "upload-rehearsal-"));
  const command = ["versions", "upload", "--dry-run", "--no-bundle", "--upload-source-maps=false"];
  let result;
  try {
    const home = join(dir, "home");
    await mkdir(home, { mode: 0o700 });
    const outfile = join(dir, "upload.multipart");
    const args = [...command, "--config", config, "--tag", tag, "--outfile", outfile];
    const child = spawnSync(process.execPath, [join(tool, "bin/wrangler.js"), ...args], {
      cwd: dir,
      env: {
        CI: "true",
        HOME: home,
        XDG_CONFIG_HOME: home,
        TMPDIR: dir,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        WRANGLER_SEND_METRICS: "false",
      },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    });
    if (child.error || child.status !== 0) {
      result = {
        outcome: "wrangler-failed",
        status: child.status,
        signal: child.signal,
        error: child.error?.code,
        stderr: stripVTControlCharacters(child.stderr ?? "").slice(-4_000),
      };
    } else {
      try {
        const stat = await lstat(outfile);
        assert.ok(stat.isFile() && stat.size <= 64 * 1024 * 1024, "invalid Wrangler output file");
        const comparison = await compareDryRun(await readFile(outfile), expected, tag);
        result = { outcome: comparison.sameModuleBytes ? "matched" : "module-mismatch", comparison };
      } catch (error) {
        result = { outcome: "invalid-envelope", error: error.message };
      }
    }
    checkRehearsalInput(identity, context, await readFile(config), await outputIdentity(installed));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    schema: "two.kit-parity-upload-rehearsal.v1",
    scope: "credential-free dry run only; not selected remote assets, an upload UUID, deployed parity, or qualified recovery",
    ...context,
    tag,
    kitConfigSha256: identity.kitConfigSha256,
    installedOutputSha256: identity.installedOutputSha256,
    workerSha256: expected[ENTRY_NAME],
    assetInputTreeSha256: sha256(JSON.stringify(assetInputs)),
    controlFiles: { "_headers": assetInputs._headers, ".assetsignore": assetInputs[".assetsignore"] },
    wrangler: { version, command },
    scratchRemoved: true,
    ...result,
  };
}
