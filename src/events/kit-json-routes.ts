export const KIT_EVENT_COLLECTION_ROUTE = {
  method: "GET",
  path: "/events.json",
  enabled: true,
  // The family handler admits the request before its own session check.
  reads: "public",
} as const;

export const KIT_EVENT_JSON_ROUTE = {
  method: "GET",
  path: "/events/:key",
  enabled: true,
  reads: "public",
  dynamic: {
    id: "/events/[key]",
    // A populated literal .ics suffix belongs to the separate feed family.
    matches: (raw: string) => /^\/events\/(?![^/]+\.ics$)[^/%]+$/.test(raw),
  },
} as const;
