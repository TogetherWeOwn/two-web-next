import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyAdmissions } from "./budget-ledger.mjs";

export const DEPLOY_BASE = "ci/budgets/deploy/worker.json";
export function loadDeployBase(root) {
  const plan = JSON.parse(readFileSync(join(root, DEPLOY_BASE), "utf8"));
  const measured = plan?.measuredMain;
  const raw = measured?.rawBytesUpperBound;
  if (
    !Number.isSafeInteger(raw) ||
    raw <= 0 ||
    !/^[a-f0-9]{40}$/.test(measured?.sha) ||
    !/^https:\/\/github\.com\/TogetherWeOwn\/two-web-next\/actions\/runs\/\d+\/job\/\d+$/.test(
      measured?.evidence,
    ) ||
    !Number.isSafeInteger(plan?.worker?.maxRawBytes) ||
    BigInt(plan.worker.maxRawBytes) !== (BigInt(raw) * 102n + 99n) / 100n
  ) {
    throw new Error("invalid final-artifact base: expected measured main raw upper bound plus 2%");
  }
  return { worker: { maxRawBytes: plan.worker.maxRawBytes } };
}
export function loadDeployBudget(root) {
  return applyAdmissions(root, "deploy", loadDeployBase(root));
}
