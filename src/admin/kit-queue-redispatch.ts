import { Context, Hono } from "hono";
import type { Env } from "../env";
import { internalErrorHandler } from "../errors";
import { STAGING_APP_URL } from "../qa";
import { crossOriginRefusal } from "../same-origin";
import { adminGuard } from "./guard";
import type { QueuePreviewVars } from "./queue-preview";
import {
  QUEUE_REDISPATCH_PATH,
  queueRedispatchAction,
  queueRedispatchAdmission,
} from "./queue-redispatch";

const path = `/admin${QUEUE_REDISPATCH_PATH}`;
const routes = [
  {
    method: "POST",
    path,
    enabled: true,
    reads: "public", // The endpoint owns its staging and session admission.
    dynamic: {
      id: "/admin/queue/failed/[id]/redispatch",
      matches: (raw: string, decoded: string) =>
        raw === decoded && /^\/admin\/queue\/failed\/[A-Za-z0-9_-]+\/redispatch$/.test(raw),
    },
  },
] as const;

export function kitQueueRedispatchFamily(env: Env) {
  return {
    flag: env.APP_URL === STAGING_APP_URL ? env.KIT_ROUTE_ADMIN_QUEUE_REDISPATCH : undefined,
    routes,
    crossOriginRefusal(request: Request, requestId: string) {
      const context = new Context<QueuePreviewVars>(request, { env, path });
      context.set("requestId", requestId);
      return crossOriginRefusal(context);
    },
  };
}

// The Kit endpoint uses the same middleware chain and original Request as Hono,
// including Hono parameter extraction and the streaming body cap.
export function fetchKitQueueRedispatch(request: Request, env: Env, requestId: string) {
  const app = new Hono<QueuePreviewVars>();
  app.onError((error, context) => internalErrorHandler(error, context, path));
  app.post(
    path,
    async (context, next) => {
      context.set("requestId", requestId);
      await next();
    },
    queueRedispatchAdmission,
    adminGuard(),
    ...queueRedispatchAction,
  );
  return app.fetch(request, env);
}
