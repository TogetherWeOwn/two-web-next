import { Hono } from "hono";
import type { Env } from "../env";
import { internalErrorHandler } from "../errors";
import type { Actor } from "./guard";
import { adminFormPath } from "./kit-serving";
import type { QueuePreviewVars } from "./queue-preview";
import { buildAdminApp } from "./routes";

const formAdmission = Symbol("kitAdminFormAdmission");
type FormBindings = Env & {
  [formAdmission]?: { actor: Actor; requestId: string };
};

function createFormApp() {
  const forms = new Hono<QueuePreviewVars>();
  forms.onError(internalErrorHandler);
  // Run the shared controller only for an admitted form POST. Bindings are
  // request-local and no client header can supply the capability or actor.
  forms.use("*", async (c, next) => {
    const admission = (c.env as FormBindings)[formAdmission];
    if (c.req.method !== "POST" || !admission || !adminFormPath(new URL(c.req.url).pathname)) {
      return c.notFound();
    }
    c.set("requestId", admission.requestId);
    await next();
  });
  forms.route(
    "/admin",
    buildAdminApp(async (c, next) => {
      const admission = (c.env as FormBindings)[formAdmission];
      if (!admission) return c.notFound();
      c.set("adminActor", admission.actor);
      await next();
    }),
  );
  return forms;
}

let formApp: ReturnType<typeof createFormApp> | undefined;

export async function fetchKitAdminForm(
  request: Request,
  env: Env,
  actor: Actor,
  requestId: string,
) {
  const bindings: FormBindings = { ...env, [formAdmission]: { actor, requestId } };
  return (formApp ??= createFormApp()).fetch(request, bindings);
}
