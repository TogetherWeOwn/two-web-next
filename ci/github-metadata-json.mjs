// One GitHub metadata page, including job steps and their associated metadata.
const maxBytes = 1024 * 1024;

export async function readGitHubMetadataJson(body) {
  if (!body) throw new Error("Missing GitHub metadata response body");
  const bytes = Buffer.alloc(maxBytes);
  const reader = body.getReader();
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (!(value instanceof Uint8Array) || value.byteLength === 0)
        throw new Error("Invalid GitHub metadata response body");
      if (value.byteLength > maxBytes - size)
        throw new Error("GitHub metadata response exceeds the byte limit");
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    // An upstream cleanup promise must not delay a known refusal.
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!size) throw new Error("Empty GitHub metadata response body");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } catch {
    throw new Error("Invalid GitHub metadata JSON");
  }
}
