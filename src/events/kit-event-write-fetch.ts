import { Context } from "hono";
import { getPath, tryDecodeURIComponent } from "hono/utils/url";
import { requestBodyLimit } from "../body-limit";
import type { Env } from "../env";
import { internalErrorHandler } from "../errors";
import { safeRequestId } from "../http/request-log";
import { crossOriginRefusal } from "../same-origin";
import { readContextSession } from "../session-hono";
import { throttleGuard, WRITE_THROTTLE_PER_MINUTE } from "../throttle";
import { KIT_EVENT_WRITE_ROUTES } from "./kit-event-write-routes";
import { rsvpHandlers } from "./routes-rsvp";
import type { SessionReader } from "./routes-shared";
import {
  createModeratorEvent,
  duplicateModeratorEvent,
  EVENT_TRANSITIONS,
  moderatorForEventWrite,
  patchModeratorEvent,
  transitionModeratorEvent,
} from "./routes-writes";

const actionCap = requestBodyLimit("action");
const jsonCap = requestBodyLimit("json");

function eventWriteContext(request: Request, env: Env, requestId?: string) {
  const c = new Context<{ Bindings: Env }>(request, { env, path: getPath(request) });
  const id = safeRequestId(requestId);
  if (id !== undefined) c.set("requestId", id);
  return c;
}

export function refuseKitEventWriteOrigin(request: Request, env: Env, requestId: string) {
  return crossOriginRefusal(eventWriteContext(request, env, requestId));
}

export async function fetchKitEventWrite(
  request: Request,
  env: Env,
  requestId?: string,
  readSession: SessionReader = (c) => readContextSession(c, false),
): Promise<Response> {
  const rawPath = new URL(request.url).pathname;
  const c = eventWriteContext(request, env, requestId);
  const method = request.method;
  const route = KIT_EVENT_WRITE_ROUTES.find(
    (route) =>
      (route.method === method || route.method === "*") &&
      ("dynamic" in route ? route.dynamic.matches(rawPath, c.req.path) : route.path === rawPath),
  );
  if (!route) return new Response(null, { status: 404 });
  // Decode the key as Hono does using the original request path.
  const [, mount, segment = "", action] = c.req.path.split("/");
  const key = tryDecodeURIComponent(segment);
  try {
    const isRsvp = action === "rsvp";
    const native = mount === "e";
    if (isRsvp && !native && method !== "PUT" && method !== "DELETE") {
      const refusal = rsvpHandlers.refuseMethod(c);
      return method === "HEAD" ? new Response(null, refusal) : refusal;
    }
    const cap = route.path === "/events" || (method === "PATCH" && !isRsvp) ? jsonCap : actionCap;
    const refused = await cap(c, async () => {});
    if (refused) return refused;
    if (isRsvp) {
      return await (native ? rsvpHandlers.form : rsvpHandlers.json)(c, key, readSession);
    }

    const limited = await throttleGuard(c, "event-write", WRITE_THROTTLE_PER_MINUTE);
    if (limited) return limited;
    const moderator = await moderatorForEventWrite(c, readSession);
    if (moderator instanceof Response) return moderator;
    if (method === "PATCH") return await patchModeratorEvent(c, moderator, key);
    if (route.path === "/events") return await createModeratorEvent(c, moderator);
    if (action === "duplicate") return await duplicateModeratorEvent(c, moderator, key);
    const transition = EVENT_TRANSITIONS.find((entry) => entry === action);
    if (transition) return await transitionModeratorEvent(c, moderator, key, transition);
    throw new Error("Unknown matched event action");
  } catch (error) {
    return internalErrorHandler(error, c, route.path);
  }
}
