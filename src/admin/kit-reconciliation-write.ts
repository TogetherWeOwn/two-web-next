import { Context } from "hono";
import { alertRequestError } from "../alerts";
import { requestBodyLimit } from "../body-limit";
import type { Env } from "../env";
import { throttleGuard, WRITE_THROTTLE_PER_MINUTE } from "../throttle";
import { decideKitAdminGuard, type KitAdminGuardLocals } from "./kit-guard";
import { reconciliationResolutionForm } from "./reconciliation-input";
import { reconciliationServiceFor } from "./reconciliation-service";

const cap = requestBodyLimit("action");

export async function writeKitReconciliation(
  request: Request,
  key: string,
  locals: KitAdminGuardLocals & { requestId?: string },
  env: Env,
): Promise<{ status: number; retryAfter?: string }> {
  // The ownership hook checks origin and bridges the session before resolve.
  // A Kit action runs before layout loads, so it must guard itself.
  const admission = decideKitAdminGuard(locals, "/admin");
  if (admission.kind !== "pass") {
    return {
      status: admission.kind === "guest" ? 401 : admission.kind === "forbidden" ? 403 : 503,
    };
  }

  // Adapt the shared Hono body cap and throttle without registering a Hono route.
  const context = new Context<{ Bindings: Env }>(request, { env });
  const refused = await cap(context, () => Promise.resolve());
  if (refused) return { status: refused.status };
  const limited = await throttleGuard(context, "admin-write", WRITE_THROTTLE_PER_MINUTE);
  if (limited) {
    return { status: limited.status, retryAfter: limited.headers.get("retry-after") ?? undefined };
  }

  let form: FormData;
  try {
    form = await context.req.raw.formData();
  } catch {
    return { status: 400 };
  }
  const input = reconciliationResolutionForm(key, form);
  if (!input) return { status: 400 };

  try {
    const service = await reconciliationServiceFor(env, admission.actor.id);
    if (!service) return { status: 503 };
    const outcome = await service.resolve(input.key, input.resolution);
    return { status: outcome === "resolved" ? 303 : outcome === "unchanged" ? 409 : 400 };
  } catch (error) {
    alertRequestError(error, {
      method: "POST",
      route: "/admin/reconciliation/:key",
      requestId: locals.requestId,
    });
    return { status: 503 };
  }
}
