import { env } from "cloudflare:workers";
import { fetchKitQueuePreview } from "../../../../../../../../src/admin/kit-queue-preview";
import type { RequestHandler } from "./$types";

export const trailingSlash = "ignore";

export const GET: RequestHandler = ({ locals, params, request }) => {
  if (!locals.requestId) throw new Error("Queue preview requires an admitted request");
  return fetchKitQueuePreview(request, env, params.id, locals.requestId);
};
