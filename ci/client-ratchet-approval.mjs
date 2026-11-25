// Replay the complete measured client plan. Route-only decisions advance the
// same chain as aggregate decisions; neither can fork or reset the other.
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CLIENT_FILES, parseDecision, replayDecision } from "./kit-client-ratchet.mjs";
import { ROUTE_BUDGET, validateRouteBudget } from "./kit-route-budget.mjs";

export const INITIAL_CLIENT_BUDGET = {
  js: { maxRawBytes: 261632, maxGzipBytes: 104448, maxFiles: 55 },
  // CSS raw 3584: ci/budgets/decisions/kit-perf/2026-11-11-admin-validation-css-raw.md
  css: { maxRawBytes: 3584, maxGzipBytes: 1280, maxFiles: 4 },
};
export const INITIAL_ROUTE_DECISION =
  "ci/budgets/decisions/kit-perf/2026-11-04-route-client-closure-and-ratchet.md";
export const RECONCILIATION_ROUTE_DECISION = "2026-11-23-reconciliation-routes.json";
export const ATTENDANCE_ROUTE_DECISION = "2026-11-24-attendance-route.json";
const plan = (files) => ({
  client: {
    js: files[CLIENT_FILES[0]].client.js,
    css: files[CLIENT_FILES[1]].client.css,
  },
  routeBudget: validateRouteBudget(files[ROUTE_BUDGET]),
});

function readDecision(root, path) {
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    assert.ok(!lstatSync(current).isSymbolicLink(), "symlink decision evidence");
  }
  const stat = lstatSync(current);
  assert.ok(
    stat.isFile() && stat.size <= 2 * 1024 * 1024,
    "invalid or oversized decision evidence",
  );
  return readFileSync(current, "utf8");
}

export function initialRouteBudget(root) {
  const text = readDecision(root, INITIAL_ROUTE_DECISION);
  const matches = [...text.matchAll(/## Initial approved route plan\n\n```json\n([\s\S]*?)\n```/g)];
  assert.equal(matches.length, 1, "missing or ambiguous initial approved route plan");
  return validateRouteBudget(JSON.parse(matches[0][1]));
}

export function approvedClientPlan(root) {
  const dir = "ci/budgets/decisions/kit-perf";
  const decisions = readdirSync(join(root, dir));
  const pending = decisions
    .filter((name) => /^auto-client-ratchet-[a-f0-9]{12}\.md$/.test(name))
    .sort()
    .map((name) => {
      const text = readDecision(root, `${dir}/${name}`);
      const evidence = parseDecision(text);
      const { base } = evidence;
      const result = replayDecision(evidence);
      return { name, before: plan(base), after: plan(result.files) };
    });
  let approved = {
    client: structuredClone(INITIAL_CLIENT_BUDGET),
    routeBudget: initialRouteBudget(root),
  };
  const admissions = [RECONCILIATION_ROUTE_DECISION, ATTENDANCE_ROUTE_DECISION].filter((name) =>
    decisions.includes(name),
  );
  while (pending.length || admissions.length) {
    const index = pending.findIndex((record) => isDeepStrictEqual(record.before, approved));
    if (index >= 0) {
      const [record] = pending.splice(index, 1);
      approved = record.after;
      continue;
    }
    const name = admissions.shift();
    assert.ok(name, "measured client decisions do not extend the approved ceiling chain");
    // Replay prior lowerings first. The reviewed admission only adds rows, then
    // later lowerings must match the expanded plan in full.
    const admission = validateRouteBudget(JSON.parse(readDecision(root, `${dir}/${name}`)));
    for (const [id, route] of Object.entries(admission.routes)) {
      assert.ok(!Object.hasOwn(approved.routeBudget.routes, id), "route already approved");
      for (const kind of ["js", "css"])
        for (const [metric, limit] of Object.entries(route[kind]))
          assert.ok(limit <= approved.client[kind][metric], "route ceiling exceeds aggregate");
      approved.routeBudget.routes[id] = route;
    }
  }
  return approved;
}

export const approvedClientBudget = (root) => approvedClientPlan(root).client;
export const approvedRouteBudget = (root) => approvedClientPlan(root).routeBudget;
