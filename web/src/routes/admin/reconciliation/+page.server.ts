import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { readKitReconciliation } from "../../../../../src/admin/kit-reconciliation";
import { reconciliationServiceFor } from "../../../../../src/admin/reconciliation-service";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent, locals, setHeaders }) => {
  // Kit starts parent and page loads concurrently. Admit the moderator first.
  const { actor } = await parent();
  setHeaders({ "cache-control": "private, no-store" });
  const data = await readKitReconciliation(
    async () => {
      const service = await reconciliationServiceFor(env, actor.id);
      return service && { open: await service.listOpen(), resolved: await service.listResolved() };
    },
    "/admin/reconciliation",
    locals.requestId,
  );
  if (!data) error(503, "Admin temporarily unavailable");
  return data;
};
