// Intercept API requests before Kit interprets their URLs. Reuse the compiled
// catch-all so the same Hono app, bindings and guards handle the request.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/** @param {string} worker @param {string} endpointImport */
export function withHonoApiDispatch(worker, endpointImport) {
  const fetchEntry = /async fetch\(req, env\) \{/g;
  if ([...worker.matchAll(fetchEntry)].length !== 1) {
    throw new Error("Cloudflare adapter fetch entry changed; review the pre-Kit API handoff");
  }
  return (
    `import { fallback as honoApi } from ${JSON.stringify(endpointImport)};\n` +
    worker.replace(
      fetchEntry,
      `async fetch(req, env) {
      const apiPath = new URL(req.url).pathname;
      if (apiPath === "/api" || apiPath.startsWith("/api/")) {
        return honoApi({ request: req });
      }`,
    )
  );
}

/** @param {import("@sveltejs/kit").Builder} builder */
export async function installHonoApiDispatch(builder) {
  const server = builder.getServerDirectory();
  const manifest = JSON.parse(await readFile(join(server, ".vite/manifest.json"), "utf8"));
  const endpoint = manifest["src/routes/[...path]/+server.ts"];
  if (!endpoint?.isEntry || typeof endpoint.file !== "string") {
    throw new Error("Compiled Hono catch-all missing from the server manifest");
  }
  const workerPath = join(builder.getBuildDirectory("cloudflare"), "_worker.js");
  const endpointImport = `./${relative(dirname(workerPath), join(server, endpoint.file)).split(sep).join("/")}`;
  const worker = await readFile(workerPath, "utf8");
  await writeFile(workerPath, withHonoApiDispatch(worker, endpointImport));
}
