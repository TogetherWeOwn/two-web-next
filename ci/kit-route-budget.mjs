// Shared data-only route policy. Neither decision replay nor the authenticated
// writer imports the build/measurement entry point.
import assert from "node:assert/strict";

export const ROUTE_BUDGET = "ci/budgets/kit-routes.json";
export const ROUTE_SCOPE = "kit-immutable-route-closure-v1";
export const targetBytes = (measured, step) => Math.ceil((measured * 1.25) / step) * step;
const METRICS = ["maxRawBytes", "maxGzipBytes", "maxFiles"];
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function keys(value, expected) {
  assert.ok(object(value), "expected object");
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), "inventory mismatch");
}

export function validateRouteBudget(budget) {
  keys(budget, ["version", "scope", "routes"]);
  assert.equal(budget.version, 1, "unsupported budget version");
  assert.equal(budget.scope, ROUTE_SCOPE, "unsupported scope");
  assert.ok(object(budget.routes) && Object.keys(budget.routes).length > 0, "empty routes");
  for (const [id, route] of Object.entries(budget.routes)) {
    assert.ok(id.startsWith("/") && !/[\u0000-\u001f]/.test(id), "invalid route id");
    keys(route, ["js", "css"]);
    for (const kind of ["js", "css"]) {
      keys(route[kind], METRICS);
      for (const metric of METRICS) {
        assert.ok(
          Number.isSafeInteger(route[kind][metric]) && route[kind][metric] >= 0,
          "invalid ceiling",
        );
      }
    }
  }
  return budget;
}
