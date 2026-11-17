const key = (n: number) => String(n).padStart(26, "0");

export const QUERY_CANARY = "query-canary-7f3a9c41";

export const UNKNOWN_PATHS = [
  "/api/public",
  "/api/public/",
  "/api/public/cache",
  "/api/public/invalidate",
  "/api/public/unknown",
  "/api/public/unknown/nested/deep",
  "/api/public/events/",
  `/api/public/events/${key(1)}/extra`,
  "/api/public/community/extra",
  "/api/public/join/extra",
  "/api/public/unknown?probe=1",
  `/api/public/unknown?q=${QUERY_CANARY}`,
] as const;
