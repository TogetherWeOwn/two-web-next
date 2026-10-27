// The read API's error envelope and its unknown-path answer, kept free of
// database and event-read imports so the global error handlers can use them
// without pulling the read routes into every bundle that registers them.
import type { Context } from "hono";
import type { Env } from "../env";
import {
  PUBLIC_DATA_ERROR_NEXT,
  type PublicDataErrorCode,
  type PublicDataErrorDto,
} from "./contracts";

export type Ctx = Context<{ Bindings: Env }>;

export function apiError(
  c: Ctx,
  code: PublicDataErrorCode,
  message: string,
  status: 422 | 404 | 500 | 503,
): Response {
  const body: PublicDataErrorDto = {
    error: {
      code,
      message,
      request_id: c.get("requestId"),
      next: PUBLIC_DATA_ERROR_NEXT[code],
    },
  };
  return c.json(body, status, { "cache-control": "no-store, private" });
}

/** The exact `/api/public` namespace: the root and everything below a slash. */
export function isPublicApiPath(path: string): boolean {
  return path === "/api/public" || path.startsWith("/api/public/");
}

/**
 * Unknown path inside the public API namespace: the same static not_found
 * envelope as a missing event, never the branded page or an asset lookup. The
 * request path is never echoed; HEAD loses its body in the framework.
 */
export function publicApiNotFound(c: Ctx): Response {
  return apiError(c, "not_found", "No such API path.", 404);
}
