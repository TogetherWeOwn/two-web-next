// GET /join, /join/discord, /join/callback (W6).
//
// Join route barrel (structural split; zero behavior change). One module per
// concern lives beside this file: shared cookies/TTLs/types/helpers in
// ./route-shared, the landing page in ./route-page, the Discord start in
// ./route-start, the OAuth callback in ./route-callback. Registration order
// below matches the original file exactly. This file re-exports the historic
// public names so existing importers keep working untouched.
import type { Hono } from "hono";
import type { Env } from "../env";
import { registerJoinCallbackRoutes } from "./route-callback";
import { registerJoinPageRoutes } from "./route-page";
import { type JoinRender, type JoinSessionHooks } from "./route-shared";
import { registerJoinStartRoutes } from "./route-start";

export {
  JOIN_NEXT_COOKIE,
  JOIN_SOURCE_COOKIE,
  JOIN_STATE_COOKIE,
  JOURNEY_TTL_SECONDS,
  STATE_TTL_SECONDS,
} from "./route-shared";
export type {
  EnvWithJoin,
  JoinPageProps,
  JoinRender,
  JoinRouteDeps,
  JoinSessionHooks,
  RecoveryProps,
} from "./route-shared";

export function registerJoinRoutes(
  app: Hono<{ Bindings: Env }>,
  hooks: JoinSessionHooks,
  render: JoinRender,
) {
  registerJoinPageRoutes(app, render);
  registerJoinStartRoutes(app, hooks);
  registerJoinCallbackRoutes(app, hooks, render);
}
