#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        (file.endsWith(".cjs") ? "" : String.raw`import 'oth\x65r'; import 'ho\n o'; `) +
          "const unrelated = require('other');" +
          "\nconst load = () => import(`other/${name}`);\n" +
          "const other = () => import(`oth\\x65r/cors${name}`);\n" +
          'const computed = () => import(resolve("hono"));\n' +
          'const unrelatedCall = (other)("hono");\n' +
          'const unrelatedMember = loader.require("hono");\n' +
          'const text = "ast-grep-ignore: http-no-hono";\n' +
          'const extra = require("node:path", "hono");\n' +
          'const wrappedExtra = require("node:path", (("hono")));\n' +
          'const commentedExtra = require(/* first */ "node:path", /* second */ (/* nested */ "hono"));\n',
      );
    for (const extension of ["ts", "tsx"]) {
      appendFileSync(
        join(directory, `boundary.${extension}`),
        'const assertedOther = require("node:path" as "hono");\n' +
          'const satisfiedOther = require("node:path" satisfies "hono");\n' +
          'const wrappedLater = require("node:path", ("hono" satisfies string)!);\n',
      );
    }
    appendFileSync(
      join(directory, "boundary.ts"),
      'const typeOperand = require(<"hono">"node:path");\n' +
        'const assertionLater = require("node:path", <string>"hono");\n',
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
    const suppressed = join(hiddenDirectory, "suppressed.ts");
    for (const directive of ["// ast-grep-ignore: http-no-hono", "/* ast-grep-ignore */"]) {
      writeFileSync(suppressed, `${directive}\nimport "hono";\n`);
      const suppressionScan = scan("scan:http-boundary");
      const suppressionOutput = `${suppressionScan.stdout ?? ""}\n${suppressionScan.stderr ?? ""}`;
      if (
        suppressionScan.error ||
        suppressionScan.status === 0 ||
        !suppressionOutput.includes(`${suppressed}:`) ||
        !suppressionOutput.includes("ast-grep suppression is forbidden")
      ) {
        throw new Error(`HTTP boundary accepted a suppression: ${suppressionOutput}`);
      }
    }
    rmSync(suppressed);
    for (const file of files) writeFileSync(file, 'const cors = require("hono/cors");\n');
    writeFileSync(hidden, 'import "hono";\n');
    const extraCases = [
      "import type Hono = require('hono');",
      "import Cors = require('hono/cors');",
      String.raw`import type { Context } from 'h\x6fno';`,
      "const load = () => import(`hono`);",
      "const parenthesized = (require)('hono');",
      "const cors = require(`hono/cors`);",
      "const dollar = require(`hono/$literal`);",
      "const asserted = () => import('hono' as const);",
      "const nestedAssertion = require((('hono/cors' as const)));",
      "const commentedAssertion = require((/* inner */ 'hono' as const));",
      "const satisfied = () => import('hono' satisfies string);",
      "const nonNull = require(('hono/cors')!);",
      "const nestedWrappers = require((('hono' satisfies string)!) as string);",
    ];
    const escapedCases = [
      String.raw`import 'hono';`,
      "const dynamic = () => import(`hono/${name}`);",
      "const parenthesized = ((require))('hono');",
      "const commented = require /* call */ ('hono');",
      "const commentedImport = () => import /* call */ ('hono');",
      String.raw`export * from 'hono\x2fcors';`,
      String.raw`const load = () => import('h\x6fno');`,
      String.raw`const load = () => import(` + "`" + String.raw`h\x6fno\x2f${name}` + "`" + `);`,
      String.raw`const cors = require('hono\x2fcors');`,
      String.raw`const cors = require('\150\157\156\157\057cors');`,
      String.raw`const cors = require('hono\57cors');`,
      `const load = () => import((('hono')));`,
      `const cors = require((('hono/cors')));`,
      `const load = () => import(/* first */ 'hono');`,
      `const cors = require(/* first */ (/* nested */ 'hono/cors'));`,
      String.raw`import 'ho\u{6e}o';`,
      "import 'ho\\\nno';",
      String.raw`const load = () => import(` + "`" + String.raw`h\x6fno` + "`" + `);`,
    ];
    const extraFiles = ["ts", "tsx", "jsx", "cjs"].flatMap((extension) =>
      (extension === "jsx" || extension === "cjs" ? escapedCases : [...extraCases, ...escapedCases])
        .filter((source) => extension !== "cjs" || !/^(import|export) /.test(source))
        .map((source, index) => {
          const file = join(directory, `case-${index}.${extension}`);
          writeFileSync(file, `${source}\n`);
          return file;
        }),
    );
    const angleCases = [
      "const load = () => import(<string>'hono');",
      "const cors = require(<string>('hono/cors'!));",
    ].map((source, index) => {
      const file = join(directory, `angle-${index}.ts`);
      writeFileSync(file, `${source}\n`);
      return file;
    });
    const jsxFiles = ["tsx", "jsx"].flatMap((extension) =>
      ["export const node = <div />;", "export const node = <div>text</div>;"].map(
        (source, index) => {
          const file = join(directory, `jsx-${index}.${extension}`);
          writeFileSync(file, `${source}\n`);
          return file;
        },
      ),
    );
    const denied = scan("scan:http-boundary");
    const deniedOutput = `${denied.stdout ?? ""}\n${denied.stderr ?? ""}`;
    if (
      denied.error ||
      denied.status !== 1 ||
      deniedOutput.includes("could not inspect comments") ||
      !/error\[http-no-hono/.test(deniedOutput) ||
      [...files, ...extraFiles, ...angleCases, ...jsxFiles].some(
        (file) => !deniedOutput.includes(`${file}:`),
      )
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
