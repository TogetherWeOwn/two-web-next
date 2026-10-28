import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { expect, it } from "vitest";

function property(object: Node | null | undefined, name: string): Node {
  assert.ok(object?.type === "ObjectExpression");
  const entry = object.properties.find(
    (node) =>
      node.type === "ObjectProperty" && node.key.type === "Identifier" && node.key.name === name,
  );
  assert.ok(entry?.type === "ObjectProperty", `missing configuration: ${name}`);
  return entry.value;
}

function productionOptions() {
  const ast = parse(readFileSync("web/vite.config.ts", "utf8"), {
    sourceType: "module",
    plugins: ["typescript"],
  });
  const exported = ast.program.body.find((node) => node.type === "ExportDefaultDeclaration");
  assert.ok(exported?.declaration.type === "CallExpression");
  const environments = property(exported.declaration.arguments[0], "environments");
  const build = property(property(environments, "ssr"), "build");
  const output = property(property(build, "rolldownOptions"), "output");
  assert.ok(output.type === "ObjectExpression");
  const linkerNames = output.properties.find(
    (node) =>
      node.type === "ObjectProperty" &&
      node.key.type === "Identifier" &&
      node.key.name === "keepNames",
  );
  const linkerValue = linkerNames?.type === "ObjectProperty" ? linkerNames.value : undefined;
  const minifyNode = property(output, "minify");
  const keepNames = property(property(minifyNode, "mangle"), "keepNames");
  assert.ok(keepNames.type === "BooleanLiteral" && keepNames.value);
  const compress = property(minifyNode, "compress");
  const codegen = property(minifyNode, "codegen");
  assert.ok(compress.type === "BooleanLiteral" && !compress.value);
  assert.ok(codegen.type === "BooleanLiteral" && codegen.value);
  return {
    keepNames: linkerValue?.type === "BooleanLiteral" && linkerValue.value,
    minify: {
      compress: compress.value,
      mangle: { keepNames: keepNames.value },
      codegen: codegen.value,
    },
  };
}

const webRequire = createRequire(new URL("../web/package.json", import.meta.url).href);
const { rolldown } = webRequire("rolldown");

it("the actual SSR minifier compacts bindings without changing diagnostic names or error identity", async () => {
  const bundle = await rolldown({
    input: resolve("src/admin/validation-shared.ts"),
    platform: "node",
  });
  try {
    const { output } = await bundle.generate({ format: "esm", ...productionOptions() });
    const code = output.find((entry: { type: string }) => entry.type === "chunk").code;
    const compiled = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    );
    expect(compiled.ValidationError.name).toBe("ValidationError");
    expect(compiled.fail.name).toBe("fail");
    expect(compiled.str.name).toBe("str");
    expect(compiled.str("  preserved  ")).toBe("preserved");
    const fields = { join_url: "Enter a public URL." };
    let caught: unknown;
    try {
      compiled.fail(fields);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(compiled.ValidationError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).constructor.name).toBe("ValidationError");
    expect((caught as Error).message).toBe("invalid input: join_url");
    expect((caught as { fields: unknown }).fields).toEqual(fields);
  } finally {
    await bundle.close();
  }
});

it("preserves original class and function names when modules collide during SSR linking", async () => {
  const modules: Record<string, string> = {
    "collision:entry": `export { CollisionError as LeftError, helper as leftHelper } from "collision:left";
export { CollisionError as RightError, helper as rightHelper } from "collision:right";`,
    "collision:left":
      "export class CollisionError extends Error {} export function helper() { return 'left'; }",
    "collision:right":
      "export class CollisionError extends Error {} export function helper() { return 'right'; }",
  };
  const bundle = await rolldown({
    input: "collision:entry",
    plugins: [
      {
        name: "diagnostic-name-collisions",
        resolveId(id: string) {
          return id in modules ? id : null;
        },
        load(id: string) {
          return modules[id] ?? null;
        },
      },
    ],
  });
  try {
    const { output } = await bundle.generate({ format: "esm", ...productionOptions() });
    const code = output.find((entry: { type: string }) => entry.type === "chunk").code;
    const compiled = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    );
    expect(new compiled.LeftError().constructor.name).toBe("CollisionError");
    expect(new compiled.RightError().constructor.name).toBe("CollisionError");
    expect(compiled.leftHelper.name).toBe("helper");
    expect(compiled.rightHelper.name).toBe("helper");
    expect(compiled.leftHelper()).toBe("left");
    expect(compiled.rightHelper()).toBe("right");
    expect(new compiled.LeftError()).not.toBeInstanceOf(compiled.RightError);
  } finally {
    await bundle.close();
  }
});
