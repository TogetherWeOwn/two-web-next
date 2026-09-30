// Match the existing img-src 'self' https://cdn.discordapp.com policy.
// Validate new admin input and suppress blocked images on older/imported rows.
//
// The same-site check compares against the configured APP_URL origin (the
// only origin the server knows). The browser enforces img-src 'self' against
// the *serving* origin, which can differ (workers.dev aliases, previews).
// featuredImageSrc closes that gap: same-site absolute URLs render as
// path-only src, so 'self' matches wherever the page is served. CSP unchanged.
export function featuredImageAllowed(raw: string, appUrl: string): boolean {
  try {
    const image = new URL(raw, appUrl);
    const site = new URL(appUrl);
    return !image.username && !image.password
      && (image.protocol === "http:" || image.protocol === "https:")
      && (image.origin === site.origin || image.origin === "https://cdn.discordapp.com");
  } catch {
    return false;
  }
}

/** Render src for an allowed image: same-site absolute URLs become path-only. */
export function featuredImageSrc(raw: string, appUrl: string): string | null {
  if (!featuredImageAllowed(raw, appUrl)) return null;
  try {
    const image = new URL(raw, appUrl);
    const site = new URL(appUrl);
    if (image.origin === site.origin) return `${image.pathname}${image.search}${image.hash}`;
    return image.href;
  } catch {
    return null;
  }
}
