import type { Env } from "../../src/env";
import app from "../../src/index";

export type AppFetch = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

type FetchTarget =
  | [ctx?: Parameters<typeof app.fetch>[2]]
  | [ctx: ExecutionContext, candidate: AppFetch];

// A built Worker needs a context; Hono fixtures can keep their context-free path.
export async function fetchApp(
  request: Request,
  env: Env,
  ...target: FetchTarget
): Promise<Response> {
  if (target.length === 2) return target[1](request, env, target[0]);
  return app.fetch(request, env, target[0]);
}

export function requestApp(
  input: string | Request,
  init: RequestInit | undefined,
  env: Env,
  ...target: FetchTarget
): Promise<Response> {
  // Do not clone caller-owned streams when no init overrides are supplied.
  const url =
    typeof input === "string" && input.startsWith("/") ? new URL(input, env.APP_URL) : input;
  const request = url instanceof Request && !init ? url : new Request(url, init);
  return fetchApp(request, env, ...target);
}
