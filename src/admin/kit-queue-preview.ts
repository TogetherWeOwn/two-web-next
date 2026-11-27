import { Context } from "hono";
import type { Env } from "../env";
import { internalErrorHandler } from "../errors";
import { adminGuard } from "./guard";
import { KIT_QUEUE_PREVIEW_ROUTE } from "./kit-serving";
import { queuePreviewAdmission, type QueuePreviewVars, respondQueuePreview } from "./queue-preview";

const admitModerator = adminGuard(undefined, KIT_QUEUE_PREVIEW_ROUTE.path);

/** The mounted Kit endpoint supplies the matched selector and the hook's request ID. */
export async function fetchKitQueuePreview(
  request: Request,
  env: Env,
  selector: string,
  requestId: string,
): Promise<Response> {
  const c = new Context<QueuePreviewVars>(request, { env, path: new URL(request.url).pathname });
  c.set("requestId", requestId);
  try {
    const refused = await queuePreviewAdmission(
      c,
      async () => {
        const denied = await admitModerator(c, async () => {
          await respondQueuePreview(c, selector);
        });
        if (denied) c.res = denied;
      },
      selector,
    );
    return refused ?? c.res;
  } catch (error) {
    return internalErrorHandler(error, c, KIT_QUEUE_PREVIEW_ROUTE.path);
  }
}
