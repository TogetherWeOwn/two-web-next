import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { transform } from "esbuild";
import { describe, expect, it } from "vitest";
import { requireCaptureArtifact } from "../ci/kit-capture-build.mjs";

function property(object: Node | null | undefined, name: string): Node {
  assert.ok(object?.type === "ObjectExpression");
  const entry = object.properties.find(
    (node) =>
      node.type === "ObjectProperty" && node.key.type === "Identifier" && node.key.name === name,
  );
  assert.ok(entry?.type === "ObjectProperty", `missing configuration: ${name}`);
  return entry.value;
}

// Evaluate only the real SSR transform expression, not Kit/Vite plugins.
function captureTransform(flag: string | undefined): { define?: Record<string, string> } {
  const text = readFileSync("web/vite.config.ts", "utf8");
  const source = parse(text, { sourceType: "module", plugins: ["typescript"] });
  const exported = source.program.body.find((node) => node.type === "ExportDefaultDeclaration");
  assert.ok(exported?.declaration.type === "CallExpression");
  const environments = property(exported.declaration.arguments[0], "environments");
  const build = property(property(environments, "ssr"), "build");
  const expression = property(property(build, "rolldownOptions"), "transform");
  assert.ok(typeof expression.start === "number" && typeof expression.end === "number");
  return runInNewContext(`(${text.slice(expression.start, expression.end)})`, {
    process: { env: { SSR_CAPTURE_FIXTURE: flag } },
  });
}

const guard = 'typeof __TWO_LOCAL_CAPTURE__ !== "undefined" && __TWO_LOCAL_CAPTURE__ === true';

describe("capture build isolation", () => {
  for (const flag of [undefined, "false", "TRUE", "true"]) {
    it(`removes capture code unless the Kit build explicitly opts in (${flag})`, async () => {
      const requireWeb = createRequire(new URL("../web/package.json", import.meta.url).href);
      const { rolldown } = requireWeb("rolldown");
      const options = captureTransform(flag);
      expect(options.define?.__TWO_LOCAL_CAPTURE__).toBe(flag === "true" ? undefined : "false");
      const bundle = await rolldown({
        input: "capture-test-entry",
        platform: "node",
        transform: options,
        plugins: [
          {
            name: "capture-test-entry",
            resolveId(id: string) {
              if (id === "capture-test-entry") return "\0capture-test-entry";
            },
            load(id: string) {
              if (id !== "\0capture-test-entry") return;
              return `import { renderDate, captureRefusal, captureResponse } from ${JSON.stringify(resolve("src/render-clock.ts"))};
export const stamp = (request, env) => ${guard} ? renderDate(request, env).toISOString() : "live";
export const respond = async (request, env, resolve) => {
  if (${guard}) {
    const refusal = captureRefusal(request, env);
    if (refusal) return refusal;
    return captureResponse(request, env, await resolve());
  }
  return resolve();
};`;
            },
          },
        ],
      });
      try {
        const { output } = await bundle.generate({
          format: "esm",
          minify: { compress: false, mangle: false, codegen: true },
        });
        const code = output.find((entry: { type: string }) => entry.type === "chunk").code;
        const scratch = mkdtempSync(join(tmpdir(), "capture-build-"));
        try {
          const worker = join(scratch, "worker.js");
          writeFileSync(worker, code);
          if (flag === "true") {
            expect(() => requireCaptureArtifact(worker)).not.toThrow();
          } else {
            expect(code).not.toContain("2098-12-31T20:00:00Z");
            expect(code).not.toContain("x-two-ssr-clock");
            expect(code).not.toContain("fixtureRequest");
            expect(code).not.toContain("__TWO_LOCAL_CAPTURE__");
            expect(() => requireCaptureArtifact(worker)).toThrow(
              "rebuild with SSR_CAPTURE_FIXTURE=true npm run build --prefix web",
            );
          }
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
        // Model the generated Wrangler define AFTER Vite/Rolldown tree-shaking.
        const late = await transform(code, {
          format: "esm",
          define: { __TWO_LOCAL_CAPTURE__: "true" },
        });
        const compiled = await import(
          `data:text/javascript;base64,${Buffer.from(late.code).toString("base64")}`
        );
        const env = { APP_URL: "http://127.0.0.1:8788", SSR_CAPTURE_FIXTURE: "true" };
        const local = new Request(env.APP_URL + "/faq");
        const remote = new Request("https://example.test/faq", {
          headers: { host: "127.0.0.1:8788", origin: env.APP_URL },
        });
        expect(compiled.stamp(local, env)).toBe(
          flag === "true" ? "2098-12-31T20:00:00.000Z" : "live",
        );
        expect(compiled.stamp(remote, env)).not.toBe("2098-12-31T20:00:00.000Z");
        const response = await compiled.respond(
          local,
          env,
          async () => new Response("fixture", { headers: { "content-type": "text/html" } }),
        );
        expect(response.headers.get("x-two-ssr-clock")).toBe(
          flag === "true" ? "2098-12-31T20:00:00Z" : null,
        );
      } finally {
        await bundle.close();
      }
    });
  }

  it("recognizes capture chunks behind the adapter wrapper and refuses ordinary server output", () => {
    const scratch = mkdtempSync(join(tmpdir(), "capture-adapter-"));
    try {
      const server = join(scratch, "output/server");
      mkdirSync(join(scratch, "cloudflare"), { recursive: true });
      mkdirSync(join(scratch, "cloudflare-tmp"));
      mkdirSync(join(server, "chunks"), { recursive: true });
      writeFileSync(
        join(scratch, "cloudflare/_worker.js"),
        "import { server } from '../cloudflare-tmp/server.js';",
      );
      writeFileSync(
        join(scratch, "cloudflare-tmp/server.js"),
        "export { server } from '../output/server/index.js';",
      );
      writeFileSync(join(server, "index.js"), "export { server } from './chunks/events.js';");
      const chunk = join(server, "chunks/events.js");
      const capture =
        'export const server = typeof __TWO_LOCAL_CAPTURE__ === "boolean" ? "2098-12-31T20:00:00Z" : null;';
      writeFileSync(chunk, capture);
      expect(() => requireCaptureArtifact(server)).not.toThrow();
      writeFileSync(chunk, 'export const server = "live";');
      writeFileSync(join(server, "chunks/events.js.map"), capture);
      expect(() => requireCaptureArtifact(server)).toThrow(
        "rebuild with SSR_CAPTURE_FIXTURE=true npm run build --prefix web",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps literal compile-time guards at every capture importing boundary", () => {
    for (const path of [
      "src/index.tsx",
      "src/events/routes-calendar.tsx",
      "src/events/routes-detail.tsx",
      "src/kit-past-events.ts",
      "web/src/hooks.server.ts",
      "web/src/routes/e/[key]/+page.server.ts",
      "web/src/routes/events/past/+page.server.ts",
    ]) {
      const source = readFileSync(path, "utf8").replace(/\s+/g, " ");
      expect(source, path).toContain(guard);
    }
    const launcher = readFileSync("ci/kit-worker-dev.mjs", "utf8");
    expect(launcher).toContain('if (process.env.SSR_CAPTURE_FIXTURE === "true") {');
    const artifactCheck = 'requireCaptureArtifact(join(web, ".svelte-kit/output/server"))';
    expect(launcher).toContain(artifactCheck);
    expect(launcher.indexOf(artifactCheck)).toBeLessThan(launcher.indexOf("const scratch ="));
  });
});
