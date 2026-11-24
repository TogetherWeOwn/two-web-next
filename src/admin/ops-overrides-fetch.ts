import { Context } from "hono";
import { requestBodyLimit } from "../body-limit";
import type { Env } from "../env";
import { opsOverridesHandler, opsOverridesMethodRefused } from "./ops-overrides";

const limitRefusedMethodBody = requestBodyLimit("action");

/**
 * Detached transport for the operator read. The caller owns exact-path routing,
 * shared guards and the fallback for methods this adapter does not handle.
 * Reuse the shipped handlers without mounting a router or entering session middleware.
 */
export async function fetchOpsOverrides(request: Request, env: Env): Promise<Response | null> {
  switch (request.method) {
    case "GET":
    case "HEAD": {
      const response = await opsOverridesHandler(new Context<{ Bindings: Env }>(request, { env }));
      return request.method === "HEAD" ? new Response(null, response) : response;
    }
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "OPTIONS": {
      const context = new Context<{ Bindings: Env }>(request, {
        env,
        path: new URL(request.url).pathname,
      });
      const refused = await limitRefusedMethodBody(context, () => Promise.resolve());
      return refused ?? opsOverridesMethodRefused(context);
    }
    default:
      return null;
  }
}
