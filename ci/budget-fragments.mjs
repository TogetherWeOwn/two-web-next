// Budget fragments: the Kit and served-asset ceilings live one unit per
// file under ci/budgets/kit/ and ci/budgets/bundle/, and this loader
// aggregates them into the exact plan objects the checkers always consumed.
//
// Frozen fragments establish bases. Each reviewed admission adds its own
// decision file; effective byte ceilings are base + sum(delta_bytes), with no
// shared JSON edit. ci/check-budget-admissions.mjs enforces immutable history,
// aggregate per-PR caps and trusted rolling-window accounting.
//
// Semantics are fail-closed, matching the checkers' exit-2 contract:
// a missing/empty fragment dir with no legacy file, malformed JSON, a
// fragment of the wrong shape, or the same unit defined by two fragments
// all throw, and every caller already turns a throw into "cannot
// enforce" (exit 2). A legacy monolith next to a fragment dir is
// ambiguous authority and also throws.
//
// Legacy fallback: scratch fixtures in the checker selftests still write
// a single legacy file (ci/kit-perf-budget.json / ci/bundle-budget.json)
// into a scratch root with no ci/budgets/ dir; those keep loading exactly
// as before, which is what keeps the checker selftests a proof that
// failure behaviour is unchanged. The real tree has only fragments.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KIT_BUDGET_SECTIONS } from "./bundle-inventory.mjs";
import {
  applyAdmissions,
  budgetUnits,
  readAdmissions,
  retiredBudgetUnits,
} from "./budget-ledger.mjs";
import { DEPLOY_BASE, loadDeployBase } from "./kit-deploy-budget.mjs";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Aggregation assigns fragment keys into plain objects; magic keys would
// hit setters instead of creating own properties (and could pollute
// Object.prototype before plan validation runs), so reject them outright.
function assertSafeKey(relativeDir, name, key) {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    throw new Error(`${relativeDir}/${name}: unsupported budget key ${key}`);
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readFragment(root, relativeDir, name) {
  const text = readFileSync(join(root, relativeDir, name), "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${relativeDir}/${name}: ${error.message}`);
  }
}

function fragmentNames(root, relativeDir) {
  return readdirSync(join(root, relativeDir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

// Aggregate ci/budgets/kit/*.json into the Kit budget plan object, or load
// the legacy ci/kit-perf-budget.json when no fragment dir exists. Kit
// units are atomic: worker.<entry>, server.<group>, client.<group> and
// startup may each be defined by exactly one fragment. Top-level $
// metadata in a fragment is a per-fragment note and is not carried into
// the aggregate. Shape/ceiling validation stays with validateKitPlan in
// ci/bundle-inventory.mjs, applied by the checker to the aggregate.
function loadKitBase(root) {
  const relativeDir = "ci/budgets/kit";
  if (!isDirectory(join(root, relativeDir))) {
    return JSON.parse(readFileSync(join(root, "ci/kit-perf-budget.json"), "utf8"));
  }
  if (existsSync(join(root, "ci/kit-perf-budget.json"))) {
    throw new Error(
      "both ci/budgets/kit/ fragments and legacy ci/kit-perf-budget.json exist; " +
        "remove the legacy file (ambiguous budget authority)",
    );
  }
  const names = fragmentNames(root, relativeDir);
  if (names.length === 0) throw new Error(`no budget fragments in ${relativeDir}/`);
  const budget = {};
  const definedIn = new Map();
  const define = (unit, name, assign) => {
    if (definedIn.has(unit)) {
      throw new Error(
        `duplicate budget unit ${unit} in ${relativeDir}/${name} ` +
          `(already defined in ${relativeDir}/${definedIn.get(unit)})`,
      );
    }
    definedIn.set(unit, name);
    assign();
  };
  for (const name of names) {
    const fragment = readFragment(root, relativeDir, name);
    if (!isObject(fragment)) throw new Error(`${relativeDir}/${name}: fragment must be an object`);
    // One budget unit per fragment is the anti-conflict grain: an empty or
    // multi-unit fragment violates the fragment contract even when its
    // siblings are valid, so reject it here, not just in the repo test.
    let fragmentUnits = 0;
    for (const [section, value] of Object.entries(fragment)) {
      if (section.startsWith("$")) continue;
      assertSafeKey(relativeDir, name, section);
      // Reject unknown sections here, not after aggregation: an empty
      // unknown section contributes no unit, and an inherited name like
      // "toString" would not become an own property of the aggregate, so
      // either would vanish before validateKitPlan ever sees the plan.
      if (!KIT_BUDGET_SECTIONS.includes(section)) {
        throw new Error(`${relativeDir}/${name}: unsupported budget section: ${section}`);
      }
      if (section === "startup") {
        fragmentUnits += 1;
        define("startup", name, () => {
          budget.startup = value;
        });
        continue;
      }
      if (!isObject(value)) {
        throw new Error(`${relativeDir}/${name}: budget section ${section} must be an object`);
      }
      const units = Object.entries(value);
      if (units.length === 0) {
        throw new Error(
          `${relativeDir}/${name}: budget section ${section} must define a budget unit`,
        );
      }
      for (const [unitKey, unitValue] of units) {
        assertSafeKey(relativeDir, name, unitKey);
        fragmentUnits += 1;
        define(`${section}.${unitKey}`, name, () => {
          if (!Object.hasOwn(budget, section)) budget[section] = {};
          budget[section][unitKey] = unitValue;
        });
      }
    }
    if (fragmentUnits !== 1) {
      throw new Error(
        `${relativeDir}/${name}: fragment must define exactly one budget unit, got ${fragmentUnits}`,
      );
    }
  }
  return budget;
}

// Aggregate ci/budgets/bundle/*.json into the served-asset budgets map, or
// load the legacy ci/bundle-budget.json when no fragment dir exists. Each
// budgets.<entry> is atomic: two fragments defining the same entry throw
// instead of silently overriding a ceiling. Entry/ceiling validation
// stays with the checker (check-bundle-budget.mjs) and with
// ci/minify-assets.mjs failing closed on a read error.
function loadBundleBase(root) {
  const relativeDir = "ci/budgets/bundle";
  if (!isDirectory(join(root, relativeDir))) {
    return JSON.parse(readFileSync(join(root, "ci/bundle-budget.json"), "utf8")).budgets;
  }
  if (existsSync(join(root, "ci/bundle-budget.json"))) {
    throw new Error(
      "both ci/budgets/bundle/ fragments and legacy ci/bundle-budget.json exist; " +
        "remove the legacy file (ambiguous budget authority)",
    );
  }
  const names = fragmentNames(root, relativeDir);
  if (names.length === 0) throw new Error(`no budget fragments in ${relativeDir}/`);
  const budgets = {};
  const definedIn = new Map();
  for (const name of names) {
    const fragment = readFragment(root, relativeDir, name);
    if (!isObject(fragment)) throw new Error(`${relativeDir}/${name}: fragment must be an object`);
    for (const key of Object.keys(fragment)) {
      if (key !== "budgets" && !key.startsWith("$")) {
        throw new Error(`${relativeDir}/${name}: fragments may only define budgets, got ${key}`);
      }
    }
    if (!isObject(fragment.budgets)) {
      throw new Error(`${relativeDir}/${name}: fragment must define a budgets object`);
    }
    if (Object.keys(fragment.budgets).length !== 1) {
      throw new Error(
        `${relativeDir}/${name}: fragment must define exactly one budgets entry, ` +
          `got ${Object.keys(fragment.budgets).length}`,
      );
    }
    for (const [entry, ceiling] of Object.entries(fragment.budgets)) {
      assertSafeKey(relativeDir, name, entry);
      if (definedIn.has(entry)) {
        throw new Error(
          `duplicate budget entry ${entry} in ${relativeDir}/${name} ` +
            `(already defined in ${relativeDir}/${definedIn.get(entry)})`,
        );
      }
      definedIn.set(entry, name);
      budgets[entry] = ceiling;
    }
  }
  return budgets;
}

// Effective ceiling = immutable fragment + every additive decision.
export function loadKitBudget(root) {
  return applyAdmissions(root, "kit", loadKitBase(root));
}

export function loadBundleBudgets(root) {
  return applyAdmissions(root, "bundle", loadBundleBase(root));
}

export function loadBudgetBases(root) {
  return new Map([
    ...retiredBudgetUnits(readAdmissions(root)),
    ...[...budgetUnits("kit", loadKitBase(root))].map(([key, value]) => [key, value.value]),
    ...[...budgetUnits("bundle", loadBundleBase(root))].map(([key, value]) => [key, value.value]),
    ...(existsSync(join(root, DEPLOY_BASE))
      ? [...budgetUnits("deploy", loadDeployBase(root))].map(([key, value]) => [key, value.value])
      : []),
  ]);
}
