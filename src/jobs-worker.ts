import type { JobsEnv } from "./env";
import { handleQueue, handleScheduled } from "./jobs/worker";

// Jobs-only Worker entry (two-web-jobs, wrangler.jobs.jsonc).
// Same queue and cron handlers as src/worker.ts, no fetch handler: the web
// front (Hono today, SvelteKit in web/) and the jobs runtime deploy apart and
// share src/db and the domain modules. A queue has exactly one consumer, so
// staging consumes here after the handoff (docs/jobs-handoff.md); src/worker.ts
// only produces and owns no cron.
export default {
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<JobsEnv>;
