import { isFeaturedImageUrl } from "./image-policy";

// Suppress blocked images on older/imported rows using the CSP host allowlist.
// Preserve legacy same-site images as paths; new admin input is HTTPS-only.
//
// The same-site check compares against the configured APP_URL origin (the
// only origin the server knows). The browser enforces img-src 'self' against
// the *serving* origin, which can differ (workers.dev aliases, previews).
// featuredImageSrc closes that gap: same-site absolute URLs render as
// path-only src, so 'self' matches wherever the page is served.
export function featuredImageAllowed(raw: string, appUrl: string, imageHosts?: string): boolean {
  try {
    const image = new URL(raw, appUrl);
    const site = new URL(appUrl);
    return (
      !image.username &&
      !image.password &&
      (image.protocol === "http:" || image.protocol === "https:") &&
      (image.origin === site.origin || isFeaturedImageUrl(raw, imageHosts))
    );
  } catch {
    return false;
  }
}

/** Render src for an allowed image: same-site absolute URLs become path-only. */
export function featuredImageSrc(raw: string, appUrl: string, imageHosts?: string): string | null {
  if (!featuredImageAllowed(raw, appUrl, imageHosts)) return null;
  try {
    const image = new URL(raw, appUrl);
    const site = new URL(appUrl);
    if (image.origin === site.origin) {
      // A pathname starting with `//` is same-origin for CSP but renders as a
      // protocol-relative URL: suppress it like any other blocked image.
      if (image.pathname.startsWith("//")) return null;
      return `${image.pathname}${image.search}${image.hash}`;
    }
    return image.href;
  } catch {
    return null;
  }
}
