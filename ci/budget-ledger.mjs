// Kit ceiling ledger: the machine-readable half of the decision files.
//
// Every value in ci/budgets/kit/*.json must be declared by a decision file
// under ci/budgets/decisions/kit-perf/, on one line:
//
//   Ceiling: server.js.maxGzipBytes = 335616 (previous 335360)
//
// The key is the fragment path joined with dots; "(previous N)" names the
// ceiling this decision replaced. It is required, and must equal the earlier
// declaration, whenever a key is declared again; only a key's first
// declaration may omit it. Decision files are read in
// file-name order and the last declaration for a key is authoritative, so a
// ceiling change is exactly one fragment edit plus one new decision file and
// the shipping tests derive their cap, cap+1 and newly-allowed interval from
// the pair instead of carrying literal tables. Fail-closed: a malformed
// declaration, a previous ceiling not below its value or not the one it
// replaces, a fragment value no decision declares, or a declaration for a unit
// no fragment carries all throw.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DECISIONS_DIR = "ci/budgets/decisions/kit-perf";
const DECLARATION = /^Ceiling: (\S+) = (\d+)(?: \(previous (\d+)\))?$/;

// Flatten a Kit plan into dotted key -> number. "$" metadata is skipped.
export function flattenKitPlan(plan, prefix = "", out = new Map()) {
  for (const [key, value] of Object.entries(plan)) {
    if (key.startsWith("$")) continue;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "number") out.set(path, value);
    else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flattenKitPlan(value, path, out);
    } else {
      throw new Error(`kit budget ${path}: expected a number or object`);
    }
  }
  return out;
}

// key -> { value, previous (number | undefined), file }
// listNames is a seam for tests: readdir order is a filesystem detail, so the
// ordering rule below is proven by handing it names in the wrong order.
export function loadKitCeilingLedger(root, listNames = readdirSync) {
  const dir = join(root, DECISIONS_DIR);
  if (!existsSync(dir)) throw new Error(`${DECISIONS_DIR}/ is missing`);
  const ledger = new Map();
  const names = listNames(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  for (const name of names) {
    const seen = new Set();
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.startsWith("Ceiling:")) continue;
      const match = DECLARATION.exec(line);
      if (!match) throw new Error(`${DECISIONS_DIR}/${name}: malformed ceiling line: ${line}`);
      const [, key, rawValue, rawPrevious] = match;
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error(`${DECISIONS_DIR}/${name}: unsupported ceiling key ${key}`);
      }
      const value = Number(rawValue);
      const previous = rawPrevious === undefined ? undefined : Number(rawPrevious);
      if (previous !== undefined && previous >= value) {
        throw new Error(
          `${DECISIONS_DIR}/${name}: ${key} previous ${previous} must be below ${value}`,
        );
      }
      if (seen.has(key)) throw new Error(`${DECISIONS_DIR}/${name}: ${key} declared twice`);
      seen.add(key);
      // The chain is checked, not trusted: a declaration that replaces an
      // earlier one must name exactly the ceiling it replaces, or the derived
      // newly-allowed interval would be vacuous or silently absent.
      const replaced = ledger.get(key);
      if (replaced !== undefined && previous !== replaced.value) {
        throw new Error(
          `${DECISIONS_DIR}/${name}: ${key} must declare (previous ${replaced.value}), the ceiling ${replaced.file} set` +
            (previous === undefined ? "" : `, not (previous ${previous})`),
        );
      }
      ledger.set(key, { value, previous, file: name });
    }
  }
  return ledger;
}

// Throw unless the plan and the ledger describe exactly the same ceilings.
export function assertKitPlanMatchesLedger(plan, ledger) {
  const flat = flattenKitPlan(plan);
  for (const [key, value] of flat) {
    const decision = ledger.get(key);
    if (decision === undefined) {
      throw new Error(`kit ceiling ${key} = ${value} has no decision file declaring it`);
    }
    if (decision.value !== value) {
      throw new Error(
        `kit ceiling ${key} = ${value} but the latest decision (${decision.file}) declares ${decision.value}`,
      );
    }
  }
  for (const [key, decision] of ledger) {
    if (!flat.has(key)) {
      throw new Error(`decision ${decision.file} declares ${key} but no fragment carries it`);
    }
  }
}
