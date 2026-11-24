export const KIT_AUTH_ROUTES = [
  { method: "GET", path: "/auth/status" },
  { method: "GET", path: "/auth/discord/redirect" },
  { method: "GET", path: "/auth/discord" },
  { method: "GET", path: "/auth/discord/callback" },
  { method: "POST", path: "/logout" },
  { method: "POST", path: "/logout/everywhere" },
].map((route) => ({ ...route, enabled: true, reads: "public" }) as const);
