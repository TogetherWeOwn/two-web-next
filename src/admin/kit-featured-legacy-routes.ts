// The endpoint owns the guarded read boundary, like the other API families.
export const KIT_ADMIN_FEATURED_LEGACY_ROUTES = [
  { method: "GET", path: "/admin/featured-contents", enabled: true, reads: "public" },
  { method: "GET", path: "/admin/featured-contents/create", enabled: true, reads: "public" },
  {
    method: "GET",
    path: "/admin/featured-contents/:id/edit",
    enabled: true,
    reads: "public",
    dynamic: {
      id: "/admin/featured-contents/[id]/edit",
      // Encoded, empty and malformed segments keep their Hono interpretation.
      matches: (path: string) => /^\/admin\/featured-contents\/[A-Za-z0-9_-]+\/edit$/.test(path),
    },
  },
] as const;
