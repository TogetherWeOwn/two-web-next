import { gunzipSync } from "node:zlib";

// Keep the wire headers for assertions, but expose decoded bytes to the raw client.
export function decodeWireBody(chunks: Buffer[], headers: [string, string][]): Buffer | null {
  const payload = chunks.length ? Buffer.concat(chunks) : null;
  const encoding = headers.find(([name]) => name.toLowerCase() === "content-encoding")?.[1];
  return payload && encoding?.toLowerCase() === "gzip" ? gunzipSync(payload) : payload;
}
