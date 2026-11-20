import { createHash } from "node:crypto";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { compileKitFacade } from "../web/scripts/kit-facade-compiler.mjs";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("inactive Kit facade compiler", () => {
  it.each([
    "export default {",
    "const broken = ; export default broken",
    "const broken = /(/; export default {}",
    "const broken = /[z-a]/; export default {}",
    "const broken = /a/gg; export default {}",
    "const text = 'export default {}'; export const value = text",
    "// export default {}\nexport const value = 1",
    "export const defaultValue = {}",
    "const worker = {}; export { worker as notDefault }",
    'module.exports = { fetch() { return new Response("ok"); } }',
    'exports.default = { fetch() { return new Response("ok"); } }',
    "exports.default = {}; export const other = 1",
  ])("rejects malformed JavaScript or a disguised default: %s", async (source) => {
    await expect(compileKitFacade(source)).rejects.toThrow();
  });

  it("accepts valid regex syntax without executing adapter code", async () => {
    const source =
      'throw new Error("must not run"); const pattern = /[a-z]+/gi; export default { pattern };';
    const result = await compileKitFacade(source);
    expect(result.adapterSha256).toBe(digest(source));
  });

  it("preserves an external companion and hashes the exact source and output", async () => {
    const source =
      'const worker = { fetch() { return new Response("ok"); } }; export { worker as default };';
    const first = await compileKitFacade(source);
    const second = await compileKitFacade(source);
    expect(first).toEqual(second);
    expect(first.adapterSha256).toBe(digest(source));
    expect(first.facadeSha256).toBe(digest(first.output));
    expect(first.output).toContain('from "./kit-adapter.js"');
    expect(first.output).not.toContain('return new Response("ok")');
  });

  it("wraps the real adapter without executing it during compilation", async () => {
    const source = `export default {
      name: "adapter",
      fetch(request, env) { return new Response(this.name + ":" + request.method); },
      scheduled() { return this.name; }
    };`;
    const { output } = await compileKitFacade(source);
    const bundled = await build({
      stdin: { contents: output, loader: "js", resolveDir: process.cwd() },
      bundle: true,
      format: "esm",
      write: false,
      plugins: [
        {
          name: "adapter-fixture",
          setup(plugin) {
            plugin.onResolve({ filter: /^\.\/kit-adapter\.js$/ }, () => ({
              path: "adapter",
              namespace: "fixture",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: source,
              loader: "js",
            }));
          },
        },
      ],
    });
    const url = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString("base64")}`;
    const worker = (await import(/* @vite-ignore */ url)).default;
    const response = await worker.fetch(new Request("https://togetherweown.com/"), {
      APP_URL: "https://togetherweown.com",
    });
    expect(await response.text()).toBe("adapter:GET");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(worker.scheduled()).toBe("adapter");
  });
});
