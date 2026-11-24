export const KIT_STATIC_FEED_ROUTES = [
  { method: "GET", path: "/events.ics", enabled: true, reads: "public" },
  { method: "GET", path: "/events.rss", enabled: true, reads: "public" },
] as const;
