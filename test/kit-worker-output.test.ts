import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps the adapter Worker private and publishes the reviewed asset and entry paths", () => {
  const root = mkdtempSync(join(tmpdir(), "two-web-kit-layout-"));
  try {
    const web = join(root, "web");
    const output = join(web, ".svelte-kit/cloudflare");
    const previous = join(web, ".svelte-kit/cloudflare-tmp");
    const script = join(web, "scripts/copy-public.mjs");
    const deploy = join(web, ".wrangler/deploy/config.json");
    const stockEntry = "import { server } from './server.js';\nexport default { fetch: server };\n";
    const stockConfig = {
      main: "index.js",
      no_bundle: true,
      assets: { directory: "../client", binding: "ASSETS", run_worker_first: true },
    };
    for (const dir of ["client", "worker"]) mkdirSync(join(output, dir), { recursive: true });
    mkdirSync(previous);
    writeFileSync(join(previous, "stale.js"), "previous build\n");
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(dirname(deploy), { recursive: true });
    mkdirSync(join(root, "public"));
    copyFileSync("web/scripts/copy-public.mjs", script);
    writeFileSync(
      deploy,
      JSON.stringify({ configPath: "../../.svelte-kit/cloudflare/worker/wrangler.json" }),
    );
    writeFileSync(join(output, "worker/wrangler.json"), JSON.stringify(stockConfig));
    writeFileSync(join(output, "worker/index.js"), stockEntry);
    writeFileSync(
      join(output, "worker/server.js"),
      "export const server = () => new Response();\n",
    );
    writeFileSync(join(output, "worker/.dev.vars"), "FIXTURE=value\n");
    writeFileSync(join(output, "client/.assetsignore"), "_worker.js\n_headers\n");
    writeFileSync(join(output, "client/_headers"), "/_app/*\n  X-Robots-Tag: noindex\n");
    writeFileSync(join(root, "public/fixture.txt"), "public fixture\n");

    execFileSync(process.execPath, [script], { cwd: web });

    const preview = resolve(dirname(deploy), JSON.parse(readFileSync(deploy, "utf8")).configPath);
    const previewConfig = JSON.parse(readFileSync(preview, "utf8"));
    expect(previewConfig).toEqual({
      ...stockConfig,
      assets: { ...stockConfig.assets, directory: "../../cloudflare" },
    });
    expect(resolve(dirname(preview), previewConfig.assets.directory)).toBe(output);
    expect(readFileSync(join(dirname(preview), previewConfig.main), "utf8")).toBe(stockEntry);
    expect(readdirSync(previous)).toEqual(["worker"]);
    expect(readdirSync(output).sort()).toEqual([
      ".assetsignore",
      "_headers",
      "_worker.js",
      "fixture.txt",
    ]);
    expect(readFileSync(join(output, "_worker.js"), "utf8")).toBe(
      stockEntry.replace("./server.js", "../cloudflare-tmp/worker/server.js"),
    );
    expect(readFileSync(join(output, ".assetsignore"), "utf8")).toBe("_worker.js\n_headers\n");
    expect(readFileSync(join(output, "_headers"), "utf8")).toBe(
      "/_app/*\n  X-Robots-Tag: noindex\n",
    );
    expect(readFileSync(join(output, "fixture.txt"), "utf8")).toBe("public fixture\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
