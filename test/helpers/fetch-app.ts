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

const fixtureContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

// Preserve the fixture origin for relative paths and explicit host probes as written.
export function fetchAppPath(path: string, init: RequestInit | undefined, env: Env) {
  const url = path.startsWith("/") ? new URL(path, env.APP_URL) : path;
  return fetchApp(new Request(url, init), env, fixtureContext);
}
