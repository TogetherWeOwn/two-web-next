// The browser fixture rewrites virtual-origin HTML and returns identity bytes.
export async function rewriteFixtureHtml(response: Response, from: string, to: string) {
  const raw = response.body;
  const document =
    raw && response.headers.get("content-encoding") === "gzip"
      ? await new Response(raw.pipeThrough(new DecompressionStream("gzip"))).text()
      : await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("etag");
  return new Response(document.replaceAll(from, to), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
