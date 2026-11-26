import type { Context } from "hono";
import { exceptionClass } from "../alerts";
import type { Env } from "../env";
import { databaseUnavailable, forbidden } from "../errors";
import type { KitLocals } from "../kit-session";
import { STAGING_APP_URL } from "../qa";
import { bounceToLogin } from "../return-journey";
import { decideKitAdminGuard } from "./kit-guard";

export const KIT_ADMIN_OPS_ROUTES = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map(
  (method) => ({ method, path: "/admin/ops-overrides", enabled: true, reads: "public" as const }),
);

const formPaths = [
  ["/admin/events", "/admin/events"],
  ["/admin/featured", "/admin/featured"],
  ["/admin/events/:key", "/admin/events/[key]"],
  ["/admin/featured/:id", "/admin/featured/[id]"],
  ["/admin/events/:key/duplicate", "/admin/[...action]"],
  ...["publish", "cancel", "rsvp-pause", "rsvp-reopen"].map(
    (action) => [`/admin/events/:key/${action}`, "/admin/[...action]"] as const,
  ),
  ...["delete", "unpublish"].map(
    (action) => [`/admin/featured/:id/${action}`, "/admin/[...action]"] as const,
  ),
] as const;

export function adminFormPath(path: string, routeId?: string | null): string | undefined {
  const parts = path.split("/");
  return formPaths.find(([pattern, id]) => {
    if (routeId !== undefined && routeId !== id) return false;
    const expected = pattern.split("/");
    return (
      parts.length === expected.length &&
      expected.every((value, index) =>
        value.startsWith(":")
          ? /^[A-Za-z0-9_-]+$/.test(parts[index] ?? "")
          : value === parts[index],
      )
    );
  })?.[0];
}

export function admitsKitAdmin(
  request: Request,
  url: URL,
  isDataRequest: boolean | undefined,
  appUrl: string,
  flag: string | undefined,
  cutoverOrigin = false,
): boolean {
  if (flag !== "true" || isDataRequest) return false;
  const original = new URL(request.url);
  if (
    original.origin !== appUrl ||
    original.pathname !== url.pathname ||
    url.origin !== original.origin ||
    !/^\/admin(?:\/[A-Za-z0-9_-]+)*$/.test(original.pathname)
  ) {
    return false;
  }
  return (
    appUrl === STAGING_APP_URL ||
    cutoverOrigin ||
    (original.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(original.hostname))
  );
}

export async function kitAdminAdmission(
  context: Context<{ Bindings: Env }>,
  readLocals: () => Promise<KitLocals> | undefined,
) {
  let locals: KitLocals | undefined;
  try {
    locals = await readLocals();
  } catch (error) {
    console.warn("kit admin session bridge unavailable", { exception: exceptionClass(error) });
  }
  const decision = decideKitAdminGuard(
    { status: locals?.status, session: locals?.session },
    context.req.path,
  );
  switch (decision.kind) {
    case "pass":
      return { ...decision, locals };
    case "guest":
      return { kind: "refused", response: await bounceToLogin(context) } as const;
    case "forbidden":
      return { kind: "refused", response: await forbidden(context) } as const;
    case "unavailable":
      return { kind: "refused", response: await databaseUnavailable(context) } as const;
  }
}

// SvelteKit routes an explicitly selected named action or a non-form request
// differently. Native forms use the default action; other clients retain the
// same wire contract through the same controller.
export function usesKitDefaultAction(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return (
    (mediaType === "application/x-www-form-urlencoded" ||
      mediaType === "multipart/form-data" ||
      mediaType === "text/plain") &&
    ![...new URL(request.url).searchParams.keys()].some((name) => name.startsWith("/"))
  );
}

export function privateAdminResponse(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  // A framework-generated validator must never turn a renewed session's
  // response into a 304 that drops its Set-Cookie.
  headers.delete("etag");
  if (
    !headers
      .get("cache-control")
      ?.split(",")
      .some((value) => value.trim() === "no-store")
  ) {
    headers.set("cache-control", "private, no-store");
  }
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
