#!/usr/bin/env node
// Do not let ast-grep directives silence checks in the HTTP core.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parse } from "@babel/parser";

const extensions = new Set([".ts", ".mts", ".cts", ".tsx", ".jsx", ".js", ".mjs", ".cjs"]);
let failed = false;

function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const extension = extname(path);
    if (entry.isDirectory()) {
      check(path);
    } else if (entry.isFile() && extensions.has(extension)) {
      try {
        const ast = parse(readFileSync(path, "utf8"), {
          sourceType: "unambiguous",
          plugins: [
            ...(/\.[mc]?tsx?$/.test(extension) ? ["typescript"] : []),
            ...(/\.[jt]sx$/.test(extension) ? ["jsx"] : []),
          ],
        });
        for (const comment of ast.comments ?? []) {
          if (/ast-grep-ignore/.test(comment.value)) {
            console.error(
              `${path}:${comment.loc.start.line}: ast-grep suppression is forbidden in the HTTP core`,
            );
            failed = true;
          }
        }
      } catch (error) {
        console.error(`${path}: could not inspect comments: ${error.message}`);
        failed = true;
      }
    }
  }
}

check("src/http");
if (failed) process.exitCode = 1;
