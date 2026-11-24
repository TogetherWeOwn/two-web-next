import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { COMPANION_NAME, ENTRY_NAME } from "../../web/scripts/kit-facade-transaction.mjs";
import { sha256 } from "../worker-bundle-evidence.mjs";
import { readWranglerConfig } from "../wrangler-config.mjs";

const moduleNames = [ENTRY_NAME, COMPANION_NAME];
const installedAssetPath = "../cloudflare";
export const moduleMime = "application/javascript+module";
export const rehearsalSchema = "two.kit-parity-upload-rehearsal.v2";
export const productionConfig = "web/wrangler.production.jsonc";
export const wranglerVersion = "4.156.1";

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

export function rehearsalConfig(configBytes) {
  const config = readWranglerConfig(configBytes.toString());
  assert.equal(config.main, `.svelte-kit/cloudflare/${ENTRY_NAME}`);
  assert.equal(config.assets.directory, ".svelte-kit/cloudflare");
  return JSON.stringify({
    ...config,
    main: `modules/${ENTRY_NAME}`,
    base_dir: "modules",
    rules: [{ type: "ESModule", globs: [COMPANION_NAME] }],
    // The scratch config is a sibling of the original installed asset directory.
    assets: { ...config.assets, directory: installedAssetPath },
  });
}

export function rehearsalInputs(files) {
  const prefix = "cloudflare/";
  const assetInputs = Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, digest]) => [path.slice(prefix.length), digest]),
  );
  for (const name of [...moduleNames, "_headers", ".assetsignore"]) {
    assert.match(assetInputs[name] ?? "", /^[a-f0-9]{64}$/, `missing installed ${name} digest`);
  }
  return {
    moduleSha256: Object.fromEntries(moduleNames.map((name) => [name, assetInputs[name]])),
    assetInputTreeSha256: sha256(JSON.stringify(assetInputs)),
    controlFiles: { _headers: assetInputs._headers, ".assetsignore": assetInputs[".assetsignore"] },
  };
}

export async function checkModuleRoot(root, expected) {
  assert.ok((await lstat(root)).isDirectory(), "module root is not a directory");
  assert.deepEqual((await readdir(root)).sort(), [...moduleNames].sort(), "module root file set");
  for (const name of moduleNames) {
    const path = join(root, name);
    assert.ok((await lstat(path)).isFile(), "expected a regular scratch module");
    assert.equal(sha256(await readFile(path)), expected[name], `scratch module digest: ${name}`);
  }
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
    return part && (part.sha256 !== expected[name] || part.type !== moduleMime);
  });
  // Keep every compared part without persisting arbitrary names or MIME strings.
  const safeName = (name) => (moduleNames.includes(name) ? name : `sha256:${sha256(name)}`);
  const observed = Object.fromEntries(
    [...modules].map(([name, part]) => [
      safeName(name),
      { sha256: part.sha256, type: part.type === moduleMime ? moduleMime : "unexpected-mime" },
    ]),
  );
  return {
    sameModuleBytes: missing.length === 0 && extra.length === 0 && changed.length === 0,
    expected,
    observed,
    missing,
    extra: extra.map(safeName),
    changed,
  };
}

export async function checkEffectiveConfig(path, digest) {
  assert.ok((await lstat(path)).isFile(), "expected a regular scratch config");
  assert.equal(sha256(await readFile(path)), digest, "effective config digest mismatch");
}

export async function rehearseUpload(
  { repo, installed, identity, context, outputIdentity },
  run = spawnSync,
) {
  const tag = `${context.sourceSha}-${context.runId}-${context.runAttempt}`;
  const command = ["versions", "upload", "--dry-run", "--no-bundle", "--upload-source-maps=false"];
  const receipt = {
    schema: rehearsalSchema,
    scope: "local serialization only; no asset synchronization, remote validation or upload",
    ...context,
    tag,
    kitConfigSha256: identity.kitConfigSha256,
    installedOutputSha256: identity.installedOutputSha256,
  };
  const originalConfig = join(repo, productionConfig);
  const checkOriginal = async (configBytes) => {
    const files = await outputIdentity(installed);
    checkRehearsalInput(identity, context, configBytes, files);
    return files;
  };
  let dir;
  let phase = "parity-input";
  try {
    const configBytes = await readFile(originalConfig);
    Object.assign(receipt, rehearsalInputs(await checkOriginal(configBytes)));
    phase = "effective-config";
    dir = await mkdtemp(join(dirname(installed.assets), "upload-rehearsal-"));
    assert.ok(join(dir, installedAssetPath) === installed.assets, "asset directory moved");
    const config = join(dir, "wrangler.json");
    const effective = rehearsalConfig(configBytes);
    receipt.effectiveConfigSha256 = sha256(effective);
    await writeFile(config, effective, { flag: "wx", mode: 0o600 });

    phase = "module-root";
    const modules = join(dir, "modules");
    const home = join(dir, "home");
    await mkdir(modules, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    for (const name of moduleNames) {
      const bytes = await readFile(join(installed.assets, name));
      await writeFile(join(modules, name), bytes, { flag: "wx", mode: 0o600 });
    }
    await checkModuleRoot(modules, receipt.moduleSha256);
    await checkEffectiveConfig(config, receipt.effectiveConfigSha256);

    phase = "wrangler-pin";
    const lock = JSON.parse(await readFile(join(repo, "web/package-lock.json"), "utf8"));
    const tool = join(repo, "web/node_modules/wrangler");
    const { version } = JSON.parse(await readFile(join(tool, "package.json"), "utf8"));
    assert.equal(version, wranglerVersion, "unexpected rehearsal Wrangler version");
    assert.equal(version, lock.packages[""].devDependencies.wrangler, "Wrangler web pin drift");
    assert.equal(version, lock.packages["node_modules/wrangler"].version, "Wrangler lock mismatch");
    receipt.wrangler = { version, command };

    const outfile = join(dir, "upload.multipart");
    phase = "wrangler-execution";
    const args = [...command, "--config", config, "--tag", tag, "--outfile", outfile];
    const child = await run(process.execPath, [join(tool, "bin/wrangler.js"), ...args], {
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
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    });
    phase = "post-run-parity-input";
    await checkOriginal(await readFile(originalConfig));
    phase = "post-run-effective-config";
    await checkEffectiveConfig(config, receipt.effectiveConfigSha256);
    phase = "post-run-module-root";
    await checkModuleRoot(modules, receipt.moduleSha256);
    if (child.error || child.status !== 0) {
      Object.assign(receipt, {
        outcome: "wrangler-failed",
        status: child.status,
        signal: child.signal,
        error: child.error?.code,
      });
    } else {
      phase = "multipart-envelope";
      const stat = await lstat(outfile);
      assert.ok(stat.isFile() && stat.size <= 64 * 1024 * 1024, "invalid Wrangler output file");
      receipt.comparison = await compareDryRun(await readFile(outfile), receipt.moduleSha256, tag);
      receipt.outcome = receipt.comparison.sameModuleBytes ? "matched" : "module-mismatch";
    }
  } catch {
    // Wrapper errors and Wrangler stderr can carry scratch paths or config values.
    Object.assign(receipt, { outcome: "refused", phase });
  } finally {
    const removed =
      !dir ||
      (await rm(dir, { recursive: true, force: true })
        .then(() => !lstatSync(dir, { throwIfNoEntry: false }))
        .catch(() => false));
    receipt.scratchRemoved = removed;
    if (!removed) Object.assign(receipt, { outcome: "refused", phase: "cleanup" });
  }
  return receipt;
}
