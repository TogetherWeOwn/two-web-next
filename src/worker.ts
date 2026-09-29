import app from "./index";
import type { JobsEnv } from "./env";
import { handleQueue, handleScheduled } from "./jobs/worker";

// Worker entry: HTTP goes to the Hono app; queue consumers and cron triggers are W13.
export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<JobsEnv>;
