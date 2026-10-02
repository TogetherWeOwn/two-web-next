/** Largest report body accepted, in bytes. Bigger bodies are dropped. */
export const MAX_CSP_REPORT_BYTES = 8192;

/** One deadline for the entire report body, not a fresh budget per chunk. */
export const CSP_REPORT_BODY_DEADLINE_MS = 1000;

export type CappedBody = { text: string; truncated: boolean; bytes: number };

/**
 * Retain at most the cap in chunks. A declared oversize body is never read;
 * otherwise stop on the first overflow chunk. Reads are chunk-granular, so
 * `bytes` counts all observed bytes, including the discarded overflow chunk.
 * Incomplete bodies are discarded, even if their prefix is valid JSON.
 */
export async function readCappedBody(req: Request, cap: number = MAX_CSP_REPORT_BYTES): Promise<CappedBody> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > cap) return { text: "", truncated: true, bytes: n };
  }
  if (!req.body) return { text: "", truncated: false, bytes: 0 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const empty = (): CappedBody => ({ text: "", truncated: false, bytes });
  const read = (async (): Promise<CappedBody> => {
    for (;;) {
      const { done, value } = await reader.read();
      // A late read must not retain, decode, or pull again after the deadline.
      if (stopped) return empty();
      if (done) {
        complete = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > cap) return { text: "", truncated: true, bytes };
      chunks.push(value);
    }
    const merged = new Uint8Array(bytes);
    let off = 0;
    for (const chunk of chunks) {
      merged.set(chunk, off);
      off += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(merged), truncated: false, bytes };
  })();
  const deadline = new Promise<CappedBody>((resolve) => {
    timer = setTimeout(() => resolve(empty()), CSP_REPORT_BODY_DEADLINE_MS);
  });
  try {
    // Race once, so even many small chunks share one budget. Promise.race
    // also consumes a late read rejection after the deadline has won.
    return await Promise.race([read, deadline]);
  } catch {
    return empty();
  } finally {
    stopped = true;
    clearTimeout(timer);
    chunks.length = 0;
    if (!complete) {
      // Request-owned cancellation must never hold the always-204 response.
      // Handle both synchronous failure and a late cancellation rejection.
      try { void reader.cancel().catch(() => {}); } catch {}
    }
    reader.releaseLock();
  }
}
