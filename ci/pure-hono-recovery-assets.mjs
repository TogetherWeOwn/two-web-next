import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  RECOVERY_MEMBER_LIMITS,
  RECOVERY_REQUIRED_FILES,
  recordRecoveryPath,
  validRecoveryZipPath,
} from "./pure-hono-recovery-members.mjs";

const WRANGLER_INTEGRITIES = new Map(
  Object.entries({
    "4.156.1":
      "sha512-aZngeNRosSVly6wgxpaJAtFPtEoyM3hD8mLMMcHNXTnofMq4ZN+RMXOdHETyttNP+//+mfiD1hb5E8YFtiMMRQ==",
    "4.161.0":
      "sha512-yOHZUYEq9AP7vutWmkCADzCKAH9ynfvZdoKJRIGTzkiailf9/L+jhT7WRb+9p6jRDtuBXVFtCzLo7kGAcGw+pA==",
  }),
);
const CONFIG = "wrangler.jsonc";
const LOCK = "package-lock.json";
const DIRECTORY = "public";
const SOURCE_PATHS = [CONFIG, LOCK, DIRECTORY, "wrangler.json", ".wrangler"];
const TEXT_LIMIT = 64 * 1024;
const LOCK_LIMIT = 2 * 1024 * 1024;
const ASSET_LIMIT = 25 * 1024 * 1024;
const { maxEntries, maxTotalBytes, maxManifestBytes } = RECOVERY_MEMBER_LIMITS;
const CONTROL_PATHS = ["_headers", "_redirects"];
const SELECTION = { directory: DIRECTORY, binding: "ASSETS", runWorkerFirst: true };
const refusal = (reason) => new Error(`pure Hono recovery assets refused: ${reason}`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileRow = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha256(bytes) });

function git(repo, args, maxBuffer, input) {
  try {
    return execFileSync("git", ["--no-replace-objects", ...args], {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        GIT_ALLOW_PROTOCOL: "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer,
      input,
    });
  } catch {
    throw refusal("Git source unavailable or exceeds bounds");
  }
}

function listSource(repo, sourceSha) {
  const output = git(
    repo,
    ["ls-tree", "-rlz", "--full-tree", sourceSha, "--", ...SOURCE_PATHS],
    (maxEntries + 4) * 600,
  ).toString("latin1");
  if (!output.endsWith("\0")) throw refusal("source tree");
  const paths = new Map();
  const aliases = new Map();
  let count = 0;
  let total = 0;
  for (const row of output.slice(0, -1).split("\0")) {
    const match = /^(100644|100755) blob ([0-9a-f]{40}) +([0-9]+)\t(.+)$/s.exec(row);
    if (!match) throw refusal("non-regular source member");
    const [, , oid, size, path] = match;
    const length = Number(size);
    if (paths.has(path)) throw refusal("duplicate source member");
    let limit = path === LOCK ? LOCK_LIMIT : TEXT_LIMIT;
    if (path !== CONFIG && path !== LOCK) {
      if (!path.startsWith(`${DIRECTORY}/`)) throw refusal("unsupported source member");
      const relative = path.slice(DIRECTORY.length + 1);
      const archivePath = `assets/${relative}`;
      if (!validRecoveryZipPath(archivePath)) throw refusal("asset path");
      if (!recordRecoveryPath(aliases, archivePath)) throw refusal("aliased asset path");
      const root = relative.split("/", 1)[0].toLowerCase();
      if (
        root === ".assetsignore" ||
        relative.startsWith("_worker.js") ||
        (CONTROL_PATHS.includes(root) && relative !== root)
      )
        throw refusal("unsupported asset selection input");
      if (!CONTROL_PATHS.includes(relative)) {
        limit = ASSET_LIMIT;
        count++;
        total += length;
      }
    }
    if (!Number.isSafeInteger(length) || length > limit) throw refusal("file size");
    paths.set(path, { oid, length });
  }
  if (!count || count + RECOVERY_REQUIRED_FILES.length + 1 > maxEntries)
    throw refusal("asset count");
  if (total > maxTotalBytes) throw refusal("asset bytes");
  if (!paths.has(CONFIG) || !paths.has(LOCK)) throw refusal("missing source selection inputs");
  return { paths, count, total };
}

function sourceBytes(repo, paths) {
  const entries = [...paths.values()];
  const capacity = entries.reduce((sum, { length }) => sum + length + 80, 0);
  const input = entries.map(({ oid }) => `${oid}\n`).join("");
  const output = git(repo, ["cat-file", "--batch"], capacity, input);
  const files = new Map();
  let start = 0;
  for (const [path, { oid, length }] of paths) {
    const header = `${oid} blob ${length}\n`;
    const from = start + header.length;
    const end = from + length;
    if (output.toString("latin1", start, from) !== header || output[end] !== 10)
      throw refusal("Git blob size or identity");
    files.set(path, Buffer.from(output.subarray(from, end)));
    start = end + 1;
  }
  if (output.length !== start) throw refusal("unexpected Git blob bytes");
  return files;
}

function readText(bytes) {
  if (!isUtf8(bytes) || bytes.includes(0)) throw refusal("selection input encoding");
  return bytes.toString("utf8");
}

function sourceSelection(configBytes, lockBytes) {
  let config;
  let lock;
  try {
    const stringsOrComments = /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
    const stringsOrTrailingCommas = /"(?:\\.|[^"\\])*"|(?<=[\d"e\]}l]\s*),(?=\s*[}\]])/g;
    const json = readText(configBytes)
      .replace(/^\uFEFF/, "")
      .replace(stringsOrComments, (token) => (token.startsWith('"') ? token : " "))
      .replace(stringsOrTrailingCommas, (token) => (token === "," ? "" : token));
    config = JSON.parse(json);
    lock = JSON.parse(readText(lockBytes));
  } catch {
    throw refusal("source selection parsing");
  }
  const pin = lock?.packages?.["node_modules/wrangler"];
  const integrity = WRANGLER_INTEGRITIES.get(pin?.version);
  if (!integrity || pin.integrity !== integrity) throw refusal("unsupported Wrangler pin");
  const production = config?.env?.production;
  const assets = config?.assets;
  if (
    config?.main !== "src/worker.ts" ||
    !production ||
    typeof production !== "object" ||
    Array.isArray(production) ||
    Object.hasOwn(config.env, "__proto__") ||
    ["__proto__", "build", "site"].some((key) => Object.hasOwn(config, key)) ||
    ["__proto__", "build", "site", "assets", "main"].some((key) =>
      Object.hasOwn(production, key),
    ) ||
    !assets ||
    Object.keys(assets).length !== 3 ||
    assets.directory !== `./${SELECTION.directory}` ||
    assets.binding !== SELECTION.binding ||
    assets.run_worker_first !== SELECTION.runWorkerFirst
  )
    throw refusal("unsupported Wrangler asset config");
  return pin.version;
}

// Read tracked bytes at a commit in a trusted repository.
export function inventoryPureHonoSourceAssets({ repo, sourceSha }) {
  if (typeof repo !== "string" || !isAbsolute(repo)) throw refusal("repository");
  if (typeof sourceSha !== "string" || sourceSha.length !== 40 || !/^[0-9a-f]+$/.test(sourceSha))
    throw refusal("full source SHA required");
  if (git(repo, ["cat-file", "-t", sourceSha], 1024).toString("latin1") !== "commit\n")
    throw refusal("source is not a commit");
  const { paths, count, total } = listSource(repo, sourceSha);
  const files = sourceBytes(repo, paths);
  const config = files.get(CONFIG);
  const lock = files.get(LOCK);
  const version = sourceSelection(config, lock);
  const controls = {};
  const controlFiles = {};
  for (const name of CONTROL_PATHS) {
    const path = `${DIRECTORY}/${name}`;
    const bytes = files.get(path) ?? null;
    if (bytes) readText(bytes);
    controls[name] = bytes;
    controlFiles[name] = bytes ? fileRow(path, bytes) : null;
    files.delete(path);
  }
  files.delete(CONFIG);
  files.delete(LOCK);
  const assets = [...files.keys()].sort().map((path) => ({
    path: `assets/${path.slice(DIRECTORY.length + 1)}`,
    bytes: files.get(path),
  }));
  const receipt = Buffer.from(
    JSON.stringify({
      schema: "two.pure-hono-source-assets.v1",
      sourceSha,
      wrangler: { version, configSha256: sha256(config), lockSha256: sha256(lock) },
      selection: SELECTION,
      controlFiles,
      assetCount: count,
      assetBytes: total,
      files: assets.map(({ path, bytes }) => fileRow(path, bytes)),
    }),
  );
  if (receipt.length > maxManifestBytes) throw refusal("receipt size");
  return { assets, controls, receipt, receiptSha256: sha256(receipt) };
}
