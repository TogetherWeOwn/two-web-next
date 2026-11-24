// Copies the repo's public/ into the Kit Worker's asset directory after
// `vite build`. The files stay outside Kit's manifest on purpose: with
// run_worker_first (wrangler.jsonc) every static path reaches the Worker,
// falls through Kit's catch-all to the Hono app, and Hono serves it from
// ASSETS with its host guard and headers, exactly as the Hono Worker does.
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const src = join(web, "..", "public");
const build = join(web, ".svelte-kit");
const dest = join(build, "cloudflare");
const client = join(dest, "client");
const worker = join(dest, "worker");
const entry = readFileSync(join(worker, "index.js"), "utf8");
const serverImport = "import { server } from './server.js';";
assert.ok(entry.startsWith(`${serverImport}\n`), "unexpected Cloudflare adapter entry");
assert.ok(lstatSync(join(worker, "server.js")).isFile(), "missing Cloudflare adapter server");

const deployPath = join(web, ".wrangler/deploy/config.json");
const deploy = JSON.parse(readFileSync(deployPath, "utf8"));
assert.equal(deploy.configPath, "../../.svelte-kit/cloudflare/worker/wrangler.json");
const config = JSON.parse(readFileSync(join(worker, "wrangler.json"), "utf8"));
assert.equal(config.main, "index.js");
assert.equal(config.assets.directory, "../client");
assert.equal(config.assets.binding, "ASSETS");
assert.equal(config.assets.run_worker_first, true);
const ignored = readFileSync(join(client, ".assetsignore"), "utf8").split(/\r?\n/);
assert.ok(ignored.includes("_worker.js"), "asset inventory must exclude the Worker entry");

const files = readdirSync(src);
const clashes = files.filter((name) => name === "_worker.js" || existsSync(join(client, name)));
if (clashes.length > 0)
  throw new Error(`public/ entries clash with Kit output: ${clashes.join(", ")}`);

// Preserve the staging entry, budget inputs and cutover packet layout. Keep the
// native Worker intact for Wrangler's generated preview config, outside assets.
const runtime = join(build, "cloudflare-tmp");
const scratch = mkdtempSync(join(build, "cloudflare-layout-"));
try {
  writeFileSync(
    join(client, "_worker.js"),
    entry.replace(serverImport, "import { server } from '../cloudflare-tmp/worker/server.js';"),
    { flag: "wx" },
  );
  for (const name of files) {
    cpSync(join(src, name), join(client, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  if (lstatSync(runtime, { throwIfNoEntry: false })) {
    renameSync(runtime, join(scratch, "previous"));
  }
  renameSync(client, join(scratch, "assets"));
  renameSync(dest, runtime);
  renameSync(join(scratch, "assets"), dest);
  config.assets.directory = "../../cloudflare";
  writeFileSync(join(runtime, "worker/wrangler.json"), JSON.stringify(config));
  deploy.configPath = "../../.svelte-kit/cloudflare-tmp/worker/wrangler.json";
  const redirect = join(scratch, "config.json");
  writeFileSync(redirect, JSON.stringify(deploy), { flag: "wx" });
  renameSync(redirect, deployPath);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`copied ${files.length} public/ entries into ${dest}`);
