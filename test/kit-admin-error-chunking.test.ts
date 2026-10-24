import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { describe, expect, it } from "vitest";

// Parse the real configuration without loading Kit's build-time Vite plugin
// into the root test runner. Actual emitted bytes remain the kit-perf gate.
function property(object: Node | null | undefined, name: string): Node {
  assert.ok(object?.type === "ObjectExpression");
  const entry = object.properties.find(
    (node) =>
      node.type === "ObjectProperty" && node.key.type === "Identifier" && node.key.name === name,
  );
  assert.ok(entry?.type === "ObjectProperty", `missing configuration: ${name}`);
  return entry.value;
}

function serverOutput() {
  const source = parse(readFileSync("web/vite.config.ts", "utf8"), {
    sourceType: "module",
    plugins: ["typescript"],
  });
  const exported = source.program.body.find((node) => node.type === "ExportDefaultDeclaration");
  assert.ok(exported?.declaration.type === "CallExpression");
  const config = exported.declaration.arguments[0];
  const environments = property(config, "environments");
  const build = property(property(environments, "ssr"), "build");
  const output = property(property(build, "rolldownOptions"), "output");
  const groups = property(property(output, "codeSplitting"), "groups");
  assert.ok(groups.type === "ArrayExpression");
  return { environments, output, groups: groups.elements };
}

function groupPattern(name: string): RegExp {
  const group = serverOutput().groups.find((node) => {
    const groupName = property(node, "name");
    return groupName.type === "StringLiteral" && groupName.value === name;
  });
  assert.ok(group, `missing server group: ${name}`);
  const pattern = property(group, "test");
  assert.ok(pattern.type === "RegExpLiteral");
  return new RegExp(pattern.pattern, pattern.flags);
}

function booleanProperty(object: Node, name: string): boolean {
  const value = property(object, name);
  assert.ok(value.type === "BooleanLiteral");
  return value.value;
}

describe("native admin error server chunking", () => {
  it("co-compresses both boundaries with their pure shell and retry helper", () => {
    const pattern = groupPattern("admin-errors");
    for (const module of [
      "lib/AdminShell.svelte",
      "lib/admin-read-retry.ts",
      "routes/admin/+error.svelte",
      "routes/admin/join-attempts/+error.svelte",
    ]) {
      expect(pattern.test(`/checkout/web/src/${module}`), module).toBe(true);
    }
  });

  it("does not capture loaders, actions, public errors or unrelated pages", () => {
    const pattern = groupPattern("admin-errors");
    for (const module of [
      "lib/ErrorShell.svelte",
      "lib/AdminShell.svelte.backup",
      "lib/server/admin-read-retry.ts",
      "routes/+error.svelte",
      "routes/admin/+page.svelte",
      "routes/admin/+page.server.ts",
      "routes/admin/events/+error.svelte",
      "routes/admin/join-attempts/[id]/+page.server.ts",
      "routes/profile/+page.svelte",
    ]) {
      expect(pattern.test(`/checkout/web/src/${module}`), module).toBe(false);
    }
    expect(groupPattern("site-shell").test("/checkout/web/src/lib/ErrorShell.svelte")).toBe(true);
    expect(groupPattern("admin").test("/checkout/src/admin/reads.ts")).toBe(true);
  });

  it("keeps grouping on SSR and preserves conservative minification", () => {
    const { environments, output } = serverOutput();
    assert.ok(environments.type === "ObjectExpression");
    expect(
      environments.properties.map((node) =>
        node.type === "ObjectProperty" && node.key.type === "Identifier" ? node.key.name : null,
      ),
    ).toEqual(["ssr"]);
    const minify = property(output, "minify");
    expect(["compress", "mangle", "codegen"].map((name) => booleanProperty(minify, name))).toEqual([
      false,
      false,
      true,
    ]);
    const comments = property(output, "comments");
    expect(["annotation", "jsdoc", "legal"].map((name) => booleanProperty(comments, name))).toEqual(
      [false, false, true],
    );
  });
});
