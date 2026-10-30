import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const webRequire = createRequire(path.resolve("web/package.json"));
const { build } = webRequire("vite");
const { svelte } = webRequire("@sveltejs/vite-plugin-svelte");

// csr=false prevents hydration, but Kit still builds a structural client node.
// Compile and tree-shake the real leaves with Vite's client environment: moving
// the server-only guard below the form must put its unused markup back here.
describe("featured editor client artifacts", () => {
  for (const route of ["new", "[id]"]) {
    it(`${route} leaves editorial forms and reuse controls on the server`, async () => {
      const filename = path.resolve(`web/src/routes/admin/featured/${route}/+page.svelte`);
      const result = await build({
        configFile: false,
        root: path.resolve("web"),
        logLevel: "silent",
        mode: "production",
        plugins: [svelte({ configFile: false, compilerOptions: { dev: false } })],
        build: {
          write: false,
          minify: true,
          lib: { entry: filename, formats: ["es"], fileName: "featured-editor" },
          rolldownOptions: { external: [/^#lib\//] },
        },
      });
      const artifact = (Array.isArray(result) ? result : [result])
        .flatMap((bundle: { output: { type: string; code: string }[] }) => bundle.output)
        .filter((file: { type: string }) => file.type === "chunk")
        .map((file: { code: string }) => file.code)
        .join("\n");
      expect(artifact).toMatch(/export[\s\S]*default/);
      expect(artifact).not.toContain("Headline");
      expect(artifact).not.toContain("Reuse as new slot");
      expect(artifact).not.toContain("Could not reuse that saved slot");
      expect(artifact).not.toContain("/islands/admin-event-editor.js");
    });
  }
});
