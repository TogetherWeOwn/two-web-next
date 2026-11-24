const memberPath = /^\/members\/[^/]+$/;

export const KIT_PROFILE_WRITE_PATH = "/members/:user";
export const KIT_PROFILE_WRITE_ROUTE_ID = "/members/[user]";

export const KIT_PROFILE_WRITE_ROUTES = ["PATCH", "POST"].map(
  (method) =>
    ({
      method,
      path: KIT_PROFILE_WRITE_PATH,
      enabled: true,
      reads: "public", // The write adapter owns session and owner admission before any profile lookup.
      dynamic: {
        id: KIT_PROFILE_WRITE_ROUTE_ID,
        // Kit's path decoder preserves escaped slashes. Leave those aliases with Hono.
        matches: (raw: string, decoded: string) =>
          memberPath.test(raw) && memberPath.test(decoded) && !/%2f/i.test(raw),
      },
    }) as const,
);
