import app from "./index";
import type { JobsEnv } from "./env";
import { handleQueue, handleScheduled } from "./jobs/worker";
import { withStreamedBody } from "./html-stream";

// Worker entry: HTTP goes to the Hono app; queue consumers and cron triggers are W13.
// Wire encoding (TWO-7591/TWO-8089): the remote-placement lane marks text/html
// no-transform for every body shape, so the Worker encodes the document itself.
// The wrap must sit at the outermost return: Hono's dispatch rebuilds the
// response object and drops encodeBody "manual", which lets the platform
// re-encode an already-gzipped body (double compression on the served wire).
export default {
  fetch: async (request: Request, env: JobsEnv, ctx: ExecutionContext): Promise<Response> =>
    withStreamedBody(await app.fetch(request, env, ctx), request),
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<JobsEnv>;
