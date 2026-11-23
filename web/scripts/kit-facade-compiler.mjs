// Inactive compiler helper; the installer owns all filesystem changes.
// Design credit: Rick7C2, draft #2092, eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const sourcePath = (name) =>
  JSON.stringify(fileURLToPath(new URL(`../../src/${name}`, import.meta.url)));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// The companion name is fixed so the generated entry and adapter can be placed
// together without rewriting either output. Adapter source is parsed, not run.
export async function compileKitFacade(adapterSource) {
  // esbuild does not fully validate regular-expression grammar. Node's syntax
  // check parses the original module without evaluating it or loading imports.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", "--input-type=module"], {
      env: {},
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("kit facade compiler: invalid adapter JavaScript"));
    });
    child.stdin.end(adapterSource);
  });

  const parsed = await build({
    stdin: { contents: adapterSource, loader: "js", sourcefile: "adapter.js" },
    bundle: false,
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const [adapterInput] = Object.values(parsed.metafile.inputs);
  const [adapterOutput] = Object.values(parsed.metafile.outputs);
  // CommonJS entries can acquire a synthetic default during ESM conversion.
  if (adapterInput.format !== "esm" || !adapterOutput.exports.includes("default")) {
    throw new Error("kit facade compiler: adapter must export default");
  }

  const result = await build({
    stdin: {
      contents: `import adapter from "./kit-adapter.js";
import { createKitWorkerFacade } from ${sourcePath("kit-worker-facade.ts")};
import { handleLiveRequest } from ${sourcePath("live/socket-route.ts")};
export { LiveGuildHub } from ${sourcePath("live/guild-hub.ts")};
export default createKitWorkerFacade(adapter, undefined, handleLiveRequest);
`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "js",
      sourcefile: "kit-facade-entry.js",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd"],
    alias: Object.fromEntries(builtinModules.map((name) => [name, `node:${name}`])),
    external: ["./kit-adapter.js", "cloudflare:sockets", "node:*"],
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles[0].text;
  return { output, adapterSha256: sha256(adapterSource), facadeSha256: sha256(output) };
}
