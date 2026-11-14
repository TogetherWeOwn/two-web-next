// Keep the error envelope independent of database and event-read imports so
// global error handlers can use it without importing the read routes.
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
  next = PUBLIC_DATA_ERROR_NEXT[code],
): Response {
  const body: PublicDataErrorDto = {
    error: {
      code,
      message,
      request_id: c.get("requestId"),
      next,
    },
  };
  return c.json(body, status, { "cache-control": "no-store, private" });
}

export function isPublicApiPath(path: string): boolean {
  return path === "/api/public" || path.startsWith("/api/public/");
}

export function publicApiNotFound(c: Ctx): Response {
  return apiError(c, "not_found", "No such API path.", 404, "Check the API path and retry.");
}
