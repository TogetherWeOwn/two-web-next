// Copies the repo's public/ into the Kit Worker's asset directory after
// `vite build`. The files stay outside Kit's manifest on purpose: with
// run_worker_first (wrangler.jsonc) every static path reaches the Worker,
// falls through Kit's catch-all to the Hono app, and Hono serves it from
// ASSETS with its host guard and headers, exactly as the Hono Worker does.
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const src = join(web, "..", "public");
const dest = join(web, ".svelte-kit", "cloudflare");

if (!existsSync(dest)) throw new Error(`${dest} is missing: run vite build first`);
// Kit owns its own output; a public/ file with the same name is a bug, not an override.
const clashes = readdirSync(src).filter((name) => existsSync(join(dest, name)));
if (clashes.length > 0)
  throw new Error(`public/ entries clash with Kit output: ${clashes.join(", ")}`);
cpSync(src, dest, { recursive: true });
console.log(`copied ${readdirSync(src).length} public/ entries into ${dest}`);
