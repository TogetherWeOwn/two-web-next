export async function etagFor(body: string, algorithm: "SHA-1" | "SHA-256"): Promise<string> {
  const d = await crypto.subtle.digest(algorithm, new TextEncoder().encode(body));
  return `"${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

/** Match a standalone wildcard or a list of strong or weak tags against a strong ETag. */
export function matchesIfNoneMatch(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  const value = header.trim();
  if (value === "*") return true;
  return value.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag);
}

/** Apply Kit's single-tag check before Kit's automatic 304 can discard headers. */
export function applySingleValidator(request: Request, response: Response): Response {
  const etag = response.headers.get("etag");
  let validator = request.headers.get("if-none-match");
  if (validator?.startsWith('W/"')) validator = validator.slice(2);
  if (response.status === 200 && etag !== null && validator === etag) {
    return new Response(null, { status: 304, headers: response.headers });
  }
  return response;
}
