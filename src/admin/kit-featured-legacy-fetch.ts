import { Hono } from "hono";
import type { Env } from "../env";
import { internalErrorHandler } from "../errors";
import { adminGuard } from "./guard";
import type { QueuePreviewVars } from "./queue-preview";
import { mountFeaturedLegacyRoutes } from "./routes";

const admission = Symbol("kitFeaturedLegacyRequestId");
type Bindings = Env & { [admission]?: string };

const bookmarks = new Hono<QueuePreviewVars>();
bookmarks.use("*", async (c, next) => {
  const requestId = (c.env as Bindings)[admission];
  if (requestId) c.set("requestId", requestId);
  await next();
});
bookmarks.onError(internalErrorHandler);

// The same guard owns session rotation, read classification and refusal
// envelopes even on redirect and lookup-outage responses.
const routes = new Hono<QueuePreviewVars>();
routes.use("/*", adminGuard());
mountFeaturedLegacyRoutes(routes);
bookmarks.route("/admin", routes);

export function fetchKitFeaturedLegacy(request: Request, env: Env, requestId?: string) {
  const bindings: Bindings = { ...env, [admission]: requestId };
  return bookmarks.fetch(request, bindings);
}
