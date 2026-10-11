#!/usr/bin/env node
// Accept new visual baselines from a browser-smoke failure artifact:
//   node ci/visual-accept.mjs <unzipped e2e-failure artifact dir>
// Copies every `*-actual.png` under test-results-visual/ (a changed page) over
// the matching committed baseline, and every new baseline the run wrote under
// e2e/visual/__screenshots__/ (a page with no baseline yet), into
// e2e/visual/__screenshots__/. Review the diff images in
// the same artifact before committing; a baseline change is a reviewed change.
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node ci/visual-accept.mjs <artifact-dir>");
  process.exit(2);
}
const dest = "e2e/visual/__screenshots__";
mkdirSync(dest, { recursive: true });
let n = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry.endsWith("-actual.png")) {
      copyFileSync(p, join(dest, basename(p).replace(/-actual\.png$/, ".png")));
      n++;
    } else if (entry.endsWith(".png") && p.includes("__screenshots__")) {
      copyFileSync(p, join(dest, basename(p)));
      n++;
    }
  }
};
walk(root);
console.log(`accepted ${n} baseline(s) into ${dest}`);
process.exit(n ? 0 : 1);
