import { Hono } from "hono";
import type { Env } from "../env";
import { internalErrorHandler } from "../errors";
import { type Actor, adminGuard } from "./guard";
import { adminFormPath, isKitAdminRsvpForm } from "./kit-serving";
import type { QueuePreviewVars } from "./queue-preview";
import { buildAdminApp } from "./routes";

const formAdmission = Symbol("kitAdminFormAdmission");
type FormBindings = Env & {
  [formAdmission]: { actor: Actor | null; requestId: string };
};

function createFormApp() {
  const forms = new Hono<QueuePreviewVars>();
  const admitRsvpForm = adminGuard();
  forms.onError(internalErrorHandler);
  forms.route(
    "/admin",
    buildAdminApp(async (c, next) => {
      const { actor, requestId } = (c.env as FormBindings)[formAdmission];
      c.set("requestId", requestId);
      if (actor === null) return admitRsvpForm(c, next);
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
  actor: Actor | null,
  requestId: string,
) {
  const path = adminFormPath(new URL(request.url).pathname);
  if (request.method !== "POST" || !path || (actor === null) !== isKitAdminRsvpForm(path)) {
    return new Response(null, { status: 404 });
  }
  // These private bindings carry either the dispatcher's admitted actor or
  // a request for the same moderator guard Hono uses on the RSVP actions.
  const bindings: FormBindings = { ...env, [formAdmission]: { actor, requestId } };
  return (formApp ??= createFormApp()).fetch(request, bindings);
}
