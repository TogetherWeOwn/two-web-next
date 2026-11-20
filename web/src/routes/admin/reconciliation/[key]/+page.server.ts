import { error, redirect } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { readKitReconciliation } from "../../../../../../src/admin/kit-reconciliation";
import { writeKitReconciliation } from "../../../../../../src/admin/kit-reconciliation-write";
import { reconciliationServiceFor } from "../../../../../../src/admin/reconciliation-service";
import type { Actions, PageServerLoad } from "./$types";

export const actions: Actions = {
  default: async ({ request, params, locals, setHeaders }) => {
    const { status, retryAfter } = await writeKitReconciliation(
      request,
      params.key,
      { status: locals.status, session: locals.session, requestId: locals.requestId },
      env,
    );
    setHeaders({ "cache-control": "private, no-store" });
    if (retryAfter) setHeaders({ "retry-after": retryAfter });
    if (status === 401) redirect(303, "/auth/recover?next=%2Fadmin");
    if (status === 303) redirect(303, `/admin/reconciliation/${encodeURIComponent(params.key)}`);
    error(status);
  },
};

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
