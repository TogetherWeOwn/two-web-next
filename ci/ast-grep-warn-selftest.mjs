#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixture = join("src", `ast-grep-warning-selftest-${process.pid}.test.ts`);
try {
  writeFileSync(fixture, "expect(true).toBe(true);\n");
  const result = spawnSync("npx", ["-y", "--package", "@ast-grep/cli@0.50.0", "ast-grep", "scan"], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) {
    throw new Error(output || result.error?.message || "ast-grep scan exited non-zero");
  }
  if (!output.includes("ts-vacuous-literal-expect")) {
    throw new Error("ast-grep did not report the planted warning rule");
  }
  console.log("ast-grep WARN selftest: planted warning reported with exit 0");

  const directory = mkdtempSync(join("src", "http", "ast-grep-boundary-selftest-"));
  let outsideDirectory;
  try {
    outsideDirectory = mkdtempSync(join("src", "ast-grep-boundary-outside-"));
    const outside = join(outsideDirectory, "boundary.ts");
    writeFileSync(outside, 'import "hono";\n');
    const extensions = ["ts", "mts", "cts", "tsx", "jsx", "js", "mjs", "cjs"];
    const hiddenDirectory = join(directory, ".generated", "nested");
    mkdirSync(hiddenDirectory, { recursive: true });
    const hidden = join(hiddenDirectory, "headers.ts");
    const files = [
      ...extensions.map((extension) => join(directory, `boundary.${extension}`)),
      hidden,
    ];
    for (const file of files)
      writeFileSync(
        file,
        String.raw`import 'oth\x65r'; import 'ho\n o'; const unrelated = require('other');` +
          "\nconst load = () => import(`hono/${name}`);\n" +
          "const other = () => import(`h\\x6fno/cors${name}`);\n" +
          'const computed = () => import(resolve("hono"));\n',
      );
    const scan = (script) => spawnSync("npm", ["run", script], { encoding: "utf8" });
    const allowed = scan("scan:fetch-await");
    const allowedOutput = `${allowed.stdout ?? ""}\n${allowed.stderr ?? ""}`;
    if (
      allowed.error ||
      allowed.status !== 0 ||
      /(?:error|warning)\[http-no-hono/.test(allowedOutput)
    ) {
      throw new Error(
        `allowed imports or outside path failed: ${allowedOutput || allowed.error?.message}`,
      );
    }
    for (const file of files) writeFileSync(file, 'const cors = require("hono/cors");\n');
    writeFileSync(hidden, 'import "hono";\n');
    const extraCases = [
      "import type Hono = require('hono');",
      "import Cors = require('hono/cors');",
      String.raw`import type { Context } from 'h\x6fno';`,
      "const load = () => import(`hono`);",
      "const cors = require(`hono/cors`);",
      "const dollar = require(`hono/$literal`);",
    ];
    const escapedCases = [
      String.raw`import 'hono';`,
      String.raw`export * from 'hono\x2fcors';`,
      String.raw`const load = () => import('h\x6fno');`,
      String.raw`const cors = require('hono\x2fcors');`,
      String.raw`const cors = require('\150\157\156\157\057cors');`,
      String.raw`const cors = require('hono\57cors');`,
      `const load = () => import((('hono')));`,
      `const cors = require((('hono/cors')));`,
      String.raw`import 'ho\u{6e}o';`,
      "import 'ho\\\nno';",
      String.raw`const load = () => import(` + "`" + String.raw`h\x6fno` + "`" + `);`,
    ];
    const extraFiles = ["ts", "tsx", "jsx", "cjs"].flatMap((extension) =>
      (extension === "jsx" || extension === "cjs"
        ? escapedCases
        : [...extraCases, ...escapedCases]
      ).map((source, index) => {
        const file = join(directory, `case-${index}.${extension}`);
        writeFileSync(file, `${source}\n`);
        return file;
      }),
    );
    const denied = scan("scan:http-boundary");
    const deniedOutput = `${denied.stdout ?? ""}\n${denied.stderr ?? ""}`;
    if (
      denied.error ||
      denied.status !== 1 ||
      [...files, ...extraFiles].some((file) => !deniedOutput.includes(`${file}:`))
    ) {
      throw new Error(
        `HTTP boundary scan did not reject every file: ${deniedOutput || denied.error?.message}`,
      );
    }
    if (deniedOutput.includes(outside))
      throw new Error("HTTP boundary scan rejected a file outside src/http");
    console.log(
      "ast-grep HTTP boundary selftest: allowed and outside imports pass; all HTTP file types fail",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (outsideDirectory) rmSync(outsideDirectory, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`ast-grep WARN selftest failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(fixture, { force: true });
}
