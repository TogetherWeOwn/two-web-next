export const KIT_STATIC_FEED_PATHS = { calendar: "/events.ics", rss: "/events.rss" } as const;

export const KIT_STATIC_FEED_ROUTES = Object.values(KIT_STATIC_FEED_PATHS).map(
  (path) => ({ method: "GET", path, enabled: true, reads: "public" }) as const,
);
