// Pinned-asset cache (TOG-12550). The self-hosted fonts in public/fonts/ are
// pinned binaries: their bytes only change under a new filename, so a
// year-long `immutable` can never serve stale glyphs (ports two-web TOG-6785,
// which pins /fonts/ in nginx). Nothing else gets this header: islands JS,
// CSS, icons, the manifest and the favicon are not content-hashed.
export const PINNED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

// Only exact /fonts/*.woff2 members. Rejects nesting, suffix tricks and
// extension case games so an unhashed sibling never inherits the header.
export function isPinnedAssetPath(pathname: string): boolean {
  return /^\/fonts\/[^/]+\.woff2$/.test(pathname);
}

// Copy an ASSETS response, stamping the immutable header on pinned fonts and
// returning every other asset untouched (the same response object, so the
// existing 304/ETag passthrough keeps working). ASSETS bodies stream; the
// copy preserves status and metadata so outer security middleware still gets
// a writable response.
export function withPinnedAssetCache(requestUrl: string, asset: Response): Response {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return asset;
  }
  if (!isPinnedAssetPath(pathname)) return asset;
  const headers = new Headers(asset.headers);
  headers.set("cache-control", PINNED_ASSET_CACHE_CONTROL);
  return new Response(asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });
}
