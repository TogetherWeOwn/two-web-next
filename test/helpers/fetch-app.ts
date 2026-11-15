import type { Env } from "../../src/env";
import app from "../../src/index";

export type AppFetch = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

// Pass a built Worker's fetch handler explicitly to exercise a candidate.
export async function fetchApp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  candidate: AppFetch = app.fetch,
): Promise<Response> {
  return candidate(request, env, ctx);
}
