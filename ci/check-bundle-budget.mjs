// No build: these are the exact files Workers serves. Match the legacy checker:
// 0 = fits, 1 = asset breach/broken asset, 2 = cannot enforce the budget.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Nested island helpers are budgeted too: an island may import a shared
// `./vendor/*.js`, and Workers serves dot files/directories under public/ too.
// Theme stylesheets are served from the public/ top level (`/theme.css` on
// every themed page plus per-theme files); they are authored in place, not
// built from assets/, but they still need ceilings. Parent traversal can never
// be a valid budget key; the regex alone accepts `..`.
const assetPattern = /^public\/(?:islands\/(?:[^/]+\/)*[^/]+\.js|[^/]+\.css)$/;

function isBudgetKey(entry) {
  return typeof entry === "string" && assetPattern.test(entry) && !entry.split("/").includes("..");
}

// Every .js file served from public/islands, at any depth, plus every
// top-level public/*.css: a nested import or an unbudgeted stylesheet without
// an explicit ceiling fails closed instead of escaping enforcement.
function discoverServed(root) {
  const islands = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory()) walk(join(dir, name.name), `${prefix}${name.name}/`);
      else if (name.isFile() && name.name.endsWith(".js")) islands.push(`${prefix}${name.name}`);
    }
  };
  walk(join(root, "public/islands"), "public/islands/");
  islands.sort();
  const styles = [];
  for (const name of readdirSync(join(root, "public"), { withFileTypes: true })) {
    if (name.isFile() && name.name.endsWith(".css")) styles.push(`public/${name.name}`);
  }
  styles.sort();
  return [...styles, ...islands];
}

export function run(root, output = console) {
  let budgets;
  try {
    budgets = JSON.parse(readFileSync(join(root, "ci/bundle-budget.json"), "utf8")).budgets;
    if (
      !budgets ||
      typeof budgets !== "object" ||
      Array.isArray(budgets) ||
      !Object.keys(budgets).length
    ) {
      throw new Error("budgets must be a nonempty object");
    }
    for (const [entry, ceiling] of Object.entries(budgets)) {
      if (
        !isBudgetKey(entry) ||
        !ceiling ||
        !Number.isSafeInteger(ceiling.maxRawBytes) ||
        ceiling.maxRawBytes <= 0 ||
        !Number.isSafeInteger(ceiling.maxGzipBytes) ||
        ceiling.maxGzipBytes <= 0
      ) {
        throw new Error(`invalid entry or raw/gzip ceilings: ${entry}`);
      }
    }
    for (const entry of discoverServed(root)) {
      if (!Object.hasOwn(budgets, entry)) throw new Error(`no budget for ${entry}`);
    }
  } catch (error) {
    output.error(`bundle budget: cannot enforce: ${error.message}`);
    return 2;
  }

  let breaches = 0;
  for (const [entry, ceiling] of Object.entries(budgets)) {
    let bytes;
    try {
      bytes = readFileSync(join(root, entry));
    } catch (error) {
      output.error(`bundle budget: ${entry}: missing/unreadable asset: ${error.message}`);
      breaches += 1;
      continue;
    }
    const raw = bytes.length;
    // Default zlib level, identical to the legacy checker, not best-case gzip.
    const gzip = gzipSync(bytes).length;
    const exceeded = [];
    if (raw > ceiling.maxRawBytes) exceeded.push(`raw ${raw}B over ${ceiling.maxRawBytes}B`);
    if (gzip > ceiling.maxGzipBytes) exceeded.push(`gzip ${gzip}B over ${ceiling.maxGzipBytes}B`);
    if (exceeded.length) {
      output.error(`bundle budget: ${entry}: ${exceeded.join(", ")}`);
      breaches += 1;
    } else {
      output.log(
        `ok ${entry}: raw ${raw}/${ceiling.maxRawBytes}B, gzip ${gzip}/${ceiling.maxGzipBytes}B`,
      );
    }
  }
  if (breaches) return 1;
  output.log("bundle budget: every asset fits.");
  return 0;
}

function selftest() {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "bundle-budget-"),
  );
  try {
    mkdirSync(join(root, "ci"));
    mkdirSync(join(root, "public/islands"), { recursive: true });
    const entries = ["public/islands/example.js", "public/styles.css"];
    const payload = Buffer.from(
      Array.from({ length: 128 }, (_, i) => `/* asset-${i} */\n`).join(""),
    );
    const exact = { maxRawBytes: payload.length, maxGzipBytes: gzipSync(payload).length };
    let cases = 0;
    const check = (name, mutate, expected, message) => {
      const budget = { budgets: Object.fromEntries(entries.map((entry) => [entry, { ...exact }])) };
      for (const entry of entries) writeFileSync(join(root, entry), payload);
      writeFileSync(join(root, "ci/bundle-budget.json"), JSON.stringify(budget));
      mutate(budget);
      const errors = [];
      const code = run(root, {
        log() {},
        error(text) {
          errors.push(text);
        },
      });
      assert.equal(code, expected, `${name}: ${errors.join("; ")}`);
      if (message)
        assert.ok(
          errors.some((text) => text.includes(message)),
          `${name}: missing diagnostic`,
        );
      cases += 1;
      console.log(`PASS ${name}`);
    };
    const save = (budget) =>
      writeFileSync(join(root, "ci/bundle-budget.json"), JSON.stringify(budget));
    check("exact raw and gzip ceilings fit", () => {}, 0);
    for (const entry of entries) {
      for (const [metric, field] of [
        ["raw", "maxRawBytes"],
        ["gzip", "maxGzipBytes"],
      ]) {
        check(
          `${metric}-only breach names ${entry}`,
          (budget) => {
            budget.budgets[entry][field] -= 1;
            save(budget);
          },
          1,
          `${entry}: ${metric}`,
        );
      }
      check(`missing asset names ${entry}`, () => rmSync(join(root, entry)), 1, entry);
    }
    check("missing budget", () => rmSync(join(root, "ci/bundle-budget.json")), 2, "cannot enforce");
    check("malformed JSON", () => writeFileSync(join(root, "ci/bundle-budget.json"), "{"), 2);
    for (const invalid of [
      {},
      { budgets: {} },
      { budgets: [] },
      { budgets: { "../escape.js": exact } },
      { budgets: { "public/styles.css": { maxRawBytes: 1 } } },
      { budgets: { "public/styles.css": { maxRawBytes: -1, maxGzipBytes: "100" } } },
    ]) {
      check("invalid budget fails closed", () => save(invalid), 2);
    }
    check(
      "new island cannot escape enforcement",
      () => {
        writeFileSync(join(root, "public/islands/new.js"), "export {};");
      },
      2,
      "no budget for public/islands/new.js",
    );
    rmSync(join(root, "public/islands/new.js"));
    // Review repro: an imported but unbudgeted nested helper must fail
    // closed, not report 0 while Workers serves the extra bytes.
    check(
      "nested island import cannot escape enforcement",
      () => {
        writeFileSync(
          join(root, "public/islands/example.js"),
          'import "./vendor/framework.js";\nexport const ok = 1;\n',
        );
        mkdirSync(join(root, "public/islands/vendor"), { recursive: true });
        writeFileSync(
          join(root, "public/islands/vendor/framework.js"),
          `/* ${"x".repeat(100000)} */\n`,
        );
      },
      2,
      "no budget for public/islands/vendor/framework.js",
    );
    rmSync(join(root, "public/islands/vendor"), { recursive: true });
    // A budgeted nested helper fits when its ceiling covers it.
    check(
      "budgeted nested helper fits",
      (budget) => {
        mkdirSync(join(root, "public/islands/vendor"), { recursive: true });
        const helper = "export const shared = 1;\n";
        writeFileSync(join(root, "public/islands/vendor/shared.js"), helper);
        const nested = `public/islands/vendor/shared.js`;
        budget.budgets[nested] = {
          maxRawBytes: Buffer.byteLength(helper),
          maxGzipBytes: gzipSync(Buffer.from(helper)).length,
        };
        save(budget);
      },
      0,
    );
    rmSync(join(root, "public/islands/vendor"), { recursive: true, force: true });
    for (const path of [".hidden.js", ".vendor/framework.js", "vendor/.helper.js"]) {
      const entry = `public/islands/${path}`;
      const helper = Buffer.from(`/* ${"x".repeat(100000)} */\n`);
      const helperCeiling = { maxRawBytes: helper.length, maxGzipBytes: gzipSync(helper).length };
      const addHelper = () => {
        mkdirSync(dirname(join(root, entry)), { recursive: true });
        writeFileSync(join(root, entry), helper);
        writeFileSync(join(root, "public/islands/example.js"), `import "./${path}";\n`);
      };
      check(`dot path ${path} cannot escape enforcement`, addHelper, 2, `no budget for ${entry}`);
      check(
        `budgeted dot path ${path} fits`,
        (budget) => {
          addHelper();
          budget.budgets[entry] = { ...helperCeiling };
          save(budget);
        },
        0,
      );
      for (const [metric, field] of [
        ["raw", "maxRawBytes"],
        ["gzip", "maxGzipBytes"],
      ]) {
        check(
          `dot path ${path} ${metric} breach`,
          (budget) => {
            addHelper();
            budget.budgets[entry] = { ...helperCeiling, [field]: helperCeiling[field] - 1 };
            save(budget);
          },
          1,
          `${entry}: ${metric}`,
        );
      }
      rmSync(join(root, "public/islands", path.split("/")[0]), { recursive: true, force: true });
    }
    check(
      "stylesheet cannot escape enforcement",
      (budget) => {
        delete budget.budgets["public/styles.css"];
        save(budget);
      },
      2,
      "no budget for public/styles.css",
    );
    check(
      "unbudgeted top-level CSS cannot escape enforcement",
      () => {
        writeFileSync(join(root, "public/theme.css"), payload);
      },
      2,
      "no budget for public/theme.css",
    );
    rmSync(join(root, "public/theme.css"), { force: true });
    check(
      "over-ceiling theme CSS fails",
      (budget) => {
        writeFileSync(join(root, "public/theme.css"), payload);
        budget.budgets["public/theme.css"] = {
          maxRawBytes: exact.maxRawBytes - 1,
          maxGzipBytes: exact.maxGzipBytes,
        };
        save(budget);
      },
      1,
      "public/theme.css: raw",
    );
    rmSync(join(root, "public/theme.css"), { force: true });
    check(
      "parent traversal CSS is rejected",
      (budget) => {
        budget.budgets["public/../x.css"] = { ...exact };
        save(budget);
      },
      2,
    );
    console.log(`bundle budget selftest: ${cases} cases passed.`);
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--selftest")) {
    console.error("Usage: node ci/check-bundle-budget.mjs [--selftest]");
    process.exitCode = 2;
  } else {
    process.exitCode = process.argv[2] === "--selftest" ? selftest() : run(repoRoot);
  }
}
