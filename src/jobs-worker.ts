import type { JobsEnv } from "./env";
import { handleQueue, handleScheduled } from "./jobs/worker";

// Jobs-only Worker entry (two-web-jobs, wrangler.jobs.jsonc; TOG-12247 spike).
// Same queue and cron handlers as src/worker.ts, no fetch handler: the web
// front (Hono today, SvelteKit in web/) and the jobs runtime deploy apart and
// share src/db and the domain modules. A queue has exactly one consumer, so
// staging keeps consuming in src/worker.ts until a cutover PR moves it here.
export default {
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<JobsEnv>;
