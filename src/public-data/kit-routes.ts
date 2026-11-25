export const PUBLIC_API_PATHS = {
  events: "/api/public/events",
  event: "/api/public/events/:key",
  community: "/api/public/community",
  join: "/api/public/join",
  openApi: "/openapi.json",
} as const;

const read = { method: "GET", enabled: true, reads: "public" } as const;

export const KIT_PUBLIC_API_ROUTES = [
  { ...read, path: PUBLIC_API_PATHS.events },
  { ...read, path: PUBLIC_API_PATHS.community },
  { ...read, path: PUBLIC_API_PATHS.join },
  { ...read, path: PUBLIC_API_PATHS.openApi },
  {
    ...read,
    path: PUBLIC_API_PATHS.event,
    dynamic: {
      id: "/api/public/events/[key]",
      releaseReservedLiteral: true,
      matches: (raw: string) => /^\/api\/public\/events\/[^/%]+$/.test(raw),
    },
  },
] as const;
