import { env } from "cloudflare:workers";
import { fetchKitQueueRedispatch } from "../../../../../../../../src/admin/kit-queue-redispatch";
import type { RequestHandler } from "./$types";

export const trailingSlash = "ignore";

export const POST: RequestHandler = ({ locals, request }) => {
  if (!locals.requestId) throw new Error("Queue redispatch requires an admitted request");
  return fetchKitQueueRedispatch(request, env, locals.requestId);
};
