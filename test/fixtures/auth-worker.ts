import worker from "../../src/worker";
import type { JobsEnv } from "../../src/env";
import { createMemorySessionStore } from "../../src/sessions";

// Only the store is replaced: requests still traverse the production Worker
// entry, Hono routes, crypto, cookies, security headers and rendering in workerd.
// Real Postgres persistence is covered separately by the agent-testdb suites.
const store = createMemorySessionStore();
export default {
  fetch(request: Request, env: JobsEnv, ctx: ExecutionContext) {
    return worker.fetch(request, { ...env, SESSION_STORE: store } as JobsEnv, ctx);
  },
};
