import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { readKitReconciliation } from "../../../../../../src/admin/kit-reconciliation";
import { reconciliationServiceFor } from "../../../../../../src/admin/reconciliation-service";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent, params, locals, setHeaders }) => {
  const { actor } = await parent();
  setHeaders({ "cache-control": "private, no-store" });
  const data = await readKitReconciliation(
    async () => {
      const service = await reconciliationServiceFor(env, actor.id);
      return service && { row: await service.get(params.key) };
    },
    "/admin/reconciliation/:key",
    locals.requestId,
  );
  if (!data) error(503, "Admin temporarily unavailable");
  if (!data.row) error(404, "Reconciliation record not found");
  return { row: data.row };
};
