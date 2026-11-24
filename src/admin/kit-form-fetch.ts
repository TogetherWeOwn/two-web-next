import { Hono } from "hono";
import type { Env } from "../env";
import { internalErrorHandler } from "../errors";
import type { Actor } from "./guard";
import { adminFormPath } from "./kit-serving";
import type { QueuePreviewVars } from "./queue-preview";
import { buildAdminApp } from "./routes";

const formAdmission = Symbol("kitAdminFormAdmission");
type FormBindings = Env & {
  [formAdmission]: { actor: Actor; requestId: string };
};

function createFormApp() {
  const forms = new Hono<QueuePreviewVars>();
  forms.onError(internalErrorHandler);
  forms.route(
    "/admin",
    buildAdminApp(async (c, next) => {
      const { actor, requestId } = (c.env as FormBindings)[formAdmission];
      c.set("requestId", requestId);
      c.set("adminActor", actor);
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
  if (request.method !== "POST" || !adminFormPath(new URL(request.url).pathname)) {
    return new Response(null, { status: 404 });
  }
  // The router is private to this function. Only the calling dispatcher can
  // attach its admitted actor and request ID to these per-request bindings.
  const bindings: FormBindings = { ...env, [formAdmission]: { actor, requestId } };
  return (formApp ??= createFormApp()).fetch(request, bindings);
}
