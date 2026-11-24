const memberPath = /^\/members\/[^/]+$/;

export const KIT_PROFILE_WRITE_PATH = "/members/:user";
export const KIT_PROFILE_WRITE_ROUTE_ID = "/members/[user]";

export const KIT_PROFILE_WRITE_ROUTES = ["PATCH", "POST"].map(
  (method) =>
    ({
      method,
      path: KIT_PROFILE_WRITE_PATH,
      enabled: true,
      reads: "public", // This branch guards writes before any session or profile lookup.
      dynamic: {
        id: KIT_PROFILE_WRITE_ROUTE_ID,
        matches: (raw: string, decoded: string) => memberPath.test(raw) && memberPath.test(decoded),
      },
    }) as const,
);
