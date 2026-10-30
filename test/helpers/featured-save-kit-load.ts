import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { getFeatured } from "../../src/admin/store";

// Bundle the real Kit server load. Only Worker bindings and framework errors
// are replaced; the admitted getter is the real SQL read on our owned schema.
export async function compileFeaturedSaveLoad(env: Env) {
  const entry = fileURLToPath(
    new URL("../../web/src/routes/admin/featured/[id]/+page.server.ts", import.meta.url).href,
  );
  const deps = `let db, get; export function setDeps(d,g){db=d;get=g;}
    export async function dbFor(){return db;}
    export async function getFeatured(...args){return get(...args);}`;
  const { outputFiles } = await build({
    stdin: {
      contents: `import {load} from ${JSON.stringify(entry)};
        import {setDeps} from 'acceptance-deps';
        export async function run(db,get,event){setDeps(db,get);return load(event);}`,
      resolveDir: fileURLToPath(new URL("../..", import.meta.url).href),
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    tsconfigRaw: { compilerOptions: {} },
    plugins: [
      {
        name: "featured-save-kit-load",
        setup(plugin) {
          plugin.onResolve(
            {
              filter:
                /^(acceptance-deps|@sveltejs\/kit|cloudflare:workers)$|src\/admin\/(db|store-featured)$/,
            },
            ({ path }) => ({
              path:
                path === "@sveltejs/kit" ? "kit" : path === "cloudflare:workers" ? "env" : "deps",
              namespace: "featured-save-load",
            }),
          );
          plugin.onLoad({ filter: /.*/, namespace: "featured-save-load" }, ({ path }) => ({
            contents:
              path === "kit"
                ? "export function error(status,message){throw Object.assign(new Error(message),{status});}"
                : path === "env"
                  ? `export const env=${JSON.stringify(env)};`
                  : deps,
            loader: "js",
          }));
        },
      },
    ],
  });
  const { run } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`
  );
  return (db: Db, id: number, setHeaders: (headers: Record<string, string>) => void) =>
    run(db, getFeatured, {
      parent: async () => ({}),
      params: { id: String(id) },
      setHeaders,
    });
}
