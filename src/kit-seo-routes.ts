export const KIT_SEO_PATHS = { robots: "/robots.txt", sitemap: "/sitemap_index.xml" } as const;

export const KIT_SEO_ROUTES = Object.values(KIT_SEO_PATHS).map(
  (path) => ({ method: "GET", path, enabled: true, reads: "public" }) as const,
);
