import { env, waitUntil } from "cloudflare:workers";
import app from "../../../../src/index";
import { RECOVERY_RENDER, type RecoveryRender } from "../../../../src/recovery-outcome";

// The strangler seam: every request Kit does not route itself (all of /api/*,
// every unported page, static files from public/) goes to the unchanged Hono
// app with the Worker's real bindings. Kit 3 has no `platform`, so the
// execution context is rebuilt from cloudflare:workers; Hono only uses
// waitUntil (e.g. /up closing its database clients).
const ctx: ExecutionContext = {
  waitUntil,
  passThroughOnException() {},
  props: {},
} as ExecutionContext;

export function honoFetch(request: Request): Promise<Response> {
  return Promise.resolve(app.fetch(request, env, ctx));
}

export function honoRecoveryFetch(request: Request, render: RecoveryRender): Promise<Response> {
  const recoveryContext = { ...ctx, [RECOVERY_RENDER]: render };
  return Promise.resolve(app.fetch(request, env, recoveryContext));
}
