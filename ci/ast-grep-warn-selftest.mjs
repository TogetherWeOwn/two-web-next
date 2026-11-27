#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanByteLengthComparisons } from "./raw-byte-length-ratchet.mjs";

function checkByteLengthRuleCoverage() {
  const directory = mkdtempSync(join(tmpdir(), "ast-grep-byte-length-"));
  try {
    for (const path of ["ci", "public", "src/http", "web/src", "web/scripts"]) {
      mkdirSync(join(directory, path), { recursive: true });
    }
    const comparison = "left.byteLength > right.byteLength";
    const unsafe = `if (${comparison}) reject();\n`;
    const nodePath = "ci/unsafe.mjs";
    const jsPath = "web/scripts/unsafe.js";
    const sveltePath = "web/src/unsafe.svelte";
    const cleanPath = "ci/clean.mjs";
    writeFileSync(join(directory, nodePath), unsafe);
    writeFileSync(join(directory, cleanPath), "exceedsByteLimit(left.byteLength, max);\n");
    const git = (...args) => execFileSync("git", args, { cwd: directory });
    const commit = (message, ...args) =>
      git("-c", "core.hooksPath=/dev/null", "commit", "-qm", message, "--no-gpg-sign", ...args);
    git("init", "--quiet");
    git("add", "--", nodePath, cleanPath);
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.org");
    commit("Fixture");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(directory, ".gitignore"), `${nodePath}\n`);
    writeFileSync(join(directory, nodePath), `${unsafe}// ast-grep-ignore\n${unsafe}`);
    writeFileSync(join(directory, jsPath), unsafe);
    renameSync(join(directory, cleanPath), join(directory, "ci/renamed.mjs"));
    writeFileSync(join(directory, "ci/placeholder.mjs"), "");
    writeFileSync(join(directory, "public/generated.js"), unsafe);
    writeFileSync(
      join(directory, sveltePath),
      `<script module>// ast-grep-ignore
      ${unsafe}</script>\n<script lang="ts">
        function authReturnHref() {
          const fits = (href: string) => new TextEncoder().encode(href).byteLength <= maxBytes;
          return fits(url);
        }
      </script>`,
    );
    writeFileSync(
      join(directory, "web/src/clean.svelte"),
      `<script>let total = left.byteLength;</script>\n<p>left.byteLength &gt; max</p>\n`,
    );
    writeFileSync(
      join(directory, "web/src/fallback.svelte"),
      `<script lang="legacy">${unsafe}</script>\n`,
    );

    for (const file of ["src/probe.tsx", "src/probe.jsx"]) {
      writeFileSync(
        join(directory, file),
        "// ast-grep-ignore\nconst view = <div>{left.byteLength > max}</div>;\n",
      );
    }
    const root = fileURLToPath(new URL("..", import.meta.url));
    for (const path of [
      "package.json",
      "sgconfig.yml",
      "sg-rules",
      "ci/raw-byte-length-ratchet.mjs",
      "ci/http-boundary-suppressions.mjs",
    ]) {
      cpSync(join(root, path), join(directory, path), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
    const event = join(directory, "event.json");
    writeFileSync(event, "{}");
    const lint = (ref, actions = "") =>
      spawnSync("npm", ["run", "scan:fetch-await"], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_ACTIONS: actions, GITHUB_REF: ref },
      });
    const expected = [
      `${nodePath}:3`,
      "src/probe.jsx:2",
      "src/probe.tsx:2",
      `${jsPath}:1`,
      "web/src/fallback.svelte:1",
      `${sveltePath}:2`,
      `${sveltePath}:6`,
    ];
    git("add", "--", nodePath);
    commit("Plant comparison");
    const planted = git("rev-parse", "HEAD").toString().trim();
    commit("Feature tip", "--allow-empty");
    for (const ref of ["refs/heads/feature", "refs/heads/main"]) {
      if (ref === "refs/heads/main") {
        git("update-ref", "HEAD", planted);
        git("update-ref", "refs/remotes/origin/main", planted);
      }
      const result = lint(ref);
      assert.equal(result.status, 1, result.error?.message ?? result.stderr);
      assert.deepEqual(
        result.stderr.match(/^.+:\d+(?=: Use the shared byte-limit helpers for )/gm),
        expected,
      );
    }
    const hosted = lint("refs/heads/main", "true");
    assert.equal(hosted.status, 1, hosted.error?.message ?? hosted.stderr);
    assert.match(hosted.stderr, /The CI checkout has missing tracked files/);
    writeFileSync(join(directory, "ci/non-utf8.mjs"), Buffer.from([0xff]));
    assert.throws(() => scanByteLengthComparisons(directory), /ci\/non-utf8\.mjs: invalid UTF-8/);
    writeFileSync(
      join(directory, "ci/non-utf8.mjs"),
      "// too large for ast-grep\n".repeat(200_001),
    );
    assert.throws(() => scanByteLengthComparisons(directory), /Incomplete ast-grep scan/);
    const badName = Buffer.concat([
      Buffer.from(`${directory}/ci/`),
      Buffer.of(0xff),
      Buffer.from(".mjs"),
    ]);
    writeFileSync(badName, unsafe);
    assert.throws(() => scanByteLengthComparisons(directory), /Git returned non-UTF-8 paths/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  console.log("ast-grep byte-length selftest passed");
}

const fixture = join("src", `ast-grep-warning-selftest-${process.pid}.test.ts`);
try {
  writeFileSync(fixture, "expect(true).toBe(true);\n");
  const args = ["-y", "--package", "@ast-grep/cli@0.50.0", "ast-grep", "scan"];
  const result = spawnSync("npx", [...args, "--filter", "^ts-vacuous-literal-expect$"], {
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
  checkByteLengthRuleCoverage();

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
      "const load = () => import(`h\\x6fno\\x2f${name}`);",
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
