export const BRANDED_NOT_FOUND = {
  status: 404,
  headers: {
    "cache-control": "no-store, private",
    "content-type": "text/html; charset=UTF-8",
  },
} as const;

// For an already-selected fallback. Dispatch, suggestions and response
// decoration (including security headers) belong to the caller.
export async function brandedNotFoundFallback(
  request: Request,
  render: () => string | Promise<string>,
): Promise<Response> {
  return new Response(request.method === "HEAD" ? null : await render(), BRANDED_NOT_FOUND);
}
