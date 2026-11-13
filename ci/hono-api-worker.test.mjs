import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installHonoApiDispatch, withHonoApiDispatch } from "../web/scripts/hono-api-worker.mjs";

const template = `export default { async fetch(req, env) {
  return env.kit(req);
} };`;
const asModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

test("pre-Kit API dispatch preserves the original Request and every method", async () => {
  const endpoint = asModule(`export function fallback({request}) { return request; }`);
  const { default: worker } = await import(asModule(withHonoApiDispatch(template, endpoint)));
  for (const path of [
    "/api",
    "/api/public/",
    "/api/public/events/?game=",
    "/api/public/unknown/__route.js",
    "/api/public/unknown/__data.json",
    "/api/public/unknown?x-sveltekit-foo=bar",
    "/api/public/join?x-sveltekit-foo=bar",
  ]) {
    for (const method of ["GET", "HEAD", "POST", "OPTIONS", "DELETE"]) {
      const request = new Request(`https://example.invalid${path}`, {
        method,
        headers: { origin: "https://foreign.invalid" },
        ...(method === "POST" ? { body: "unread" } : {}),
      });
      const result = await worker.fetch(request, {
        kit() {
          assert.fail("API requests must not enter Kit");
        },
      });
      assert.equal(result, request, `${method} ${path}: Request identity survives`);
      assert.equal(request.bodyUsed, false);
    }
  }
});

test("non-API requests retain the adapter's request, bindings and result", async () => {
  const endpoint = asModule(
    `export function fallback() { throw new Error("unexpected API dispatch"); }`,
  );
  const { default: worker } = await import(asModule(withHonoApiDispatch(template, endpoint)));
  for (const path of [
    "/apiculture",
    "/apiary/",
    "/about/",
    "/_app/immutable/a.js",
    "/unknown?x-sveltekit-foo=bar",
  ]) {
    const request = new Request(`https://example.invalid${path}`);
    const response = new Response("Kit control");
    const env = {
      kit(received) {
        assert.equal(received, request);
        assert.equal(this, env);
        return response;
      },
    };
    assert.equal(await worker.fetch(request, env), response);
  }
});

test("adapter handoff fails closed when the pinned template changes", () => {
  assert.throws(() => withHonoApiDispatch("export default {}", "./hono.js"), /fetch entry changed/);
  assert.throws(() => withHonoApiDispatch(template + template, "./hono.js"), /fetch entry changed/);
});

test("installer resolves the compiled catch-all from Vite's server manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "hono-api-worker-"));
  try {
    const server = join(root, "output/server");
    const cloudflare = join(root, "cloudflare");
    await mkdir(join(server, ".vite"), { recursive: true });
    await mkdir(cloudflare);
    const manifestPath = join(server, ".vite/manifest.json");
    const workerPath = join(cloudflare, "_worker.js");
    const builder = {
      getServerDirectory: () => server,
      getBuildDirectory(name) {
        assert.equal(name, "cloudflare");
        return cloudflare;
      },
    };
    await writeFile(workerPath, template);
    await writeFile(
      manifestPath,
      JSON.stringify({
        "src/routes/[...path]/+server.ts": { isEntry: true, file: "entries/endpoints/catchall.js" },
      }),
    );
    await installHonoApiDispatch(builder);
    assert.equal(
      await readFile(workerPath, "utf8"),
      withHonoApiDispatch(template, "./../output/server/entries/endpoints/catchall.js"),
    );
    await writeFile(manifestPath, "{}");
    await assert.rejects(installHonoApiDispatch(builder), /Hono catch-all missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
